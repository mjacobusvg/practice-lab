// netlify/functions/my-templates.js
// Returns the template ids the signed-in member has individually purchased, so
// the library can show them as unlocked. template_purchases is service-role only,
// so the client cannot read it directly. Token-gated; a member only ever sees
// their own purchases.
//
// Body: { token }  ->  { ok, ids: [template_id, ...] }

const { verifyToken } = require('./_lib/session');

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ids: [] }) };
  const email = String(session.claims.email || '').toLowerCase().trim();
  if (!email) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ids: [] }) };

  const sbHeaders = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  try {
    const meRes = await fetch(URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1', { headers: sbHeaders });
    const me = (await meRes.json())[0];
    if (!me) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ids: [] }) };
    const purRes = await fetch(URL + '/rest/v1/template_purchases?account_id=eq.' + me.id + '&select=template_id', { headers: sbHeaders });
    const rows = await purRes.json();
    const ids = (Array.isArray(rows) ? rows : []).map(function (r) { return r.template_id; });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ids: ids }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ids: [] }) };
  }
};
