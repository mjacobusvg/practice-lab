// netlify/functions/create-comment.js
// Member commenting on forum posts. Any signed-in member (forum OR full tier)
// may comment; free/hub scope may not. Writes with the Supabase service role key
// so RLS stays locked for anon clients (forum_comments has only a public SELECT
// policy, no INSERT policy).
//
// SECURITY: the comment body is member-supplied, and platform.html renders
// forum_comments.body_html via innerHTML. So member text is ESCAPED here and
// rebuilt into safe paragraph HTML — no member-supplied markup ever reaches the
// stored body_html. Identity is taken from the SIGNED token, never the client.
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
//
// Actions:
//   { action:'create', token, post_id, body[, parent_comment_id] }
//   { action:'delete', token, comment_id }   (author of the comment, or an admin)

const { verifyToken } = require('./_lib/session');
const { notifyNewComment } = require('./_lib/notify');
const { resolveMentions, linkifyMentions, notifyMentions } = require('./_lib/mentions');
const { toRichHtml } = require('./_lib/richtext');

const MAX_COMMENT_CHARS = 8000;

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }) };

  const sbHeaders = {
    'apikey': KEY,
    'Authorization': 'Bearer ' + KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
  const sb = async (path, method, body) => {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method, headers: sbHeaders, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text.slice(0, 200));
    return text ? JSON.parse(text) : null;
  };

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  // Identity from the SIGNED session token, never a client-supplied email.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };
  // 'member' (forum/full) may comment anywhere; 'free' may comment only on posts
  // explicitly opened to free members (enforced per-post below). Nothing else.
  const scope = String(session.claims.scope || '');
  if (scope !== 'member' && scope !== 'free') return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Members only' }) };
  const email = String(session.claims.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };

  try {
    // Resolve the member's account. Every signed-in member has one; we never
    // fabricate an author identity.
    const accts = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id,name,avatar_url,credentials,is_admin&limit=1', 'GET');
    if (!accts || !accts.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No account found for this session. Refresh and sign in again.' }) };
    }
    const me = accts[0];

    if (p.action === 'create') {
      const postId = String(p.post_id || '').trim();
      const raw = String(p.body || '').trim();
      if (!postId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'post_id required' }) };
      if (!raw) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Comment cannot be empty' }) };
      if (raw.length > MAX_COMMENT_CHARS) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Comment is too long' }) };

      // Post must exist and be open to replies.
      const posts = await sb('forum_posts?id=eq.' + encodeURIComponent(postId) + '&select=id,title,author_id,comment_count,is_locked,free_visible&limit=1', 'GET');
      if (!posts || !posts.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Post not found' }) };
      if (posts[0].is_locked) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'This thread is locked' }) };
      // Free-tier accounts may comment only on posts opened to free members.
      if (scope !== 'member' && !posts[0].free_visible) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Join to comment on this thread' }) };

      // Optional threaded reply: the parent must belong to the same post.
      let parentId = null;
      if (p.parent_comment_id) {
        const pid = String(p.parent_comment_id).trim();
        const parents = await sb('forum_comments?id=eq.' + encodeURIComponent(pid) + '&select=id,post_id&limit=1', 'GET');
        if (!parents || !parents.length || parents[0].post_id !== postId) {
          return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid parent comment' }) };
        }
        parentId = pid;
      }

      // Resolve @mentions (ids the composer collected) and linkify the body.
      const mentioned = await resolveMentions(p.mention_ids);
      const bodyHtml = linkifyMentions(toRichHtml(raw), mentioned);

      const row = {
        post_id: postId,
        author_id: me.id,
        parent_comment_id: parentId,
        body_plain: raw,
        body_html: bodyHtml,
        reaction_count: 0
      };
      const inserted = await sb('forum_comments', 'POST', row);
      const comment = inserted && inserted[0];

      // Keep the denormalized counter honest.
      const nextCount = (Number(posts[0].comment_count) || 0) + 1;
      try { await sb('forum_posts?id=eq.' + encodeURIComponent(postId), 'PATCH', { comment_count: nextCount }); } catch (e) {}

      // Notify the post author + prior commenters (in-app + email per preference).
      try {
        await notifyNewComment(
          { id: postId, title: posts[0].title, author_id: posts[0].author_id },
          { id: me.id, name: me.name }
        );
      } catch (e) { /* never block commenting */ }

      // Notify anyone @mentioned in the comment (in-app + opt-in email).
      try {
        await notifyMentions(mentioned, { id: me.id, name: me.name }, { title: posts[0].title || 'a thread', post_id: postId });
      } catch (e) { /* never block commenting */ }

      // Index the comment into Ask the Archive (real-time, async).
      try { await require('./_lib/embed').triggerEmbedComment(comment.id); } catch (e) { /* best-effort */ }

      return {
        statusCode: 200, headers, body: JSON.stringify({
          ok: true,
          comment: {
            id: comment.id,
            post_id: postId,
            author_id: me.id,
            parent_comment_id: parentId,
            body_html: comment.body_html,
            body_plain: comment.body_plain,
            created_at: comment.created_at,
            accounts: { name: me.name, avatar_url: me.avatar_url }
          },
          comment_count: nextCount
        })
      };
    }

    if (p.action === 'delete') {
      const commentId = String(p.comment_id || '').trim();
      if (!commentId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'comment_id required' }) };

      const rows = await sb('forum_comments?id=eq.' + encodeURIComponent(commentId) + '&select=id,post_id,author_id&limit=1', 'GET');
      if (!rows || !rows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Comment not found' }) };
      const target = rows[0];

      // Only the comment's author or an admin may delete it.
      if (target.author_id !== me.id && !me.is_admin) {
        return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Not allowed' }) };
      }

      await sb('forum_comments?id=eq.' + encodeURIComponent(commentId), 'DELETE');

      // Decrement the post counter (floor at 0).
      try {
        const posts = await sb('forum_posts?id=eq.' + encodeURIComponent(target.post_id) + '&select=comment_count&limit=1', 'GET');
        if (posts && posts.length) {
          const nextCount = Math.max(0, (Number(posts[0].comment_count) || 0) - 1);
          await sb('forum_posts?id=eq.' + encodeURIComponent(target.post_id), 'PATCH', { comment_count: nextCount });
        }
      } catch (e) {}

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
