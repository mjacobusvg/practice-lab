// netlify/functions/reembed-post.js
// Re-embeds a single Circle post (and its comments) in Supabase
// POST with { "secret": "your-backfill-secret", "post_id": 23781508 }

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

  const postId = body.post_id;
  if (!postId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'post_id required' }) };
  }

  const circleToken = process.env.CIRCLE_API_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!circleToken || !supabaseUrl || !supabaseKey || !openaiKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  const stats = { post: 0, comments: 0, errors: [] };

  try {
    // ── Fetch the full post from Circle ──────────────────────────────────────
    const postRes = await fetch(`https://app.circle.so/api/v1/posts/${postId}`, {
      headers: { 'Authorization': `Token ${circleToken}`, 'Content-Type': 'application/json' }
    });

    if (!postRes.ok) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: `Post ${postId} not found: ${postRes.status}` }) };
    }

    const fullPost = await postRes.json();
    const postBody = extractBody(fullPost);

    if (!postBody || postBody.length < 20) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Post body too short or empty' }) };
    }

    // ── Re-embed and upsert the post ─────────────────────────────────────────
    const postText = [fullPost.name || '', postBody].filter(Boolean).join('\n\n').trim();
    const embedding = await getEmbedding(postText, openaiKey);

    await upsertToSupabase(supabaseUrl, supabaseKey, {
      id: `post_${postId}`,
      circle_post_id: postId,
      title: fullPost.name || '',
      body: postBody.substring(0, 10000),
      author: fullPost.user_name || 'Member',
      space_name: fullPost.space_name || '',
      space_slug: fullPost.space_slug || '',
      url: fullPost.url || '',
      created_at: fullPost.created_at,
      updated_at: fullPost.updated_at,
      embedding: embedding,
      chunk_index: 0
    });

    stats.post = 1;
    console.log(`POST re-embedded: ${fullPost.name || postId}`);

    // ── Re-embed comments ────────────────────────────────────────────────────
    const comments = await getPostComments(circleToken, postId);
    console.log(`Comments found: ${comments.length}`);

    for (const comment of comments) {
      try {
        const commentBody = extractCommentBody(comment);
        if (!commentBody || commentBody.length < 20) continue;

        const commentText = `[Comment on: ${fullPost.name || 'post'}]\n\n${commentBody}`;
        const commentEmbedding = await getEmbedding(commentText, openaiKey);

        await upsertToSupabase(supabaseUrl, supabaseKey, {
          id: `comment_${comment.id}`,
          circle_post_id: postId,
          title: `Comment on: ${fullPost.name || ''}`,
          body: commentBody.substring(0, 10000),
          author: comment.user_name || 'Member',
          space_name: fullPost.space_name || '',
          space_slug: fullPost.space_slug || '',
          url: fullPost.url || '',
          created_at: comment.created_at,
          updated_at: comment.updated_at,
          embedding: commentEmbedding,
          chunk_index: 0
        });

        stats.comments++;
      } catch(ce) {
        console.log(`Comment error ${comment.id}: ${ce.message}`);
        stats.errors.push(`comment_${comment.id}: ${ce.message}`);
      }
    }

    console.log(`REEMBED COMPLETE: post=${stats.post} comments=${stats.comments} errors=${stats.errors.length}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        title: fullPost.name || postId,
        ...stats
      })
    };

  } catch(err) {
    console.log(`REEMBED FATAL: ${err.message}`);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getPostComments(token, postId) {
  const comments = [];
  let page = 1;
  while (true) {
    const resp = await fetch(`https://app.circle.so/api/v1/comments?post_id=${postId}&page=${page}&per_page=50`, {
      headers: { 'Authorization': `Token ${token}`, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) break;
    const data = await resp.json();
    const batch = Array.isArray(data) ? data : (data.comments || data.records || []);
    if (!batch.length) break;
    comments.push(...batch);
    if (batch.length < 50) break;
    page++;
  }
  return comments;
}

function extractBody(post) {
  if (post.body && typeof post.body === 'object' && post.body.body) return stripHtml(post.body.body);
  if (typeof post.body === 'string') return stripHtml(post.body);
  if (post.body_plain_text) return post.body_plain_text;
  if (post.body_plain) return post.body_plain;
  return '';
}

function extractCommentBody(comment) {
  if (comment.body && typeof comment.body === 'object' && comment.body.body) return stripHtml(comment.body.body);
  if (typeof comment.body === 'string') return stripHtml(comment.body);
  if (comment.body_plain_text) return comment.body_plain_text;
  return '';
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function getEmbedding(text, apiKey) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text.substring(0, 8000), dimensions: 1536 })
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
