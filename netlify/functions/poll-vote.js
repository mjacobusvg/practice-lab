// netlify/functions/poll-vote.js
// Cast or read a member's vote on a post's poll. Identity is the signed token;
// one vote per member per poll (voting again changes it). Tallies are computed
// server-side and returned as { counts, total, my_option } so the client never
// reads the private poll_votes table directly.
//
// Actions:
//   { token, action:'results', post_id }
//   { token, action:'vote', post_id, option_id }

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

  const postId = String(p.post_id || '').trim();
  if (!postId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'post_id required' }) };

  // Tally every vote for the poll and find this member's choice.
  const tally = async (meId) => {
    const rows = await sb('poll_votes?post_id=eq.' + encodeURIComponent(postId) + '&select=account_id,option_id', 'GET');
    const counts = {};
    let total = 0, myOption = null;
    (rows || []).forEach(function (r) {
      counts[r.option_id] = (counts[r.option_id] || 0) + 1;
      total++;
      if (meId && r.account_id === meId) myOption = r.option_id;
    });
    return { counts: counts, total: total, my_option: myOption };
  };

  try {
    const meRows = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1', 'GET');
    if (!meRows || !meRows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No account found.' }) };
    const meId = meRows[0].id;

    if (p.action === 'results') {
      const t = await tally(meId);
      return { statusCode: 200, headers, body: JSON.stringify(Object.assign({ ok: true }, t)) };
    }

    if (p.action === 'vote') {
      const optionId = String(p.option_id || '').trim();
      if (!optionId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'option_id required' }) };

      // The option must be one this post's poll actually offers.
      const posts = await sb('forum_posts?id=eq.' + encodeURIComponent(postId) + '&select=id,poll&limit=1', 'GET');
      if (!posts || !posts.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Post not found' }) };
      const poll = posts[0].poll;
      if (!poll || !Array.isArray(poll.options) || !poll.options.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'This post has no poll' }) };
      }
      const valid = poll.options.some(function (o) { return o && o.id === optionId; });
      if (!valid) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown option' }) };

      // One vote per member: update if they already voted, else insert.
      const existing = await sb('poll_votes?post_id=eq.' + encodeURIComponent(postId) + '&account_id=eq.' + meId + '&select=id&limit=1', 'GET');
      if (existing && existing.length) {
        await sb('poll_votes?id=eq.' + existing[0].id, 'PATCH', { option_id: optionId, updated_at: new Date().toISOString() }, 'return=minimal');
      } else {
        await sb('poll_votes', 'POST', { post_id: postId, account_id: meId, option_id: optionId }, 'return=minimal');
      }

      const t = await tally(meId);
      return { statusCode: 200, headers, body: JSON.stringify(Object.assign({ ok: true }, t)) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
