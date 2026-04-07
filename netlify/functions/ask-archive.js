// netlify/functions/ask-archive.js
// RAG query function for Ask the Archive
// 1. Embeds member question via OpenAI
// 2. Runs vector similarity search against Supabase posts table
// 3. Enriches comment chunks with parent post context
// 4. Sends full context + question to Claude for synthesis
// 5. Returns { answer, sources } or { unanswered: true } if no match found
// 6. Logs unanswered questions to Supabase and emails michael@thinkbeyondpsych.com

const MATCH_THRESHOLD = 0.45;
const BROWSE_THRESHOLD = 0.38;
const MATCH_COUNT = 14;

// Patterns that indicate a browse/meta question rather than a clinical question
const META_PATTERNS = [
  /^are there (any )?posts? on /i,
  /^do you have (anything|any posts?) (on|about) /i,
  /^what (do you have|posts?) (on|about) /i,
  /^is there anything (on|about) /i,
  /^what topics? (cover|cover|address|discuss) /i,
  /^show me (posts?|anything) (on|about) /i,
  /^find (posts?|anything) (on|about) /i,
  /^(search|look) for (posts?|anything) (on|about) /i,
  /^any posts? (on|about) /i,
  /^(what|anything) (in the archive|available) (on|about) /i
];

function isMetaQuestion(question) {
  return META_PATTERNS.some(function(p) { return p.test(question); });
}

exports.handler = async function(event, context) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const question = (body.question || '').trim();
  const memberRequested = body.member_requested === true;
  const requestTemplate = body.request_template === true;
  const conversationHistory = body.conversation_history || [];

  if (!question) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Question required' }) };

  // ── Template request path ────────────────────────────────────────────────
  if (requestTemplate) {
    await logTemplateRequest(supabaseUrl, supabaseKey, question);
    await sendTemplateRequestEmail(resendKey, question);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, message: 'Template request submitted.' })
    };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!supabaseUrl || !supabaseKey || !openaiKey || !anthropicKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  try {
    // ── Step 1: Embed the question ──────────────────────────────────────────
    const embedding = await getEmbedding(question, openaiKey);

    // ── Step 2: Vector similarity search ───────────────────────────────────
    const matchRes = await fetch(`${supabaseUrl}/rest/v1/rpc/match_posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      body: JSON.stringify({
        query_embedding: embedding,
        match_threshold: isMetaQuestion(question) ? BROWSE_THRESHOLD : MATCH_THRESHOLD,
        match_count: MATCH_COUNT
      })
    });

    if (!matchRes.ok) {
      const err = await matchRes.text();
      console.log('match_posts error:', err.substring(0, 200));
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Search failed' }) };
    }

    const matches = await matchRes.json();
    console.log('Matches found:', matches.length);

    // ── Step 3: Handle meta/browse questions ────────────────────────────────
    if (isMetaQuestion(question)) {
      if (!matches || matches.length === 0) {
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({
            browse: true,
            topic: question,
            posts: [],
            related_topics: []
          })
        };
      }

      // Sort: full posts first, comments second
      const sortedMatches = matches.slice().sort(function(a, b) {
        var aIsComment = (a.id || '').startsWith('comment_') ? 1 : 0;
        var bIsComment = (b.id || '').startsWith('comment_') ? 1 : 0;
        return aIsComment - bIsComment;
      });

      // Ask Claude to identify related topics and generate post descriptions
      const browseContext = sortedMatches.map(function(m, i) {
        return `[${i+1}] Title: ${m.title}\nSpace: ${m.space_name}\nContent: ${(m.body || '').substring(0, 300)}`;
      }).join('\n\n');

      const browseRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: `Given these forum posts related to "${question}":\n\n${browseContext}\n\nReturn JSON with two fields:\n1. "post_descriptions": array of objects with { "index": number, "description": "one sentence, max 15 words, what this post covers" }\n2. "related_topics": array of 3-5 short topic strings (2-5 words each) that are adjacent or related and would make good follow-up searches.\n\nOnly include topics clearly supported by the content above. Return only valid JSON, no preamble.`
          }]
        })
      });

      let relatedTopics = [];
      let postDescMap = {};
      if (browseRes.ok) {
        try {
          const browseData = await browseRes.json();
          const browseText = browseData.content[0].text.replace(/```json|```/g, '').trim();
          const browseParsed = JSON.parse(browseText);
          relatedTopics = browseParsed.related_topics || [];
          (browseParsed.post_descriptions || []).forEach(function(d) {
            const match = sortedMatches[d.index - 1];
            if (match && match.url) {
              postDescMap[match.url] = d.description;
            }
          });
        } catch(e) {
          console.log('Browse parse error:', e.message);
        }
      }

      // Dedupe posts by URL, full posts first (already sorted)
      const seenBrowse = new Set();
      const browsePosts = sortedMatches
        .filter(function(m) { return m.url; })
        .filter(function(m) {
          if (seenBrowse.has(m.url)) return false;
          seenBrowse.add(m.url);
          return true;
        })
        .map(function(m) {
          return {
            title: m.title,
            space: m.space_name,
            author: m.author,
            url: m.url,
            description: postDescMap[m.url] || ''
          };
        });

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          browse: true,
          topic: question,
          posts: browsePosts,
          related_topics: relatedTopics
        })
      };
    }

    // ── Step 4: Handle unanswered ───────────────────────────────────────────
    if (!matches || matches.length === 0) {
      await logUnanswered(supabaseUrl, supabaseKey, question, memberRequested);
      await sendUnansweredEmail(resendKey, question);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          unanswered: true,
          answer: "The archive doesn't have a strong match for this question yet. It's been logged and Michael will be notified."
        })
      };
    }

    // ── Step 4: Enrich comment chunks with parent post context ──────────────
    const enrichedChunks = await enrichCommentChunks(matches, supabaseUrl, supabaseKey);

    // ── Step 5: Build context for Claude ────────────────────────────────────
    const contextBlocks = enrichedChunks.map(function(chunk, i) {
      return `[Source ${i + 1}]\nTitle: ${chunk.title}\nSpace: ${chunk.space_name}\nAuthor: ${chunk.author}\nURL: ${chunk.url}\n\n${chunk.body}`;
    }).join('\n\n---\n\n');

    // ── Step 6: Build messages for Claude ───────────────────────────────────
    const systemPrompt = `You are Ask the Archive, a tool that answers clinical, billing, and practice management questions for psychiatric prescribers using content from the Think Beyond Practice forum written by Michael Van Gelder, PMHNP-BC.

Your answers must be grounded exclusively in the source content provided. Do not add general medical knowledge, generic advice, or anything not present in the sources.

Format every answer in exactly this structure:

1. What to do — one direct, actionable sentence that answers the question immediately. No preamble, no setup, no "it depends." If there are multiple components, they go in Required elements — do NOT embed them in this sentence.

2. Required elements — when the answer involves specific components, document them as a clean line-item list. Each item on its own line. Never fold these into a paragraph.

3. Critical rule — one line only. Include ONLY when the source content contains a hard rule clinicians commonly violate or get wrong (e.g. "Do not write 'patient is cleared for surgery'" or "You cannot use time as the basis for E/M when billing add-on psychotherapy codes"). Skip this section entirely if no such rule exists in the retrieved content.

4. Example — pulled directly from the language in the source posts. Include only when present in retrieved content — do not generate. Keep it short and copyable.

5. Common mistake — one line identifying the most frequent error. Include only when present in retrieved content.

Keep the total answer under 200 words. If the content requires more, prioritize the most actionable elements and leave depth to the source links.

Do NOT open with explanation or context. The first sentence must be the answer.
Do NOT include a "Go deeper in these posts" line or any source references in the answer text. Sources are rendered separately by the UI.

Return your response as JSON with exactly these fields:
{
  "answer": "the full answer text following the structure above",
  "source_descriptions": [
    { "index": 1, "description": "one-line description of why this post is relevant" }
  ],
  "template_sources": [
    { "index": 1, "template_description": "one-line description of what template or sample language this post contains" }
  ]
}

For template_sources: only include sources that contain an actual usable template, sample note language, macro, phrasing bank, or downloadable document. Do not include sources that merely explain or discuss a concept. If no sources contain templates, return an empty array for template_sources.

Return only valid JSON. No preamble, no markdown fences.`;

    const userMessage = `Forum sources:\n\n${contextBlocks}\n\n---\n\nQuestion: ${question}`;

    // Build messages array including conversation history for follow-up support
    const messages = [];
    conversationHistory.forEach(function(turn) {
      messages.push(turn);
    });
    messages.push({ role: 'user', content: userMessage });

    // ── Step 7: Claude synthesis ─────────────────────────────────────────────
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: systemPrompt,
        messages: messages
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.log('Claude error:', err.substring(0, 200));
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Synthesis failed' }) };
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content[0].text;

    let parsed;
    try {
      const clean = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch(e) {
      console.log('JSON parse error:', e.message, 'Raw:', rawText.substring(0, 300));
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Response parse failed' }) };
    }

    // ── Step 8: Build source list with descriptions ──────────────────────────
    const sourceDescMap = {};
    (parsed.source_descriptions || []).forEach(function(s) {
      sourceDescMap[s.index] = s.description;
    });

    const sources = enrichedChunks.map(function(chunk, i) {
      return {
        title: chunk.title,
        space: chunk.space_name,
        author: chunk.author,
        url: chunk.url,
        description: sourceDescMap[i + 1] || ''
      };
    }).filter(function(s) { return s.url; });

    // Dedupe by URL
    const seen = new Set();
    const dedupedSources = sources.filter(function(s) {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    // ── Step 9: Build template sources list ──────────────────────────────────
    const templateSourceIndexes = new Set(
      (parsed.template_sources || []).map(function(t) { return t.index; })
    );
    const templateDescMap = {};
    (parsed.template_sources || []).forEach(function(t) {
      templateDescMap[t.index] = t.template_description;
    });

    const templateSourcesRaw = enrichedChunks
      .map(function(chunk, i) {
        if (!templateSourceIndexes.has(i + 1)) return null;
        return {
          title: chunk.title,
          space: chunk.space_name,
          author: chunk.author,
          url: chunk.url,
          template_description: templateDescMap[i + 1] || ''
        };
      })
      .filter(Boolean)
      .filter(function(s) { return s.url; });

    // Dedupe template sources by URL
    const seenTemplates = new Set();
    const templateSources = templateSourcesRaw.filter(function(s) {
      if (seenTemplates.has(s.url)) return false;
      seenTemplates.add(s.url);
      return true;
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        answer: parsed.answer,
        sources: dedupedSources,
        template_sources: templateSources,
        unanswered: false
      })
    };

  } catch(err) {
    console.log('ask-archive fatal error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error: ' + err.message }) };
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getEmbedding(text, apiKey) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.substring(0, 8000),
      dimensions: 1536
    })
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('OpenAI embedding failed: ' + err.substring(0, 200));
  }
  const data = await resp.json();
  return data.data[0].embedding;
}

async function enrichCommentChunks(matches, supabaseUrl, supabaseKey) {
  const enriched = [];
  for (const chunk of matches) {
    // If this is a comment chunk, fetch the parent post for context
    if (chunk.id && chunk.id.startsWith('comment_') && chunk.circle_post_id) {
      try {
        const parentRes = await fetch(
          `${supabaseUrl}/rest/v1/posts?id=eq.post_${chunk.circle_post_id}&select=title,body,url,space_name,author&limit=1`,
          {
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`
            }
          }
        );
        if (parentRes.ok) {
          const parentData = await parentRes.json();
          if (parentData.length > 0) {
            const parent = parentData[0];
            enriched.push({
              ...chunk,
              title: chunk.title || parent.title,
              url: chunk.url || parent.url,
              space_name: chunk.space_name || parent.space_name,
              author: chunk.author || parent.author,
              body: `[From post: ${parent.title}]\n\n${chunk.body}`
            });
            continue;
          }
        }
      } catch(e) {
        console.log('Parent fetch error for', chunk.id, e.message);
      }
    }
    enriched.push(chunk);
  }
  return enriched;
}

async function logUnanswered(supabaseUrl, supabaseKey, question, memberRequested) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/unanswered_questions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        question: question,
        member_requested: memberRequested,
        created_at: new Date().toISOString()
      })
    });
  } catch(e) {
    console.log('logUnanswered error:', e.message);
  }
}

async function sendUnansweredEmail(resendKey, question) {
  if (!resendKey) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: 'Ask the Archive <noreply@thinkbeyondpractice.com>',
        to: ['michael@thinkbeyondpsych.com'],
        subject: 'Ask the Archive — Unanswered Question',
        html: `<p>A member asked a question the archive couldn't answer:</p><blockquote>${question}</blockquote><p>To review all unanswered questions, run:<br><code>select question, member_requested, created_at from unanswered_questions order by created_at desc;</code></p>`
      })
    });
  } catch(e) {
    console.log('sendUnansweredEmail error:', e.message);
  }
}

async function logTemplateRequest(supabaseUrl, supabaseKey, question) {
  if (!supabaseUrl || !supabaseKey) return;
  try {
    await fetch(`${supabaseUrl}/rest/v1/unanswered_questions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        question: `[TEMPLATE REQUEST] ${question}`,
        member_requested: true,
        created_at: new Date().toISOString()
      })
    });
  } catch(e) {
    console.log('logTemplateRequest error:', e.message);
  }
}

async function sendTemplateRequestEmail(resendKey, question) {
  if (!resendKey) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: 'Ask the Archive <noreply@thinkbeyondpractice.com>',
        to: ['michael@thinkbeyondpsych.com'],
        subject: 'Ask the Archive — Template Request',
        html: `<p>A member requested a template for:</p><blockquote>${question}</blockquote><p>Consider creating a post with a template for this topic.</p>`
      })
    });
  } catch(e) {
    console.log('sendTemplateRequestEmail error:', e.message);
  }
}
