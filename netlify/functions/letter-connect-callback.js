// netlify/functions/letter-connect-callback.js
//
// Letter Generator — clinician Stripe connect, step 2: OAuth callback. Stripe redirects the
// clinician's browser here after they authorize (or deny) on "Connect with Stripe". We:
//   1. Verify the signed `state` to recover which clinician this is (the redirect carries no
//      session token of its own).
//   2. Exchange the `code` for the connected account id (stripe_user_id) using the platform
//      secret key.
//   3. Store that acct_ on the clinician's row, in the column for the current MODE.
//   4. 302-redirect back to the Letter Generator with a friendly result flag.
//
// MODE mirrors letter-connect-start.js / create-letter-charge.js:
//   test -> STRIPE_CONNECT_TEST_SECRET_KEY, accounts.stripe_connect_account_id_test
//   live -> STRIPE_SECRET_KEY,              accounts.stripe_connect_account_id
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET, STRIPE_SECRET_KEY,
//      STRIPE_CONNECT_TEST_SECRET_KEY, LETTER_PAY_MODE, PUBLIC_BASE_URL

var crypto = require('crypto');

function verifyState(state) {
  try {
    var secret = process.env.SESSION_SIGNING_SECRET || '';
    var parts = String(state || '').split('.');
    if (parts.length !== 2) return null;
    var expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
    var a = Buffer.from(parts[1]);
    var b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    var claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!claims.exp || Date.now() > claims.exp) return null;
    return claims;
  } catch (e) { return null; }
}

exports.handler = async function (event) {
  var base = (process.env.PUBLIC_BASE_URL || 'https://thinkbeyondpractice.com').replace(/\/$/, '');
  function redirect(flag) {
    return { statusCode: 302, headers: { Location: base + '/pm-letter-generator.html?connect=' + flag }, body: '' };
  }

  var q = event.queryStringParameters || {};

  // Clinician denied authorization (or Stripe returned an error).
  if (q.error) return redirect('oauth_denied');
  if (!q.code || !q.state) return redirect('oauth_error');

  var claims = verifyState(q.state);
  if (!claims || !claims.email) return redirect('oauth_error');
  var clinicianEmail = String(claims.email).toLowerCase().trim();

  var live = process.env.LETTER_PAY_MODE === 'live';
  var secretKey = live ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_CONNECT_TEST_SECRET_KEY;
  var acctCol = live ? 'stripe_connect_account_id' : 'stripe_connect_account_id_test';
  if (!secretKey) return redirect('oauth_error');

  try {
    // Exchange the authorization code for the connected account id.
    var stripe = require('stripe')(secretKey);
    var token = await stripe.oauth.token({ grant_type: 'authorization_code', code: q.code });
    var connectedAccount = token && token.stripe_user_id;
    if (!connectedAccount) return redirect('oauth_error');

    // Store it on the clinician's row (create the row if it somehow doesn't exist).
    var SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    var SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    var sbHeaders = { 'Content-Type': 'application/json', 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY };

    var body = {}; body[acctCol] = connectedAccount;
    var patch = await fetch(SUPABASE_URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(clinicianEmail), {
      method: 'PATCH', headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=representation' }),
      body: JSON.stringify(body)
    });
    var rows = patch.ok ? await patch.json() : [];
    if (!rows.length) {
      body.email = clinicianEmail;
      await fetch(SUPABASE_URL + '/rest/v1/accounts', {
        method: 'POST', headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=minimal' }),
        body: JSON.stringify(body)
      });
    }

    return redirect('oauth_done');
  } catch (err) {
    return redirect('oauth_error');
  }
};
