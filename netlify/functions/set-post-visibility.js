// netlify/functions/set-post-visibility.js
// Admin-only: toggle a post's free_visible / free_readonly flags. free_visible
// true lets free-tier members read the full post instead of the teaser (for
// rotating "free post of the week" lead-magnets). free_readonly true (only
// meaningful alongside free_visible) further restricts free members to READING —
// no commenting or reacting — for Case Discussion conversion previews. Either
// field may be sent; only the provided fields are updated. Writes with the
// service key.
//
// Body: { token, post_id, free_visible?, free_readonly? }

const { verifyToken } = require('./_lib/session');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  const email = String(session.claims && session.claims.email || '').toLowerCase();
  if (!session.valid || ADMIN_EMAILS.indexOf(email) === -1) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Admin only' }) };

  const postId = String(p.post_id || '').trim();
  if (!postId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'post_id required' }) };

  // Update only the flag(s) explicitly provided in the body.
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(p, 'free_visible')) patch.free_visible = !!p.free_visible;
  if (Object.prototype.hasOwnProperty.call(p, 'free_readonly')) patch.free_readonly = !!p.free_readonly;
  // A read-only post must be free-visible to be readable by free members at all.
  if (patch.free_readonly === true) patch.free_visible = true;
  if (!Object.keys(patch).length) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Nothing to update' }) };

  try {
    const res = await fetch(URL + '/rest/v1/forum_posts?id=eq.' + encodeURIComponent(postId), {
      method: 'PATCH',
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(patch)
    });
    const text = await res.text();
    if (!res.ok) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Supabase ' + res.status + ': ' + text.slice(0, 150) }) };
    const rows = text ? JSON.parse(text) : [];
    if (!rows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Post not found' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, free_visible: rows[0].free_visible, free_readonly: rows[0].free_readonly }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
