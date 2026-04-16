// netlify/functions/inngest-serve.mjs
// ESM module (.mjs) — required because the inngest SDK is ESM-only.
// All other .js functions in this repo remain CommonJS and are unaffected.
// This file registers all Inngest functions with the pipeline.

import { Inngest } from 'inngest';
import { serve } from 'inngest/lambda';

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

const MATCH_THRESHOLD = 0.45;
const MATCH_COUNT = 20;

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;
const RECHUNK_MIN_LENGTH = 1500;
const RECHUNK_BATCH_SIZE = 5; // posts per step.run() batch — Inngest checkpoints between each

// ── META QUESTION DETECTION ───────────────────────────────────────────────────

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

// ── CHUNKING ──────────────────────────────────────────────────────────────────

function chunkText(text, chunkSize, overlap) {
  if (!text || text.length <= chunkSize) return [text];

  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? current + '\n\n' + para : para;

    if (candidate.length <= chunkSize) {
      current = candidate;
    } else {
      if (current) {
        chunks.push(current.trim());
        const overlapText = current.slice(-overlap);
        current = overlapText + '\n\n' + para;
      } else {
        let pos = 0;
        while (pos < para.length) {
          chunks.push(para.slice(pos, pos + chunkSize).trim());
          pos += chunkSize - overlap;
        }
        current = '';
      }
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(function(c) { return c.length > 50; });
}

// ── HYBRID RETRIEVAL ──────────────────────────────────────────────────────────

function hybridMerge(vectorResults, ftsResults, queryKeywords) {
  const scores = {};
  const records = {};

  (vectorResults || []).forEach(function(r) {
    scores[r.id] = { vector: r.similarity || 0, fts: 0 };
    records[r.id] = r;
  });

  (ftsResults || []).forEach(function(r, idx) {
    const ftsScore = Math.max(0, 1.0 - (idx * 0.05));
    if (scores[r.id]) {
      scores[r.id].fts = ftsScore;
    } else {
      scores[r.id] = { vector: 0, fts: ftsScore };
      records[r.id] = r;
    }
  });

  const keywords = (queryKeywords || []).map(function(k) { return k.toLowerCase(); });

  const results = Object.keys(scores).map(function(id) {
    const s = scores[id];
    const r = records[id];
    let titleBoost = 0;
    if (r.title && keywords.length > 0) {
      const titleLower = r.title.toLowerCase();
      const matchCount = keywords.filter(function(k) { return k.length > 3 && titleLower.includes(k); }).length;
      if (matchCount >= 2) titleBoost = 0.25;
      else if (matchCount === 1) titleBoost = 0.12;
    }
    // Space authority boost: posts from Michael's authoritative spaces score higher
    // than posts from member discussion spaces. These are the spaces where only
    // Michael posts (members can comment but not create posts).
    const AUTHORITY_SPACES = [
      'clinical references',
      'billing & documentation',
      'licensing & legal',
      'shared clinical dilemmas',
      'clinical insights',
      'critical perspectives',
      'ethics & systemic',
      'therapeutic modalities',
      'practice growth',
      'workflow systems'
    ];
    const spaceNameLower = (r.space_name || '').toLowerCase();
    const spaceBoost = AUTHORITY_SPACES.some(function(s) { return spaceNameLower.includes(s); }) ? 0.10 : 0;

    r._hybridScore = (s.vector * 0.65) + (s.fts * 0.35) + titleBoost + spaceBoost;
    return r;
  });

  results.sort(function(a, b) { return (b._hybridScore || 0) - (a._hybridScore || 0); });
  return results.slice(0, MATCH_COUNT);
}

function extractKeywords(question) {
  const stopwords = new Set(['what','how','when','why','can','is','are','do','does','the','a','an','in','on','at','to','for','of','and','or','but','with','my','i','it','this','that','if','be','been','was','were','will','would','should','could','have','has','had']);
  return question.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(function(w) { return w.length > 3 && !stopwords.has(w); });
}

function buildFtsQuery(question) {
  const keywords = extractKeywords(question);
  if (keywords.length === 0) return question.substring(0, 60);
  return keywords.slice(0, 6).join(' OR ');
}

// ── SHARED HELPERS ────────────────────────────────────────────────────────────

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

// ── RECHUNK HELPER: process one post ─────────────────────────────────────────

async function rechunkOnePost(post, supabaseUrl, supabaseKey, openaiKey) {
  const chunks = chunkText(post.body, CHUNK_SIZE, CHUNK_OVERLAP);

  if (chunks.length <= 1) {
    return { skipped: true };
  }

  const chunkRows = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkTextWithTitle = `${post.title}\n\n${chunks[i]}`;
    const embedding = await getEmbedding(chunkTextWithTitle, openaiKey);

    chunkRows.push({
      id: i === 0 ? post.id : `${post.id}_chunk_${i}`,
      circle_post_id: post.circle_post_id,
      title: post.title,
      body: chunks[i],
      author: post.author,
      space_name: post.space_name,
      space_slug: post.space_slug,
      url: post.url,
      created_at: post.created_at,
      updated_at: post.updated_at,
      embedding: embedding,
      chunk_index: i
    });

    if (i < chunks.length - 1) {
      await new Promise(function(r) { setTimeout(r, 200); });
    }
  }

  // Delete any existing extra chunk rows (safe to re-run)
  await fetch(
    `${supabaseUrl}/rest/v1/posts?circle_post_id=eq.${post.circle_post_id}&id=like.post_${post.circle_post_id}_chunk_%`,
    { method: 'DELETE', headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
  );

  // Upsert all chunk rows
  for (const row of chunkRows) {
    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(row)
    });
    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      throw new Error('Upsert failed for ' + row.id + ': ' + errText.substring(0, 200));
    }
  }

  return { chunksCreated: chunkRows.length };
}

// ── INNGEST CLIENT ────────────────────────────────────────────────────────────

const inngest = new Inngest({
  id: 'think-beyond-practice',
  signingKey: process.env.INNGEST_SIGNING_KEY,
  eventKey: process.env.INNGEST_EVENT_KEY,
});

// ── FUNCTION 1: ASK THE ARCHIVE PIPELINE ─────────────────────────────────────

const askArchivePipeline = inngest.createFunction(
  {
    id: 'ask-archive-pipeline',
    name: 'Ask the Archive Pipeline',
    retries: 2,
  },
  { event: 'ask-archive/question.submitted' },
  async function({ event }) {
    const { job_id, question, member_requested, conversation_history } = event.data;
    const conversationHistory = conversation_history || [];
    console.log('conversationHistory length:', conversationHistory.length, '| question:', question.substring(0, 50));

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const resendKey = process.env.RESEND_API_KEY;

    async function saveResult(result) {
      const saveRes = await fetch(`${supabaseUrl}/rest/v1/archive_jobs?job_id=eq.${job_id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ status: 'complete', result: JSON.stringify(result) })
      });
      if (!saveRes.ok) {
        const errText = await saveRes.text();
        console.error('saveResult FAILED:', saveRes.status, errText.substring(0, 200));
      } else {
        console.log('saveResult OK for job:', job_id);
      }
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
        const expansionRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
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

        const isFollowUp = conversationHistory.length > 0;
        const threshold = isFollowUp ? 0.50 : MATCH_THRESHOLD;
        const matchCount = isFollowUp ? 8 : MATCH_COUNT;

        async function runSearch(variants) {
          const embeddings = await Promise.all(variants.map(function(q) { return getEmbedding(q, openaiKey); }));

          const vectorSearchPromises = embeddings.map(function(emb) {
            return fetch(`${supabaseUrl}/rest/v1/rpc/match_posts`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
              body: JSON.stringify({ query_embedding: emb, match_threshold: threshold, match_count: matchCount })
            }).then(function(r) { return r.ok ? r.json() : []; });
          });

          const ftsQuery = buildFtsQuery(question);
          const ftsSearchPromise = fetch(`${supabaseUrl}/rest/v1/rpc/search_posts_fts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
            body: JSON.stringify({ search_query: ftsQuery, match_count: 20 })
          }).then(function(r) { return r.ok ? r.json() : []; }).catch(function() { return []; });

          const [vectorResultSets, ftsResults] = await Promise.all([
            Promise.all(vectorSearchPromises),
            ftsSearchPromise
          ]);

          const vectorMap = {};
          vectorResultSets.forEach(function(resultSet) {
            (resultSet || []).forEach(function(record) {
              if (!vectorMap[record.id] || record.similarity > vectorMap[record.id].similarity) {
                vectorMap[record.id] = record;
              }
            });
          });
          const vectorResults = Object.values(vectorMap);

          console.log('Vector results:', vectorResults.length, '| FTS results:', (ftsResults||[]).length);

          const keywords = extractKeywords(question);
          const merged = hybridMerge(vectorResults, ftsResults, keywords);
          return isFollowUp ? merged.slice(0, 8) : merged;
        }

        matches = await runSearch(queryVariants);
        console.log('Hybrid search matches:', matches.length);

        if (matches.length === 0) {
          console.log('Zero matches on first attempt, retrying search...');
          await new Promise(function(r) { setTimeout(r, 500); });
          matches = await runSearch(queryVariants);
          console.log('Retry search matches:', matches.length);
        }

        console.log('Starting template search...');

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

        // Serotonin post guarantee: if question involves serotonergic medications or symptoms,
        // always include both dedicated serotonin syndrome posts as sources.
        // These posts are clinically authoritative and should appear on any relevant question
        // regardless of how they score in retrieval.
        const SEROTONIN_TRIGGERS = ['serotonin', 'ssri', 'snri', 'sertraline', 'fluoxetine', 'escitalopram', 'venlafaxine', 'duloxetine', 'paroxetine', 'citalopram', 'fluvoxamine', 'sympathetic overdrive', 'adrenergic', 'hunter criteria', 'clonus'];
        const questionLower = question.toLowerCase();
        const isSerotonin = SEROTONIN_TRIGGERS.some(function(t) { return questionLower.includes(t); });
        if (isSerotonin) {
          const existingIds = new Set(matches.map(function(m) { return m.id; }));
          const SEROTONIN_POST_IDS = ['post_26508281', 'post_26722424'];
          for (const postId of SEROTONIN_POST_IDS) {
            if (!existingIds.has(postId)) {
              try {
                const postRes = await fetch(
                  `${supabaseUrl}/rest/v1/posts?id=eq.${postId}&select=id,circle_post_id,title,body,author,space_name,url&limit=1`,
                  { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
                );
                if (postRes.ok) {
                  const postData = await postRes.json();
                  if (postData.length > 0) {
                    postData[0]._guaranteed = true;
                    matches.push(postData[0]);
                    console.log('Guaranteed serotonin post added:', postId);
                  }
                }
              } catch(e) { console.log('Failed to fetch guaranteed post:', postId, e.message); }
            }
          }
        }
      }

      if (isMetaQuestion(question)) {
        const EXCLUDED = ['start here','forum updates','forum updates & announcements','welcome','announcements'];
        const filtered = (matches||[]).filter(function(m) {
          return !EXCLUDED.some(function(ex) { return (m.space_name||'').toLowerCase().includes(ex); });
        });
        const result = { browse: true, topic: question, posts: filtered.slice(0,10).map(function(m) {
          return { title: m.title, space: m.space_name, author: m.author, url: m.url, description: '' };
        }), total: filtered.length };
        await saveResult(result);
        return;
      }

      if (!matches || matches.length === 0) {
        await logUnanswered(supabaseUrl, supabaseKey, question, member_requested);
        await sendUnansweredEmail(resendKey, question);
        await saveResult({ unanswered: true, answer: "The archive doesn't have content on this topic yet. It's been logged and Michael will be notified." });
        return;
      }

      console.log('Starting enrichment for', matches.length, 'matches...');
      const enrichedChunks = await enrichCommentChunksParallel(matches, supabaseUrl, supabaseKey);
      console.log('Enrichment complete:', enrichedChunks.length, 'chunks');

      console.log('Starting Claude synthesis with', enrichedChunks.length, 'chunks...');

      const contextBlocks = enrichedChunks.map(function(chunk, i) {
        const templateFlag = chunk._isTemplateCandidate ? '\n[NOTE: This post contains templates or macros]' : '';
        return `[Source ${i+1}]\nTitle: ${chunk.title}\nSpace: ${chunk.space_name}\nAuthor: ${chunk.author}\nURL: ${chunk.url}${templateFlag}\n\n${chunk.body}`;
      }).join('\n\n---\n\n');

      const systemPrompt = `You are Ask the Archive, a tool that answers clinical, billing, and practice management questions for psychiatric prescribers using content from the Think Beyond Practice forum written by Michael Van Gelder, PMHNP-BC.

FIRST: Assess whether the retrieved sources contain ANY relevant information about the question asked.

Only return { "status": "unanswered" } if the sources contain ZERO information relevant to the question — meaning the topic is completely absent from the archive. If the sources contain partial, adjacent, or related information, answer using what is available.

Do NOT return unanswered just because the sources don't perfectly answer the question. Use what is there and answer as specifically as the sources allow.

If the sources DO address the question (even partially), return status "answered" with the full structured response.

Format answered responses in exactly this structure:

1. What to do — one direct, actionable sentence that answers the question immediately. No preamble, no setup, no "it depends." If there are multiple components, they go in Required elements — do NOT embed them in this sentence.

2. Required elements — when the answer involves specific components, document them as a clean line-item list. Each item on its own line. Never fold these into a paragraph.

3. Critical rule — one line only. Include ONLY when the source content contains a hard rule clinicians commonly violate or get wrong. Skip entirely if no such rule exists in the retrieved content.

4. Example — pulled directly from the language in the source posts. Include only when present in retrieved content — do not generate. Keep it to 2-3 lines maximum.

5. Common mistake — one line identifying the most frequent error. Include only when present in retrieved content.

Keep the answer section under 200 words. Prioritize the most actionable elements and leave depth to the source links.

MEDICATION ACCURACY RULE: When the answer involves specific medications, only include clinical details (dosing, monitoring frequencies, lab values, target levels, timing) that are explicitly stated in the retrieved sources AND apply to the specific medication being asked about. Never blend monitoring requirements, dosing schedules, or lab targets from one medication into an answer about a different medication. Never include situational or optional labs (such as B12, vitamin D, magnesium, or folate) in medication-specific monitoring answers unless the retrieved source explicitly lists them as required for that specific medication. When in doubt about whether a specific clinical detail applies to the medication in question, omit it rather than include it.

MEDICATION MANAGEMENT RULE: When the answer identifies sympathetic overdrive or adrenergic spillover as the likely cause, management is: hold the most recently added agent temporarily, check vitals, consider dose reduction if stable. This is NOT a stop-everything emergency. Only true serotonin syndrome with confirmed clonus warrants stopping serotonergic medications. Do not recommend stopping medications for adrenergic symptoms alone.

FORMATTING RULE: Never use em dashes in the answer text. Use a comma, period, or colon instead.

Do NOT open with explanation or context. The first sentence must be the answer.
Do NOT include a "Go deeper in these posts" line or any source references in the answer text. Sources are rendered separately by the UI.

CRITICAL: Your entire response must be valid JSON. Start with { and end with }. Nothing outside the JSON object.

For answered questions:
{
  "status": "answered",
  "answer": "the full answer text following the structure above",
  "template_sources": [
    { "index": 1, "template_description": "one-line description of what template this source contains" }
  ]
}

For template_sources: only include sources with actual usable templates, sample language, macros, or downloadable documents. Return empty array if none.
Return ONLY the JSON object. Nothing before or after it.`;

      const followUpInstruction = conversationHistory.length > 0
        ? '\n\nFOLLOW-UP MODE: This is a follow-up question in an ongoing conversation. The member already has context from the previous answer. Do NOT repeat Required elements, structure, or framing already covered. Give a direct, focused answer to what is being asked now. Skip Required elements entirely unless the follow-up introduces a genuinely new topic. Critical rule and Common mistake only if they add new information not in prior turns. Keep the answer under 120 words.'
        : '';

      const messages = [...conversationHistory, { role: 'user', content: `Forum sources:\n\n${contextBlocks}\n\n---\n\nQuestion: ${question}` }];

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4000, system: systemPrompt + followUpInstruction, messages: messages })
      });

      if (!claudeRes.ok) throw new Error('Claude synthesis failed');

      console.log('Claude synthesis complete, saving result...');

      const claudeData = await claudeRes.json();
      const parsed = JSON.parse(claudeData.content[0].text.replace(/```json|```/g, '').trim());

      if (parsed.status === 'unanswered') {
        await logUnanswered(supabaseUrl, supabaseKey, question, member_requested);
        await sendUnansweredEmail(resendKey, question);
        await saveResult({ unanswered: true, answer: "The archive doesn't have content on this topic yet. It's been logged and Michael will be notified." });
        return;
      }

      console.log('Synthesis token usage:', claudeData.usage ? JSON.stringify(claudeData.usage) : 'unknown');

      let sourceDescMap = {};
      try {
        const sourceList = enrichedChunks.map(function(chunk, i) {
          return (i+1) + '. ' + chunk.title;
        }).join('\n');

        const descRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 800,
            messages: [{ role: 'user', content: 'For each of the following forum post titles, write a description of max 8 words describing what clinical or billing issue it covers. Return ONLY a JSON array of objects with "index" and "description" fields. No preamble.\n\n' + sourceList }]
          })
        });

        if (descRes.ok) {
          const descData = await descRes.json();
          const descParsed = JSON.parse(descData.content[0].text.replace(/```json|```/g, '').trim());
          if (Array.isArray(descParsed)) {
            descParsed.forEach(function(s) { sourceDescMap[s.index] = s.description; });
          }
          console.log('Descriptions returned:', descParsed.length, '| Desc token usage:', descData.usage ? JSON.stringify(descData.usage) : 'unknown');
        }
      } catch(e) { console.log('Source description call error:', e.message); }

      const sources = enrichedChunks.map(function(chunk, i) {
        return { title: chunk.title, space: chunk.space_name, author: chunk.author, url: chunk.url, description: sourceDescMap[i+1] || '' };
      }).filter(function(s) { return s.url; });

      const urlMap = {};
      sources.forEach(function(s) {
        if (!urlMap[s.url]) {
          urlMap[s.url] = s;
        } else {
          const existing = urlMap[s.url];
          const existingIsComment = (existing.title || '').startsWith('Comment on:');
          const newIsComment = (s.title || '').startsWith('Comment on:');
          // Prefer post titles over comment titles for the same URL
          if (existingIsComment && !newIsComment) {
            urlMap[s.url] = s;
          } else if (!existingIsComment && !newIsComment && !existing.description && s.description) {
            urlMap[s.url] = s;
          }
        }
      });

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

      console.log('inngest-serve COMPLETE for job:', job_id);
      return;

    } catch(err) {
      console.error('inngest-serve ERROR:', err.message);
      await saveResult({ error: err.message });
      throw err;
    }
  }
);

// ── FUNCTION 2: RECHUNK ALL POSTS ─────────────────────────────────────────────
// Uses step.run() to process posts in batches of RECHUNK_BATCH_SIZE.
// Inngest checkpoints after every batch so the inactivity timeout resets.
// This allows the job to run indefinitely regardless of archive size or plan.
//
// Trigger: send Inngest event 'archive/rechunk.posts' with { secret: '...' }
// Progress: visible in Inngest run trace as individual steps per batch
// Safe to re-run: existing extra chunk rows are deleted before re-inserting

const rechunkAllPosts = inngest.createFunction(
  {
    id: 'archive-rechunk-posts',
    name: 'Archive: Rechunk All Posts',
    retries: 0,
  },
  { event: 'archive/rechunk.posts' },
  async function({ event, step }) {
    if (event.data.secret !== process.env.BACKFILL_SECRET) {
      throw new Error('Unauthorized');
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    // Step 1: fetch all long posts — one fast network call, Inngest checkpoints here
    const longPosts = await step.run('fetch-posts', async function() {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/posts?id=like.post_*&chunk_index=eq.0&select=id,circle_post_id,title,body,author,space_name,space_slug,url,created_at,updated_at&limit=1000`,
        { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
      );
      if (!res.ok) throw new Error('Failed to fetch posts: ' + res.status);
      const all = await res.json();
      const long = all.filter(function(p) { return p.body && p.body.length >= RECHUNK_MIN_LENGTH; });
      console.log('Total posts fetched:', all.length, '| Long posts to rechunk:', long.length);
      return long;
    });

    // Divide into batches
    const batches = [];
    for (let i = 0; i < longPosts.length; i += RECHUNK_BATCH_SIZE) {
      batches.push(longPosts.slice(i, i + RECHUNK_BATCH_SIZE));
    }

    console.log('Total batches:', batches.length);

    // Steps 2+: one step per batch — timeout resets between each
    const allStats = [];
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const batchStats = await step.run('rechunk-batch-' + batchIdx, async function() {
        const stats = { chunked: 0, skipped: 0, totalChunks: 0, errors: [] };
        for (const post of batch) {
          try {
            const result = await rechunkOnePost(post, supabaseUrl, supabaseKey, openaiKey);
            if (result.skipped) {
              stats.skipped++;
            } else {
              stats.chunked++;
              stats.totalChunks += result.chunksCreated;
            }
            console.log(`Batch ${batchIdx} | ${post.id} | ${result.skipped ? 'skipped' : result.chunksCreated + ' chunks'}`);
          } catch(err) {
            console.error('Error on post', post.id, ':', err.message);
            stats.errors.push({ id: post.id, error: err.message });
          }
          await new Promise(function(r) { setTimeout(r, 300); });
        }
        return stats;
      });
      allStats.push(batchStats);
    }

    // Aggregate
    const final = allStats.reduce(function(acc, s) {
      acc.chunked += s.chunked;
      acc.skipped += s.skipped;
      acc.totalChunks += s.totalChunks;
      acc.errors = acc.errors.concat(s.errors);
      return acc;
    }, { chunked: 0, skipped: 0, totalChunks: 0, errors: [] });

    console.log('RECHUNK COMPLETE:', JSON.stringify(final));
    return final;
  }
);

// ── SERVE ─────────────────────────────────────────────────────────────────────

export const handler = serve({
  client: inngest,
  functions: [askArchivePipeline, rechunkAllPosts],
  serveHost: 'https://thinkbeyondpractice.com',
  servePath: '/.netlify/functions/inngest-serve',
});
