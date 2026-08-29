// netlify/functions/check-entitlement.js
//
// READ-ONLY: returns the active per-feature entitlements for the signed-in member.
// Lets a tool's client-side gate (auth-gate.js protect({feature})) show a forum
// member the tool + a trial banner when they hold a hand-granted pass, instead of
// the upgrade wall. This is a UX convenience only — the real enforcement is the
// server gate in clinical-proxy.js, which re-checks the same table and fails closed.
//
// GET/POST { token } (or Bearer) -> { ok, entitlements: [{ feature, expires_at }] }
//   optional ?feature=letter_generator narrows to one; adds { active, expires_at }.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET

const { verifyToken } = require('./_lib/session');

exports.handler = async function (event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: 'Server not configured' }) };

  // Token from query, body, or Authorization header.
  let token = '';
  try {
    const q = event.queryStringParameters || {};
    let bodyTok = '';
    if (event.body) { try { bodyTok = (JSON.parse(event.body) || {}).token || ''; } catch (e) {} }
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    token = (q.token || bodyTok || authHeader.replace(/^Bearer\s+/i, '')).trim();
  } catch (e) {}

  const session = verifyToken(token);
  if (!session.valid) return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'Invalid or expired session' }) };
  const email = String(session.claims.email || '').trim().toLowerCase();
  if (!email) return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'No email in session' }) };

  const feature = String((event.queryStringParameters || {}).feature || '').trim();

  try {
    const nowIso = new Date().toISOString();
    let path = URL + '/rest/v1/feature_entitlements?email=eq.' + encodeURIComponent(email) +
      '&expires_at=gt.' + encodeURIComponent(nowIso) + '&select=feature,expires_at';
    if (feature) path += '&feature=eq.' + encodeURIComponent(feature);
    const res = await fetch(path, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
    const rows = res.ok ? await res.json() : [];
    const entitlements = Array.isArray(rows) ? rows : [];
    const out = { ok: true, entitlements };
    if (feature) {
      const match = entitlements.find(function (r) { return r.feature === feature; });
      out.active = !!match;
      out.expires_at = match ? match.expires_at : null;
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
