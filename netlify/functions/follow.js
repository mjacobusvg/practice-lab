// netlify/functions/follow.js
// A member follows a thread (post) or a topic (tag) to keep it close. Following a
// thread means new comments on it notify you even if you never commented;
// following a topic collects its posts in your Following view. Identity is the
// signed token; the follows table is service-role only (no client reads it).
//
// Actions:
//   { token, action:'toggle', target_type:'post'|'tag', target_id }
//   { token, action:'list' }                 -> { posts:[ids], tags:[names] }
//   { token, action:'status', target_type, target_id } -> { following:bool }

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

    if (p.action === 'list') {
      const rows = await sb('follows?account_id=eq.' + meId + '&select=target_type,target_id', 'GET');
      const posts = [], tags = [];
      (rows || []).forEach(function (r) { if (r.target_type === 'post') posts.push(r.target_id); else if (r.target_type === 'tag') tags.push(r.target_id); });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, posts: posts, tags: tags }) };
    }

    const targetType = p.target_type === 'tag' ? 'tag' : (p.target_type === 'post' ? 'post' : null);
    const targetId = String(p.target_id || '').trim();
    if (!targetType || !targetId || targetId.length > 200) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'target_type and target_id required' }) };
    }

    if (p.action === 'status') {
      const rows = await sb('follows?account_id=eq.' + meId + '&target_type=eq.' + targetType + '&target_id=eq.' + encodeURIComponent(targetId) + '&select=id&limit=1', 'GET');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, following: !!(rows && rows.length) }) };
    }

    if (p.action === 'toggle') {
      const rows = await sb('follows?account_id=eq.' + meId + '&target_type=eq.' + targetType + '&target_id=eq.' + encodeURIComponent(targetId) + '&select=id&limit=1', 'GET');
      let following;
      if (rows && rows.length) {
        await sb('follows?id=eq.' + rows[0].id, 'DELETE', null, 'return=minimal');
        following = false;
      } else {
        await sb('follows', 'POST', { account_id: meId, target_type: targetType, target_id: targetId }, 'return=minimal');
        following = true;
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, following: following }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
