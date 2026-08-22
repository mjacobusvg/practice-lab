// netlify/functions/_lib/marketplace.js
//
// Shared helpers for the Member Marketplace (Denis mentorship pilot). See
// MARKETPLACE.md for the design of record. Everything here is server-side only
// (service-role Supabase, Stripe secret keys) — never import into a browser.
//
// Payment model (locked): a paid offering is a DIRECT CHARGE on the seller's
// connected Stripe account (mirrors the letter-charge flow). The bundle adds an
// application_fee_amount equal to TBP's toolkit half, so Denis is merchant of
// record and TBP only ever collects a fee (no payout to Denis, no 1099 either
// direction). The free-month trial is a SEPARATE platform Checkout (see
// marketplace-activate-trial.js) — the only thing that lands on TBP's own account.

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function sbHeaders(extra) {
  return Object.assign({
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

// Thin PostgREST helper. path is everything after /rest/v1/.
async function sb(path, method, body, prefer) {
  const opts = { method: method || 'GET', headers: sbHeaders(prefer ? { Prefer: prefer } : null) };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  if (!res.ok) {
    const err = new Error('supabase ' + res.status + ': ' + text.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return json;
}

// ---- Payment mode + Stripe keys (fail-safe: TEST unless explicitly live) ----
// Reuses the letter-generator env. MARKETPLACE_PAY_MODE overrides LETTER_PAY_MODE
// if you ever want to launch the marketplace on a different cadence than letters.
function payMode() {
  const m = (process.env.MARKETPLACE_PAY_MODE || process.env.LETTER_PAY_MODE || 'test').toLowerCase();
  return m === 'live' ? 'live' : 'test';
}
function isLive() { return payMode() === 'live'; }

// The seller's connected-account column is mode-split: a sandbox acct_ from the
// test key is unusable with the live key, so test and live never share a column.
function connectAcctColumn() {
  return isLive() ? 'stripe_connect_account_id' : 'stripe_connect_account_id_test';
}

// Platform Stripe key (TBP Payments). Used for the connected-account DIRECT charge
// (platform key + { stripeAccount } header) AND for the platform trial subscription.
function platformStripe() {
  const key = isLive() ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_CONNECT_TEST_SECRET_KEY;
  if (!key) throw new Error('Stripe not configured for ' + payMode() + ' mode');
  return require('stripe')(key);
}

// ---- Buyer pricing eligibility (server-side; NEVER trust the client or the token) ----
//
// Member pricing applies only to a PAID member. A "member" whose only active
// membership is a marketplace promo trial (the free month someone got by buying a
// session) does NOT get member pricing — otherwise they could buy a $200 session,
// get the free month, and immediately use it to take the $399 member toolkit
// (spec section 9). We detect that by checking whether their active membership is
// solely explained by a marketplace_trial_grants row.
//
// Returns { account, isMember, isPromoTrialOnly }. account may be null (nonmember).
async function resolveBuyer(email) {
  const clean = String(email || '').toLowerCase().trim();
  const out = { email: clean, account: null, isMember: false, isPromoTrialOnly: false };
  if (!clean || clean.indexOf('@') === -1) return out;

  const accts = await sb('accounts?email=eq.' + encodeURIComponent(clean) +
    '&select=id,email,name,tier,tier_override,stripe_customer_id&limit=1');
  const account = accts && accts[0];
  out.account = account || null;
  if (!account) return out;

  const tier = String(account.tier || 'free').toLowerCase();
  if (tier !== 'forum' && tier !== 'full') return out; // free -> nonmember

  // Comp/override members are real members for pricing purposes.
  if (account.tier_override) { out.isMember = true; return out; }

  // Look at active subscriptions vs. marketplace trial grants. If every active sub
  // is a marketplace trial, they are promo-trial-only -> public pricing.
  const subs = await sb('subscriptions?account_id=eq.' + account.id +
    '&select=stripe_subscription_id,status&status=in.(active,trialing,past_due)');
  const activeSubIds = (subs || []).map(function (s) { return s.stripe_subscription_id; }).filter(Boolean);

  if (!activeSubIds.length) {
    // tier says member but no active sub we can see: trust the tier, treat as member.
    out.isMember = true;
    return out;
  }

  const grants = await sb('marketplace_trial_grants?buyer_email=eq.' + encodeURIComponent(clean) +
    '&select=stripe_subscription_id,status');
  const trialSubIds = new Set((grants || [])
    .filter(function (g) { return g.status === 'trialing'; })
    .map(function (g) { return g.stripe_subscription_id; })
    .filter(Boolean));

  const hasNonTrialActive = activeSubIds.some(function (id) { return !trialSubIds.has(id); });
  out.isMember = hasNonTrialActive;
  out.isPromoTrialOnly = !hasNonTrialActive;
  return out;
}

// Ensure a (free) account exists for a buyer email so entitlements (toolkit) and
// membership can key to an account_id. Idempotent on email. Returns the id or null.
async function ensureAccount(email, knownId) {
  if (knownId) return knownId;
  const clean = String(email || '').toLowerCase().trim();
  if (!clean || clean.indexOf('@') === -1) return null;
  const existing = await sb('accounts?email=eq.' + encodeURIComponent(clean) + '&select=id&limit=1');
  if (existing && existing[0]) return existing[0].id;
  const rows = await sb('accounts', 'POST', { email: clean, tier: 'free' }, 'return=representation')
    .catch(function () { return null; });
  if (rows && rows[0]) return rows[0].id;
  const again = await sb('accounts?email=eq.' + encodeURIComponent(clean) + '&select=id&limit=1');
  return again && again[0] ? again[0].id : null;
}

// Whether this email has already used its one lifetime marketplace promo month.
async function hasUsedPromoMonth(email) {
  const clean = String(email || '').toLowerCase().trim();
  if (!clean) return false;
  const rows = await sb('marketplace_trial_grants?buyer_email=eq.' + encodeURIComponent(clean) +
    '&select=id&limit=1');
  return !!(rows && rows.length);
}

// Compute the priced line items + split for an offering purchase.
// kind: 'session' | 'bundle'. isMember decides member vs public pricing.
// Returns { amountTotalCents, applicationFeeCents, items:[{item_type,description,amount_cents,template_id}],
//           allocations:[{recipient,amount_cents,allocation_type,note}], pricingContext }.
function priceOffering(offering, kind, isMember) {
  const pricingContext = isMember ? 'member' : 'public';
  if (kind === 'session') {
    const amt = isMember && offering.price_member_cents != null
      ? offering.price_member_cents : offering.price_public_cents;
    return {
      amountTotalCents: amt,
      applicationFeeCents: 0, // TBP takes nothing on the seller's own time
      pricingContext: pricingContext,
      items: [{ item_type: 'session', description: offering.title, amount_cents: amt, template_id: null }],
      allocations: [{ recipient: 'seller', amount_cents: amt, allocation_type: 'direct_net', note: 'session (before Stripe fee)' }]
    };
  }
  // bundle: session line is ALWAYS the public session price ($200) — the member
  // discount on a bundle lives entirely in the toolkit ($699 -> $399), per spec.
  const sessionCents = offering.price_public_cents;
  const toolkitCents = isMember && offering.bundle_price_member_cents != null
    ? (offering.bundle_price_member_cents - sessionCents)  // member toolkit portion
    : (offering.bundle_price_public_cents - sessionCents); // public toolkit portion
  const total = sessionCents + toolkitCents;
  const splitPct = offering.toolkit_seller_split_pct != null ? offering.toolkit_seller_split_pct : 50;
  const tbpToolkitCents = Math.round(toolkitCents * (100 - splitPct) / 100); // TBP's half = application fee
  const sellerToolkitCents = toolkitCents - tbpToolkitCents;
  return {
    amountTotalCents: total,
    applicationFeeCents: tbpToolkitCents, // application_fee on the direct charge -> TBP
    pricingContext: pricingContext,
    items: [
      { item_type: 'session', description: offering.title, amount_cents: sessionCents, template_id: null },
      { item_type: 'toolkit', description: 'Private Practice Toolkit', amount_cents: toolkitCents, template_id: offering.bundle_toolkit_template_id }
    ],
    allocations: [
      { recipient: 'seller', amount_cents: sessionCents, allocation_type: 'direct_net', note: 'session (before Stripe fee)' },
      { recipient: 'seller', amount_cents: sellerToolkitCents, allocation_type: 'direct_net', note: 'toolkit seller split' },
      { recipient: 'tbp', amount_cents: tbpToolkitCents, allocation_type: 'application_fee', note: 'toolkit TBP split (application fee)' }
    ]
  };
}

module.exports = {
  SUPABASE_URL, sb, sbHeaders,
  payMode, isLive, connectAcctColumn, platformStripe,
  resolveBuyer, hasUsedPromoMonth, priceOffering, ensureAccount
};
