// netlify/functions/embed-post-background.js
//
// Real-time Ask-the-Archive indexing for NATIVE platform posts. Circle is
// retired, so new posts are authored on the platform (create-post /
// create-member-post) and must be embedded into the `posts` vector index the
// moment they're created — this replaces the old weekly Circle batch sync.
//
// A background function (up to 15 min, invoked async) so the OpenAI embedding
// call never adds latency to posting. The caller fires it and returns instantly.
//
// Idempotent: upserts on the text id `fp_<forum_post_id>`, so re-embedding an
// edited post just refreshes its row. Circle-sourced rows (keyed post_<circle_id>)
// are untouched.
//
// POST { post_id, secret }   secret must equal BACKFILL_SECRET (internal caller).
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY, BACKFILL_SECRET

const PLATFORM = 'https://thinkbeyondpractice.com/platform';

exports.handler = async function (event) {
  // Scheduled/async invocations have no httpMethod; a manual/HTTP call must POST.
  if (event.httpMethod && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'POST only' };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }
  if (!process.env.BACKFILL_SECRET || body.secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  const postId = String(body.post_id || '').trim();
  if (!postId) return { statusCode: 400, body: 'post_id required' };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY, OA = process.env.OPENAI_API_KEY;
  if (!URL || !KEY || !OA) return { statusCode: 500, body: 'Missing env' };
  const sbHeaders = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  try {
    // Pull the post with its author name and space (single embedded query).
    const r = await fetch(URL + '/rest/v1/forum_posts?id=eq.' + encodeURIComponent(postId) +
      '&select=id,title,body_plain,created_at,updated_at,accounts(name),spaces(name,slug)&limit=1', { headers: sbHeaders });
    const rows = r.ok ? await r.json() : [];
    const post = rows[0];
    if (!post) return { statusCode: 404, body: 'post not found' };

    const bodyPlain = String(post.body_plain || '');
    if (bodyPlain.trim().length < 20) return { statusCode: 200, body: JSON.stringify({ skipped: 'body too short' }) };

    const text = [post.title || '', bodyPlain].filter(Boolean).join('\n\n').trim();
    const embedding = await getEmbedding(text.substring(0, 8000), OA);

    const rowOut = {
      id: 'fp_' + post.id,
      circle_post_id: null,
      title: post.title || '',
      body: bodyPlain.substring(0, 10000),
      author: (post.accounts && post.accounts.name) || 'Member',
      space_name: (post.spaces && post.spaces.name) || '',
      space_slug: (post.spaces && post.spaces.slug) || '',
      url: PLATFORM + '?post=' + post.id,
      created_at: post.created_at,
      updated_at: post.updated_at || post.created_at,
      embedding: embedding,
      chunk_index: 0
    };

    const up = await fetch(URL + '/rest/v1/posts?on_conflict=id', {
      method: 'POST',
      headers: Object.assign({}, sbHeaders, { Prefer: 'return=minimal,resolution=merge-duplicates' }),
      body: JSON.stringify(rowOut)
    });
    if (!up.ok) return { statusCode: 200, body: JSON.stringify({ error: 'upsert ' + up.status + ' ' + (await up.text()).slice(0, 200) }) };

    console.log('embedded native post', post.id, '-', post.title);
    return { statusCode: 200, body: JSON.stringify({ ok: true, id: rowOut.id }) };
  } catch (e) {
    console.log('embed-post error:', e.message);
    return { statusCode: 200, body: JSON.stringify({ error: e.message }) };
  }
};

async function getEmbedding(text, apiKey) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text, dimensions: 1536 })
  });
  if (!resp.ok) throw new Error('OpenAI embedding failed: ' + (await resp.text()).slice(0, 150));
  const data = await resp.json();
  return data.data[0].embedding;
}
