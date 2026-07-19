// netlify/functions/embed-post-background.js
//
// Real-time Ask-the-Archive indexing for NATIVE platform content. Circle is
// retired, so new posts/comments are authored on the platform and must be
// embedded into the `posts` vector index the moment they're created — this
// replaces the old weekly Circle batch sync.
//
// A background function (up to 15 min, invoked async) so the OpenAI embedding
// call never adds latency to posting/commenting. The caller fires it and returns.
//
// Modes (POST body, all require secret === BACKFILL_SECRET):
//   { post_id }      embed one native post   -> posts.id = fp_<uuid>
//   { comment_id }   embed one native comment-> posts.id = fpc_<uuid>
//   { backfill:true }embed every native post + comment not yet indexed
//
// Idempotent upsert on the text id, so edits just refresh the row. Circle rows
// (post_<id> / comment_<id>) are untouched.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY, BACKFILL_SECRET

const PLATFORM = 'https://thinkbeyondpractice.com/platform';

exports.handler = async function (event) {
  if (event.httpMethod && event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }
  if (!process.env.BACKFILL_SECRET || body.secret !== process.env.BACKFILL_SECRET) return { statusCode: 401, body: 'Unauthorized' };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY, OA = process.env.OPENAI_API_KEY;
  if (!URL || !KEY || !OA) return { statusCode: 500, body: 'Missing env' };
  const ctx = { URL, KEY, OA, sbHeaders: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' } };

  try {
    if (body.backfill === true) {
      const stats = { posts: 0, comments: 0, skipped: 0, errors: 0 };
      const postRows = await sbGet(ctx, 'forum_posts?circle_post_id=is.null&select=id&limit=5000');
      for (const r of postRows) { const ok = await embedPost(ctx, r.id).catch(function () { return 'err'; }); ok === true ? stats.posts++ : (ok === 'err' ? stats.errors++ : stats.skipped++); }
      const cmtRows = await sbGet(ctx, 'forum_comments?circle_comment_id=is.null&select=id&limit=20000');
      for (const r of cmtRows) { const ok = await embedComment(ctx, r.id).catch(function () { return 'err'; }); ok === true ? stats.comments++ : (ok === 'err' ? stats.errors++ : stats.skipped++); }
      console.log('embed backfill:', JSON.stringify(stats));
      return { statusCode: 200, body: JSON.stringify({ ok: true, backfill: stats }) };
    }
    if (body.comment_id) { const ok = await embedComment(ctx, String(body.comment_id).trim()); return { statusCode: 200, body: JSON.stringify({ ok: ok }) }; }
    if (body.post_id) { const ok = await embedPost(ctx, String(body.post_id).trim()); return { statusCode: 200, body: JSON.stringify({ ok: ok }) }; }
    return { statusCode: 400, body: 'post_id, comment_id, or backfill required' };
  } catch (e) {
    console.log('embed error:', e.message);
    return { statusCode: 200, body: JSON.stringify({ error: e.message }) };
  }
};

async function embedPost(ctx, postId) {
  if (!postId) return false;
  const rows = await sbGet(ctx, 'forum_posts?id=eq.' + encodeURIComponent(postId) +
    '&select=id,title,body_plain,created_at,updated_at,accounts(name),spaces(name,slug)&limit=1');
  const post = rows[0];
  if (!post) return false;
  const bodyPlain = String(post.body_plain || '');
  if (bodyPlain.trim().length < 20) return false;
  const embedding = await getEmbedding([post.title || '', bodyPlain].filter(Boolean).join('\n\n').substring(0, 8000), ctx.OA);
  return upsert(ctx, {
    id: 'fp_' + post.id, circle_post_id: null,
    title: post.title || '', body: bodyPlain.substring(0, 10000),
    author: (post.accounts && post.accounts.name) || 'Member',
    space_name: (post.spaces && post.spaces.name) || '', space_slug: (post.spaces && post.spaces.slug) || '',
    url: PLATFORM + '?post=' + post.id, created_at: post.created_at, updated_at: post.updated_at || post.created_at,
    embedding: embedding, chunk_index: 0
  });
}

async function embedComment(ctx, commentId) {
  if (!commentId) return false;
  const rows = await sbGet(ctx, 'forum_comments?id=eq.' + encodeURIComponent(commentId) +
    '&select=id,body_plain,created_at,updated_at,accounts(name),forum_posts(id,title,spaces(name,slug))&limit=1');
  const c = rows[0];
  if (!c) return false;
  const bodyPlain = String(c.body_plain || '');
  if (bodyPlain.trim().length < 20) return false;
  const post = c.forum_posts || {};
  const embedding = await getEmbedding(('[Comment on: ' + (post.title || 'post') + ']\n\n' + bodyPlain).substring(0, 8000), ctx.OA);
  return upsert(ctx, {
    id: 'fpc_' + c.id, circle_post_id: null,
    title: 'Comment on: ' + (post.title || ''), body: bodyPlain.substring(0, 10000),
    author: (c.accounts && c.accounts.name) || 'Member',
    space_name: (post.spaces && post.spaces.name) || '', space_slug: (post.spaces && post.spaces.slug) || '',
    url: PLATFORM + '?post=' + (post.id || ''), created_at: c.created_at, updated_at: c.updated_at || c.created_at,
    embedding: embedding, chunk_index: 0
  });
}

async function sbGet(ctx, path) {
  const r = await fetch(ctx.URL + '/rest/v1/' + path, { headers: ctx.sbHeaders });
  return r.ok ? r.json() : [];
}
async function upsert(ctx, row) {
  const up = await fetch(ctx.URL + '/rest/v1/posts?on_conflict=id', {
    method: 'POST',
    headers: Object.assign({}, ctx.sbHeaders, { Prefer: 'return=minimal,resolution=merge-duplicates' }),
    body: JSON.stringify(row)
  });
  if (!up.ok) { console.log('upsert fail', up.status, (await up.text()).slice(0, 150)); return 'err'; }
  return true;
}
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
