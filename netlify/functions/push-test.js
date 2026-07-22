// netlify/functions/push-test.js
//
// Sends a single test push to the CALLER'S OWN devices, so a member can confirm
// notifications actually reach their phone/desktop. It only ever targets the
// account that owns the signed token, so it cannot be used to notify anyone else.
// Doubles as the health check for the VAPID env vars: if they are missing or
// wrong, sent = 0.
//
// Body: { token }  ->  { ok, sent, pruned }

const { verifyToken } = require('./_lib/session');
const { sendToAccounts, ensureConfigured } = require('./_lib/webpush');

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

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };
  const email = String(session.claims.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };

  if (!ensureConfigured()) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, sent: 0, error: 'Push is not configured on the server yet (VAPID keys missing).' }) };
  }

  try {
    const res = await fetch(URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1',
      { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
    const rows = res.ok ? await res.json() : [];
    if (!rows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No account' }) };

    const result = await sendToAccounts([rows[0].id], {
      title: 'Think Beyond Practice',
      body: 'Test notification — you\'re all set. This is how new posts, replies, and messages will reach you.',
      url: 'https://thinkbeyondpractice.com/platform.html',
      tag: 'push-test'
    });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, sent: result.sent, pruned: result.pruned }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
