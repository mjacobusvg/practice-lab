// netlify/functions/broadcast-stats.js
// Admin-only: past broadcasts with per-send engagement (the Sent / Opened /
// Clicked / Unsubscribed table Circle showed). Unique counts are computed by
// distinct recipient email per broadcast.
//
// Body: { token, limit? }
// -> { ok, broadcasts:[{ id, subject, audience, sent, opened, clicked, unsub,
//                        open_rate, click_rate, created_at }] }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

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
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid || ADMIN_EMAILS.indexOf(String(session.claims.email || '').toLowerCase()) === -1) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Admin only' }) };
  }

  const sb = async (path) => {
    const res = await fetch(URL + '/rest/v1/' + path, { headers: Object.assign({ 'Content-Type': 'application/json' }, auth) });
    if (!res.ok) return [];
    const t = await res.text();
    return t ? JSON.parse(t) : [];
  };

  try {
    const limit = Math.min(Math.max(parseInt(p.limit, 10) || 40, 1), 200);
    const rows = await sb('broadcasts?status=eq.sent&select=id,subject,audience,recipient_count,created_at&order=created_at.desc&limit=' + limit);
    if (!rows.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, broadcasts: [] }) };

    const ids = rows.map(function (r) { return r.id; });
    const inList = '(' + ids.map(function (i) { return '"' + i + '"'; }).join(',') + ')';
    // Pull events for these broadcasts (bounded) and aggregate unique emails per kind.
    const events = await sb('broadcast_events?broadcast_id=in.' + encodeURIComponent(inList) + '&select=broadcast_id,email,kind&limit=100000');
    const agg = {};
    events.forEach(function (e) {
      const b = agg[e.broadcast_id] || (agg[e.broadcast_id] = { open: {}, click: {}, unsub: {} });
      if (b[e.kind]) b[e.kind][String(e.email).toLowerCase()] = true;
    });

    const out = rows.map(function (r) {
      const a = agg[r.id] || { open: {}, click: {}, unsub: {} };
      const sent = r.recipient_count || 0;
      const opened = Object.keys(a.open).length, clicked = Object.keys(a.click).length, unsub = Object.keys(a.unsub).length;
      return {
        id: r.id, subject: r.subject, audience: r.audience, sent: sent,
        opened: opened, clicked: clicked, unsub: unsub,
        open_rate: sent ? Math.round((opened / sent) * 100) : 0,
        click_rate: sent ? Math.round((clicked / sent) * 100) : 0,
        created_at: r.created_at
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, broadcasts: out }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
