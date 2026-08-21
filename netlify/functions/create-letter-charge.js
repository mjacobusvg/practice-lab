// netlify/functions/create-letter-charge.js
//
// Letter Generator — per-letter patient charge (pay-to-release), step 1 of 2.
// The clinician (full member) sets an ad-hoc amount + patient email; this function:
//   1. Verifies the clinician session and resolves THEIR connected Stripe account.
//   2. Stores the finished letter PDF in letter_charges as a PENDING, held row with a
//      random access_token and a retention expires_at (PHI stays in our Supabase/BAA).
//   3. Creates a Stripe Checkout Session ON THE CLINICIAN'S CONNECTED ACCOUNT
//      (direct charge, NO application fee -> funds go 100% to the clinician, platform
//      takes nothing) and returns the pay link for the clinician to send the patient.
// The letter is released (emailed to the patient) only after payment, by
// letter-charge-webhook.js on checkout.session.completed.
//
// PHI: Stripe only ever sees the patient email, the amount, a generic line item, and
// the letter_charge_id (a uuid). The letter content never leaves Supabase.
//
// MODE (fail-safe): defaults to TEST. Real money moves only when LETTER_PAY_MODE=live.
//   test  -> STRIPE_CONNECT_TEST_SECRET_KEY (sandbox); if the clinician has no connected
//            account yet, falls back to LETTER_TEST_CONNECTED_ACCOUNT so the loop is
//            testable before onboarding is built.
//   live  -> STRIPE_SECRET_KEY (TBP Payments platform key) + the clinician's real acct_.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, STRIPE_SECRET_KEY,
//      STRIPE_CONNECT_TEST_SECRET_KEY, LETTER_PAY_MODE, LETTER_TEST_CONNECTED_ACCOUNT,
//      PUBLIC_BASE_URL (defaults to https://thinkbeyondpractice.com)

var crypto = require('crypto');
var { verifyToken } = require('./_lib/session');

var RETENTION_DAYS = 30;               // patient has this long to pay + retrieve the letter
var MAX_AMOUNT_CENTS = 500000;         // $5,000 sanity cap on an ad-hoc letter charge

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
    var payload = JSON.parse(event.body || '{}');

    // AUTH: identity from the signed token, never client-supplied. Full-tier only
    // (the Letter Generator is a Full-membership tool), matching letter-log.js.
    var authHeader = event.headers.authorization || event.headers.Authorization || '';
    var sessionToken = (payload.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
    var session = verifyToken(sessionToken);
    if (!session.valid) return resp(headers, 401, { error: 'Sign in to charge for a letter.' });
    if (!(session.claims.scope === 'member' && session.claims.tier === 'full')) {
      return resp(headers, 403, { error: 'Full membership required.' });
    }
    var clinicianEmail = String(session.claims.email || '').toLowerCase().trim();

    // ---- Validate inputs ----
    var amountCents = parseInt(payload.amount_cents, 10);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return resp(headers, 400, { error: 'Enter an amount greater than $0.' });
    }
    if (amountCents > MAX_AMOUNT_CENTS) {
      return resp(headers, 400, { error: 'Amount exceeds the per-letter limit.' });
    }
    var patientEmail = String(payload.patient_email || '').trim();
    if (!patientEmail || patientEmail.indexOf('@') === -1) {
      return resp(headers, 400, { error: 'Enter the patient email that will receive the pay link.' });
    }
    // Keep the Stripe-visible line item generic — it must not carry PHI.
    var lineItem = String(payload.line_item || 'Clinical letter').slice(0, 120);
    var letterType = payload.letter_type ? String(payload.letter_type).slice(0, 120) : null;
    var pdfBase64 = payload.pdf_base64 ? String(payload.pdf_base64) : null;
    if (!pdfBase64) return resp(headers, 400, { error: 'Missing the letter to hold for release.' });
    var pdfFilename = String(payload.pdf_filename || 'letter.pdf').slice(0, 160);

    var SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    var SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) return resp(headers, 500, { error: 'Server configuration error.' });
    var sbHeaders = {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': 'Bearer ' + SERVICE_KEY
    };

    // ---- MODE + Stripe key + account column (fail-safe: test unless explicitly live) ----
    // Each mode owns its own connected-account column: a sandbox acct_ from the test key
    // is not usable with the live key, so test and live must not share one column.
    var live = process.env.LETTER_PAY_MODE === 'live';
    var stripeKey = live ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_CONNECT_TEST_SECRET_KEY;
    if (!stripeKey) return resp(headers, 500, { error: 'Payments are not configured for this mode.' });
    var acctCol = live ? 'stripe_connect_account_id' : 'stripe_connect_account_id_test';
    var stripe = require('stripe')(stripeKey);

    // ---- Resolve the clinician's connected account ----
    var acctRes = await fetch(SUPABASE_URL + '/rest/v1/accounts?email=eq.' +
      encodeURIComponent(clinicianEmail) + '&select=' + acctCol + '&limit=1', { headers: sbHeaders });
    var accts = acctRes.ok ? await acctRes.json() : [];
    var connectedAccount = accts[0] && accts[0][acctCol];
    // Testing convenience only: before onboarding is built, allow a configured sandbox
    // connected account so the charge/release loop is exercisable. Never used in live mode.
    if (!connectedAccount && !live && process.env.LETTER_TEST_CONNECTED_ACCOUNT) {
      connectedAccount = process.env.LETTER_TEST_CONNECTED_ACCOUNT;
    }
    if (!connectedAccount) {
      return resp(headers, 409, { error: 'connect_required', message: 'Connect your Stripe account once before charging for a letter.' });
    }

    // ---- Store the held letter as a PENDING charge row ----
    var accessToken = crypto.randomBytes(24).toString('base64url');
    var expiresAt = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    var insRes = await fetch(SUPABASE_URL + '/rest/v1/letter_charges', {
      method: 'POST',
      headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=representation' }),
      body: JSON.stringify({
        clinician_email: clinicianEmail,
        stripe_connected_account: connectedAccount,
        patient_email: patientEmail,
        amount_cents: amountCents,
        currency: 'usd',
        line_item: lineItem,
        letter_type: letterType,
        status: 'pending',
        access_token: accessToken,
        test_mode: !live,
        pdf_base64: pdfBase64,
        pdf_filename: pdfFilename,
        expires_at: expiresAt
      })
    });
    if (!insRes.ok) {
      return resp(headers, 500, { error: 'Could not create the charge.', detail: (await insRes.text()).slice(0, 200) });
    }
    var chargeRow = (await insRes.json())[0];
    var chargeId = chargeRow.id;

    // ---- Create the Checkout Session on the CLINICIAN'S connected account ----
    // Direct charge (Standard): platform key + stripeAccount header, NO application fee,
    // so 100% of funds (minus Stripe's processing fee, borne by the clinician) land in
    // the clinician's account.
    var base = (process.env.PUBLIC_BASE_URL || 'https://thinkbeyondpractice.com').replace(/\/$/, '');
    var checkout;
    try {
      checkout = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: patientEmail,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: amountCents,
            product_data: { name: lineItem }   // generic; no PHI
          }
        }],
        payment_intent_data: {
          description: lineItem,
          metadata: { tbp: 'letter_charge', letter_charge_id: chargeId }
        },
        metadata: { tbp: 'letter_charge', letter_charge_id: chargeId },
        success_url: base + '/letter.html?c=' + encodeURIComponent(accessToken) + '&paid=1',
        cancel_url: base + '/letter.html?canceled=1'
      }, { stripeAccount: connectedAccount });
    } catch (e) {
      // Roll the row back to canceled so a failed Checkout create doesn't leave a stuck pending.
      await fetch(SUPABASE_URL + '/rest/v1/letter_charges?id=eq.' + chargeId, {
        method: 'PATCH', headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ status: 'canceled' })
      });
      return resp(headers, 502, { error: 'Stripe could not create the payment request: ' + e.message });
    }

    // ---- Record the session id on the row ----
    await fetch(SUPABASE_URL + '/rest/v1/letter_charges?id=eq.' + chargeId, {
      method: 'PATCH', headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ stripe_checkout_session_id: checkout.id })
    });

    return resp(headers, 200, {
      ok: true,
      charge_id: chargeId,
      pay_url: checkout.url,       // clinician sends this to the patient
      test_mode: !live
    });
  } catch (err) {
    return resp(headers, 500, { error: err.message });
  }
};
