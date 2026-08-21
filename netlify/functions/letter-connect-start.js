// netlify/functions/letter-connect-start.js
//
// Letter Generator — clinician Stripe onboarding, step 1: begin (or resume) Connect.
// The clinician (full member) clicks "Connect Stripe" once. This function:
//   1. Verifies the clinician session (full tier only).
//   2. Ensures they have a Standard connected account (creates one if not) and stores
//      its acct_ id on their accounts row — in the column for the current MODE.
//   3. Creates a single-use Account Link (account_onboarding) and returns its URL.
// The frontend then redirects the clinician into Stripe's hosted onboarding.
//
// Standard accounts + direct charges: onboarding is Stripe-hosted, KYC is Stripe's,
// and money from letter charges lands 100% in the clinician's own account. We use
// the modern create-account + Account Link flow (NOT OAuth, which Stripe now
// discourages under its single-platform policy).
//
// MODE (fail-safe, mirrors create-letter-charge.js): defaults to TEST. A Standard
// account created with the sandbox key is a sandbox account whose acct_ id does not
// work with the live key, so each mode reads/writes its OWN column:
//   test -> STRIPE_CONNECT_TEST_SECRET_KEY, accounts.stripe_connect_account_id_test
//   live -> STRIPE_SECRET_KEY,              accounts.stripe_connect_account_id
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, STRIPE_SECRET_KEY,
//      STRIPE_CONNECT_TEST_SECRET_KEY, LETTER_PAY_MODE,
//      PUBLIC_BASE_URL (defaults to https://thinkbeyondpractice.com)

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

    // AUTH: full-tier member only, identity from the signed token.
    var authHeader = event.headers.authorization || event.headers.Authorization || '';
    var sessionToken = (payload.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
    var session = verifyToken(sessionToken);
    if (!session.valid) return resp(headers, 401, { error: 'Sign in to connect Stripe.' });
    if (!(session.claims.scope === 'member' && session.claims.tier === 'full')) {
      return resp(headers, 403, { error: 'Full membership required.' });
    }
    var clinicianEmail = String(session.claims.email || '').toLowerCase().trim();
    if (!clinicianEmail) return resp(headers, 400, { error: 'No email on session.' });

    var SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    var SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) return resp(headers, 500, { error: 'Server configuration error.' });
    var sbHeaders = {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': 'Bearer ' + SERVICE_KEY
    };

    // ---- MODE + Stripe key + which account column this mode owns ----
    var live = process.env.LETTER_PAY_MODE === 'live';
    var stripeKey = live ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_CONNECT_TEST_SECRET_KEY;
    if (!stripeKey) return resp(headers, 500, { error: 'Payments are not configured for this mode.' });
    var acctCol = live ? 'stripe_connect_account_id' : 'stripe_connect_account_id_test';
    var stripe = require('stripe')(stripeKey);

    // ---- Load (or find) the clinician's account row + any existing connected acct ----
    var acctRes = await fetch(SUPABASE_URL + '/rest/v1/accounts?email=eq.' +
      encodeURIComponent(clinicianEmail) + '&select=email,' + acctCol + '&limit=1', { headers: sbHeaders });
    var accts = acctRes.ok ? await acctRes.json() : [];
    var rowExists = !!(accts[0] && accts[0].email);
    var connectedAccount = accts[0] && accts[0][acctCol];

    // ---- Ensure a Standard connected account exists ----
    if (!connectedAccount) {
      var acct;
      // A customer-facing business name (business_profile.name) must exist before
      // Stripe will let the account run Checkout. Set it at creation so the account is
      // chargeable immediately (in test mode) and so a clinician who hasn't finished
      // onboarding never hits Stripe's "set a business name" error. Prefer a name the
      // caller supplies (their practice name); fall back to something sensible.
      var bizName = String((payload.business_name || '')).trim().slice(0, 120) ||
        (clinicianEmail.split('@')[0] || 'Clinical services');
      try {
        acct = await stripe.accounts.create({
          type: 'standard',
          email: clinicianEmail,
          business_profile: {
            name: bizName,
            product_description: 'Clinical letters and documentation',
            url: 'https://thinkbeyondpractice.com',
            mcc: '8099'
          },
          metadata: { tbp: 'letter_connect', clinician_email: clinicianEmail }
        });
      } catch (e) {
        return resp(headers, 502, { error: 'Stripe could not start onboarding: ' + e.message });
      }
      connectedAccount = acct.id;

      // Persist it in the mode's column (update if the row exists, else insert).
      var body = {}; body[acctCol] = connectedAccount;
      var saveOk = false;
      if (rowExists) {
        var upd = await fetch(SUPABASE_URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(clinicianEmail), {
          method: 'PATCH', headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=minimal' }),
          body: JSON.stringify(body)
        });
        saveOk = upd.ok;
      } else {
        body.email = clinicianEmail;
        var ins = await fetch(SUPABASE_URL + '/rest/v1/accounts', {
          method: 'POST', headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=minimal' }),
          body: JSON.stringify(body)
        });
        saveOk = ins.ok;
      }
      if (!saveOk) {
        // We created the acct at Stripe but couldn't record it — surface it so a retry
        // doesn't orphan another account. (Retry will re-create; acceptable in sandbox.)
        return resp(headers, 500, { error: 'Could not save the Stripe connection. Please try again.' });
      }
    }

    // ---- Is this account already able to accept charges? ----
    // In test mode a freshly created account is chargeable immediately, so the frontend
    // can skip the hosted-onboarding redirect entirely. In live mode it won't be, so we
    // fall through to the Account Link below.
    var chargesEnabled = false;
    try {
      var chk = await stripe.accounts.retrieve(connectedAccount);
      chargesEnabled = !!chk.charges_enabled;
    } catch (e) { /* treat as not-yet-enabled */ }

    // ---- Create a single-use Account Link (hosted onboarding) ----
    // Always returned so the clinician can complete/refresh onboarding when needed.
    var base = (process.env.PUBLIC_BASE_URL || 'https://thinkbeyondpractice.com').replace(/\/$/, '');
    var link;
    try {
      link = await stripe.accountLinks.create({
        account: connectedAccount,
        type: 'account_onboarding',
        return_url: base + '/pm-letter-generator.html?connect=return',
        refresh_url: base + '/pm-letter-generator.html?connect=refresh'
      });
    } catch (e) {
      return resp(headers, 502, { error: 'Stripe could not create the onboarding link: ' + e.message });
    }

    return resp(headers, 200, {
      ok: true,
      url: link.url,                     // frontend redirects here when onboarding is needed
      account_id: connectedAccount,
      test_mode: !live,
      charges_enabled: chargesEnabled    // if true (test mode), frontend skips the redirect
    });
  } catch (err) {
    return resp(headers, 500, { error: err.message });
  }
};
