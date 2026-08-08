// netlify/functions/post-members-extra.js
// Serves the true-locked "members-only second half" of a post.
//
// The locked body lives in post_members_extra, a table only the service role can
// read (RLS on, no policy, privileges revoked from anon/authenticated). So the
// content NEVER reaches a free or logged-out browser — this endpoint is the only
// way to get it, and it hands it out only to a signed-in PAID member.
//
// Identity + tier come from the SIGNED session token, never the client. Paid =
// scope 'member' (forum/full). Free/anon get 403 (the UI shows the unlock CTA).
//
// Body: { token, post_id }  ->  { ok:true, html }  |  403 { ok:false, locked:true }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET

const { verifyToken } = require('./_lib/session');
const { toRichHtml } = require('./_lib/richtext');
const { hasUnlock } = require('./_lib/unlocks');

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

  const SUPABASE_URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }) };

  let p; try { p = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };

  // Paid members only. scope 'member' == forum/full; 'free' and anything else
  // are locked out (the client renders the unlock CTA for them). Admins always
  // pass so the author can see their own locked section.
  const scope = String(session.claims.scope || '');
  const email = String(session.claims.email || '').toLowerCase();
  const postId = String(p.post_id || '').trim();
  if (!postId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'post_id required' }) };

  // Paid (scope 'member') and admins always pass. A free member passes only for a
  // post they've spent their monthly free unlock on (D) — checked against their
  // account id, so the client can never fake entitlement.
  let allowed = scope === 'member' || ADMIN_EMAILS.indexOf(email) !== -1;
  if (!allowed && scope === 'free' && email.indexOf('@') !== -1) {
    try {
      const meRes = await fetch(
        SUPABASE_URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1',
        { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } }
      );
      const meRows = meRes.ok ? await meRes.json() : [];
      if (meRows && meRows[0]) allowed = await hasUnlock(SUPABASE_URL, KEY, meRows[0].id, postId);
    } catch (e) { /* fail closed */ }
  }
  if (!allowed) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, locked: true, error: 'Members only' }) };

  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/post_members_extra?post_id=eq.' + encodeURIComponent(postId) + '&select=body&limit=1',
      { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } }
    );
    const rows = res.ok ? await res.json() : [];
    if (!rows || !rows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No members-only section' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, html: toRichHtml(rows[0].body || '') }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
