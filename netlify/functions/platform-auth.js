// netlify/functions/platform-auth.js
//
// Mints a SIGNED session token for a platform.html user who authenticated via
// SUPABASE AUTH (magic link / Google OAuth). This is the Supabase-side equivalent
// of circle-auth.js (which mints for Circle-authenticated tool-page users).
//
// The client sends its Supabase ACCESS TOKEN. We VERIFY it server-side against
// Supabase Auth (GET /auth/v1/user with that bearer) — we never trust a
// client-supplied email/tier. We then look up the linked account row for tier +
// admin + circle_member_id and mint our signed token from verified data.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY, SESSION_SIGNING_SECRET (via _lib/session)

const { mintToken } = require('./_lib/session');

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ verified: false, message: 'Method not allowed' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  // Anon key is public by design; used only as the apikey header to route the
  // /auth/v1/user verify call. The actual verification is the user's access token
  // in the Authorization header. Fall back to the service key if the anon env var
  // isn't set (avoids a hard dependency on a maybe-missing var).
  const APIKEY = process.env.SUPABASE_ANON_KEY || SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ verified: false, message: 'Server configuration error' }) };
  }

  let accessToken;
  try {
    const body = JSON.parse(event.body || '{}');
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    accessToken = (body.accessToken || authHeader.replace(/^Bearer\s+/i, '')).trim();
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ verified: false, message: 'Invalid request' }) };
  }
  if (!accessToken) {
    return { statusCode: 401, headers, body: JSON.stringify({ verified: false, message: 'Missing access token' }) };
  }

  try {
    // 1) VERIFY the Supabase session server-side: who does this access token belong to?
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: APIKEY, Authorization: 'Bearer ' + accessToken }
    });
    if (!userRes.ok) {
      return { statusCode: 401, headers, body: JSON.stringify({ verified: false, message: 'Invalid or expired session.' }) };
    }
    const authUser = await userRes.json();
    const authId = authUser && authUser.id;
    const verifiedEmail = (authUser && authUser.email || '').toLowerCase().trim();
    if (!authId || !verifiedEmail) {
      return { statusCode: 401, headers, body: JSON.stringify({ verified: false, message: 'Invalid session.' }) };
    }

    // 2) Look up the linked account (service key; by auth_id) for tier/admin/cmid.
    const acctRes = await fetch(
      SUPABASE_URL + '/rest/v1/accounts?auth_id=eq.' + encodeURIComponent(authId) +
      '&select=email,tier,is_admin,circle_member_id',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    const accts = acctRes.ok ? await acctRes.json() : [];
    const acct = (accts && accts[0]) ? accts[0] : null;

    // tier from the account row (free/forum/full). No account row yet => 'free'.
    const tier = (acct && acct.tier) ? String(acct.tier).toLowerCase() : 'free';
    const cmid = acct && acct.circle_member_id != null ? acct.circle_member_id : null;

    // 3) Mint our signed token. scope 'member' for forum/full; 'free' accounts get scope 'free'
    //    so the clinical/full gates reject them (they are not paying members).
    const scope = (tier === 'forum' || tier === 'full') ? 'member' : 'free';
    const token = mintToken({ email: verifiedEmail, scope: scope, tier: tier, communityMemberId: cmid });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        verified: true,
        token: token,
        email: verifiedEmail,
        tier: tier,
        is_admin: !!(acct && acct.is_admin),
        communityMemberId: cmid
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ verified: false, message: 'Auth error' }) };
  }
};
