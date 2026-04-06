// netlify/functions/ask-archive.js
// RAG query function for Ask the Archive
// 1. Embeds member question via OpenAI
// 2. Runs vector similarity search against Supabase posts table
// 3. Enriches comment chunks with parent post context
// 4. Sends full context + question to Claude for synthesis
// 5. Returns { answer, sources } or { unanswered: true } if no match found
// 6. Logs unanswered questions to Supabase and emails michael@thinkbeyondpsych.com

const MATCH_THRESHOLD = 0.45;
const MATCH_COUNT = 14;

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
  const conversationHistory = body.conversation_history || [];

  if (!question) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Question required' }) };

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
        match_threshold: MATCH_THRESHOLD,
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

    // ── Step 3: Handle unanswered ───────────────────────────────────────────
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
1. What to do — one direct sentence
2. Required elements — short inline list only when enumerating specific components
3. Example — pulled directly from the language in the source posts
4. Common mistake — one line identifying the most frequent error
5. Go deeper in these posts — list the source titles with one-line descriptions (you will return these as structured data)

Return your response as JSON with exactly these fields:
{
  "answer": "the full answer text following the structure above (without the sources section — that goes in source_descriptions)",
  "source_descriptions": [
    { "index": 1, "description": "one-line description of why this post is relevant" },
    ...
  ]
}

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

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        answer: parsed.answer,
        sources: dedupedSources,
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
