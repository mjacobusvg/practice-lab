// netlify/functions/log-view.js
// Records which member opened which page (page_views).
// Identity comes from the verified signed token, never from the browser.
//
// NOTE: this previously used a local, INCORRECT copy of verifyToken (it HMACed
// the base64 header instead of the decoded JSON payload, and treated `exp` as
// seconds when the minter writes milliseconds). That rejected every real token,
// so page_views stayed empty. It now uses the shared _lib/session verifier, so
// the algorithm is guaranteed to match the minters (circle-auth / platform-auth).

const { verifyToken } = require('./_lib/session');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'bad json' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();

  const session = verifyToken(token);
  if (!session.valid || !session.claims || !session.claims.email) {
    return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'server misconfigured' }) };
  }

  const path = String(body.path || '/').slice(0, 200);
  const row = {
    email: String(session.claims.email).toLowerCase().trim(),
    tier: session.claims.tier || null,
    path: path
  };

  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/page_views', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(row)
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('page_views insert failed:', res.status, t.slice(0, 200));
      return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'insert failed' }) };
    }
  } catch (e) {
    console.error('page_views insert error:', e && e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'insert error' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
