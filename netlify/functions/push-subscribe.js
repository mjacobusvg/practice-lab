// netlify/functions/push-subscribe.js
//
// Stores (or removes) a member's Web Push subscription so the server can send
// phone notifications. Identity is the signed session token; the subscription is
// always tied to the account that owns the token, so a member can only register
// push for themselves.
//
// Actions (POST JSON):
//   { token, action:'subscribe', subscription:{endpoint,keys:{p256dh,auth}}, ua }
//   { token, action:'unsubscribe', endpoint }
//   { token, action:'status', endpoint }   -> { ok, subscribed:boolean }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { verifyToken } = require('./_lib/session');

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

  const sb = async (path, method, body, prefer) => {
    const h = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
    if (prefer) h['Prefer'] = prefer;
    const res = await fetch(URL + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error('sb ' + res.status + ': ' + text.slice(0, 150));
    return text ? JSON.parse(text) : null;
  };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };
  const email = String(session.claims.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };

  try {
    const meRows = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1', 'GET');
    if (!meRows || !meRows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No account' }) };
    const accountId = meRows[0].id;

    if (p.action === 'subscribe') {
      const sub = p.subscription || {};
      const endpoint = String(sub.endpoint || '').trim();
      const keys = sub.keys || {};
      const p256dh = String(keys.p256dh || '').trim();
      const auth = String(keys.auth || '').trim();
      if (!endpoint || !p256dh || !auth) {
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Incomplete subscription' }) };
      }
      // Upsert on the unique endpoint: re-subscribing from the same device (or a
      // re-issued endpoint) updates ownership/keys and re-enables, rather than
      // creating duplicate rows.
      const row = {
        account_id: accountId,
        email: email,
        endpoint: endpoint,
        p256dh: p256dh,
        auth: auth,
        enabled: true,
        fail_count: 0,
        ua: String(p.ua || '').slice(0, 300),
        created_at: new Date().toISOString()
      };
      await sb('push_subscriptions?on_conflict=endpoint', 'POST', row, 'resolution=merge-duplicates,return=minimal');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, subscribed: true }) };
    }

    if (p.action === 'unsubscribe') {
      const endpoint = String(p.endpoint || '').trim();
      if (!endpoint) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'endpoint required' }) };
      // Only touch this member's own subscription for that endpoint.
      await sb('push_subscriptions?endpoint=eq.' + encodeURIComponent(endpoint) + '&account_id=eq.' + accountId, 'DELETE', null, 'return=minimal');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, subscribed: false }) };
    }

    if (p.action === 'status') {
      const endpoint = String(p.endpoint || '').trim();
      if (!endpoint) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, subscribed: false }) };
      const rows = await sb('push_subscriptions?endpoint=eq.' + encodeURIComponent(endpoint) + '&account_id=eq.' + accountId + '&enabled=is.true&select=id&limit=1', 'GET');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, subscribed: !!(rows && rows.length) }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
