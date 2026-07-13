// netlify/functions/inngest-serve.mjs
// ESM module (.mjs) — required because the inngest SDK is ESM-only.
// All other .js functions in this repo remain CommonJS and are unaffected.
// This file registers all Inngest functions with the pipeline.

import { Inngest } from 'inngest';
import { serve } from 'inngest/lambda';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

// ── USAGE LOGGING (inline mirror of _lib/usage.js; .mjs can't require _lib) ─────
// Records one tool_usage row per AI call: tool label, model, token COUNTS, cost,
// and (when the trigger forwarded it) the member's email/tier. Counts only — no
// question text or content is written. Keep MODEL_COST in sync with _lib/usage.js.
const USAGE_MODEL_COST_PER_MTOK = {
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
  'claude-sonnet-4-6':         { in: 3.0, out: 15.0 },
  'claude-sonnet-4-5':         { in: 3.0, out: 15.0 },
  'text-embedding-3-small':    { in: 0.02, out: 0.0 }
};
function usageEstCost(model, inTok, outTok) {
  const price = USAGE_MODEL_COST_PER_MTOK[model];
  if (!price) return null;
  return Math.round((((Number(inTok) || 0) * price.in + (Number(outTok) || 0) * price.out) / 1e6) * 1e6) / 1e6;
}
async function logUsage(row) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) return;
    const email = row.email ? String(row.email).toLowerCase().trim() : null;
    const model = row.model || null;
    const inputTokens = (row.inputTokens != null) ? Number(row.inputTokens) : null;
    const outputTokens = (row.outputTokens != null) ? Number(row.outputTokens) : null;
    await fetch(`${SUPABASE_URL}/rest/v1/tool_usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        tool: row.tool || 'Unknown',
        mode: row.mode || null,
        event: row.event || 'interaction',
        created_at: new Date().toISOString(),
        account_email: email,
        tier: row.tier || null,
        model: model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        est_cost_usd: model ? usageEstCost(model, inputTokens, outputTokens) : null
      })
    });
  } catch (e) {
    console.log('tool_usage log error:', e && e.message);
  }
}

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

    // Author boost: posts written by Michael Van Gelder carry the highest authority.
    // Exact match against the stored author string confirmed in Supabase.
    // Prevents member comments from outranking admin posts on the same topic.
    const isMichaelPost = (r.author || '') === 'Michael Van Gelder';
    const authorBoost = isMichaelPost ? 0.15 : 0;

    // Post-type boost: top-level posts are more authoritative than comments.
    // Comments are member replies that may contain incomplete or incorrect information.
    const idStr = (r.id || '').toString();
    const isComment = idStr.startsWith('comment_') || (r.title || '').startsWith('Comment on:');
    const postTypeBoost = isComment ? -0.08 : 0.05;

    r._hybridScore = (s.vector * 0.65) + (s.fts * 0.35) + titleBoost + spaceBoost + authorBoost + postTypeBoost;
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

// Internal notification email via Amazon SES (under the AWS BAA).
// Replaces the previous Resend integration so all outbound mail runs through SES.
// NOTE: env var names below should match those used by your other SES functions.
async function sendUnansweredEmail(question) {
  const region = process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1';
  const accessKeyId = process.env.SES_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const fromAddress = process.env.SES_FROM || 'Ask the Archive <noreply@thinkbeyondpractice.com>';
  const toAddress = process.env.NOTIFY_TO || 'michael@thinkbeyondpractice.com';

  const config = { region };
  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey };
  }

  try {
    const client = new SESv2Client(config);
    await client.send(new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: { ToAddresses: [toAddress] },
      Content: {
        Simple: {
          Subject: { Data: 'Ask the Archive — Unanswered Question', Charset: 'UTF-8' },
          Body: { Html: { Data: `<p>A member asked a question the archive couldn't answer:</p><blockquote>${question}</blockquote>`, Charset: 'UTF-8' } }
        }
      }
    }));
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
  isDev: false,
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
    const { job_id, question, member_requested, conversation_history, account_email, tier } = event.data;
    const conversationHistory = conversation_history || [];
    // Identity is best-effort: Ask the Archive is a mostly-public tool, so these
    // are null unless the trigger forwarded a verified token's claims.
    const usageEmail = account_email || null;
    const usageTier = tier || null;
    console.log('conversationHistory length:', conversationHistory.length, '| question:', question.substring(0, 50));

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

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
            if (expansionData.usage) {
              logUsage({ tool: 'Ask the Archive', mode: 'query_expansion', event: 'subcall', email: usageEmail, tier: usageTier, model: 'claude-haiku-4-5-20251001', inputTokens: expansionData.usage.input_tokens, outputTokens: expansionData.usage.output_tokens });
            }
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
        await sendUnansweredEmail(question);
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

YOUR ORDER OF OPERATIONS FOR EVERY QUESTION:

STEP 1 — READ THE QUESTION FOR CLINICAL FINDINGS.
Before looking at the sources, extract what the question itself tells you: symptoms present, exam findings mentioned, medications involved, timing, and any discriminating features. The question is the patient presentation. Treat it like a clinical encounter.

STEP 2 — REACH A CLINICAL CONCLUSION FROM THE FINDINGS.
Use the findings from Step 1 to form a working diagnosis or clinical impression before letting the sources influence you. The sources support your conclusion — they do not determine it.

Examples of how findings drive conclusions:
- Autonomic symptoms only (racing heart, sweating, tremor, restlessness) on serotonergic medications: working conclusion is sympathetic overdrive or adrenergic spillover. Not serotonin syndrome. Management: hold the most recently added agent temporarily, check vitals, consider dose reduction if stable.
- Autonomic symptoms PLUS neuromuscular findings (involuntary leg jerking, rhythmic muscle contractions, clonus, hyperreflexia): working conclusion is possible serotonin syndrome. Assess with Hunter Criteria. Consider stopping the most recently added serotonergic agent and urgent evaluation.
- Denial code CO-45: working conclusion is contracted rate adjustment, not a clinical denial.
- Denial code CO-4: working conclusion is coding error, not an authorization issue.
- MDM with stable chronic conditions only: working conclusion is low to moderate complexity.

STEP 3 — PULL FROM SOURCES TO SUPPORT YOUR CONCLUSION.
Use the retrieved forum content to explain mechanism, support management, provide documentation language, and add clinical depth. Sources are evidence for your conclusion, not the source of it.

STEP 4 — STRUCTURE THE ANSWER AROUND YOUR CONCLUSION.
Frame the answer around what you concluded in Step 2. If the question has neuromuscular findings, lead with possible serotonin syndrome even if the sources emphasize sympathetic overdrive content. The question drives the framing. The sources provide the depth.

UNANSWERED QUESTIONS:
Only return { "status": "unanswered" } if sources contain ZERO relevant information. Use partial or adjacent content when available. Do not return unanswered just because sources do not perfectly match.

ANSWER FORMAT:

1. What the forum consistently shows — one direct sentence describing what the archive content shows about this presentation or question. Frame this as what clinicians in the forum have found, considered, or concluded — not as a directive to the reader. Do not say "you should" or "stop the medication." Say "the forum consistently shows" or "this presentation warrants assessment for" or "clinicians in the forum commonly consider."

2. Relevant considerations — the clinical factors, options, and reasoning that bear on this question, as a clean line-item list. When multiple approaches exist, present them with reasoning. Do not prescribe a single course of action unless the forum is unambiguous about a safety-critical standard of care (for example: confirmed serotonin syndrome with clonus warrants urgent medical evaluation — that is not a preference, it is standard of care). For everything else, present what clinicians consider and why, and let the reader decide.

3. Critical rule — one line only. A hard rule clinicians commonly get wrong, from source content. Skip if none exists.

4. Example — pulled from source post language only. Do not generate. 2-3 lines maximum.

5. Common mistake — one line from retrieved content only.

Keep the answer under 220 words.

VOICE RULE: The archive informs clinical reasoning. It does not direct clinical action. Replace directive language ("stop the medication," "send to the ED," "hold Vyvanse") with observational language ("the forum consistently shows," "this presentation warrants assessment for," "confirmed findings would suggest," "clinicians commonly consider"). The clinician makes the call. The archive informs it. Exception: safety-critical standards of care where there is no reasonable clinical alternative may be stated directly.

MEDICATION ACCURACY RULE: Only include clinical details explicitly stated in the retrieved sources for the specific medication being asked about. Never blend monitoring requirements from one medication into an answer about a different medication. When in doubt, omit.

SOURCE AUTHORITY RULE: Sources authored by Michael Van Gelder carry the highest authority. When sources conflict, prefer Michael Van Gelder's posts and dedicated topic posts over member comments. A member comment that contradicts a dedicated post by Michael Van Gelder should not drive the answer. Member comments may add nuance but should not override admin-authored content on the same topic.

FORMATTING RULE: Never use em dashes in the answer text. Use a comma, period, or colon instead.

Do NOT open with explanation or context. The first sentence must be the answer.
Do NOT include source references in the answer text. Sources are rendered separately by the UI.

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
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, system: systemPrompt + followUpInstruction, messages: messages })
      });

      if (!claudeRes.ok) throw new Error('Claude synthesis failed');

      console.log('Claude synthesis complete, saving result...');

      const claudeData = await claudeRes.json();
      // Synthesis is the actual answer — count it as the interaction. Token counts only.
      if (claudeData.usage) {
        logUsage({ tool: 'Ask the Archive', mode: 'synthesis', event: 'interaction', email: usageEmail, tier: usageTier, model: 'claude-sonnet-4-6', inputTokens: claudeData.usage.input_tokens, outputTokens: claudeData.usage.output_tokens });
      }
      const parsed = JSON.parse(claudeData.content[0].text.replace(/```json|```/g, '').trim());

      if (parsed.status === 'unanswered') {
        await logUnanswered(supabaseUrl, supabaseKey, question, member_requested);
        await sendUnansweredEmail(question);
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
          if (descData.usage) {
            logUsage({ tool: 'Ask the Archive', mode: 'source_descriptions', event: 'subcall', email: usageEmail, tier: usageTier, model: 'claude-haiku-4-5-20251001', inputTokens: descData.usage.input_tokens, outputTokens: descData.usage.output_tokens });
          }
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


// =====================================================================
// CHART CODER PIPELINE (background)
// Runs the heavy three-pass analysis (audit + MDM + review) server-side
// with no synchronous timeout, so MDM runs on Sonnet. The fast preflight
// stays client-side. Writes result to the shared tool_jobs table.
// =====================================================================

const CC_AUDIT_PROMPT = `You are a psychiatric chart documentation auditor. Your job is to find internal inconsistencies, contradictions, and documentation gaps in a completed psychiatric note BEFORE it is coded. You are NOT coding the note. You are checking whether the note is internally consistent and audit-ready.

Read the entire note carefully. Compare every section against every other section. Flag any of the following:

INCONSISTENCIES (statements in one section that contradict another):
- HPI symptom reports that contradict ROS (e.g. patient reports insomnia in HPI but ROS says sleep disturbance negative)
- Medication doses or names in HPI that don't match the Medications list
- Assessment discusses a medication change but Plan says something different
- HPI says one dose, Plan says a different dose
- MSE findings that contradict HPI or Assessment (e.g. MSE says euthymic but Assessment says depressed)
- Diagnosis in Assessment not reflected in the problem list, or vice versa
- Patient reports substance use in HPI but substance use section says denies

TIME DISCREPANCIES (VERY NARROW SCOPE — most notes will have ZERO time issues):
The ONLY time issue worth flagging is when the note contains two DIFFERENT numbers for PSYCHOTHERAPY time specifically. Example: "Time: 18 minutes" in one place and "Time spent on psychotherapy services only: 17 minutes" in another place. Those are two claims about the SAME thing that disagree.

EVERYTHING ELSE ABOUT TIME IS NORMAL AND MUST NOT BE FLAGGED:
- Total visit time (e.g. "25 minutes") being larger than psychotherapy time (e.g. "20 minutes") is CORRECT. The difference is E/M time. This is how psychiatric billing works. NEVER flag this.
- Start/end time matching total time but differing from psychotherapy time is CORRECT. NEVER flag this.
- Short E/M time is CORRECT. A 5-minute E/M portion is normal for stable follow-ups. NEVER flag this.
- Do NOT do subtraction between total time and psychotherapy time. Do NOT comment on it. Do NOT mention it.

If you cannot identify two conflicting statements about psychotherapy time, return an empty time_issues array.

DOCUMENTATION GAPS THAT AFFECT AUDIT DEFENSIBILITY:
- Plan references a medication not discussed anywhere in HPI or Assessment
- Assessment makes clinical claims not supported by any HPI content
- Psychotherapy intervention documented but no time stated
- Medication changed but no rationale documented
- Safety assessment missing when clinical content suggests it should be present (e.g. patient mentions hopelessness but no SI screening documented)

PSYCHOTHERAPY ADD-ON SUFFICIENCY (only evaluate this if the note appears to bill or document a psychotherapy add-on — 90833/90836/90838 — or contains a psychotherapy section):
A psychotherapy add-on is one of the most audited and most often denied elements in psychiatric billing. The central failure is documentation that is actually MEDICATION MANAGEMENT COUNSELING (already bundled into and paid by the E/M code) being presented as billable psychotherapy. Apply this test rigorously and flag gaps.

THE BUNDLING DISTINCTION (the most important check):
- BUNDLED INTO E/M, NOT billable psychotherapy: teaching how to take the medication, what side effects to watch for, lab/BP/vitals monitoring, dosing timing, substance avoidance counseling, adherence counseling, follow-up planning, and discussion of the medication plan. These are medication management counseling and do NOT support a psychotherapy add-on no matter how much time is spent.
- BILLABLE PSYCHOTHERAPY: active therapeutic work targeting the psychiatric condition or its symptoms/behaviors — e.g. teaching about the disorder itself (neurobiology, course, prognosis) with the target being the patient's understanding of and engagement with their illness, cognitive restructuring, processing, skills work, exploring ambivalence, emotional regulation work. Psychoeducation IS a recognized modality, but only when it addresses the psychiatric condition, not the mechanics of medication-taking.
- THE PRACTICAL TEST: would the note still describe a therapeutic encounter if the medication-management content were removed? If no, what is documented is E/M-only and a psychotherapy add-on is not defensible. Flag this explicitly.

THE FIVE REQUIRED ELEMENTS (flag each that is missing or invalid):
1. Modality — must be named AND tied to actual therapeutic work, not medication counseling. "Talk therapy," "counseling," or bare "psychotherapy" are too vague. "Individual psychotherapy via telehealth" names delivery format, not modality.
2. Intervention — the specific active therapeutic technique inside the modality must be documented. Content topics alone are not an intervention. Flag when interventions read as passive/educational ("provided psychoeducation," "discussed," "advised") rather than active therapeutic work, OR when the documented intervention is actually medication counseling.
3. Focus — must be a psychiatric symptom or behavior being therapeutically addressed (e.g. illness-related avoidance, executive-function challenges, emotional regulation, illness beliefs). Flag when the stated focus is medication-management topics (adherence, monitoring, affordability, side-effect tracking).
4. Patient response — must be a response to a THERAPEUTIC intervention, not agreement with the medication plan. Flag "patient agreed with plan" / "engaged" when it responds to med management rather than therapy.
5. Time — psychotherapy-only minutes, documented separately from the E/M. Flag if missing.

When flagging psychotherapy issues, name which of the five elements fail and whether the deeper problem is that the content is medication management rather than psychotherapy.

AI SCRIBE HALLUCINATION PATTERNS (flag these specifically):
Many clinicians use AI scribes that generate draft notes. These tools commonly introduce errors that weaken audit defensibility. Watch for:
- Symptoms documented in ROS or Assessment that were never mentioned in HPI (fabricated symptoms)
- Denials documented that were never actually asked about (inferred negatives from silence)
- Findings stated with more clinical certainty than the HPI content supports (e.g. "patient reports significant improvement" when HPI says "doing okay")
- Treatment recommendations or clinical decisions in the Assessment that are not reflected in the Plan (or vice versa)
- Medications captured with wrong names, wrong doses, or wrong frequencies compared to the medication list
- Mental health content discussed in HPI that is absent from the Assessment (AI scribes miss mental health details at high rates)
- MDM complexity inflated by assessment language that overstates what actually happened in the visit (e.g. "comprehensive evaluation" for a routine follow-up, or listing clinical reasoning the note doesn't actually support)
- Consent or disclosure language that appears auto-generated rather than clinician-written (e.g. "patient was advised of and consented to" without corresponding documentation of that conversation)

DO NOT flag:
- Stylistic preferences or formatting
- Missing sections that are optional
- Things that are clinically reasonable even if not explicitly stated
- Boilerplate or template language that is clearly intentional (e.g. crisis line information, standard plan language)

Respond ONLY with JSON. No markdown, no backticks.

{
  "inconsistencies": [
    {
      "type": "hpi_vs_ros" or "hpi_vs_plan" or "hpi_vs_meds" or "assessment_vs_plan" or "mse_vs_assessment" or "diagnosis_mismatch" or "substance_use_mismatch" or "fabricated_symptom" or "inferred_denial" or "overstated_finding" or "missing_mental_health_content" or "inflated_complexity" or "other",
      "sections": ["section 1", "section 2"],
      "detail": "Specific description of the contradiction with quotes from the note",
      "severity": "high" or "moderate" or "low",
      "audit_impact": "One sentence on how this could affect an audit"
    }
  ],
  "time_issues": [
    {
      "detail": "Specific time discrepancy with the numbers",
      "severity": "high" or "moderate" or "low"
    }
  ],
  "documentation_gaps": [
    {
      "detail": "Specific gap description",
      "severity": "high" or "moderate" or "low",
      "audit_impact": "One sentence on how this could affect an audit"
    }
  ],
  "psychotherapy_issues": [
    {
      "elements_failed": ["modality" and/or "intervention" and/or "focus" and/or "patient_response" and/or "time"],
      "is_actually_em_only": true or false,
      "detail": "Specific description: which elements fail, and whether the content is medication management rather than psychotherapy, with quotes from the note",
      "severity": "high" or "moderate" or "low",
      "audit_impact": "One sentence on the add-on denial / takeback risk"
    }
  ],
  "clean": true or false
}

If the note has no issues, return {"inconsistencies":[],"time_issues":[],"documentation_gaps":[],"psychotherapy_issues":[],"clean":true}.
Be thorough but precise. Only flag real problems, not nitpicks.`;

const CC_MDM_EVAL_PROMPT = `You are an expert psychiatric E/M coder evaluating Medical Decision Making under the 2021/2025 guidelines.

Read this chart note. Evaluate all three MDM axes: Problems, Data, and Risk.

You already know the MDM framework. Apply it accurately. Do not undercode, but do not overcode either. Code what this visit actually is, not what the patient's lifetime acuity suggests.

For Problems: Evaluate what is happening at THIS visit, not the patient's full diagnostic history.

PROBLEMS COUNTING RULES:
- Count each diagnosis on the problem list that is being actively addressed in the visit
- Separate ICD codes = separate problems for MDM purposes, regardless of pathophysiological relationship
- Do NOT collapse related conditions (e.g. depression + anxiety + insomnia) into "one complex" — count each diagnosis being managed
- If there are separate medications, separate clinical reasoning, or separate diagnostic codes being addressed, they are separate problems
- Focus on what the clinician is documenting and managing, not theoretical diagnostic relationships
- A patient with depression (F33.1), GAD (F41.1), and insomnia (G47.00) each with active medications and assessment discussion has THREE problems, not one

Low: 1 stable chronic illness being managed without change, OR 2 or more self-limited problems. A stable follow-up where one condition is well-controlled, the patient reports improvement or stability, and the clinician renews medications without changes IS low. "Deciding not to change a working regimen" for a single stable condition is routine management, not a complex clinical decision. Do not count medications managed by other providers (e.g. PCP-managed antihypertensives) as adding psychiatric complexity.

Moderate: 2 or more stable chronic illnesses, OR 1 or more chronic illnesses with mild exacerbation, OR 1 undiagnosed new problem. The distinction from Low is: either multiple conditions are being actively managed, or one condition is showing worsening that requires clinical attention beyond routine renewal. "Actively managed" does NOT require a medication change. It includes: documented monitoring of a condition that interacts with treatment decisions for another condition (e.g. substance use disorders being monitored in the context of stimulant prescribing), documented risk-benefit analysis about continuing a treatment given another condition, and clinical reasoning about how multiple diagnoses affect each other at this visit. Count the diagnoses the clinician is actually reasoning about in the assessment, not just the ones with medication changes.

High: Determined by ANY of the following three pathways:

PATHWAY 1 — HIGH-COMPLEXITY DECISION-MAKING: New diagnoses being established that require immediate high-risk treatment decisions. Starting controlled substances or high-risk medications in the context of diagnostic uncertainty (e.g. stimulant trial with unresolved bipolar concerns). Treatment decisions requiring extensive clinical reasoning due to competing risks. Complex medication management with multiple simultaneous adjustments, new starts, or dose changes alongside safety considerations. If the clinician documents substantial decision-making around diagnostic uncertainty, medication risks, new diagnoses, or complex treatment decisions, Problems is HIGH.

PATHWAY 2 — SEVERE EXACERBATION: Active suicidal ideation (passive or active), recent psychiatric ER visit, self-discontinuation of critical medications with emerging destabilization, psychotic symptoms with safety concerns, acute functional deterioration, medication-induced adverse events requiring immediate management changes, or clinical situations where higher level of care was discussed, offered, or declined.

PATHWAY 3 — THREAT TO LIFE OR FUNCTION: A condition that poses a direct threat to life or bodily function at this visit.

High Problems is about the decision-making burden and clinical judgment required, not just crisis severity. Do not deflate to moderate simply because conditions appear "stable" or there is "no severe exacerbation" when Pathway 1 is clearly met.

Do not inflate stable single-condition visits to high just because the patient carries multiple diagnoses or has a complex history. But do not deflate genuinely complex decision-making visits to moderate just because there is no acute crisis.

For Risk: "If any clinical decision documented in this note turned out to be wrong, what is the worst plausible outcome for the patient?" That determines the risk level. This applies to decisions to prescribe, decisions NOT to prescribe, decisions about level of care, safety assessments, and any other clinical judgment documented in the note.

CRITICAL RULE — Prescription Drug Management: Per the AMA MDM table, "prescription drug management" is an example of moderate risk. This does NOT require starting, stopping, or changing a medication. Continuing a prescription medication IS prescription drug management when the note documents patient-specific medication assessment and a treatment decision — not merely sending a refill. Moderate-risk indicators: PMP review, cardiac monitoring, substance use screening, drug interaction assessment, explicit risk-benefit analysis about continuing given comorbidities, or documented assessment of tolerability/side effects/adherence that informs the decision to continue. The standard psychiatric interview (ROS, MSE, "how are you doing") does NOT by itself constitute prescription drug management. The question is: did the clinician document specific medication evaluation work beyond the routine interview that informed the decision to continue?

Psychiatric visits are systematically undercoded on the Risk axis because coders miss that outpatient crisis management, medication safety decisions, and declined escalations of care are themselves high-risk clinical judgments. Do not make that mistake.

Respond ONLY with JSON. No markdown.

{
  "problems": {
    "level": "minimal" or "low" or "moderate" or "high",
    "evidence": ["specific finding from note"],
    "reasoning": "paragraph explaining determination"
  },
  "data": {
    "level": "minimal" or "limited" or "moderate" or "extensive",
    "evidence": ["specific data item from note"],
    "reasoning": "paragraph explaining determination"
  },
  "risk": {
    "level": "minimal" or "low" or "moderate" or "high",
    "evidence": ["specific risk factor from note"],
    "reasoning": "paragraph explaining determination",
    "highest_stakes_decision": "one sentence: the single clinical decision in this note where being wrong has the most serious consequences"
  }
}`;

const CC_REVIEW_PROMPT = `You are a senior psychiatric coding reviewer. You receive the original chart note and an initial MDM evaluation from another coder.

YOUR JOB IS VERIFICATION, NOT RE-CODING. For each axis, ask:
1. Does Pass 1's reasoning cite real evidence from the note? (not fabricated or assumed)
2. Does that evidence actually support the level Pass 1 chose?
3. Is the logic sound given the MDM definitions below?

If the answer to all three is YES: confirm the rating.
If any answer is NO: correct it, citing the specific evidence or logic error.

Do NOT form your own independent opinion and override. Do NOT search for reasons to disagree. Your role is peer review: check the work, confirm if defensible, correct if wrong.

=== REFERENCE DEFINITIONS (use these to verify Pass 1's logic) ===

PROBLEMS COUNTING RULES:
- Count each diagnosis on the problem list that is addressed in the assessment or has active medication management
- Separate ICD codes = separate problems, regardless of pathophysiological relationship
- Do NOT collapse related psychiatric conditions into "one interconnected complex"
- Respect the clinician's diagnostic framework

Low: 1 stable chronic illness being managed without change, OR 2 or more self-limited problems. One condition, routine renewal, no changes, patient doing well.

Moderate: 2 or more stable chronic illnesses being actively managed, OR 1 or more chronic illnesses with mild exacerbation, OR 1 undiagnosed new problem. "Actively managed" includes documented monitoring, risk-benefit analysis, and clinical reasoning about how conditions interact — not just medication changes.

High: Determined by ANY of the following three pathways:

PATHWAY 1 — HIGH-COMPLEXITY DECISION-MAKING: New diagnoses requiring high-risk treatment decisions. Starting controlled substances or high-risk medications with diagnostic uncertainty or competing risks. Complex medication management with multiple simultaneous adjustments. Substantial documented clinical reasoning around diagnostic uncertainty, medication risks, or complex treatment decisions.

PATHWAY 2 — SEVERE EXACERBATION: Active suicidal ideation, recent ER visit, medication-induced adverse events requiring immediate changes, psychotic symptoms, acute functional deterioration, or higher level of care discussed/declined.

PATHWAY 3 — THREAT TO LIFE OR FUNCTION: A condition posing direct threat to life or bodily function at this visit.

VERIFICATION RULE FOR PROBLEMS: If Pass 1 rated Problems at a level and cited evidence that fits the definition above, confirm it. If Pass 1 rated high and cited Pathway 1 evidence (new diagnosis, controlled substance start, diagnostic uncertainty, multiple med changes), and that evidence exists in the note, the rating is correct. Do not override it because the patient "seems stable" or because you would characterize the complexity differently. The question is: is Pass 1's reasoning defensible given the note content?

For Data: Verify that the data sources Pass 1 cited actually appear in the note. Re-count if needed.

For Risk: Verify that the clinical decisions Pass 1 cited are documented in the note and that the risk characterization is defensible.

CRITICAL RULE — Prescription Drug Management: Per the AMA MDM table, "prescription drug management" is an example of moderate risk. Continuing a medication IS prescription drug management when the note documents patient-specific assessment (tolerability, side effects, safety monitoring, clinical reasoning about continuing). The standard interview alone (ROS, MSE, symptom check) is NOT prescription drug management. Documented medication-specific evaluation with clinical reasoning IS moderate risk.

After verification, apply the 2-of-3 rule.

=== CPT 2025 CRITICAL RULE ===
When a psychotherapy add-on code (90833, 90836, 90838) is billed alongside an E/M code, TIME CANNOT BE USED as the basis for E/M level selection. E/M level MUST be determined by MDM complexity alone. (CPT 2025, p. 766)

=== E/M CODE MAPPING (Established Patient) ===
99212: straightforward MDM (2 of 3 at minimal/low)
99213: low MDM (2 of 3 at low)
99214: moderate MDM (2 of 3 at moderate)
99215: high MDM (2 of 3 at high)

=== E/M CODE MAPPING (New Patient) ===
99202: straightforward MDM
99203: low MDM
99204: moderate MDM
99205: high MDM

Respond ONLY with JSON. No markdown.

{
  "corrections": [{"axis": "problems/data/risk", "from": "original level", "to": "corrected level", "reason": "specific evidence or logic error in Pass 1 that necessitates correction"}],
  "final_problems": "level",
  "final_data": "level",
  "final_risk": "level",
  "em_code": "99XXX",
  "em_description": "brief description",
  "two_of_three": "which two axes and at what level determined the code",
  "addon_code": "90833 or 90836 or 90838 or none",
  "addon_time": "documented time or null",
  "modifiers": ["25", "95"],
  "coding_support": "Strong or Moderate or Weak",
  "coding_support_reason": "one sentence",
  "audit_defensibility": "Strong or Moderate or Weak",
  "audit_reason": "one sentence",
  "documentation_gaps": ["gap 1 that could weaken the code", "gap 2"],
  "suggested_language": ["specific language to add to strengthen documentation"],
  "attestation": "A chart-ready MDM attestation for audit defensibility. Use this exact structure: '[Visit type] ([code]) was determined by [level] complexity medical decision making based on: (1) [level] problems — [one sentence with specific clinical content]; (2) [level] data — [one sentence]; (3) [level] risk — [one sentence with specific clinical content]. [2-of-3 rule statement]. Psychotherapy add-on [code] for [X] minutes of [modality]. Modifiers: [list with descriptions].' Do NOT write a visit narrative. Do NOT describe what happened during the visit. This is a structured coding justification, not a progress note summary. For established patients say 'established patient follow-up visit,' for new patients say 'new patient evaluation.'"
}`;

async function ccCallAnthropic(systemPrompt, userMessage, anthropicKey, maxTokens) {
  // Stream the response. Streaming makes tokens arrive continuously, which keeps
  // the serverless connection active and prevents the inactivity timeout that
  // kills a long blocking (non-streaming) Sonnet call mid-generation.
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens || 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      stream: true
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Anthropic API error ' + res.status + ': ' + t.substring(0, 200));
  }

  // Read the SSE stream and accumulate the assistant text.
  let text = '';
  let buffer = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = rawEvent.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;
        try {
          const evt = JSON.parse(dataStr);
          if (evt.type === 'content_block_delta' && evt.delta && typeof evt.delta.text === 'string') {
            text += evt.delta.text;
          } else if (evt.type === 'error') {
            throw new Error('Anthropic stream error: ' + (evt.error ? (evt.error.message || JSON.stringify(evt.error)) : 'unknown'));
          }
        } catch (e) {
          // ignore keep-alive / non-JSON lines
        }
      }
    }
  }
  return text;
}

function ccParseJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim()); }
  catch(e) { console.log('CC JSON parse error:', e.message, 'Raw:', (text||'').substring(0, 300)); return null; }
}

const chartCoderPipeline = inngest.createFunction(
  {
    id: 'chart-coder-pipeline',
    name: 'Chart Coder Pipeline',
    retries: 1,
  },
  { event: 'chart-coder/audit.submitted' },
  async function({ event }) {
    const { job_id, noteText, visitType, preflightContext } = event.data;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    async function saveResult(status, result) {
      const saveRes = await fetch(`${supabaseUrl}/rest/v1/tool_jobs?job_id=eq.${job_id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ status: status, result: JSON.stringify(result) })
      });
      if (!saveRes.ok) {
        const errText = await saveRes.text();
        console.error('CC saveResult FAILED:', saveRes.status, errText.substring(0, 200));
      } else {
        console.log('CC saveResult OK for job:', job_id);
      }
    }

    try {
      const userMsg = 'Visit type: ' + (visitType || '') + '\n\nChart note:\n\n' + noteText + (preflightContext || '');

      // Straight sequential pass — NO step.run. Mirrors the working
      // askArchivePipeline exactly: one invocation, all calls in sequence,
      // saveResult once at the end. inngest-serve has timeout=900 so the
      // single long-running invocation has ample time.
      console.log('CC audit start for job:', job_id);
      const auditRaw = await ccCallAnthropic(CC_AUDIT_PROMPT, 'Chart note to audit:\n\n' + noteText, anthropicKey, 2000);
      const audit = ccParseJSON(auditRaw);

      console.log('CC mdm start for job:', job_id);
      const mdmRaw = await ccCallAnthropic(CC_MDM_EVAL_PROMPT, userMsg, anthropicKey, 2000);
      const mdm = ccParseJSON(mdmRaw);

      console.log('CC review start for job:', job_id);
      const reviewInput = userMsg + '\n\nINITIAL MDM EVALUATION:\n' + JSON.stringify(mdm, null, 2);
      const reviewRaw = await ccCallAnthropic(CC_REVIEW_PROMPT, reviewInput, anthropicKey, 2000);
      const review = ccParseJSON(reviewRaw);

      await saveResult('complete', { audit: audit, mdm: mdm, review: review });
      console.log('Chart Coder pipeline complete for job:', job_id);
      return;
    } catch (err) {
      console.error('Chart Coder pipeline error:', err.message);
      await saveResult('error', { error: err.message });
      throw err;
    }
  }
);


// ── SERVE ─────────────────────────────────────────────────────────────────────

export const handler = serve({
  client: inngest,
  signingKey: process.env.INNGEST_SIGNING_KEY,
  functions: [askArchivePipeline, rechunkAllPosts, chartCoderPipeline],
  serveHost: 'https://thinkbeyondpractice.com',
  servePath: '/.netlify/functions/inngest-serve',
});
