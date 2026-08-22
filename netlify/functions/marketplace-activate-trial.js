// netlify/functions/marketplace-activate-trial.js
//
// STEP 2 of the buyer flow (nonmembers only): activate the free month.
// This is a PLATFORM Checkout (TBP Payments account, NOT the seller's connected
// account) in subscription mode: $0 today + a 30-day trial on full_monthly_119,
// which auto-converts to $119/mo unless canceled. The card is saved on TBP's
// platform, so this is the one piece that lands on our own account.
//
// Guardrails: the order must be a PAID marketplace order for this email, the buyer
// must be a nonmember, and each email gets ONE promo month for life.
//
// The actual grant + attribution row is written by stripe-webhook.js when the
// platform checkout completes (metadata.tbp_purchase === 'marketplace_trial').
//
// Body: { order_id, success_url, cancel_url }
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, STRIPE_SECRET_KEY /
//      STRIPE_CONNECT_TEST_SECRET_KEY, PUBLIC_BASE_URL

const { sb, isLive, platformStripe, resolveBuyer, hasUsedPromoMonth, ensureAccount } = require('./_lib/marketplace');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};
const j = (s, o) => ({ statusCode: s, headers: CORS, body: JSON.stringify(o) });
const TRIAL_DAYS = 30;
const MEMBERSHIP_LOOKUP_KEY = 'full_monthly_119';

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return j(200, {});
  if (event.httpMethod !== 'POST') return j(405, { error: 'POST only' });

  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return j(400, { error: 'Bad JSON' }); }
  const orderId = String(body.order_id || '').trim();
  if (!orderId) return j(400, { error: 'order_id required' });
  if (!body.success_url || !body.cancel_url) return j(400, { error: 'success_url and cancel_url required' });

  try {
    const orders = await sb('marketplace_orders?id=eq.' + encodeURIComponent(orderId) +
      '&select=id,status,buyer_email,seller_id&limit=1');
    const order = orders && orders[0];
    if (!order) return j(404, { error: 'Order not found' });
    if (order.status !== 'paid') return j(409, { error: 'not_paid', message: 'This purchase is not complete yet.' });

    const email = String(order.buyer_email || '').toLowerCase().trim();

    // Members do not get the promo month.
    const buyer = await resolveBuyer(email);
    if (buyer.isMember) return j(200, { skip: true, reason: 'already_member' });

    // One promo month per email, for life.
    if (await hasUsedPromoMonth(email)) return j(200, { skip: true, reason: 'promo_already_used' });

    // Ensure an account + Stripe customer so tier sync + one-per-email hold together.
    const accountId = await ensureAccount(email);
    const stripe = platformStripe();

    let customerId = null;
    if (accountId) {
      const a = await sb('accounts?id=eq.' + accountId + '&select=stripe_customer_id&limit=1');
      customerId = a && a[0] ? a[0].stripe_customer_id : null;
    }
    if (!customerId) {
      const customer = await stripe.customers.create({ email: email, metadata: { tbp_account_email: email } });
      customerId = customer.id;
      if (accountId) {
        await sb('accounts?id=eq.' + accountId, 'PATCH', { stripe_customer_id: customerId }, 'return=minimal').catch(function () {});
      }
    }

    // Resolve the membership price by lookup key (same as create-membership-checkout).
    const prices = await stripe.prices.list({ lookup_keys: [MEMBERSHIP_LOOKUP_KEY], active: true, limit: 1 });
    const price = prices.data[0];
    if (!price) return j(500, { error: 'Membership price not configured' });

    const meta = {
      tbp_purchase: 'marketplace_trial',
      tbp_account_email: email,
      source_order_id: order.id,
      source_seller_id: order.seller_id
    };
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: price.id, quantity: 1 }],
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        metadata: { tbp_owned: 'true', tbp_source: 'marketplace_trial', tbp_account_email: email, source_order_id: order.id, source_seller_id: order.seller_id }
      },
      metadata: meta,
      success_url: body.success_url,
      cancel_url: body.cancel_url
    });

    return j(200, { ok: true, url: checkout.url, trial_days: TRIAL_DAYS, test_mode: !isLive() });
  } catch (e) {
    return j(500, { error: e.message });
  }
};
