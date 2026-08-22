// netlify/functions/letter-charge-webhook.js
//
// Letter Generator — pay-to-release, step 2 of 2. This is the CONNECT webhook: it
// receives checkout.session.completed events for the letter-charge Checkout Sessions
// created on clinicians' connected accounts (create-letter-charge.js). On payment it:
//   1. Verifies the Stripe signature (Connect webhook signing secret).
//   2. Marks the matching letter_charges row PAID (idempotent).
//   3. Emails the PATIENT a secure, expiring link to view/download their letter.
//
// PHI: the email carries only a link (no letter content, no attachment). The letter
// itself is served by letter-view.js against the row's access_token, and only while
// the row is paid + unexpired.
//
// This endpoint must be registered in Stripe as a webhook that listens to events on
// CONNECTED accounts (not just the platform). Its signing secret goes in
// STRIPE_CONNECT_WEBHOOK_SECRET (sandbox secret while testing; live secret at launch).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, STRIPE_CONNECT_WEBHOOK_SECRET,
//      STRIPE_CONNECT_TEST_SECRET_KEY / STRIPE_SECRET_KEY (only for the SDK helper),
//      SES_AWS_*, PUBLIC_BASE_URL

const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

const FROM_NAME = 'Think Beyond Practice';
const FROM_ADDRESS = 'support@thinkbeyondpractice.com';

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // The Stripe SDK is used only for signature verification (no API call), so either
  // key works; prefer the test key while we're in sandbox.
  const stripe = require('stripe')(process.env.STRIPE_CONNECT_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
  const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  const sig = event.headers['stripe-signature'];
  if (!webhookSecret) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Webhook not configured' }) };

  let stripeEvent;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    stripeEvent = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Signature verification failed: ' + err.message }) };
  }

  // We only act on completed, paid checkout for OUR letter charges.
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, ignored: stripeEvent.type }) };
  }
  const s = stripeEvent.data.object;
  // Marketplace direct charges land on this same Connect endpoint. Delegate them to
  // the shared marketplace fulfillment so no second Stripe webhook must be registered.
  if (s.metadata && s.metadata.tbp === 'marketplace') {
    try {
      const result = await require('./_lib/marketplace-fulfill').fulfillMarketplaceCheckout(s);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    } catch (e) {
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, error: e.message }) };
    }
  }
  if (!(s.metadata && s.metadata.tbp === 'letter_charge' && s.metadata.letter_charge_id)) {
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, not_letter_charge: true }) };
  }
  if (s.payment_status && s.payment_status !== 'paid') {
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, payment_status: s.payment_status }) };
  }

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const sbHeaders = { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' };

  try {
    // Load the row. Match on our metadata id (authoritative), verify it's still pending.
    const getRes = await fetch(SUPABASE_URL + '/rest/v1/letter_charges?id=eq.' +
      encodeURIComponent(s.metadata.letter_charge_id) +
      '&select=id,status,patient_email,access_token,line_item,expires_at&limit=1', { headers: sbHeaders });
    const rows = getRes.ok ? await getRes.json() : [];
    const row = rows[0];
    if (!row) return { statusCode: 200, headers, body: JSON.stringify({ received: true, no_row: true }) };
    if (row.status === 'paid') {
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, already_paid: true }) };
    }

    // Mark paid (idempotent guard: only flip a row that's still pending).
    const patchRes = await fetch(SUPABASE_URL + '/rest/v1/letter_charges?id=eq.' + row.id + '&status=eq.pending', {
      method: 'PATCH',
      headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=representation' }),
      body: JSON.stringify({ status: 'paid', paid_at: new Date().toISOString(), stripe_payment_intent: s.payment_intent || null })
    });
    const patched = patchRes.ok ? await patchRes.json() : [];
    if (!patched.length) {
      // Another delivery won the race; nothing more to do.
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, race_or_no_change: true }) };
    }

    // Email the patient a secure, expiring link (no PHI in the email itself).
    const base = (process.env.PUBLIC_BASE_URL || 'https://thinkbeyondpractice.com').replace(/\/$/, '');
    const link = base + '/letter.html?c=' + encodeURIComponent(row.access_token);
    await sendPatientLink(row.patient_email, link).catch(function () { /* never fail the webhook on email */ });

    return { statusCode: 200, headers, body: JSON.stringify({ received: true, released: row.id }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

async function sendPatientLink(toEmail, link) {
  const text = [
    'Your letter is ready.',
    '',
    'Your payment was received and your clinician has released your letter. You can view and download it here:',
    link,
    '',
    'For your privacy, this secure link expires. Save a copy once you open it.',
    '',
    'Think Beyond Practice'
  ].join('\n');
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;color:#1a2430">' +
    '<h2 style="font-size:19px;margin:0 0 10px">Your letter is ready</h2>' +
    '<p style="font-size:15px;line-height:1.6">Your payment was received and your clinician has released your letter.</p>' +
    '<p style="margin:20px 0"><a href="' + link + '" style="background:#2aabb8;color:#fff;text-decoration:none;border-radius:8px;padding:12px 22px;font-size:15px">View &amp; download your letter</a></p>' +
    '<p style="font-size:13px;line-height:1.6;color:#5a6672">For your privacy, this secure link expires. Please save a copy once you open it.</p>' +
    '<p style="font-size:13px;color:#8a94a0">Think Beyond Practice</p></div>';
  await sesClient().send(new SendEmailCommand({
    FromEmailAddress: FROM_NAME + ' <' + FROM_ADDRESS + '>',
    Destination: { ToAddresses: [toEmail] },
    Content: { Simple: {
      Subject: { Data: 'Your letter is ready' },
      Body: { Text: { Data: text }, Html: { Data: html } }
    } }
  }));
}

function sesClient() {
  const region = process.env.SES_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
  const accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const cfg = { region: region };
  if (accessKeyId && secretAccessKey) cfg.credentials = { accessKeyId: accessKeyId, secretAccessKey: secretAccessKey };
  return new SESv2Client(cfg);
}
