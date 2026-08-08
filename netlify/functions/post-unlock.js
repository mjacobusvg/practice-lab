// netlify/functions/post-unlock.js
//
// Metered "one free unlock per calendar month" for free-tier members (D).
// A free account may fully unlock ONE otherwise-locked post per UTC calendar
// month: the full body of a member-only post AND its members-only second half,
// plus commenting/reacting on that one post (create-comment.js / reactions.js
// check post_unlocks the same way this does).
//
// The meter is enforced SERVER-SIDE by a unique(account_id, period) constraint on
// post_unlocks — the client can never grant itself a second unlock in a month.
// Paid members (scope 'member') and admins never consume an unlock; they already
// have access. Anonymous visitors have no account to meter, so they must create a
// free account first (the client routes them to signup).
//
// Body:
//   { token, post_id, action:'status' }  -> { ok, this_post_unlocked, has_unlock_available, used_post_id }
//   { token, post_id, action:'unlock' }  -> { ok, unlocked:true, extra_html }  |  403 { used_this_month, unlocked_post_id }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET

const { verifyToken } = require('./_lib/session');
const { toRichHtml } = require('./_lib/richtext');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];

function currentPeriod() {
  // 'YYYY-MM' in UTC. A calendar-month bucket keyed off the server clock.
  return new Date().toISOString().slice(0, 7);
}

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
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }) };
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  const sb = async (path, method, body, prefer) => {
    const h = Object.assign({ 'Content-Type': 'application/json' }, auth);
    if (prefer) h['Prefer'] = prefer;
    const res = await fetch(URL + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
  };

  let p; try { p = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Create a free account first' }) };
  const scope = String(session.claims.scope || '');
  const email = String(session.claims.email || '').trim().toLowerCase();
  if (scope !== 'member' && scope !== 'free') return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Create a free account first' }) };
  if (!email || email.indexOf('@') === -1) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Create a free account first' }) };

  const postId = String(p.post_id || '').trim();
  if (!postId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'post_id required' }) };
  const action = p.action === 'status' ? 'status' : 'unlock';
  const isPrivileged = scope === 'member' || ADMIN_EMAILS.indexOf(email) !== -1;

  // Fetch the members-only second half (service-role only). Null when the post
  // has none. Only ever returned to a caller who is entitled (paid/admin, or a
  // free member with a recorded unlock for this post).
  const fetchExtra = async () => {
    const r = await sb('post_members_extra?post_id=eq.' + encodeURIComponent(postId) + '&select=body&limit=1', 'GET');
    const rows = r.ok ? r.data : [];
    return (rows && rows[0]) ? toRichHtml(rows[0].body || '') : null;
  };

  try {
    // Resolve the account.
    const meRows = (await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1', 'GET')).data;
    if (!meRows || !meRows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No account found.' }) };
    const meId = meRows[0].id;
    const period = currentPeriod();

    // Privileged callers already have full access — never metered.
    if (isPrivileged) {
      if (action === 'status') return { statusCode: 200, headers, body: JSON.stringify({ ok: true, this_post_unlocked: true, has_unlock_available: true, used_post_id: null, privileged: true }) };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, unlocked: true, extra_html: await fetchExtra(), privileged: true }) };
    }

    // Has this member already unlocked THIS post (any month)? If so it stays open.
    const mine = (await sb('post_unlocks?account_id=eq.' + meId + '&post_id=eq.' + encodeURIComponent(postId) + '&select=id&limit=1', 'GET')).data;
    const thisUnlocked = !!(mine && mine.length);

    // What has this member spent the CURRENT month on (if anything)?
    const thisPeriod = (await sb('post_unlocks?account_id=eq.' + meId + '&period=eq.' + encodeURIComponent(period) + '&select=post_id&limit=1', 'GET')).data;
    const usedPostId = (thisPeriod && thisPeriod[0]) ? thisPeriod[0].post_id : null;
    const usedThisMonth = !!usedPostId;

    if (action === 'status') {
      return { statusCode: 200, headers, body: JSON.stringify({
        ok: true,
        this_post_unlocked: thisUnlocked,
        has_unlock_available: !usedThisMonth,
        used_post_id: usedPostId
      }) };
    }

    // action 'unlock'
    if (thisUnlocked) {
      // Idempotent: they already unlocked this post — just hand back the content.
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, unlocked: true, extra_html: await fetchExtra() }) };
    }
    if (usedThisMonth) {
      return { statusCode: 403, headers, body: JSON.stringify({ ok: false, used_this_month: true, unlocked_post_id: usedPostId,
        error: 'You have already used your free unlock this month. It resets next month.' }) };
    }

    // Record the unlock. The unique(account_id, period) constraint is the real
    // guard against a race (two requests in the same month) — a 409 there means
    // the quota was just spent.
    const ins = await sb('post_unlocks', 'POST', { account_id: meId, post_id: postId, period: period }, 'return=minimal');
    if (!ins.ok) {
      if (ins.status === 409) {
        const now = (await sb('post_unlocks?account_id=eq.' + meId + '&period=eq.' + encodeURIComponent(period) + '&select=post_id&limit=1', 'GET')).data;
        const uid = (now && now[0]) ? now[0].post_id : null;
        // If the race resolved to THIS post, treat as success; else quota is spent.
        if (uid === postId) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, unlocked: true, extra_html: await fetchExtra() }) };
        return { statusCode: 403, headers, body: JSON.stringify({ ok: false, used_this_month: true, unlocked_post_id: uid, error: 'You have already used your free unlock this month. It resets next month.' }) };
      }
      throw new Error('unlock insert failed: ' + ins.status);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, unlocked: true, extra_html: await fetchExtra() }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
