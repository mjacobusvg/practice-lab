// netlify/functions/letter-connect-start.js
//
// Letter Generator — clinician Stripe connect, step 1: begin OAuth ("Connect with Stripe").
//
// We use Stripe Connect OAuth instead of creating a brand-new account + Account Link. A
// clinician who already has Stripe (most established practices) just logs into their
// EXISTING account and authorizes us in one click — no new account, no re-running KYC, no
// email guessing. Clinicians without Stripe can sign up from the same screen.
//
// This function verifies the clinician session and returns the Stripe OAuth authorize URL.
// The browser is sent there; Stripe redirects back to letter-connect-callback.js with a
// code, which we exchange for the connected account id (stripe_user_id) and store.
//
// MODE (fail-safe): defaults to TEST. Each mode has its own OAuth client id and its own
// account column, mirroring create-letter-charge.js:
//   test -> STRIPE_CONNECT_CLIENT_ID_TEST, accounts.stripe_connect_account_id_test
//   live -> STRIPE_CONNECT_CLIENT_ID,      accounts.stripe_connect_account_id
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET,
//      STRIPE_CONNECT_CLIENT_ID, STRIPE_CONNECT_CLIENT_ID_TEST, LETTER_PAY_MODE,
//      PUBLIC_BASE_URL (defaults to https://thinkbeyondpractice.com)

var crypto = require('crypto');
var { verifyToken } = require('./_lib/session');

var STATE_TTL_MS = 15 * 60 * 1000;   // the OAuth round-trip must complete within 15 min

function resp(headers, status, obj) {
  return { statusCode: status, headers: headers, body: JSON.stringify(obj) };
}

// Sign a short-lived state that ties the OAuth callback back to this clinician, since the
// callback is a browser redirect from Stripe with no session token of its own.
function signState(email) {
  var secret = process.env.SESSION_SIGNING_SECRET || '';
  var payload = Buffer.from(JSON.stringify({ email: email, exp: Date.now() + STATE_TTL_MS })).toString('base64url');
  var sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}

exports.handler = async function (event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') return resp(headers, 405, { error: 'Method not allowed' });

  try {
    var payload = {};
    try { payload = JSON.parse(event.body || '{}'); } catch (e) {}

    var authHeader = event.headers.authorization || event.headers.Authorization || '';
    var sessionToken = (payload.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
    var session = verifyToken(sessionToken);
    if (!session.valid) return resp(headers, 401, { error: 'Sign in to connect Stripe.' });
    if (!(session.claims.scope === 'member' && session.claims.tier === 'full')) {
      return resp(headers, 403, { error: 'Full membership required.' });
    }
    var clinicianEmail = String(session.claims.email || '').toLowerCase().trim();
    if (!clinicianEmail) return resp(headers, 400, { error: 'No email on session.' });

    var live = process.env.LETTER_PAY_MODE === 'live';
    var clientId = live ? process.env.STRIPE_CONNECT_CLIENT_ID : process.env.STRIPE_CONNECT_CLIENT_ID_TEST;
    if (!clientId) return resp(headers, 500, { error: 'Stripe Connect is not configured for this mode yet.' });

    var base = (process.env.PUBLIC_BASE_URL || 'https://thinkbeyondpractice.com').replace(/\/$/, '');
    var redirectUri = base + '/.netlify/functions/letter-connect-callback';

    // Build the OAuth authorize URL. read_write is the standard scope for accepting charges
    // on the connected account; prefilling the email nudges an existing user to log in.
    var params = [
      'response_type=code',
      'client_id=' + encodeURIComponent(clientId),
      'scope=read_write',
      'redirect_uri=' + encodeURIComponent(redirectUri),
      'state=' + encodeURIComponent(signState(clinicianEmail)),
      'stripe_user[email]=' + encodeURIComponent(clinicianEmail),
      'stripe_user[business_type]=company'
    ].join('&');
    var authorizeUrl = 'https://connect.stripe.com/oauth/authorize?' + params;

    return resp(headers, 200, {
      ok: true,
      url: authorizeUrl,   // frontend redirects the clinician here to connect their Stripe
      oauth: true,
      test_mode: !live
    });
  } catch (err) {
    return resp(headers, 500, { error: err.message });
  }
};
