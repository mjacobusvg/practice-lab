// netlify/functions/admin-legacy-link.js
//
// One-off helper to REINSTATE a lapsed member at their legacy rate after the
// Circle cutover. Given an amount + tier, it creates (or reuses) a recurring
// Stripe Price ATTACHED TO THE EXISTING tier product, then returns a durable
// Stripe Payment Link you can paste into an email. The member opens it, adds a
// card, and our stripe-webhook flips their account back to that tier
// automatically (it matches the new subscription to their account by email).
//
// WHY the price hangs off the existing product: stripe-webhook maps Stripe
// PRODUCT -> tier. A brand-new product would fall back to 'forum'. Reusing the
// full/forum product the webhook already knows keeps the grant correct.
//
// Idempotent: the price is keyed by lookup_key (legacy_<tier>_<interval>_<amount>)
// and the payment link is reused if one already points at that price. Safe to
// call repeatedly — it will not mint duplicates. It never charges anyone; the
// member enters their own card on Stripe's hosted page.
//
// The link is a public URL. Share it privately (reply-first), and deactivate it
// in the Stripe dashboard once the recovery is done if you want it single-use.
//
// POST body: { secret, amount_cents (default 8900), interval ('month'|'year',
//   default 'month'), tier ('full'|'forum', default 'full'), email (optional,
//   tagged on the link for your reference) }
// Env: STRIPE_SECRET_KEY, BACKFILL_SECRET

// Existing tier products the webhook already maps (see _lib/subscription-tier.js).
const TIER_PRODUCT = {
  full: 'prod_UG0R8KspOn5vFe',  // Full Access ($119/mo, $1,190/yr)
  forum: 'prod_SnR5gmEzqzf4QY'  // Full Forum Access ($50/$525)
};

exports.handler = async function (event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  if (!process.env.BACKFILL_SECRET || body.secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Invalid secret' }) };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  const amountCents = Number.isInteger(body.amount_cents) ? body.amount_cents : 8900;
  const interval = body.interval === 'year' ? 'year' : 'month';
  const tier = body.tier === 'forum' ? 'forum' : 'full';
  const productId = TIER_PRODUCT[tier];
  if (amountCents < 100) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'amount_cents too small' }) };
  }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const lookupKey = 'legacy_' + tier + '_' + interval + '_' + amountCents;

  try {
    // 1) Reuse or create the recurring price on the existing tier product.
    let price = null;
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    if (found.data.length) {
      price = found.data[0];
    } else {
      price = await stripe.prices.create({
        product: productId,
        currency: 'usd',
        unit_amount: amountCents,
        recurring: { interval },
        lookup_key: lookupKey,
        nickname: 'Legacy reinstate ' + tier + ' $' + (amountCents / 100) + '/' + interval,
        metadata: { tbp_legacy: 'true', tbp_tier: tier }
      });
    }

    // 2) Reuse an existing active payment link for this price, else create one.
    let link = null;
    for await (const pl of stripe.paymentLinks.list({ active: true, limit: 100 })) {
      if (pl.metadata && pl.metadata.tbp_legacy_price === price.id) { link = pl; break; }
    }
    if (!link) {
      link = await stripe.paymentLinks.create({
        line_items: [{ price: price.id, quantity: 1 }],
        metadata: { tbp_legacy: 'true', tbp_legacy_price: price.id, tbp_tier: tier, tbp_for: (body.email || '') },
        subscription_data: { metadata: { tbp_owned: 'true' } },
        after_completion: { type: 'redirect', redirect: { url: 'https://thinkbeyondpractice.com/platform?joined=1' } },
        allow_promotion_codes: false
      });
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        url: link.url,
        tier,
        amount: '$' + (amountCents / 100) + '/' + interval,
        price_id: price.id,
        product_id: productId,
        lookup_key: lookupKey,
        note: 'Share privately. When the member pays, stripe-webhook grants ' + tier +
          ' by matching their email to their account. Deactivate the link in Stripe if you want it single-use.'
      }, null, 2)
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
