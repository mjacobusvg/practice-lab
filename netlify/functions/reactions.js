// netlify/functions/reactions.js
// Toggle a member's reaction on a post or comment. Identity from the signed
// token; one reaction per member per target (changing kind updates it, same kind
// removes it). Keeps forum_posts/forum_comments.reaction_count in sync.
// Reads are public (RLS); writes go through here with the service key.
//
// Action: { token, action:'toggle', target_type:'post'|'comment', target_id, kind }

const { verifyToken } = require('./_lib/session');

const KINDS = ['heart', 'helpful', 'insight'];

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
  // 'member' (forum/full) may react anywhere; 'free' may react only on posts
  // opened to free members (enforced per-target below). Nothing else.
  const scope = String(session.claims.scope || '');
  if (scope !== 'member' && scope !== 'free') return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Members only' }) };
  const email = String(session.claims.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };

  const targetType = p.target_type === 'comment' ? 'comment' : (p.target_type === 'post' ? 'post' : null);
  const targetId = String(p.target_id || '').trim();
  const kind = KINDS.indexOf(p.kind) !== -1 ? p.kind : 'heart';
  if (!targetType || !targetId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'target_type and target_id required' }) };

  const col = targetType === 'post' ? 'post_id' : 'comment_id';
  const table = targetType === 'post' ? 'forum_posts' : 'forum_comments';

  try {
    const meRows = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1', 'GET');
    if (!meRows || !meRows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No account found.' }) };
    const meId = meRows[0].id;

    // Free-tier accounts may react only on posts opened to free members (mirror
    // create-comment). For a comment target, the parent post's flag governs.
    if (scope !== 'member') {
      let pv = null;
      if (targetType === 'post') {
        const pr = await sb('forum_posts?id=eq.' + encodeURIComponent(targetId) + '&select=free_visible&limit=1', 'GET');
        pv = pr && pr[0];
      } else {
        const cr = await sb('forum_comments?id=eq.' + encodeURIComponent(targetId) + '&select=post_id&limit=1', 'GET');
        if (cr && cr[0]) {
          const pr = await sb('forum_posts?id=eq.' + encodeURIComponent(cr[0].post_id) + '&select=free_visible&limit=1', 'GET');
          pv = pr && pr[0];
        }
      }
      if (!pv || !pv.free_visible) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Join to react to this thread' }) };
    }

    const existing = await sb('reactions?account_id=eq.' + meId + '&' + col + '=eq.' + encodeURIComponent(targetId) + '&select=id,reaction_type&limit=1', 'GET');
    let myKind = null;
    if (existing && existing.length) {
      if (existing[0].reaction_type === kind) {
        await sb('reactions?id=eq.' + existing[0].id, 'DELETE', null, 'return=minimal');
        myKind = null;
      } else {
        await sb('reactions?id=eq.' + existing[0].id, 'PATCH', { reaction_type: kind }, 'return=minimal');
        myKind = kind;
      }
    } else {
      const row = { account_id: meId, reaction_type: kind };
      row[col] = targetId;
      await sb('reactions', 'POST', row, 'return=minimal');
      myKind = kind;
    }

    const count = await countOf('reactions?' + col + '=eq.' + encodeURIComponent(targetId) + '&select=id');
    try { await sb(table + '?id=eq.' + encodeURIComponent(targetId), 'PATCH', { reaction_count: count }, 'return=minimal'); } catch (e) {}

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, count: count, my_kind: myKind }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
