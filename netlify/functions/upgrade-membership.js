// netlify/functions/upgrade-membership.js
//
// In-place upgrade of an EXISTING membership subscription to Full ($119/mo or
// $1,190/yr) — e.g. a grandfathered $50/mo Forum member moving up to Full. This
// changes the member's CURRENT Stripe subscription in place (swaps the price on
// the existing subscription item) rather than creating a second subscription, so
// they are never billed for both plans at once.
//
// Why not just open a new Checkout? create-membership-checkout.js starts a BRAND
// NEW subscription. For someone who already pays $50/mo that would stack a second
// live subscription (billed $50 AND $119). This endpoint is the correct path for
// anyone who already has an active/trialing subscription: it edits that one.
//
// Billing behavior: proration_behavior 'always_invoice' bills the prorated
// difference for the remainder of the current period NOW, on the card already on
// file, then renews at the Full price. The webhook (customer.subscription.updated)
// then recomputes accounts.tier -> 'full' automatically, because the Full price's
// product maps to 'full' in _lib/subscription-tier.js. No tier write happens here.
//
// Auth: requires a valid signed session token (Bearer or body.token). Email comes
// from the verified token, never from client input.
//
// POST body: { plan?, dry_run?, token? }
//   plan: 'full_monthly_119' (default) or 'full_annual_1190'. If omitted, the
//         cadence is matched to the existing subscription (monthly -> monthly,
//         annual -> annual).
//   dry_run: if true, previews the price swap + the proration amount and changes
//            nothing. Use this to show "you'll be charged $X today" before commit.
//
// Responses:
//   200 { upgraded:true, subscription, from_amount_cents, to_amount_cents, ... }
//   200 { needs_checkout:true }         -> caller has no active sub; use Checkout
//   200 { already_full:true }           -> caller is already on a Full sub
//   409 { error, reason:'multiple_subscriptions' | 'no_card' }  -> handle by hand
//
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET

const { verifyToken } = require('./_lib/session');
const { tierForProduct, ACCESS_STATUSES } = require('./_lib/subscription-tier');

// Full plans that an upgrade may target, by cadence. Keyed by the Stripe Price
// lookup_key, mirroring create-membership-checkout.js's PURCHASABLE allowlist.
const FULL_PLANS = ['full_monthly_119', 'full_annual_1190'];

exports.handler = async function (event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Verify session token (Bearer header or body.token).
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const v = verifyToken(token);
  if (!v.valid) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Not authenticated', reason: v.reason }) };
  const email = (v.claims.email || '').toLowerCase().trim();
  if (!email) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No email in session' }) };

  // If an explicit plan is given it must be a known Full plan.
  if (body.plan && FULL_PLANS.indexOf(body.plan) === -1) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown or closed plan', plan: body.plan }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!process.env.STRIPE_SECRET_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sb = (path, init) => fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', ...(init && init.headers) }
  });

  const dryRun = body.dry_run === true;

  try {
    // 1) Resolve the member's account + Stripe customer.
    const acctRes = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id,stripe_customer_id&limit=1', {});
    const accts = acctRes.ok ? await acctRes.json() : [];
    const acct = accts[0] || null;
    const customerId = acct && acct.stripe_customer_id ? acct.stripe_customer_id : null;

    // No customer on file at all -> they have never paid us. A fresh Checkout is
    // the right path (there is nothing to upgrade in place).
    if (!customerId) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ needs_checkout: true, reason: 'no_customer' }) };
    }

    // 2) Find their active/trialing subscriptions. Only these can be upgraded in
    //    place; a canceled/expired one has nothing live to edit.
    const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    const live = list.data.filter(s => ACCESS_STATUSES.has(s.status));

    if (!live.length) {
      // Customer exists but nothing is live (all canceled/expired). Start fresh.
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ needs_checkout: true, reason: 'no_active_subscription' }) };
    }

    // Already on Full? If ANY live sub is already Full, there is nothing to do.
    const alreadyFull = live.some(s => {
      const it = s.items && s.items.data && s.items.data[0];
      const prod = it && it.price && it.price.product;
      return tierForProduct(prod, 'forum') === 'full';
    });
    if (alreadyFull) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ already_full: true }) };
    }

    // More than one live (non-Full) subscription: ambiguous which to convert, and
    // editing one would leave the other billing. Refuse and route to support so a
    // human (Michael) resolves it rather than risking a double charge.
    if (live.length > 1) {
      return {
        statusCode: 409, headers: CORS,
        body: JSON.stringify({
          error: 'You have more than one active subscription. Please contact support so we can upgrade you without a double charge.',
          reason: 'multiple_subscriptions',
          subscription_ids: live.map(s => s.id)
        })
      };
    }

    const sub = live[0];
    const item = sub.items.data[0];
    const currentPrice = item.price;
    const currentInterval = currentPrice.recurring ? currentPrice.recurring.interval : 'month';

    // 3) Pick the target Full plan: explicit body.plan wins, else match cadence.
    const targetPlan = body.plan || (currentInterval === 'year' ? 'full_annual_1190' : 'full_monthly_119');
    const prices = await stripe.prices.list({ lookup_keys: [targetPlan], active: true, limit: 1 });
    if (!prices.data.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Full price not found', plan: targetPlan }) };
    }
    const targetPrice = prices.data[0];

    if (targetPrice.id === currentPrice.id) {
      // Same price already — treat as already-full (defensive; the product check
      // above should have caught it).
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ already_full: true }) };
    }

    // 4) Require a card on file. Upgrading with proration_behavior 'always_invoice'
    //    charges the difference immediately; with no card that invoice would fail.
    let customer = {};
    try { customer = await stripe.customers.retrieve(customerId); } catch (e) { customer = {}; }
    const hasCard = !!(customer && customer.invoice_settings && customer.invoice_settings.default_payment_method)
      || !!(sub.default_payment_method);
    if (!hasCard) {
      return {
        statusCode: 409, headers: CORS,
        body: JSON.stringify({
          error: 'No card on file to charge the prorated difference. Please update your payment method first, then upgrade.',
          reason: 'no_card'
        })
      };
    }

    // 5) DRY RUN: preview the swap + the proration that would be charged today.
    if (dryRun) {
      let prorationCents = null, prorationCurrency = 'usd';
      try {
        // Method name differs across Stripe SDK versions: older exposes
        // invoices.retrieveUpcoming, newer invoices.createPreview. Best-effort —
        // if neither is available the figure is simply omitted (client shows a
        // generic "prorated amount today" instead of an exact number).
        let upcoming = null;
        if (typeof stripe.invoices.retrieveUpcoming === 'function') {
          upcoming = await stripe.invoices.retrieveUpcoming({
            customer: customerId,
            subscription: sub.id,
            subscription_items: [{ id: item.id, price: targetPrice.id }],
            subscription_proration_behavior: 'always_invoice'
          });
        } else if (typeof stripe.invoices.createPreview === 'function') {
          upcoming = await stripe.invoices.createPreview({
            customer: customerId,
            subscription: sub.id,
            subscription_details: {
              items: [{ id: item.id, price: targetPrice.id }],
              proration_behavior: 'always_invoice'
            }
          });
        }
        if (upcoming) {
          prorationCents = upcoming.amount_due;
          prorationCurrency = upcoming.currency || 'usd';
        }
      } catch (e) { /* preview is best-effort; leave null on error */ }
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          dry_run: true,
          subscription: sub.id,
          from_plan: currentPrice.lookup_key || null,
          from_amount_cents: currentPrice.unit_amount,
          to_plan: targetPlan,
          to_amount_cents: targetPrice.unit_amount,
          interval: targetPrice.recurring ? targetPrice.recurring.interval : null,
          charge_today_cents: prorationCents,
          charge_today_currency: prorationCurrency
        })
      };
    }

    // 6) COMMIT: swap the price on the existing item. always_invoice bills the
    //    prorated difference now on the card on file; renews at the Full price.
    //    Tag it owned so the webhook records it as ours. The webhook then updates
    //    accounts.tier via recomputeAccountTier — no tier write here.
    const updated = await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: targetPrice.id }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
      metadata: Object.assign({}, sub.metadata, {
        tbp_owned: 'true',
        tbp_account_email: email,
        tbp_upgraded_from: currentPrice.id
      })
    });

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        upgraded: true,
        subscription: updated.id,
        status: updated.status,
        from_amount_cents: currentPrice.unit_amount,
        to_plan: targetPlan,
        to_amount_cents: targetPrice.unit_amount,
        interval: targetPrice.recurring ? targetPrice.recurring.interval : null
      })
    };
  } catch (e) {
    // A declined proration charge (error_if_incomplete) lands here. Surface a
    // clear message so the client can tell the member their card was declined.
    const msg = (e && e.message) || 'Upgrade failed';
    const declined = e && (e.code === 'card_declined' || (e.raw && e.raw.code === 'card_declined'));
    return {
      statusCode: declined ? 402 : 500,
      headers: CORS,
      body: JSON.stringify({ error: msg, reason: declined ? 'card_declined' : 'error' })
    };
  }
};
