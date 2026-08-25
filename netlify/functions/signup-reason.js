// netlify/functions/signup-reason.js
//
// Records a member's one-click answer to "what brought you to Think Beyond Practice?"
// (from the paid-welcome email), then bounces them to the platform ALREADY signed in
// via the existing one-click-signin flow. So a single tap both captures the signal and
// activates the member, and a bad/expired token just lands them at the normal gate.
//
// GET ?t=<signin token>&r=<reason slug>
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET (via signin-token)

const { verifySigninToken } = require('./_lib/signin-token');

const SITE = 'https://thinkbeyondpractice.com';
// Keep in sync with REASONS in _lib/paid-welcome.js.
const ALLOWED = { scribe: 1, coding: 1, community: 1, tools: 1, other: 1 };

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const token = q.t || '';
  const reason = String(q.r || '').toLowerCase().trim();

  // Where we send them afterward: signed in via one-click-signin, landing on /platform.
  const onward = token
    ? SITE + '/.netlify/functions/one-click-signin?t=' + encodeURIComponent(token) + '&r=' + encodeURIComponent('/platform')
    : SITE + '/platform';
  const bounce = { statusCode: 302, headers: { Location: onward, 'Cache-Control': 'no-store' }, body: '' };

  const v = verifySigninToken(token);
  if (!v.valid || !ALLOWED[reason]) return bounce; // still sign them in; just don't record

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return bounce;
  const sbHeaders = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const email = v.email;

  try {
    // Resolve the account so the reason ties to it (email kept as a fallback label).
    let accountId = null;
    try {
      const r = await fetch(URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1', { headers: sbHeaders });
      const rows = await r.json();
      if (rows && rows[0]) accountId = rows[0].id;
    } catch (e) { /* fall through with null account */ }

    // Upsert on (account_id, source) so a member changing their answer updates it.
    // When we can't resolve an account, insert a plain row (no unique target).
    const row = { account_id: accountId, email: email, reason: reason, source: 'paid_welcome' };
    const path = accountId
      ? 'signup_reasons?on_conflict=account_id,source'
      : 'signup_reasons';
    const prefer = accountId
      ? 'return=minimal,resolution=merge-duplicates'
      : 'return=minimal';
    await fetch(URL + '/rest/v1/' + path, {
      method: 'POST',
      headers: Object.assign({}, sbHeaders, { Prefer: prefer }),
      body: JSON.stringify(row)
    });
  } catch (e) {
    console.log('signup-reason record error:', e && e.message);
  }

  return bounce;
};
