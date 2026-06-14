// netlify/functions/bookmarks.js
// Member saved posts: toggle, list, and reorder. Identity is the gate email
// pre-launch (same posture as roadmap votes); switches to session auth with
// Supabase Auth. Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY.

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }) };

  const sbHeaders = {
    'apikey': KEY,
    'Authorization': 'Bearer ' + KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
  const sb = async (path, method, body) => {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method, headers: sbHeaders, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text.slice(0, 200));
    return text ? JSON.parse(text) : null;
  };

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const email = String(p.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };
  const emailFilter = 'member_email=eq.' + encodeURIComponent(email);

  try {
    if (p.action === 'toggle') {
      const postId = String(p.post_id || '').trim();
      if (!postId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'post_id required' }) };
      const existing = await sb('bookmarks?' + emailFilter + '&post_id=eq.' + encodeURIComponent(postId) + '&select=id', 'GET');
      if (existing && existing.length) {
        await sb('bookmarks?id=eq.' + existing[0].id, 'DELETE');
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, saved: false }) };
      }
      // New bookmarks go to the top (lowest sort_order)
      const top = await sb('bookmarks?' + emailFilter + '&select=sort_order&order=sort_order.asc&limit=1', 'GET');
      const newOrder = (top && top.length) ? top[0].sort_order - 1 : 0;
      await sb('bookmarks', 'POST', { member_email: email, post_id: postId, sort_order: newOrder });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, saved: true }) };
    }

    if (p.action === 'list') {
      const rows = await sb('bookmarks?' + emailFilter + '&select=id,post_id,sort_order,forum_posts(id,title,excerpt,created_at,spaces(name,slug),accounts(name,avatar_url))&order=sort_order.asc', 'GET');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, bookmarks: rows || [] }) };
    }

    if (p.action === 'reorder') {
      // Expects ordered array of bookmark ids; rewrites sort_order 0..n
      const ids = Array.isArray(p.ids) ? p.ids.slice(0, 200) : [];
      if (!ids.length) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'ids required' }) };
      for (let i = 0; i < ids.length; i++) {
        await sb('bookmarks?id=eq.' + encodeURIComponent(ids[i]) + '&' + emailFilter, 'PATCH', { sort_order: i });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
