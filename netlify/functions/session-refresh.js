// netlify/functions/session-refresh.js
//
// Renew a signed session token IN PLACE, without bouncing the member through
// platform.html. Added for audit finding H7 (2026-09-19).
//
// WHY THIS EXISTS
// The session token used to last 30 days, which meant `tier` and `scope` — frozen
// into it at mint time — stayed frozen for 30 days. A cancellation, a downgrade, an
// expired comp or a stolen token all kept working for a month, and nothing could
// stop them: sign-out clears localStorage on ONE device, it cannot invalidate a
// string that has already been copied elsewhere.
//
// The fix is a short TTL, and a short TTL is only humane if renewal is invisible.
// auth-gate.js has no Supabase client and no access token, so its only renewal path
// was a full-page redirect to platform.html — which in the Scribe, mid-encounter,
// would throw away whatever the clinician had on screen. This endpoint renews from
// the token alone, in a fetch, with nothing on screen changing.
//
// WHAT IT IS NOT
// It is not a second way in. It refuses anything that is not already a valid,
// unexpired, correctly signed token, so it can only ever EXTEND a live session —
// never create one. Four separate things stop it extending a session forever:
//
//   1. The token must verify and must not be expired. An expired token is not
//      refreshable at any grace period: that would make the TTL a suggestion.
//      Expired means the normal platform.html re-mint, which requires a live
//      Supabase session.
//   2. The refresh CHAIN is capped at REFRESH_MAX_AGE_MS from the original login
//      (`sid`). Past that, proving a Supabase session again is mandatory.
//   3. `accounts.sessions_valid_from` is the revocation epoch. If it is newer than
//      the session start, the session is dead and cannot be renewed — so it expires
//      at its own TTL and that is the end of it. Setting that column to now() kills
//      every live session for an account, on every device, which is the thing H7
//      said was impossible.
//   4. tier and scope are RE-READ from the accounts row on every refresh. A member
//      who dropped to free gets a free-scope token at their next half-life refresh,
//      not their old one for another month.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET (via _lib/session)

const { verifyToken, mintToken, sessionStartedAt, REFRESH_MAX_AGE_MS } = require('./_lib/session');

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ refreshed: false, reason: 'method_not_allowed' }) };
  }

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ refreshed: false, reason: 'server_misconfigured' }) };
  }

  let token = '';
  try {
    const body = JSON.parse(event.body || '{}');
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    token = String(body.token || authHeader.replace(/^Bearer\s+/i, '') || '').trim();
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ refreshed: false, reason: 'bad_request' }) };
  }

  // 1) It must already be a live session. Signature and expiry both.
  const check = verifyToken(token);
  if (!check.valid) {
    return { statusCode: 401, headers, body: JSON.stringify({ refreshed: false, reason: check.reason }) };
  }
  const claims = check.claims;
  const email = String(claims.email || '').toLowerCase().trim();
  if (!email) {
    return { statusCode: 401, headers, body: JSON.stringify({ refreshed: false, reason: 'malformed' }) };
  }

  // 2) The chain cannot outlive the cap, counted from the ORIGINAL login.
  const startedAt = sessionStartedAt(claims);
  if (!startedAt || Date.now() - startedAt > REFRESH_MAX_AGE_MS) {
    return { statusCode: 401, headers, body: JSON.stringify({ refreshed: false, reason: 'chain_expired' }) };
  }

  try {
    // 3) Re-read the account. This is the whole point: tier, scope and revocation
    //    all come from the row as it is NOW, not as it was when they logged in.
    const svc = { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY };
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) +
      '&select=email,tier,is_admin,circle_member_id,templates_blocked,sessions_valid_from&limit=1',
      { headers: svc });

    // A read that FAILED is not a read that returned nothing. Refusing to refresh on
    // a Supabase blip would sign people out during an outage, so say so and let the
    // caller keep its existing (still valid) token until the next attempt.
    if (!res.ok) {
      return { statusCode: 503, headers, body: JSON.stringify({ refreshed: false, reason: 'lookup_failed' }) };
    }
    const rows = await res.json();
    const acct = rows && rows[0];

    // No account row means the account is gone. That is not a blip; do not renew.
    if (!acct) {
      return { statusCode: 401, headers, body: JSON.stringify({ refreshed: false, reason: 'no_account' }) };
    }

    // 4) Revocation. Sessions that began before the epoch are dead.
    if (acct.sessions_valid_from) {
      const epoch = Date.parse(acct.sessions_valid_from);
      if (!isNaN(epoch) && startedAt < epoch) {
        return { statusCode: 401, headers, body: JSON.stringify({ refreshed: false, reason: 'revoked' }) };
      }
    }

    // 5) Mint from current data, carrying the chain start forward unchanged.
    const tier = acct.tier ? String(acct.tier).toLowerCase() : 'free';
    const scope = (tier === 'forum' || tier === 'full') ? 'member' : 'free';
    const fresh = mintToken({
      email: email,
      scope: scope,
      tier: tier,
      communityMemberId: acct.circle_member_id != null ? acct.circle_member_id : null,
      chainStartedAt: startedAt
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        refreshed: true,
        token: fresh,
        email: email,
        tier: tier,
        is_admin: !!acct.is_admin,
        templates_blocked: !!acct.templates_blocked
      })
    };
  } catch (e) {
    return { statusCode: 503, headers, body: JSON.stringify({ refreshed: false, reason: 'lookup_failed' }) };
  }
};
