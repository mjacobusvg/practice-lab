// netlify/functions/migrate-subscription.js
//
// STAGED, NOT FOR ROUTINE USE. One-at-a-time migration of a Circle-created Stripe
// subscription onto a fresh Michael-OWNED subscription, in preparation for
// disconnecting Circle. Runs only when we are ready to sever Circle.
//
// WHY: the existing member subscriptions were created by Circle's Connect platform
// and carry application_fee_percent:1 routed to Circle. Our own account key can
// manage them (cancel/edit) but CANNOT remove that platform fee (verified: Stripe
// rejects application_fee changes from a non-platform key). So the clean cutover is
// to recreate each as an owned subscription with no platform fee, reusing the
// member's existing card, then cancel the Circle one.
//
// HAND-OFF (no double charge, no gap): the new subscription is created with
// trial_end = the OLD subscription's current_period_end, so it does not charge
// until the exact moment the old one would have renewed. The old subscription is
// set to cancel_at_period_end. At that instant: old lapses, new charges, access is
// continuous (trialing grants access in the tier logic).
//
// SAFE BY DEFAULT: dry_run is true unless explicitly false. A dry run reads Stripe
// and returns the exact plan without creating or canceling anything.
//
// POST body: { secret, subscription_id (required), dry_run (default true) }
// Env: STRIPE_SECRET_KEY, BACKFILL_SECRET

const { tierForProduct } = require('./_lib/subscription-tier');

// Owned Products, one per tier, created on first use and reused thereafter.
const OWNED_PRODUCT_NAME = { forum: 'TBP Membership: Forum', full: 'TBP Membership: Full' };

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
  if (body.secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Invalid secret' }) };
  }
  if (!body.subscription_id) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'subscription_id required (migrate one at a time)' }) };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  const dryRun = body.dry_run !== false;
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  try {
    // 1) Read the old (Circle-created) subscription, expanding customer.
    const oldSub = await stripe.subscriptions.retrieve(body.subscription_id, { expand: ['customer'] });
    if (oldSub.status !== 'active' && oldSub.status !== 'trialing') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Refusing to migrate a non-active subscription (status ' + oldSub.status + ')' }) };
    }
    if (oldSub.metadata && oldSub.metadata.tbp_owned === 'true') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'This subscription is already an owned subscription; nothing to migrate' }) };
    }

    const item = oldSub.items.data[0];
    const price = item.price;
    const amount = price.unit_amount;
    const interval = price.recurring.interval;
    const tier = tierForProduct(price.product, 'forum');
    const periodEnd = item.current_period_end || oldSub.current_period_end;
    const customer = oldSub.customer;
    const customerId = typeof customer === 'string' ? customer : customer.id;
    const defaultPm = (typeof customer === 'object' && customer.invoice_settings)
      ? customer.invoice_settings.default_payment_method : null;

    const plan = {
      old_subscription: oldSub.id,
      customer: customerId,
      tier: tier,
      amount_cents: amount,
      interval: interval,
      has_card_on_file: !!defaultPm,
      new_sub_first_charge_at: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      old_sub_action: 'cancel_at_period_end'
    };

    if (!defaultPm) {
      // No stored card: creating a new sub would immediately need payment. Refuse
      // rather than risk a failed/immediate charge; handle these by hand.
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'No default payment method on customer; migrate this one manually', plan }) };
    }

    if (dryRun) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ dry_run: true, plan }, null, 2) };
    }

    // 2) Ensure an owned Price for this tier + amount + interval (find or create).
    const ownedPriceId = await ensureOwnedPrice(stripe, tier, amount, interval);

    // 3) Create the new OWNED subscription: no application fee, trial until the old
    //    period ends, reuse the card. proration_behavior none: no immediate charge.
    const newSub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: ownedPriceId }],
      default_payment_method: defaultPm,
      trial_end: periodEnd,
      proration_behavior: 'none',
      metadata: { tbp_owned: 'true', tbp_migrated_from: oldSub.id, tbp_tier: tier }
    });

    // 4) Set the old Circle subscription to lapse at period end (hand-off instant).
    const canceledOld = await stripe.subscriptions.update(oldSub.id, {
      cancel_at_period_end: true,
      metadata: Object.assign({}, oldSub.metadata, { tbp_migrated_to: newSub.id })
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        dry_run: false,
        migrated: true,
        old_subscription: oldSub.id,
        old_now_cancels_at_period_end: canceledOld.cancel_at_period_end,
        new_subscription: newSub.id,
        new_status: newSub.status,
        new_first_charge_at: plan.new_sub_first_charge_at,
        owned_price: ownedPriceId
      }, null, 2)
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

// Find an existing owned Price matching tier + amount + interval, or create the
// owned Product (once per tier) and Price. Owned objects are tagged
// metadata.tbp_owned='true' and carry no paywall_id and no application fee.
async function ensureOwnedPrice(stripe, tier, amount, interval) {
  for await (const p of stripe.prices.list({ active: true, limit: 100, expand: ['data.product'] })) {
    if (p.metadata && p.metadata.tbp_owned === 'true' &&
        p.unit_amount === amount && p.recurring && p.recurring.interval === interval &&
        p.metadata.tbp_tier === tier) {
      return p.id;
    }
  }

  // Find or create the owned Product for this tier.
  let productId = null;
  for await (const pr of stripe.products.list({ active: true, limit: 100 })) {
    if (pr.metadata && pr.metadata.tbp_owned === 'true' && pr.metadata.tbp_tier === tier) {
      productId = pr.id;
      break;
    }
  }
  if (!productId) {
    const product = await stripe.products.create({
      name: OWNED_PRODUCT_NAME[tier] || ('TBP Membership: ' + tier),
      metadata: { tbp_owned: 'true', tbp_tier: tier }
    });
    productId = product.id;
  }

  const created = await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: amount,
    recurring: { interval: interval },
    metadata: { tbp_owned: 'true', tbp_tier: tier }
  });
  return created.id;
}
