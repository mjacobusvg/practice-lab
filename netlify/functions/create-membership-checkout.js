// netlify/functions/create-membership-checkout.js
//
// Creates a Stripe Checkout Session for a membership plan. This is how a member
// starts a NEW owned subscription on our own billing (as opposed to the legacy
// Circle-created subs). The resulting subscription is tagged tbp_owned='true' so
// stripe-webhook.js records it and sets the account tier.
//
// Auth: requires a valid signed session token (Bearer or body.token). The member's
// email comes from the verified token, never from client input.
//
// Only plans in PURCHASABLE are allowed, enforced here in code. Today that is Full
// only ($119/mo, $1,190/yr); the post-accreditation Forum and $149 plans exist as
// Stripe Prices but are not open to new checkout until added to this list.
//
// POST body: { plan, success_url, cancel_url, token? }
//   plan: a Stripe Price lookup_key (see PURCHASABLE)
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET

const { verifyToken } = require('./_lib/session');

// New-member purchasable plans (Stripe Price lookup_keys). Enforced allowlist.
const PURCHASABLE = ['full_monthly_119', 'full_annual_1190'];

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

  const plan = body.plan;
  if (PURCHASABLE.indexOf(plan) === -1) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown or closed plan', plan }) };
  }
  if (!body.success_url || !body.cancel_url) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'success_url and cancel_url required' }) };
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

  try {
    // Resolve the Price by lookup_key.
    const prices = await stripe.prices.list({ lookup_keys: [plan], active: true, limit: 1 });
    if (!prices.data.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Price not found for plan', plan }) };
    }
    const priceId = prices.data[0].id;

    // Find the member's account + any existing Stripe customer.
    const acctRes = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id,stripe_customer_id&limit=1', {});
    const accts = acctRes.ok ? await acctRes.json() : [];
    const acct = accts[0] || null;
    let customerId = acct && acct.stripe_customer_id ? acct.stripe_customer_id : null;

    // Stacking guard: this endpoint starts a BRAND NEW subscription. If the member
    // already has a live (active/trialing) subscription, a new one would bill them
    // twice (e.g. keep $50 forum AND add $119 full). That case is an UPGRADE, not a
    // new checkout — send them to upgrade-membership.js, which edits the existing
    // subscription in place. Only genuinely un-subscribed members proceed here.
    if (customerId) {
      const live = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
      const hasLive = live.data.some(s => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due');
      if (hasLive) {
        return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'You already have an active subscription. Use the in-platform upgrade instead of starting a new one.', reason: 'already_subscribed' }) };
      }
    }

    if (!customerId) {
      const customer = await stripe.customers.create({ email, metadata: { tbp_account_email: email } });
      customerId = customer.id;
      if (acct) {
        await sb('accounts?id=eq.' + acct.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ stripe_customer_id: customerId }) });
      }
    }

    // Carry a referral through to the subscription: the buyer arrived via a
    // member's ?ref=<account id> invite link. Only a valid uuid that isn't the
    // buyer's own account is passed; the webhook records the referral (a referral
    // is a PAID conversion, so this is the correct point to attribute it).
    const subMeta = { tbp_owned: 'true', tbp_account_email: email };
    const refBy = String(body.referred_by || '').trim();
    if (/^[0-9a-f-]{36}$/i.test(refBy) && !(acct && acct.id === refBy)) {
      subMeta.referred_by_account_id = refBy;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: body.success_url,
      cancel_url: body.cancel_url,
      subscription_data: { metadata: subMeta },
      metadata: { tbp_owned: 'true', tbp_account_email: email, plan }
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: session.url }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
