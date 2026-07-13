// netlify/functions/whats-new.js
// "What you missed" since the member's last visit. Returns the count of new posts
// (by anyone but them) plus a short peek, using accounts.last_seen_at as the
// watermark, then advances the watermark to now. Identity is the signed token.
//
// Action (default): { token }  ->  { since, new_posts, recent:[{id,title,space,created_at}] }
// A 'peek' action does the same read WITHOUT advancing the watermark.

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
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }) };
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  const sb = async (path, method, body, prefer) => {
    const h = Object.assign({ 'Content-Type': 'application/json' }, auth);
    if (prefer) h['Prefer'] = prefer;
    const res = await fetch(URL + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text.slice(0, 150));
    return text ? JSON.parse(text) : null;
  };
  const countOf = async (path) => {
    const res = await fetch(URL + '/rest/v1/' + path, { headers: Object.assign({ 'Prefer': 'count=exact', 'Range': '0-0' }, auth) });
    const cr = res.headers.get('content-range') || '';
    return parseInt((cr.split('/')[1] || '0'), 10) || 0;
  };

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };
  if (session.claims.scope !== 'member') return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Members only' }) };
  const email = String(session.claims.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };

  try {
    const meRows = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id,last_seen_at,created_at&limit=1', 'GET');
    if (!meRows || !meRows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No account found.' }) };
    const me = meRows[0];

    // Watermark: last visit, or a week ago for a first-ever visit (so the first
    // banner is a sensible recent window, not the whole archive).
    let since = me.last_seen_at;
    if (!since) since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const sinceEnc = encodeURIComponent(since);
    const newPosts = await countOf('forum_posts?created_at=gt.' + sinceEnc + '&author_id=neq.' + me.id + '&select=id');
    const recent = await sb('forum_posts?created_at=gt.' + sinceEnc + '&author_id=neq.' + me.id + '&order=created_at.desc&limit=5&select=id,title,created_at,spaces(name)', 'GET');
    const recentOut = (recent || []).map(function (r) {
      return { id: r.id, title: r.title, created_at: r.created_at, space: r.spaces ? r.spaces.name : '' };
    });

    // Advance the watermark unless this is a non-committal peek.
    if (p.action !== 'peek') {
      try { await sb('accounts?id=eq.' + me.id, 'PATCH', { last_seen_at: new Date().toISOString() }, 'return=minimal'); } catch (e) {}
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, since: since, new_posts: newPosts, recent: recentOut }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
