// netlify/functions/stripe-webhook.js  (practice-lab)
//
// This site's Stripe webhook. Two responsibilities:
//   1) checkout.session.completed for certified-mail jobs (unchanged): marks the
//      job paid and triggers the vendor send.
//   2) customer.subscription.*: keeps the Supabase `subscriptions` table and
//      each member's accounts.tier in sync with Stripe as memberships renew,
//      change, or cancel. This is what lets the platform drive access from Stripe
//      subscription status instead of Circle membership.
//
// Access rule: a member's tier is the HIGHEST active tier across their
// subscriptions. accounts.tier_override, when set, wins and is never overwritten
// (protects comped/lifetime accounts from being downgraded by sub math).
//
// Required env (practice-lab Netlify site):
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET   (signing secret for THIS site's webhook endpoint)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

const {
  CUSTOMER_ALIAS_CMID,
  ACCESS_STATUSES,
  tierForProduct,
  isGrandfathered,
  highestTier
} = require('./_lib/subscription-tier');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const toIso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);

function sb(path, init) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(init && init.headers)
    }
  });
}
async function sbGet(path) {
  const r = await sb(path, {});
  return r.ok ? r.json() : [];
}

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
  }

  try {
    // --- Membership subscription lifecycle ---------------------------------
    if (stripeEvent.type.startsWith('customer.subscription.')) {
      // Re-fetch the LIVE subscription so we always persist Stripe's CURRENT
      // status, never the (possibly stale) status frozen in this event payload.
      // Why: a fast Checkout fires subscription.created (status=incomplete) and
      // subscription.updated (status=active) almost simultaneously. With no guard
      // the 'incomplete' event could land LAST and overwrite 'active' — which
      // froze a paid member at free (the Tara case). Reading the source of truth
      // on every event makes event ordering irrelevant: whoever writes last still
      // writes the real current status. Falls back to the event payload only if
      // the sub can't be retrieved (e.g. already deleted).
      let liveSub = stripeEvent.data.object;
      try {
        if (liveSub && liveSub.id) liveSub = await stripe.subscriptions.retrieve(liveSub.id);
      } catch (e) {
        console.warn('subscription re-fetch failed, using event payload:', liveSub && liveSub.id, e && e.message);
      }
      const result = await handleSubscriptionEvent(liveSub, stripe);
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, subscription: result }) };
    }

    // --- Checkout completed: template purchase, else certified mail --------
    if (stripeEvent.type === 'checkout.session.completed') {
      const s = stripeEvent.data.object;
      if (s.metadata && s.metadata.tbp_purchase === 'template') {
        return await handleTemplatePurchase(s, headers, stripe);
      }
      if (s.metadata && s.metadata.tbp_purchase === 'marketplace_trial') {
        return await handleMarketplaceTrial(s, headers);
      }
      return await handleCertifiedMailCheckout(s, headers);
    }

    // Anything else: acknowledge and ignore.
    return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('stripe-webhook error on', stripeEvent && stripeEvent.type, err.message);
    // 200 so Stripe does not hammer retries on a transient DB blip; the next
    // event (or the backfill) reconciles. Signature failures already returned 400.
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, error: err.message }) };
  }
};

// ---------------------------------------------------------------------------

// A free member bought a single template. Grant them access by recording the
// purchase (idempotent on account+template). template-download.js checks this.
async function handleTemplatePurchase(session, headers, stripe) {
  try {
    const email = (session.metadata && session.metadata.tbp_account_email || session.customer_email || '').toLowerCase().trim();
    const templateId = session.metadata && session.metadata.template_id;
    if (!email || !templateId) return { statusCode: 200, headers, body: JSON.stringify({ received: true, skipped: 'missing metadata' }) };

    const accts = await sbGet('accounts?email=eq.' + encodeURIComponent(email) + '&select=id,tier,email&limit=1');
    if (!accts || !accts[0]) return { statusCode: 200, headers, body: JSON.stringify({ received: true, skipped: 'no account' }) };

    const row = {
      account_id: accts[0].id,
      template_id: templateId,
      amount_cents: session.amount_total || 0,
      stripe_session_id: session.id
    };
    // resolution=merge-duplicates makes re-delivery of the event a no-op.
    await sb('template_purchases?on_conflict=account_id,template_id', {
      method: 'POST',
      headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify(row)
    });

    // If this purchase grants membership days, start a trialing Full subscription
    // on the card the buyer just saved. Best-effort; never blocks the 200.
    const grantDays = parseInt((session.metadata && session.metadata.tbp_grant_full_days) || '0', 10);
    if (grantDays > 0 && session.customer && stripe) {
      await startToolkitTrialSubscription(session, accts[0], grantDays, stripe).catch(function (e) {
        console.error('startToolkitTrialSubscription error:', e.message);
      });
    }
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, template_purchase: true }) };
  } catch (e) {
    console.error('handleTemplatePurchase error:', e.message);
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, error: e.message }) };
  }
}

// A marketplace nonmember activated their free month (Step 2 of the buyer flow).
// The subscription's tier is synced by handleSubscriptionEvent like any other; this
// only records the promo-month grant + seller attribution for the funnel, and is
// idempotent (one grant per email). See MARKETPLACE.md.
async function handleMarketplaceTrial(session, headers) {
  try {
    const email = ((session.metadata && session.metadata.tbp_account_email) || session.customer_email || '').toLowerCase().trim();
    if (!email) return { statusCode: 200, headers, body: JSON.stringify({ received: true, skipped: 'no email' }) };

    const existing = await sbGet('marketplace_trial_grants?buyer_email=eq.' + encodeURIComponent(email) + '&select=id&limit=1');
    if (existing && existing[0]) return { statusCode: 200, headers, body: JSON.stringify({ received: true, already_granted: true }) };

    const accts = await sbGet('accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1');
    const accountId = accts && accts[0] ? accts[0].id : null;

    await sb('marketplace_trial_grants', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        account_id: accountId,
        buyer_email: email,
        source_order_id: (session.metadata && session.metadata.source_order_id) || null,
        source_seller_id: (session.metadata && session.metadata.source_seller_id) || null,
        stripe_subscription_id: session.subscription || null,
        granted_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        status: 'trialing'
      })
    });
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, marketplace_trial: true }) };
  } catch (e) {
    console.error('handleMarketplaceTrial error:', e.message);
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, error: e.message }) };
  }
}

// A non-member bought the toolkit (which includes N free days of Full). Start a
// Full subscription with a trial of N days on the card they just saved, so it
// auto-converts to paid unless they cancel. Guards keep it idempotent and stop it
// stacking on anyone who is already a paying member or already has a live sub.
async function startToolkitTrialSubscription(session, acct, trialDays, stripe) {
  const customerId = session.customer;
  // Skip if they are already a paying member.
  if (acct.tier === 'forum' || acct.tier === 'full') return;
  // Skip if this customer already has a live subscription (also covers webhook retries).
  const existing = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  const live = (existing.data || []).some(function (s) {
    return ['active', 'trialing', 'past_due', 'unpaid'].indexOf(s.status) !== -1;
  });
  if (live) return;

  // Make the card saved at checkout the customer's default for invoices.
  if (session.payment_intent) {
    const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
    const pm = pi && pi.payment_method;
    if (pm) await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm } });
  }

  // Resolve the live Full monthly price by lookup_key (same source as membership checkout).
  const prices = await stripe.prices.list({ lookup_keys: ['full_monthly_119'], active: true, limit: 1 });
  if (!prices.data.length) { console.error('toolkit trial: full_monthly_119 price not found'); return; }

  await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: prices.data[0].id }],
    trial_period_days: trialDays,
    // If they never add/keep a valid card, cancel at trial end instead of forcing payment.
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    metadata: { tbp_owned: 'true', tbp_account_email: (acct.email || session.metadata.tbp_account_email || ''), tbp_source: 'toolkit_trial' }
  });
}

// Record a referral for a paid conversion by delegating to referral-attribution,
// which resolves the referrer account -> name/email, guards self-referral, dedups
// per new member, and emails Michael. Best-effort; never affects the webhook 200.
async function recordReferralOnPaid(newAccountId, referrerAccountId) {
  const rows = await sbGet('accounts?id=eq.' + encodeURIComponent(newAccountId) + '&select=email,name');
  const a = rows[0];
  if (!a || !a.email) return;
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://thinkbeyondpractice.com';
  await fetch(base + '/.netlify/functions/referral-attribution', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      new_member_email: a.email, new_member_name: a.name || null,
      referrer_account_id: referrerAccountId, source: 'ref-link-paid'
    })
  });
}

async function handleSubscriptionEvent(sub, stripe) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const price = item && item.price;
  const productId = price && price.product;
  const amount = price ? price.unit_amount : null;
  const interval = price && price.recurring ? price.recurring.interval : null;
  const customerId = (typeof sub.customer === 'string') ? sub.customer : (sub.customer && sub.customer.id);

  // Resolve the owning account. Prefer the existing subscription row (definitive),
  // then the merged-identity alias, then this customer's stored id, then the
  // customer's email / Circle id.
  let accountId = null;
  const existingRows = await sbGet('subscriptions?stripe_subscription_id=eq.' + encodeURIComponent(sub.id) + '&select=id,account_id');
  const existing = existingRows[0] || null;
  if (existing) accountId = existing.account_id;

  if (!accountId && customerId) {
    const aliasCmid = CUSTOMER_ALIAS_CMID[customerId];
    if (aliasCmid) {
      const a = await sbGet('accounts?circle_member_id=eq.' + encodeURIComponent(aliasCmid) + '&select=id');
      if (a[0]) accountId = a[0].id;
    }
    if (!accountId) {
      const a = await sbGet('accounts?stripe_customer_id=eq.' + encodeURIComponent(customerId) + '&select=id');
      if (a[0]) accountId = a[0].id;
    }
    if (!accountId) {
      // Fetch the customer for email + Circle id.
      let customer = {};
      try { customer = await stripe.customers.retrieve(customerId); } catch (e) { customer = {}; }
      const email = (customer.email || '').toLowerCase().trim();
      if (email) {
        const a = await sbGet('accounts?email=eq.' + encodeURIComponent(email) + '&select=id');
        if (a[0]) accountId = a[0].id;
      }
      const cmid = customer.metadata && customer.metadata.community_member_id;
      if (!accountId && cmid) {
        const a = await sbGet('accounts?circle_member_id=eq.' + encodeURIComponent(cmid) + '&select=id');
        if (a[0]) accountId = a[0].id;
      }
    }
  }

  if (!accountId) {
    console.warn('subscription event with no matching account:', sub.id, customerId);
    return { matched: false, stripe_subscription_id: sub.id };
  }

  const row = {
    account_id: accountId,
    product: productId,
    tier: tierForProduct(productId, 'forum'),
    status: sub.status,
    is_grandfathered: isGrandfathered(amount, interval),
    stripe_subscription_id: sub.id,
    stripe_customer_id: customerId || null,
    stripe_price_id: (price && price.id) || null,
    amount_cents: amount,             // what they actually pay; product alone can't tell $89 from $119
    billing_interval: interval,
    current_period_start: toIso((item && item.current_period_start) || sub.current_period_start),
    current_period_end: toIso((item && item.current_period_end) || sub.current_period_end),
    canceled_at: toIso(sub.canceled_at),
    updated_at: new Date().toISOString()
  };

  if (existing) {
    await sb('subscriptions?id=eq.' + existing.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  } else {
    await sb('subscriptions', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
    // First time we've seen this subscription = a paid conversion. If the buyer
    // arrived via a member's ?ref= invite link, record the referral now (a
    // referral is a PAID event). Dedup, referrer resolution, and the notify email
    // all happen inside referral-attribution.
    if (sub.metadata && sub.metadata.referred_by_account_id && (sub.status === 'active' || sub.status === 'trialing')) {
      try { await recordReferralOnPaid(accountId, sub.metadata.referred_by_account_id); }
      catch (e) { console.warn('referral record failed:', e && e.message); }
    }
  }

  const newTier = await recomputeAccountTier(accountId);
  return { matched: true, account_id: accountId, status: sub.status, tier: newTier };
}

// accounts.tier = tier_override if set, else the highest active subscription tier
// (default 'free' when no active subs). Never overwrites tier_override.
async function recomputeAccountTier(accountId) {
  const acctRows = await sbGet('accounts?id=eq.' + accountId + '&select=id,tier,tier_override,is_admin');
  const acct = acctRows[0];
  if (!acct) return null;

  let target;
  if (acct.tier_override) {
    target = acct.tier_override;
  } else {
    const subs = await sbGet('subscriptions?account_id=eq.' + accountId + '&select=tier,status');
    const activeTiers = subs.filter(s => ACCESS_STATUSES.has(s.status)).map(s => s.tier);
    target = activeTiers.length ? highestTier(activeTiers) : 'free';
  }

  if (target && target !== acct.tier) {
    await sb('accounts?id=eq.' + accountId, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ tier: target, updated_at: new Date().toISOString() })
    });
  }
  return target;
}

// ---------------------------------------------------------------------------
// Certified-mail checkout handler (behavior unchanged from the original file).
async function handleCertifiedMailCheckout(session, headers) {
  const cmJobId = session.metadata && session.metadata.certified_mail_job_id;
  if (!cmJobId) {
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, certified_mail: false }) };
  }

  try {
    await sb('certified_mail_jobs?id=eq.' + cmJobId, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'paid',
        stripe_session_id: session.id,
        amount_paid: session.amount_total || null,
        updated_at: new Date().toISOString()
      })
    });

    try {
      const sender = require('./send-certified-mail.js');
      await sender.submitCertifiedMail(cmJobId);
    } catch (sendErr) {
      console.error('Certified mail send failed for job', cmJobId, sendErr.message);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ received: true, certified_mail_job: cmJobId }) };
  } catch (err) {
    console.error('Certified-mail webhook error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, certified_mail_error: err.message }) };
  }
}
