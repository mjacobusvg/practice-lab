// netlify/functions/backfill-subscriptions.js
//
// One-time (idempotent, re-runnable) backfill that reads the LIVE Stripe
// subscriptions in this account and populates the Supabase `subscriptions`
// table, plus fills accounts.stripe_customer_id where it is missing.
//
// WHY: Circle currently bills these members through Stripe Connect into this
// same account. Migrating off Circle does not move the money (it already lands
// here); it means OUR code has to know about these subscriptions. This snapshot
// seeds the subscriptions table so the platform can drive access from Stripe
// status instead of Circle membership. From then on, stripe-webhook.js keeps
// the table fresh on every subscription/invoice event.
//
// SAFE BY DEFAULT: dry_run is true unless explicitly set false. A dry run reads
// Stripe + Supabase and returns the exact plan (matched / unmatched / mismatch)
// WITHOUT writing anything. Nothing here ever creates, cancels, or charges a
// Stripe subscription; it only reads Stripe and writes our own tables.
//
// Each subscription row records the tier THAT subscription grants (derived from
// the Stripe product), plus an is_grandfathered flag and the Stripe customer.
// A member's ACCESS tier is the highest active tier across their subscriptions;
// this backfill does NOT rewrite accounts.tier. Rows whose granted tier differs
// from the current accounts.tier are reported (expected for merged multi-sub
// members and comps), never auto-changed. Members with no account row are
// reported, never auto-created.
//
// POST body: { secret, dry_run (default true), include_canceled (default false) }
// Env (practice-lab Netlify site): STRIPE_SECRET_KEY, SUPABASE_URL,
//   SUPABASE_SERVICE_KEY, BACKFILL_SECRET

// Product -> tier map, merged-identity alias, and grandfathered/grouping logic
// are shared with stripe-webhook.js so the two can never diverge.
const {
  CUSTOMER_ALIAS_CMID,
  tierForProduct,
  isGrandfathered
} = require('./_lib/subscription-tier');

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

  const dryRun = body.dry_run !== false;            // default TRUE (safe)
  const includeCanceled = body.include_canceled === true;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !STRIPE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const stripe = require('stripe')(STRIPE_KEY);

  const sb = (path, init) => fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(init && init.headers)
    }
  });

  try {
    // 1) Load accounts (email + circle_member_id + tier + existing stripe id).
    const acctRes = await sb('accounts?select=id,email,tier,circle_member_id,stripe_customer_id', {});
    if (!acctRes.ok) throw new Error('accounts fetch failed: ' + acctRes.status);
    const accounts = await acctRes.json();
    const acctByEmail = new Map();
    const acctByCmid = new Map();
    for (const a of accounts) {
      if (a.email) acctByEmail.set(String(a.email).toLowerCase().trim(), a);
      if (a.circle_member_id != null) acctByCmid.set(String(a.circle_member_id), a);
    }

    // 2) Load existing subscription rows so the backfill is idempotent.
    const existRes = await sb('subscriptions?select=id,stripe_subscription_id', {});
    const existing = existRes.ok ? await existRes.json() : [];
    const existingBySubId = new Map(existing.filter(r => r.stripe_subscription_id).map(r => [r.stripe_subscription_id, r.id]));

    // 3) Page through all Stripe subscriptions (expand customer for email/metadata).
    const wantedStatuses = includeCanceled ? null : new Set(['active', 'trialing', 'past_due', 'unpaid']);
    const subs = [];
    for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.customer'] })) {
      if (wantedStatuses && !wantedStatuses.has(s.status)) continue;
      subs.push(s);
    }

    const plan = [];       // rows we would write
    const unmatched = [];   // sub with no account row
    const mismatches = [];  // product tier != account tier
    const custIdByAccount = new Map(); // account.id -> stripe customer id to backfill

    for (const s of subs) {
      const item = s.items && s.items.data && s.items.data[0];
      const price = item && item.price;
      const productId = price && price.product;
      const amount = price ? price.unit_amount : null;
      const interval = price && price.recurring ? price.recurring.interval : null;

      const customer = (s.customer && typeof s.customer === 'object') ? s.customer : {};
      const email = (customer.email || '').toLowerCase().trim();
      const cmid = (customer.metadata && customer.metadata.community_member_id)
        || (s.metadata && s.metadata.community_member_id) || null;

      // Alias (merged multi-identity member) wins, then email, then Circle ID.
      const aliasCmid = customer.id ? CUSTOMER_ALIAS_CMID[customer.id] : null;
      const account = (aliasCmid ? acctByCmid.get(aliasCmid) : null)
        || acctByEmail.get(email)
        || (cmid ? acctByCmid.get(String(cmid)) : null);

      if (!account) {
        unmatched.push({ stripe_subscription_id: s.id, email, cmid, amount_cents: amount, product: productId, status: s.status });
        continue;
      }

      // Tier this subscription grants (product-derived). Fall back to the account
      // tier only if the product is unknown, so we never invent access.
      const soldTier = tierForProduct(productId, account.tier);
      // Informational: the account tier differs from what this single sub grants.
      // Expected for merged multi-sub members (a $50 row under a full account) and
      // for comped accounts; surfaced, never auto-changed.
      if (soldTier !== account.tier) {
        mismatches.push({ email, account_tier: account.tier, product_tier: soldTier, amount_cents: amount, product: productId });
      }

      // Grandfathered = paying below the current standard rate for their cadence.
      const grandfathered = isGrandfathered(amount, interval);

      // current_period_* live on the subscription item in newer API versions.
      const periodStart = (item && item.current_period_start) || s.current_period_start || null;
      const periodEnd = (item && item.current_period_end) || s.current_period_end || null;
      const toIso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);

      plan.push({
        account_id: account.id,
        product: productId,
        tier: soldTier,                   // tier THIS subscription grants
        status: s.status,
        is_grandfathered: grandfathered,
        stripe_subscription_id: s.id,
        stripe_customer_id: customer.id || null,
        stripe_price_id: (price && price.id) || null,
        amount_cents: amount,             // what they actually pay; product alone can't tell $89 from $119
        billing_interval: interval,
        current_period_start: toIso(periodStart),
        current_period_end: toIso(periodEnd),
        canceled_at: toIso(s.canceled_at),
        updated_at: new Date().toISOString()
      });
      if (customer.id && !account.stripe_customer_id) custIdByAccount.set(account.id, customer.id);
    }

    let inserted = 0, updated = 0, acctPatched = 0;
    if (!dryRun) {
      for (const row of plan) {
        const existingRowId = existingBySubId.get(row.stripe_subscription_id);
        if (existingRowId) {
          const r = await sb('subscriptions?id=eq.' + existingRowId, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row)
          });
          if (r.ok) updated++;
        } else {
          const r = await sb('subscriptions', {
            method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row)
          });
          if (r.ok) inserted++;
        }
      }
      for (const [accountId, custId] of custIdByAccount) {
        const r = await sb('accounts?id=eq.' + accountId, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ stripe_customer_id: custId })
        });
        if (r.ok) acctPatched++;
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        dry_run: dryRun,
        include_canceled: includeCanceled,
        stripe_subscriptions_scanned: subs.length,
        would_write_rows: plan.length,
        matched: plan.length,
        unmatched_count: unmatched.length,
        unmatched,
        tier_mismatch_count: mismatches.length,
        tier_mismatches: mismatches,
        stripe_customer_ids_to_backfill: custIdByAccount.size,
        written: dryRun ? null : { inserted, updated, accounts_patched: acctPatched }
      }, null, 2)
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
