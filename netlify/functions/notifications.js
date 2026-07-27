// netlify/functions/notifications.js
// In-app notification center: post + comment notifications (member_notifications)
// merged with DM unread (dm_messages) for the bell badge and panel. Token-gated;
// a member only ever sees their own. Service-role writes; clients never read
// member_notifications directly.
//
// Actions:
//   { token, action:'summary' }     -> { posts, comments, dms, total }
//   { token, action:'list' }        -> { items:[post/comment notifs], dms }
//   { token, action:'mark_read', ids?:[...] , all?:true }

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
    const meRows = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1', 'GET');
    if (!meRows || !meRows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No account found.' }) };
    const meId = meRows[0].id;

    if (p.action === 'summary') {
      const posts = await countOf('member_notifications?user_id=eq.' + meId + '&type=in.(post,published)&read_at=is.null&select=id');
      const comments = await countOf('member_notifications?user_id=eq.' + meId + '&type=eq.comment&read_at=is.null&select=id');
      const mentions = await countOf('member_notifications?user_id=eq.' + meId + '&type=eq.mention&read_at=is.null&select=id');
      const dms = await countOf('dm_messages?recipient_id=eq.' + meId + '&read_at=is.null&select=id');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, posts: posts, comments: comments, mentions: mentions, dms: dms, total: posts + comments + mentions + dms }) };
    }

    if (p.action === 'list') {
      const items = await sb('member_notifications?user_id=eq.' + meId + '&order=created_at.desc&limit=40&select=id,type,actor_name,title,post_id,created_at,read_at', 'GET');
      const dms = await countOf('dm_messages?recipient_id=eq.' + meId + '&read_at=is.null&select=id');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, items: items || [], dms: dms }) };
    }

    if (p.action === 'mark_read') {
      const now = new Date().toISOString();
      if (Array.isArray(p.ids) && p.ids.length) {
        const list = p.ids.map(function (x) { return '"' + String(x).replace(/"/g, '') + '"'; }).join(',');
        await sb('member_notifications?user_id=eq.' + meId + '&id=in.(' + encodeURIComponent(list) + ')', 'PATCH', { read_at: now }, 'return=minimal');
      } else {
        await sb('member_notifications?user_id=eq.' + meId + '&read_at=is.null', 'PATCH', { read_at: now }, 'return=minimal');
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
