// netlify/functions/forum-ack.js
// Records and reports a member's one-time acknowledgment of the community rules
// (the "no PHI / no personal health information" forum notice). This is the
// server-side record that turns "we showed a notice" into "this member
// acknowledged it, on this date, for this rules version."
//
// Actions:
//   { token, action:'status', version } -> { ok, accepted:boolean, version }
//   { token, action:'accept', version } -> { ok }
//
// The member is identified by their signed session token. Writes use the
// service key. Re-acknowledgment is required only when FORUM_RULES_VERSION is
// bumped (the client sends its version; we record exactly what was shown).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { verifyToken } = require('./_lib/session');

const CURRENT_VERSION = 1; // keep in sync with FORUM_RULES_VERSION in platform.html

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
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  const sb = async (path, method, body, prefer) => {
    const h = Object.assign({ 'Content-Type': 'application/json' }, auth);
    if (prefer) h['Prefer'] = prefer;
    const res = await fetch(URL + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text.slice(0, 150));
    return text ? JSON.parse(text) : null;
  };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };
  const email = String(session.claims.email || '').toLowerCase().trim();
  if (!email || email.indexOf('@') === -1) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };

  // Only accept the version this server knows about (ignore a stale/rogue client value).
  const version = (parseInt(p.version, 10) === CURRENT_VERSION) ? CURRENT_VERSION : CURRENT_VERSION;

  try {
    if (p.action === 'status') {
      const rows = await sb('forum_rules_acceptances?email=eq.' + encodeURIComponent(email) + '&version=eq.' + version + '&select=id&limit=1', 'GET');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, accepted: !!(rows && rows.length), version: version }) };
    }
    if (p.action === 'accept') {
      // on_conflict merge-duplicates makes re-acceptance idempotent (keeps first timestamp).
      await sb('forum_rules_acceptances?on_conflict=email,version', 'POST',
        { email: email, version: version }, 'resolution=ignore-duplicates,return=minimal');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, version: version }) };
    }
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
