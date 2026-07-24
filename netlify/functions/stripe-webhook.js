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
      const result = await handleSubscriptionEvent(stripeEvent.data.object, stripe);
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, subscription: result }) };
    }

    // --- Checkout completed: template purchase, else certified mail --------
    if (stripeEvent.type === 'checkout.session.completed') {
      const s = stripeEvent.data.object;
      if (s.metadata && s.metadata.tbp_purchase === 'template') {
        return await handleTemplatePurchase(s, headers);
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
async function handleTemplatePurchase(session, headers) {
  try {
    const email = (session.metadata && session.metadata.tbp_account_email || session.customer_email || '').toLowerCase().trim();
    const templateId = session.metadata && session.metadata.template_id;
    if (!email || !templateId) return { statusCode: 200, headers, body: JSON.stringify({ received: true, skipped: 'missing metadata' }) };

    const accts = await sbGet('accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1');
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
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, template_purchase: true }) };
  } catch (e) {
    console.error('handleTemplatePurchase error:', e.message);
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, error: e.message }) };
  }
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
