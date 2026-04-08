// netlify/functions/ingest-cms-doc-upload.js
// Background function (up to 15 minutes) — accepts a single PDF as base64,
// extracts text via Claude, embeds via OpenAI, upserts to Supabase posts table.
//
// POST body (JSON):
// {
//   "secret": "<BACKFILL_SECRET>",
//   "id":     "cms_mln006764",           // unique record id (no spaces)
//   "title":  "CMS MLN: Evaluation and Management Services Guide (2025)",
//   "pdf":    "<base64-encoded PDF bytes>"
// }
//
// Optional overrides (all have defaults):
//   "space_name"  — default: "CMS Reference"
//   "space_slug"  — default: "cms-reference"
//   "author"      — default: "Centers for Medicare & Medicaid Services"
//   "url"         — default: "" (no source URL since file was uploaded directly)
//
// Returns 202 immediately. Progress in Netlify function logs.

exports.handler = async function(event, context) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (body.secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const { id, title, pdf } = body;

  if (!id || typeof id !== 'string' || !id.trim()) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing required field: id' }) };
  }
  if (!title || typeof title !== 'string' || !title.trim()) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing required field: title' }) };
  }
  if (!pdf || typeof pdf !== 'string' || pdf.length < 100) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing or invalid field: pdf (must be base64 string)' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const openaiKey   = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseKey || !openaiKey || !anthropicKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  const doc = {
    id:         id.trim(),
    title:      title.trim(),
    space_name: (body.space_name || 'CMS Reference').trim(),
    space_slug: (body.space_slug || 'cms-reference').trim(),
    author:     (body.author     || 'Centers for Medicare & Medicaid Services').trim(),
    url:        (body.url        || '').trim()
  };

  // Return 202 immediately — background function continues running
  const response = {
    statusCode: 202,
    headers: CORS,
    body: JSON.stringify({ message: `Ingestion started for "${doc.title}" (id: ${doc.id}). Check function logs for progress.` })
  };

  (async () => {
    try {
      console.log(`[ingest-cms-doc-upload] Starting: ${doc.title} (id: ${doc.id})`);
      console.log(`[ingest-cms-doc-upload] PDF base64 length: ${pdf.length}`);

      // ── Step 1: Extract text via Claude ──────────────────────────────────────
      const extractResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: pdf
                }
              },
              {
                type: 'text',
                text: 'Extract and return the full text content of this CMS document. Focus on the clinical and billing guidance — E/M coding rules, time thresholds, prolonged services, MDM criteria, and any tables showing code selection. Preserve the structure and key facts. Return plain text only, no commentary.'
              }
            ]
          }]
        })
      });

      if (!extractResp.ok) {
        const errText = await extractResp.text();
        throw new Error(`Claude extraction failed (${extractResp.status}): ${errText.substring(0, 300)}`);
      }

      const extractData = await extractResp.json();
      const extractedText = extractData.content && extractData.content[0] && extractData.content[0].text;

      if (!extractedText || extractedText.length < 100) {
        throw new Error(`Extracted text too short (${extractedText ? extractedText.length : 0} chars)`);
      }

      console.log(`[ingest-cms-doc-upload] Extracted ${extractedText.length} chars from "${doc.title}"`);

      // ── Step 2: Chunk ─────────────────────────────────────────────────────────
      const chunks = chunkText(extractedText, 7000);
      console.log(`[ingest-cms-doc-upload] ${chunks.length} chunk(s) for "${doc.title}"`);

      // ── Step 3: Embed + upsert each chunk ─────────────────────────────────────
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkId = chunks.length > 1 ? `${doc.id}_chunk${i}` : doc.id;
        const chunkTitle = chunks.length > 1 ? `${doc.title} (Part ${i + 1})` : doc.title;

        const embedding = await getEmbedding(`${doc.title}\n\n${chunk}`, openaiKey);

        await upsertToSupabase(supabaseUrl, supabaseKey, {
          id:             chunkId,
          circle_post_id: null,
          title:          chunkTitle,
          body:           chunk.substring(0, 10000),
          author:         doc.author,
          space_name:     doc.space_name,
          space_slug:     doc.space_slug,
          url:            doc.url,
          created_at:     new Date().toISOString(),
          updated_at:     new Date().toISOString(),
          embedding:      embedding,
          chunk_index:    i
        });

        console.log(`[ingest-cms-doc-upload] Upserted chunk ${i + 1}/${chunks.length} for "${doc.title}" (id: ${chunkId})`);
        await sleep(500);
      }

      console.log(`[ingest-cms-doc-upload] COMPLETE: "${doc.title}" — ${chunks.length} chunk(s) upserted.`);

    } catch(e) {
      console.error(`[ingest-cms-doc-upload] ERROR for "${doc.title}": ${e.message}`);
    }
  })();

  return response;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;

    if (end < text.length) {
      const paraBreak = text.lastIndexOf('\n\n', end);
      if (paraBreak > start + maxChars * 0.5) {
        end = paraBreak;
      } else {
        const sentBreak = text.lastIndexOf('. ', end);
        if (sentBreak > start + maxChars * 0.5) {
          end = sentBreak + 1;
        }
      }
    }

    chunks.push(text.substring(start, end).trim());
    start = end;
  }

  return chunks.filter(function(c) { return c.length > 50; });
}

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
    throw new Error(`OpenAI embedding failed: ${err.substring(0, 200)}`);
  }
  const data = await resp.json();
  return data.data[0].embedding;
}

async function upsertToSupabase(url, key, record) {
  const resp = await fetch(`${url}/rest/v1/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(record)
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Supabase upsert failed: ${err.substring(0, 200)}`);
  }
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}
