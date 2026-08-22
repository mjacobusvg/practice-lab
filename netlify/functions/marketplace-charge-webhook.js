// netlify/functions/marketplace-charge-webhook.js
//
// OPTIONAL dedicated CONNECT webhook for marketplace direct charges. You do NOT
// need to register this separately if the existing letter connect webhook is
// active — that one now also delegates marketplace events to the same shared
// fulfillment (see letter-charge-webhook.js + _lib/marketplace-fulfill.js).
// This endpoint exists for teams who prefer a dedicated marketplace webhook.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY,
//      STRIPE_MARKETPLACE_CONNECT_WEBHOOK_SECRET (or STRIPE_CONNECT_WEBHOOK_SECRET),
//      STRIPE_CONNECT_TEST_SECRET_KEY / STRIPE_SECRET_KEY (SDK only), SES_*

const { fulfillMarketplaceCheckout } = require('./_lib/marketplace-fulfill');

const H = { 'Content-Type': 'application/json' };

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'Method not allowed' }) };

  const stripe = require('stripe')(process.env.STRIPE_CONNECT_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
  const secret = process.env.STRIPE_MARKETPLACE_CONNECT_WEBHOOK_SECRET || process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'Webhook not configured' }) };

  let ev;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    ev = stripe.webhooks.constructEvent(raw, event.headers['stripe-signature'], secret);
  } catch (err) {
    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Signature verification failed: ' + err.message }) };
  }

  if (ev.type !== 'checkout.session.completed') {
    return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, ignored: ev.type }) };
  }

  try {
    const result = await fulfillMarketplaceCheckout(ev.data.object);
    return { statusCode: 200, headers: H, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};
