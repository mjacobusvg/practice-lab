// netlify/functions/letter-connect-status.js
//
// Letter Generator — clinician Stripe onboarding, status check. Tells the frontend
// whether THIS clinician can charge yet, so the UI can show "Connect Stripe" vs.
// "Connected ✓" and gate the charge panel.
//
// Returns (200):
//   { connected: bool,        // an acct_ id is on file for this mode
//     charges_enabled: bool,  // Stripe says the account can accept charges
//     details_submitted: bool,// onboarding form was completed
//     needs_onboarding: bool,  // connected but not yet chargeable (resume onboarding)
//     account_id: string|null,
//     test_mode: bool }
//
// MODE mirrors letter-connect-start.js / create-letter-charge.js: each mode reads its
// own column and its own Stripe key.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, STRIPE_SECRET_KEY,
//      STRIPE_CONNECT_TEST_SECRET_KEY, LETTER_PAY_MODE

var { verifyToken } = require('./_lib/session');

function resp(headers, status, obj) {
  return { statusCode: status, headers: headers, body: JSON.stringify(obj) };
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
    if (!session.valid) return resp(headers, 401, { error: 'Sign in to check Stripe.' });
    if (!(session.claims.scope === 'member' && session.claims.tier === 'full')) {
      return resp(headers, 403, { error: 'Full membership required.' });
    }
    var clinicianEmail = String(session.claims.email || '').toLowerCase().trim();

    var SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    var SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) return resp(headers, 500, { error: 'Server configuration error.' });
    var sbHeaders = { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY };

    var live = process.env.LETTER_PAY_MODE === 'live';
    var acctCol = live ? 'stripe_connect_account_id' : 'stripe_connect_account_id_test';

    var acctRes = await fetch(SUPABASE_URL + '/rest/v1/accounts?email=eq.' +
      encodeURIComponent(clinicianEmail) + '&select=' + acctCol + '&limit=1', { headers: sbHeaders });
    var accts = acctRes.ok ? await acctRes.json() : [];
    var connectedAccount = accts[0] && accts[0][acctCol];

    if (!connectedAccount) {
      return resp(headers, 200, {
        connected: false, charges_enabled: false, details_submitted: false,
        needs_onboarding: false, account_id: null, test_mode: !live
      });
    }

    // Ask Stripe whether the account can actually take charges yet.
    var stripeKey = live ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_CONNECT_TEST_SECRET_KEY;
    if (!stripeKey) return resp(headers, 500, { error: 'Payments are not configured for this mode.' });
    var stripe = require('stripe')(stripeKey);

    var chargesEnabled = false, detailsSubmitted = false;
    try {
      var acct = await stripe.accounts.retrieve(connectedAccount);
      chargesEnabled = !!acct.charges_enabled;
      detailsSubmitted = !!acct.details_submitted;
    } catch (e) {
      // If the stored acct can't be retrieved with this key (e.g. mode mismatch), treat
      // it as not connected so the clinician can (re)start onboarding cleanly.
      return resp(headers, 200, {
        connected: false, charges_enabled: false, details_submitted: false,
        needs_onboarding: false, account_id: null, test_mode: !live,
        note: 'stored account not retrievable in this mode'
      });
    }

    return resp(headers, 200, {
      connected: true,
      charges_enabled: chargesEnabled,
      details_submitted: detailsSubmitted,
      needs_onboarding: !chargesEnabled,
      account_id: connectedAccount,
      test_mode: !live
    });
  } catch (err) {
    return resp(headers, 500, { error: err.message });
  }
};
