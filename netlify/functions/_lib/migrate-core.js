// netlify/functions/_lib/migrate-core.js
//
// Shared core for migrating ONE Circle-created Stripe subscription onto a fresh
// owned subscription (no application_fee), reusing the member's card, with a
// no-double-charge hand-off. Extracted verbatim from migrate-subscription.js so
// the interactive one-at-a-time endpoint and the batch runner
// (migrate-batch-scheduled.js) share a single, tested implementation.
//
// HAND-OFF: new sub is created with trial_end = old sub's current_period_end, so
// it does not charge until the exact moment the old one would have renewed; the
// old sub is set to cancel_at_period_end. trialing grants access in the tier
// logic, so access is continuous and nobody is double-billed.
//
// migrateOne(stripe, subscriptionId, { dryRun }) resolves to a structured result:
//   { status: 'skipped',  reason, plan? }   non-active / already-owned / no card
//   { status: 'planned',  dry_run:true, plan }              (dryRun)
//   { status: 'migrated', plan, new_subscription, ... }     (live)
// and throws only on unexpected Stripe/network errors.

const { tierForProduct } = require('./subscription-tier');

// Owned Products, one per tier, created on first use and reused thereafter.
const OWNED_PRODUCT_NAME = { forum: 'TBP Membership: Forum', full: 'TBP Membership: Full' };

async function migrateOne(stripe, subscriptionId, opts) {
  const dryRun = !opts || opts.dryRun !== false;

  // 1) Read the old (Circle-created) subscription, expanding customer.
  const oldSub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['customer'] });

  if (oldSub.status !== 'active' && oldSub.status !== 'trialing') {
    return { status: 'skipped', reason: 'not_active', detail: 'status ' + oldSub.status };
  }
  if (oldSub.metadata && oldSub.metadata.tbp_owned === 'true') {
    return { status: 'skipped', reason: 'already_owned' };
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
  const email = (typeof customer === 'object' ? customer.email : null) || null;

  const plan = {
    old_subscription: oldSub.id,
    customer: customerId,
    email: email,
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
    return { status: 'skipped', reason: 'no_card', plan };
  }

  if (dryRun) {
    return { status: 'planned', dry_run: true, plan };
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
    metadata: {
      tbp_owned: 'true',
      tbp_migrated_from: oldSub.id,
      tbp_tier: tier,
      tbp_account_email: email || ''
    }
  });

  // 4) Set the old Circle subscription to lapse at period end (hand-off instant).
  const canceledOld = await stripe.subscriptions.update(oldSub.id, {
    cancel_at_period_end: true,
    metadata: Object.assign({}, oldSub.metadata, { tbp_migrated_to: newSub.id })
  });

  return {
    status: 'migrated',
    dry_run: false,
    plan: plan,
    old_subscription: oldSub.id,
    old_now_cancels_at_period_end: canceledOld.cancel_at_period_end,
    new_subscription: newSub.id,
    new_status: newSub.status,
    new_first_charge_at: plan.new_sub_first_charge_at,
    owned_price: ownedPriceId
  };
}

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

module.exports = { migrateOne, ensureOwnedPrice };
