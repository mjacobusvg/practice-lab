// netlify/functions/log-error.js
// Client-side error sink. The platform's global error handlers POST here when a
// script error or unhandled rejection fires, so failures that would otherwise
// die silently in a member's browser become visible to the admin.
//
// Best-effort and defensive: never throws back to the page, caps field sizes,
// and attributes the error to a member only if a valid session token is present
// (we never trust a client-supplied email).
//
// Body: { message, stack?, page?, ua?, token? }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET (via _lib/session)

const { verifyToken } = require('./_lib/session');

function clip(v, n) { return v == null ? null : String(v).slice(0, n); }

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false }) };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) }; // swallow

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) }; }
  const message = clip(p.message, 1000);
  if (!message) return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  let email = null, tier = null;
  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
    if (token) {
      const s = verifyToken(token);
      if (s.valid) { email = String(s.claims.email || '').toLowerCase() || null; tier = s.claims.tier || null; }
    }
  } catch (e) { /* anon is fine */ }

  try {
    await fetch(URL + '/rest/v1/client_errors', {
      method: 'POST',
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        email: email, tier: tier,
        page: clip(p.page, 300), message: message,
        stack: clip(p.stack, 4000), user_agent: clip(p.ua || event.headers['user-agent'], 400)
      })
    });
  } catch (e) { /* best-effort */ }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
