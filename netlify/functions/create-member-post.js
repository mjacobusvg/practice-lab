// netlify/functions/create-member-post.js
// Member-authored forum posts. Any signed-in member (forum OR full tier) may
// start a thread, but ONLY in the community discussion spaces — the authoritative
// reference spaces (Clinical References, Billing & Documentation, etc.) stay
// Michael-only for posts (members still comment there). The allowlist is enforced
// here on the server; a client cannot post into a reference space by spoofing the
// slug.
//
// SECURITY: the body is member-supplied and platform.html renders body_html via
// innerHTML, so member text is ESCAPED and rebuilt into paragraph HTML here — no
// member markup reaches storage. Identity is from the SIGNED token, never a
// client-supplied email. Writes with the service role key (forum_posts has only a
// public SELECT policy).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
// Body: { token, space, title, body, tags?: string[] }   (tags = canonical names)

const { verifyToken } = require('./_lib/session');
const { notifyNewPost } = require('./_lib/notify');

// The only spaces members may START a thread in. Slugs must match public.spaces.
const MEMBER_POSTABLE_SPACES = ['quick-q', 'member-threads', 'case-discussions', 'tool-feedback'];

const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 20000;
const MAX_TAGS = 5;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Plain text -> safe paragraph HTML. Everything is escaped first, so no member
// markup survives; blank lines split paragraphs, single newlines become <br>.
function toHtml(plain) {
  return String(plain)
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(function (p) { return p.trim(); })
    .filter(function (p) { return p.length; })
    .map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; })
    .join('\n');
}

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
  if (session.claims.scope !== 'member') return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Members only' }) };
  const email = String(session.claims.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };

  const space = String(p.space || '').trim();
  const title = String(p.title || '').trim();
  const rawBody = String(p.body || '').trim();

  if (MEMBER_POSTABLE_SPACES.indexOf(space) === -1) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'You can only post in the community spaces.' }) };
  }
  if (!title) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Title required' }) };
  if (!rawBody) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Body required' }) };
  if (title.length > MAX_TITLE_CHARS) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Title is too long' }) };
  if (rawBody.length > MAX_BODY_CHARS) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Post is too long' }) };

  try {
    // Resolve the member's account. Every signed-in member has one.
    const accts = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id,name&limit=1', 'GET');
    if (!accts || !accts.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No account found for this session. Refresh and sign in again.' }) };
    }
    const authorId = accts[0].id;
    const authorName = accts[0].name || 'A member';

    // Resolve the target space id.
    const spaces = await sb('spaces?slug=eq.' + encodeURIComponent(space) + '&select=id&limit=1', 'GET');
    if (!spaces || !spaces.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Space not found' }) };
    }
    const spaceId = spaces[0].id;

    const excerpt = rawBody.replace(/\s+/g, ' ').slice(0, 200);
    const row = {
      space_id: spaceId,
      author_id: authorId,
      title: title,
      body_plain: rawBody,
      body_html: toHtml(rawBody),
      excerpt: excerpt,
      comment_count: 0,
      reaction_count: 0,
      post_type: 'discussion',
      ce_candidate: false
    };
    const inserted = await sb('forum_posts', 'POST', row);
    const post = inserted && inserted[0];
    if (!post || !post.id) throw new Error('Insert returned no row');

    // Attach tags. Only canonical tags that already exist are linked; unknown
    // names are ignored (members pick from the fixed set in the UI).
    let attachedTags = [];
    const wantTags = Array.isArray(p.tags) ? p.tags.map(function (t) { return String(t || '').trim(); }).filter(Boolean).slice(0, MAX_TAGS) : [];
    if (wantTags.length) {
      const inList = wantTags.map(function (t) { return '"' + t.replace(/"/g, '') + '"'; }).join(',');
      const tagRows = await sb('tags?name=in.(' + encodeURIComponent(inList) + ')&select=id,name', 'GET');
      if (tagRows && tagRows.length) {
        const links = tagRows.map(function (t) { return { post_id: post.id, tag_id: t.id }; });
        try {
          await fetch(SUPABASE_URL + '/rest/v1/post_tags', {
            method: 'POST',
            headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=minimal,resolution=merge-duplicates' }),
            body: JSON.stringify(links)
          });
          attachedTags = tagRows.map(function (t) { return t.name; });
        } catch (e) { /* tag linking is best-effort; the post still stands */ }
      }
    }

    // Notify all other members in-app (no email blast for member posts).
    try {
      await notifyNewPost(
        { id: post.id, title: title, author_id: authorId },
        { id: authorId, name: authorName },
        { emailBlast: false }
      );
    } catch (e) { /* never block posting */ }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, post_id: post.id, tags: attachedTags }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
