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
    var chunks = await searchSimilar(supabaseUrl, supabaseKey, questionEmbedding, 8);

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
    if (topSimilarity < 0.3) {
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
    var answer = await synthesizeAnswer(question, context, anthropicKey);

    // Step 7: Build source links (deduplicated by post URL)
    var sources = buildSources(enrichedChunks);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ answer, sources, unanswered: false })
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
      match_threshold: 0.25,
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
        'Post content: ' + (c._parent.body || '').substring(0, 500) + '\n' +
        'Comment by ' + (c.author || 'Member') + ': ' + (c.body || '').substring(0, 800) + '\n' +
        'URL: ' + (c.url || c._parent.url || '')
      );
    } else {
      parts.push(
        '[SOURCE ' + (i+1) + '] Space: ' + c.space_name + '\n' +
        'Post: ' + c.title + '\n' +
        'Author: ' + (c.author || 'Michael Van Gelder') + '\n' +
        'Content: ' + (c.body || '').substring(0, 1000) + '\n' +
        'URL: ' + (c.url || '')
      );
    }
  }
  return parts.join('\n\n---\n\n');
}

// ── Claude synthesis ────────────────────────────────────────────────────────

async function synthesizeAnswer(question, context, apiKey) {
  var systemPrompt = `You are Ask the Archive, a search tool for Think Beyond Practice — a professional forum for psychiatric prescribers run by Michael Van Gelder, PMHNP-BC.

Your job is to synthesize answers from forum posts and member discussions. You answer in Michael's voice: direct, clinically precise, reasoning-first, no hedging, no therapeutic tone, no bullet points unless the content genuinely requires a list.

Rules:
- Answer the question directly using only the provided source material
- If sources partially answer the question, say what you found and what's missing
- Never fabricate clinical information not present in the sources
- Cite sources inline as [Source 1], [Source 2] etc.
- Keep answers focused and practical — this is a clinical professional audience
- Do not use em dashes
- Do not say "based on the sources" or "according to the archive" — just answer
- If the sources are about a different topic than the question, say so clearly`;

  var userPrompt = 'Question: ' + question + '\n\nSources:\n' + context;

  var resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!resp.ok) throw new Error('Claude synthesis failed: ' + resp.status);
  var data = await resp.json();
  return data.content[0].text;
}

// ── Build deduplicated source list ──────────────────────────────────────────

function buildSources(chunks) {
  var seen = {};
  var sources = [];

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
        author: c.id && c.id.startsWith('comment_') ? (c._parent && c._parent.author) : c.author
      });
    }
  }

  return sources.slice(0, 5);
}

// ── Log unanswered questions ────────────────────────────────────────────────

async function logUnanswered(url, key, question, memberRequested) {
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
}
