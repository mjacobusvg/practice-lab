// netlify/functions/admin-signin-link.js
//
// ADMIN-ONLY. Generates a copy-paste one-click sign-in link for any email so a
// locked-out user can be let in WITHOUT depending on their inbox (magic-link
// email deliverability). The returned URL routes to one-click-signin, which
// mints a FRESH Supabase magic link at click time and logs the person straight
// in. The link is a bearer credential for that email — same risk profile as a
// magic link — so this endpoint is gated to admins only.
//
// Body: { token, email }  ->  { ok, email, url, accountExists }
// Env: SESSION_SIGNING_SECRET (via _lib/signin-token + _lib/session),
//      SUPABASE_URL, SUPABASE_SERVICE_KEY (optional, for the account-exists check)

const { verifyToken } = require('./_lib/session');
const { mintSigninToken } = require('./_lib/signin-token');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];
const SITE = 'https://thinkbeyondpractice.com';

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }

  // Admin gate: verified session token whose email is an admin.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid || ADMIN_EMAILS.indexOf(String(session.claims.email || '').toLowerCase()) === -1) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Admin only' }) };
  }

  const email = String(p.email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Enter a valid email.' }) };
  }

  // Best-effort: does an account already exist? (flags typos / brand-new emails)
  let accountExists = null;
  try {
    const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
    if (URL && KEY) {
      const r = await fetch(URL + '/rest/v1/accounts?select=email&email=eq.' + encodeURIComponent(email) + '&limit=1',
        { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
      const rows = r.ok ? await r.json() : [];
      accountExists = Array.isArray(rows) && rows.length > 0;
    }
  } catch (e) { /* non-fatal */ }

  let url;
  try {
    url = SITE + '/.netlify/functions/one-click-signin?t=' + mintSigninToken(email);
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Server not configured (signing secret).' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, email, url, accountExists }) };
};
