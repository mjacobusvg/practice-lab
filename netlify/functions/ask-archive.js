// netlify/functions/ask-archive.js
// Ask the Archive: takes a member question, runs similarity search, returns synthesized answer + source links

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  var question = (body.question || '').trim();
  var history = body.history || []; // array of {role, content} for follow-up conversations
  if (!question) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No question provided' }) };
  }

  var supabaseUrl = process.env.SUPABASE_URL;
  var supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  var openaiKey = process.env.OPENAI_API_KEY;
  var anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseKey || !openaiKey || !anthropicKey) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  try {
    // Step 1: Embed the question
    var questionEmbedding = await getEmbedding(question, openaiKey);

    // Step 2: Search for similar chunks
    var chunks = await searchSimilar(supabaseUrl, supabaseKey, questionEmbedding, 14);

    if (!chunks || chunks.length === 0) {
      // Log unanswered question
      await logUnanswered(supabaseUrl, supabaseKey, question, false);
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          answer: "I don't have a good answer for this yet. This question has been logged and Michael will be notified to create content on this topic.",
          sources: [],
          unanswered: true
        })
      };
    }

    // Step 3: For comment chunks, also fetch their parent post for context
    var enrichedChunks = await enrichWithParentPosts(chunks, supabaseUrl, supabaseKey);

    // Step 4: Check confidence - if top match is very low, treat as unanswered
    var topSimilarity = chunks[0].similarity || 0;
    if (topSimilarity < 0.45) {
      await logUnanswered(supabaseUrl, supabaseKey, question, false);
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          answer: "I don't have a good answer for this yet. This question has been logged and Michael will be notified to create content on this topic.",
          sources: [],
          unanswered: true
        })
      };
    }

    // Step 5: Build context for Claude
    var context = buildContext(enrichedChunks);

    // Step 6: Synthesize answer with Claude
    var result = await synthesizeAnswer(question, context, anthropicKey, history);

    // Step 7: Build source links with descriptions
    var sources = buildSources(enrichedChunks, result.sourceDescriptions);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        answer: result.answer,
        sources,
        unanswered: false,
        // Return the exchange for client to store as history
        history_append: [
          { role: 'user', content: 'Question: ' + question + '\n\nSources:\n' + context },
          { role: 'assistant', content: JSON.stringify({ answer: result.answer, source_descriptions: result.sourceDescriptions }) }
        ]
      })
    };

  } catch(e) {
    console.log('Ask Archive error:', e.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: e.message }) };
  }
};

// ── OpenAI embedding ────────────────────────────────────────────────────────

async function getEmbedding(text, apiKey) {
  var resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.substring(0, 8000),
      dimensions: 1536
    })
  });
  if (!resp.ok) throw new Error('Embedding failed: ' + resp.status);
  var data = await resp.json();
  return data.data[0].embedding;
}

// ── Supabase vector search ──────────────────────────────────────────────────

async function searchSimilar(url, key, embedding, limit) {
  var resp = await fetch(url + '/rest/v1/rpc/match_posts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_threshold: 0.45,
      match_count: limit
    })
  });
  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('Search failed: ' + err.substring(0, 200));
  }
  return await resp.json();
}

// ── Enrich comments with parent post context ────────────────────────────────

async function enrichWithParentPosts(chunks, url, key) {
  var enriched = [];
  var parentCache = {};

  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i];
    if (chunk.id && chunk.id.startsWith('comment_') && chunk.circle_post_id) {
      var parentId = 'post_' + chunk.circle_post_id;
      if (!parentCache[parentId]) {
        // Fetch parent post
        var resp = await fetch(url + '/rest/v1/posts?id=eq.' + parentId + '&select=title,body,url,author,space_name', {
          headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
        });
        if (resp.ok) {
          var data = await resp.json();
          if (data && data.length > 0) parentCache[parentId] = data[0];
        }
      }
      chunk._parent = parentCache[parentId] || null;
    }
    enriched.push(chunk);
  }
  return enriched;
}

// ── Build context string for Claude ────────────────────────────────────────

function buildContext(chunks) {
  var parts = [];
  for (var i = 0; i < chunks.length; i++) {
    var c = chunks[i];
    var isComment = c.id && c.id.startsWith('comment_');

    if (isComment && c._parent) {
      parts.push(
        '[SOURCE ' + (i+1) + '] Space: ' + c.space_name + '\n' +
        'Post: ' + c._parent.title + '\n' +
        'Post content: ' + (c._parent.body || '') + '\n' +
        'Comment by ' + (c.author || 'Member') + ': ' + (c.body || '') + '\n' +
        'URL: ' + (c.url || c._parent.url || '')
      );
    } else {
      parts.push(
        '[SOURCE ' + (i+1) + '] Space: ' + c.space_name + '\n' +
        'Post: ' + c.title + '\n' +
        'Author: ' + (c.author || 'Michael Van Gelder') + '\n' +
        'Content: ' + (c.body || '') + '\n' +
        'URL: ' + (c.url || '')
      );
    }
  }
  return parts.join('\n\n---\n\n');
}

// ── Claude synthesis ────────────────────────────────────────────────────────

async function synthesizeAnswer(question, context, apiKey, history) {
  var systemPrompt = `You are Ask the Archive, a search tool for Think Beyond Practice — a professional forum for psychiatric prescribers run by Michael Van Gelder, PMHNP-BC.

Your job is to assemble a direct, decision-ready answer from the provided source material using the author's language as closely as possible. The posts were written by Michael Van Gelder — direct, clinically precise, short declarative sentences, no hedging, treats the reader as a peer.

CORE INSTRUCTION: Do not paraphrase when you can quote or near-quote. Pull the strongest sentences directly from the source material. You are assembling, not rewriting.

OUTPUT STRUCTURE — follow this every time:
1. WHAT TO DO: One direct sentence stating the core action or rule.
2. REQUIRED ELEMENTS: If the question involves required components, list them as a short inline list (the only place a list is acceptable).
3. EXAMPLE: One concrete example showing what it looks like in practice. Format: "Example: [actual example from the source material]"
4. COMMON MISTAKE: One sentence naming the most common error. Format: "The most common mistake: [mistake]."

FORMAT RULES:
- No bold text. No headers. No em dashes.
- Prose paragraphs except for the required elements list and example line.
- Keep total response under 200 words.
- Never start with "I" or "Based on" or "According to"

CITATIONS: Reference sources by their actual post title inline when natural. Never write [Source 1].

CONTENT RULES:
- Only use information present in the provided sources
- If sources partially answer the question, say what the forum has and note what it hasn't covered
- If sources are clearly off-topic, say so in one sentence and stop
- Never fabricate clinical information

Return ONLY valid JSON, no markdown, no preamble:
{
  "answer": "your structured answer here",
  "source_descriptions": {
    "POST_TITLE": "one sentence description of what this post covers relevant to the question"
  }
}`;

  var userPrompt = 'Question: ' + question + '\n\nSources:\n' + context;

  // Build messages array — include history for follow-up questions
  var messages = [];
  if (history && history.length > 0) {
    messages = history.slice(-6); // keep last 3 exchanges max
  }
  messages.push({ role: 'user', content: userPrompt });

  var resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt,
      messages: messages
    })
  });

  if (!resp.ok) throw new Error('Claude synthesis failed: ' + resp.status);
  var data = await resp.json();
  var raw = data.content[0].text.trim();

  // Parse JSON response
  try {
    var parsed = JSON.parse(raw);
    return { answer: parsed.answer || raw, sourceDescriptions: parsed.source_descriptions || {} };
  } catch(e) {
    // Fallback if JSON parse fails
    return { answer: raw, sourceDescriptions: {} };
  }
}

// ── Build deduplicated source list ──────────────────────────────────────────

function buildSources(chunks, descriptions) {
  var seen = {};
  var sources = [];
  descriptions = descriptions || {};

  for (var i = 0; i < chunks.length; i++) {
    var c = chunks[i];
    var url = c.url || (c._parent && c._parent.url) || '';
    var title = c.id && c.id.startsWith('comment_')
      ? (c._parent ? c._parent.title : c.title.replace('Comment on: ', ''))
      : c.title;

    if (url && !seen[url]) {
      seen[url] = true;
      sources.push({
        title: title,
        url: url,
        space: c.space_name,
        author: c.id && c.id.startsWith('comment_') ? (c._parent && c._parent.author) : c.author,
        description: descriptions[title] || null
      });
    }
  }

  return sources.slice(0, 5);
}

// ── Log unanswered questions ────────────────────────────────────────────────

async function logUnanswered(url, key, question, memberRequested) {
  // Log to Supabase
  await fetch(url + '/rest/v1/unanswered_questions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify({
      question: question,
      member_requested: memberRequested
    })
  });

  // Send email notification via Resend
  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;

  var sqlQuery = 'select question, member_requested, created_at from unanswered_questions order by created_at desc;';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + resendKey
    },
    body: JSON.stringify({
      from: 'Ask the Archive <onboarding@resend.dev>',
      to: 'michael@thinkbeyondpsych.com',
      subject: 'Ask the Archive: Unanswered Question',
      html: '<p>A member asked a question the Archive could not answer:</p>' +
            '<blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#333">' + question + '</blockquote>' +
            '<p>This has been logged to your Supabase unanswered_questions table.</p>' +
            '<p>To see all unanswered questions, paste this into your <a href="https://supabase.com/dashboard/project/ubcrrrapedaxkguxniwv/sql">Supabase SQL Editor</a>:</p>' +
            '<pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:13px">' + sqlQuery + '</pre>' +
            '<p style="color:#888;font-size:12px">Think Beyond Practice — Ask the Archive</p>'
    })
  });
}
