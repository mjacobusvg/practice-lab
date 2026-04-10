// netlify/functions/ask-archive-background.js
// Background function — full RAG pipeline, saves result to Supabase jobs table
// Called by ask-archive.js dispatcher, result retrieved by ask-archive-poll.js

const MATCH_THRESHOLD = 0.45;
const MATCH_COUNT = 12;

const META_PATTERNS = [
  /^are there (any )?posts? on /i,
  /^do you have (anything|any posts?) (on|about) /i,
  /^what (do you have|posts?) (on|about) /i,
  /^is there anything (on|about) /i,
  /^show me (posts?|anything) (on|about) /i,
  /^find (posts?|anything) (on|about) /i,
  /^any posts? (on|about) /i,
];

function extractTopic(q) {
  return q
    .replace(/^are there (any )?posts? on /i, '')
    .replace(/^do you have (anything|any posts?) (on|about) /i, '')
    .replace(/^what (do you have|posts?) (on|about) /i, '')
    .replace(/^is there anything (on|about) /i, '')
    .replace(/^show me (posts?|anything) (on|about) /i, '')
    .replace(/^find (posts?|anything) (on|about) /i, '')
    .replace(/^any posts? (on|about) /i, '')
    .trim();
}

function isMetaQuestion(q) {
  return META_PATTERNS.some(function(p) { return p.test(q); });
}

exports.handler = async function(event, context) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) { return { statusCode: 400, body: '' }; }

  const { job_id, question, member_requested, conversation_history } = body;
  const conversationHistory = conversation_history || [];

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  async function saveResult(result) {
    await fetch(`${supabaseUrl}/rest/v1/archive_jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        job_id: job_id,
        status: 'complete',
        result: JSON.stringify(result),
        created_at: new Date().toISOString()
      })
    });
  }

  try {
    let matches;

    if (isMetaQuestion(question)) {
      const topic = extractTopic(question);
      const ftsRes = await fetch(`${supabaseUrl}/rest/v1/rpc/search_posts_fts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
        body: JSON.stringify({ search_query: topic, match_count: 20 })
      });
      matches = ftsRes.ok ? await ftsRes.json() : [];

    } else {
      // Query expansion
      const expansionRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          messages: [{ role: 'user', content: `You are helping search a psychiatric prescriber forum. Given this question: "${question}"\n\nGenerate 3 alternative phrasings that capture the same clinical concept but use different terminology an expert might use when writing about this topic. Think about how the answer would be written, not how the question is asked.\n\nImportant: For any billing or E/M coding question, always include one variant covering time-based billing and one covering MDM-based billing.\n\nReturn only a JSON array of 3 strings. No preamble, no explanation.` }]
        })
      });

      let queryVariants = [question];
      if (expansionRes.ok) {
        try {
          const expansionData = await expansionRes.json();
          const variants = JSON.parse(expansionData.content[0].text.replace(/```json|```/g, '').trim());
          if (Array.isArray(variants)) queryVariants = [question, ...variants].slice(0, 4);
        } catch(e) {}
      }

      console.log('Query variants:', queryVariants);

      const embeddings = await Promise.all(queryVariants.map(function(q) { return getEmbedding(q, openaiKey); }));

      const searchResults = await Promise.all(embeddings.map(function(emb) {
        return fetch(`${supabaseUrl}/rest/v1/rpc/match_posts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
          body: JSON.stringify({ query_embedding: emb, match_threshold: MATCH_THRESHOLD, match_count: MATCH_COUNT })
        }).then(function(r) { return r.ok ? r.json() : []; });
      }));

      const mergedMap = {};
      searchResults.forEach(function(resultSet) {
        (resultSet || []).forEach(function(record) {
          if (!mergedMap[record.id] || record.similarity > mergedMap[record.id].similarity) mergedMap[record.id] = record;
        });
      });

      matches = Object.values(mergedMap).sort(function(a, b) { return (b.similarity||0)-(a.similarity||0); }).slice(0, MATCH_COUNT);

      console.log('Expanded search matches:', matches.length);
      console.log('Starting template search...');

      // Template search
      const templateSearchRes = await fetch(`${supabaseUrl}/rest/v1/rpc/search_posts_fts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
        body: JSON.stringify({ search_query: queryVariants[0].replace(/^(what|how|when|why|can|is|are|do|does)\s+/i, '').substring(0, 60), match_count: 8 })
      });

      if (templateSearchRes.ok) {
        const templateMatches = await templateSearchRes.json();
        const TEMPLATE_KEYWORDS = ['template', 'macro', 'phrasing', 'dotphrase', 'snippet', 'language', 'documentation'];
        const existingIds = new Set(matches.map(function(m) { return m.id; }));
        templateMatches.filter(function(m) {
          return TEMPLATE_KEYWORDS.some(function(kw) { return (m.title||'').toLowerCase().includes(kw); });
        }).forEach(function(tp) {
          if (!existingIds.has(tp.id)) { tp._isTemplateCandidate = true; matches.push(tp); }
        });
      }
    }

    // Handle meta/browse
    if (isMetaQuestion(question)) {
      const EXCLUDED = ['start here','forum updates','forum updates & announcements','welcome','announcements'];
      const filtered = (matches||[]).filter(function(m) {
        return !EXCLUDED.some(function(ex) { return (m.space_name||'').toLowerCase().includes(ex); });
      });

      const result = { browse: true, topic: question, posts: filtered.slice(0,10).map(function(m) {
        return { title: m.title, space: m.space_name, author: m.author, url: m.url, description: '' };
      }), total: filtered.length };

      await saveResult(result);
      return { statusCode: 200, body: '' };
    }

    // Unanswered
    if (!matches || matches.length === 0) {
      await logUnanswered(supabaseUrl, supabaseKey, question, member_requested);
      await sendUnansweredEmail(resendKey, question);
      await saveResult({ unanswered: true, answer: "The archive doesn't have content on this topic yet. It's been logged and Michael will be notified." });
      return { statusCode: 200, body: '' };
    }

    // Enrich
    console.log('Starting enrichment for', matches.length, 'matches...');
    const enrichedChunks = await enrichCommentChunksParallel(matches, supabaseUrl, supabaseKey);
    console.log('Enrichment complete:', enrichedChunks.length, 'chunks');

    // Gap detection
    try {
      const retrievedTitles = enrichedChunks.map(function(c) { return c.title; }).join('\n');
      const gapRes = await Promise.race([
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 100,
            messages: [{ role: 'user', content: `A member asked: "${question}"\n\nRetrieved posts:\n${retrievedTitles}\n\nList up to 2 critical topic angles MISSING from these posts needed for a complete answer. Return ONLY a JSON array of short search phrases (3-5 words each), or [] if nothing is missing. No explanation.` }]
          })
        }),
        new Promise(function(_, reject) { setTimeout(function() { reject(new Error('gap timeout')); }, 3000); })
      ]);

      if (gapRes.ok) {
        const gapData = await gapRes.json();
        const gapPhrases = JSON.parse(gapData.content[0].text.replace(/```json|```/g, '').trim());
        if (Array.isArray(gapPhrases) && gapPhrases.length > 0) {
          const existingIds = new Set(enrichedChunks.map(function(c) { return c.id; }));
          const gapSearches = await Promise.all(gapPhrases.map(async function(phrase) {
            try {
              const emb = await getEmbedding(phrase, openaiKey);
              const r = await fetch(`${supabaseUrl}/rest/v1/rpc/match_posts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
                body: JSON.stringify({ query_embedding: emb, match_threshold: MATCH_THRESHOLD, match_count: 4 })
              });
              return r.ok ? await r.json() : [];
            } catch(e) { return []; }
          }));
          gapSearches.forEach(function(results) {
            results.forEach(function(m) {
              if (!existingIds.has(m.id) && m.url) { existingIds.add(m.id); enrichedChunks.push(m); }
            });
          });
        }
      }
    } catch(ge) { console.log('Gap detection skipped:', ge.message); }

    console.log('Starting Claude synthesis with', enrichedChunks.length, 'chunks...');

    // Build context
    const contextBlocks = enrichedChunks.map(function(chunk, i) {
      const templateFlag = chunk._isTemplateCandidate ? '\n[NOTE: This post contains templates or macros]' : '';
      return `[Source ${i+1}]\nTitle: ${chunk.title}\nSpace: ${chunk.space_name}\nAuthor: ${chunk.author}\nURL: ${chunk.url}${templateFlag}\n\n${chunk.body}`;
    }).join('\n\n---\n\n');

    const systemPrompt = `You are Ask the Archive, a tool that answers clinical, billing, and practice management questions for psychiatric prescribers using content from the Think Beyond Practice forum written by Michael Van Gelder, PMHNP-BC.

FIRST: Assess whether the retrieved sources actually address the question asked.

If the sources do NOT address the question — for any reason — return:
{ "status": "unanswered" }

If the sources DO address the question, return status "answered" with the full structured response.

Format answered responses in exactly this structure:

1. What to do — one direct, actionable sentence that answers the question immediately. No preamble, no setup, no "it depends." If there are multiple components, they go in Required elements — do NOT embed them in this sentence.

2. Required elements — when the answer involves specific components, document them as a clean line-item list. Each item on its own line. Never fold these into a paragraph.

3. Critical rule — one line only. Include ONLY when the source content contains a hard rule clinicians commonly violate or get wrong. Skip entirely if no such rule exists in the retrieved content.

4. Example — pulled directly from the language in the source posts. Include only when present in retrieved content — do not generate. Keep it to 2-3 lines maximum.

5. Common mistake — one line identifying the most frequent error. Include only when present in retrieved content.

Keep the answer section under 200 words. Prioritize the most actionable elements and leave depth to the source links.

MEDICATION ACCURACY RULE: When the answer involves specific medications, only include clinical details (dosing, monitoring frequencies, lab values, target levels, timing) that are explicitly stated in the retrieved sources AND apply to the specific medication being asked about. Never blend monitoring requirements, dosing schedules, or lab targets from one medication into an answer about a different medication. Never include situational or optional labs (such as B12, vitamin D, magnesium, or folate) in medication-specific monitoring answers unless the retrieved source explicitly lists them as required for that specific medication. When in doubt about whether a specific clinical detail applies to the medication in question, omit it rather than include it.

Do NOT open with explanation or context. The first sentence must be the answer.
Do NOT include a "Go deeper in these posts" line or any source references in the answer text. Sources are rendered separately by the UI.

CRITICAL: Your entire response must be valid JSON. Start with { and end with }. Nothing outside the JSON object.

For answered questions:
{
  "status": "answered",
  "answer": "the full answer text following the structure above",
  "source_descriptions": [
    { "index": 1, "description": "one-line max 12 words describing what this source covers" }
  ],
  "template_sources": [
    { "index": 1, "template_description": "one-line description of what template this source contains" }
  ]
}

Count your sources first. source_descriptions must have one entry per source — no exceptions. If a source is a bare comment, describe the clinical issue it addresses. Missing any description is a failure.
For template_sources: only include sources with actual usable templates, sample language, macros, or downloadable documents. Return empty array if none.
Return ONLY the JSON object. Nothing before or after it.`;

    const messages = [...conversationHistory, { role: 'user', content: `Forum sources:\n\n${contextBlocks}\n\n---\n\nQuestion: ${question}` }];

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 3500, system: systemPrompt, messages: messages })
    });

    if (!claudeRes.ok) throw new Error('Claude synthesis failed');

    console.log('Claude synthesis complete, saving result...');

    const claudeData = await claudeRes.json();
    const parsed = JSON.parse(claudeData.content[0].text.replace(/```json|```/g, '').trim());

    if (parsed.status === 'unanswered') {
      await logUnanswered(supabaseUrl, supabaseKey, question, member_requested);
      await sendUnansweredEmail(resendKey, question);
      await saveResult({ unanswered: true, answer: "The archive doesn't have content on this topic yet. It's been logged and Michael will be notified." });
      return { statusCode: 200, body: '' };
    }

    const sourceDescMap = {};
    (parsed.source_descriptions || []).forEach(function(s) { sourceDescMap[s.index] = s.description; });

    const sources = enrichedChunks.map(function(chunk, i) {
      return { title: chunk.title, space: chunk.space_name, author: chunk.author, url: chunk.url, description: sourceDescMap[i+1] || '' };
    }).filter(function(s) { return s.url; });

    const urlMap = {};
    sources.forEach(function(s) { if (!urlMap[s.url] || (!urlMap[s.url].description && s.description)) urlMap[s.url] = s; });

    const templateSourceIndexes = new Set((parsed.template_sources||[]).map(function(t) { return t.index; }));
    const templateDescMap = {};
    (parsed.template_sources||[]).forEach(function(t) { templateDescMap[t.index] = t.template_description; });

    const seenTemplates = new Set();
    const templateSources = enrichedChunks.map(function(chunk, i) {
      if (!templateSourceIndexes.has(i+1)) return null;
      return { title: chunk.title, space: chunk.space_name, author: chunk.author, url: chunk.url, template_description: templateDescMap[i+1] || '' };
    }).filter(Boolean).filter(function(s) {
      if (seenTemplates.has(s.url)) return false;
      seenTemplates.add(s.url);
      return true;
    });

    await saveResult({
      answer: parsed.answer,
      sources: Object.values(urlMap),
      template_sources: templateSources,
      unanswered: false
    });

    console.log('ask-archive-background COMPLETE for job:', job_id);
    return { statusCode: 200, body: '' };

  } catch(err) {
    console.error('ask-archive-background ERROR:', err.message);
    await saveResult({ error: err.message });
    return { statusCode: 200, body: '' };
  }
};

async function getEmbedding(text, apiKey) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text.substring(0, 8000), dimensions: 1536 })
  });
  if (!resp.ok) throw new Error('OpenAI embedding failed');
  const data = await resp.json();
  return data.data[0].embedding;
}

async function enrichCommentChunksParallel(matches, supabaseUrl, supabaseKey) {
  return Promise.all(matches.map(async function(chunk) {
    if (chunk.id && chunk.id.startsWith('comment_') && chunk.circle_post_id) {
      try {
        const parentRes = await fetch(
          `${supabaseUrl}/rest/v1/posts?id=eq.post_${chunk.circle_post_id}&select=title,body,url,space_name,author&limit=1`,
          { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
        );
        if (parentRes.ok) {
          const parentData = await parentRes.json();
          if (parentData.length > 0) {
            const parent = parentData[0];
            return { ...chunk, title: chunk.title||parent.title, url: chunk.url||parent.url, space_name: chunk.space_name||parent.space_name, author: chunk.author||parent.author, body: `[From post: ${parent.title}]\n\n${chunk.body}` };
          }
        }
      } catch(e) {}
    }
    return chunk;
  }));
}

async function logUnanswered(supabaseUrl, supabaseKey, question, memberRequested) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/unanswered_questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ question, member_requested: memberRequested, created_at: new Date().toISOString() })
    });
  } catch(e) {}
}

async function sendUnansweredEmail(resendKey, question) {
  if (!resendKey) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendKey}` },
      body: JSON.stringify({ from: 'Ask the Archive <noreply@thinkbeyondpractice.com>', to: ['michael@thinkbeyondpsych.com'], subject: 'Ask the Archive — Unanswered Question', html: `<p>A member asked a question the archive couldn't answer:</p><blockquote>${question}</blockquote>` })
    });
  } catch(e) {}
}
