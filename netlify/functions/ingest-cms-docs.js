// netlify/functions/ingest-cms-docs.js
// One-time function to fetch CMS public domain documents, extract text,
// embed them, and upsert into the posts table alongside forum content.
// POST with { "secret": "your-backfill-secret" }

const CMS_DOCUMENTS = [
  {
    id: 'cms_mln006764',
    title: 'CMS MLN: Evaluation and Management Services Guide (2025)',
    url: 'https://www.cms.gov/files/document/mln006764-evaluation-management-services.pdf',
    space_name: 'CMS Reference',
    space_slug: 'cms-reference',
    author: 'Centers for Medicare & Medicaid Services'
  },
  {
    id: 'cms_pfs_em_fact_sheet',
    title: 'CMS Fact Sheet: Physician Fee Schedule Payment for Office/Outpatient E/M Visits',
    url: 'https://www.cms.gov/files/document/physician-fee-schedule-pfs-payment-officeoutpatient-evaluation-and-management-em-visits-fact-sheet.pdf',
    space_name: 'CMS Reference',
    space_slug: 'cms-reference',
    author: 'Centers for Medicare & Medicaid Services'
  },
  {
    id: 'cms_r10505cp',
    title: 'CMS: Prolonged Office/Outpatient E/M Services — G2212 vs 99417',
    url: 'https://www.cms.gov/files/document/r10505cp.pdf',
    space_name: 'CMS Reference',
    space_slug: 'cms-reference',
    author: 'Centers for Medicare & Medicaid Services'
  }
];

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

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseKey || !openaiKey || !anthropicKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  const stats = { ingested: 0, skipped: 0, errors: [] };

  for (const doc of CMS_DOCUMENTS) {
    try {
      console.log('Fetching:', doc.title);

      // Fetch the PDF
      const pdfResp = await fetch(doc.url);
      if (!pdfResp.ok) {
        throw new Error(`Failed to fetch PDF: ${pdfResp.status}`);
      }

      const pdfBuffer = await pdfResp.arrayBuffer();
      const pdfBase64 = Buffer.from(pdfBuffer).toString('base64');

      // Use Claude to extract text from the PDF
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
                  data: pdfBase64
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
        throw new Error(`Claude extraction failed: ${extractResp.status}`);
      }

      const extractData = await extractResp.json();
      const extractedText = extractData.content[0].text;

      if (!extractedText || extractedText.length < 100) {
        throw new Error('Extracted text too short');
      }

      console.log(`Extracted ${extractedText.length} chars from ${doc.title}`);

      // Chunk the text if it's very long (max 8000 chars per embedding)
      const chunks = chunkText(extractedText, 7000);
      console.log(`${chunks.length} chunk(s) for ${doc.title}`);

      for (let i = 0; i < chunks.length; i++) {
        const chunkText = chunks[i];
        const chunkId = chunks.length > 1 ? `${doc.id}_chunk${i}` : doc.id;

        // Embed the chunk
        const embedding = await getEmbedding(
          `${doc.title}\n\n${chunkText}`,
          openaiKey
        );

        // Upsert to Supabase
        await upsertToSupabase(supabaseUrl, supabaseKey, {
          id: chunkId,
          circle_post_id: null,
          title: chunks.length > 1 ? `${doc.title} (Part ${i + 1})` : doc.title,
          body: chunkText.substring(0, 10000),
          author: doc.author,
          space_name: doc.space_name,
          space_slug: doc.space_slug,
          url: doc.url,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          embedding: embedding,
          chunk_index: i
        });

        console.log(`Upserted chunk ${i + 1}/${chunks.length} for ${doc.title}`);
        await sleep(500);
      }

      stats.ingested++;

    } catch(e) {
      console.log(`Error ingesting ${doc.title}: ${e.message}`);
      stats.errors.push(`${doc.id}: ${e.message}`);
    }
  }

  console.log(`CMS INGEST COMPLETE: ingested=${stats.ingested} skipped=${stats.skipped} errors=${stats.errors.length}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify(stats)
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;

    // Try to break at a paragraph or sentence boundary
    if (end < text.length) {
      const breakAt = text.lastIndexOf('\n\n', end);
      if (breakAt > start + maxChars * 0.5) {
        end = breakAt;
      } else {
        const sentenceBreak = text.lastIndexOf('. ', end);
        if (sentenceBreak > start + maxChars * 0.5) {
          end = sentenceBreak + 1;
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
    throw new Error('OpenAI embedding failed: ' + err.substring(0, 200));
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
    throw new Error('Supabase upsert failed: ' + err.substring(0, 200));
  }
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}
