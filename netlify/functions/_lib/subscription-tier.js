// netlify/functions/_lib/subscription-tier.js
//
// Single source of truth for turning Stripe products/subscriptions into platform
// access tiers. Shared by backfill-subscriptions.js (one-time seed) and
// stripe-webhook.js (live sync) so the mapping can never drift between them.
//
// A member's ACCESS tier is the HIGHEST active tier across all of their
// subscriptions (a member can hold more than one, e.g. a $50 forum kept as a
// fallback under a $119 full trial).

// Stripe product -> the access tier that product grants.
const PRODUCT_TIER = {
  prod_SnR5gmEzqzf4QY: 'forum', // Full Forum Access ($50/$525)
  prod_TVA3ySjsPUYqFu: 'forum', // 7-Day Trial -> $50 forum
  prod_TItCoEzHwGexN3: 'forum', // Toolkit Buyers trial -> $50 forum
  prod_UsGONpNmNr3Fq9: 'full',  // Full Membership ($119/mo, $1,190/yr) — LIVE product behind the full_monthly_119 / full_annual_1190 lookup keys
  prod_UG0R8KspOn5vFe: 'full',  // Full Access ($119/mo, $1,190/yr) — earlier/alt Full product, kept mapped
  prod_Tync5rANzosLJR: 'full',  // Member Upgrade to $89 (Full CE Access, grandfathered)
  prod_Typ4Rae4Jdk2fY: 'full'   // $89 with CEs (grandfathered)
};

// Members who transact under more than one Stripe identity. Circle privacy-relay
// emails mint a separate customer per checkout, so one human can appear as two
// customers with two subscriptions. Map the extra customer id to the canonical
// account's circle_member_id so BOTH subscriptions land on ONE account.
// Elijah Miller: $119 full bought under a second masked email, merged onto his
// original $50 forum account (Michael, 2026-07). Tell Elijah at the Circle cutover.
const CUSTOMER_ALIAS_CMID = {
  cus_UZntPvjoQPMmyI: '43513695'
};

const TIER_RANK = { free: 0, forum: 1, full: 2 };

// Subscription statuses that grant access. cancel_at_period_end keeps a sub
// 'active' until the period ends, so access rides to period end automatically.
// past_due is included so a single failed charge does not instantly revoke while
// Stripe retries; on final failure the sub becomes 'canceled'/'unpaid' and drops.
const ACCESS_STATUSES = new Set(['active', 'trialing', 'past_due']);

// Current standard rate. A member paying below this for their cadence is on a
// grandfathered deal we honor ($50 forum-forever, $89 closed cohort).
const CURRENT_MONTHLY_CENTS = 11900; // $119/mo
const CURRENT_ANNUAL_CENTS = 119000; // $1,190/yr

function tierForProduct(productId, fallback) {
  return PRODUCT_TIER[productId] || fallback || null;
}

function isGrandfathered(amountCents, interval) {
  if (amountCents == null) return false;
  const standard = interval === 'year' ? CURRENT_ANNUAL_CENTS : CURRENT_MONTHLY_CENTS;
  return amountCents < standard;
}

// Highest tier from a list of tier strings; 'free' if empty/unknown.
function highestTier(tiers) {
  let best = 'free';
  for (const t of tiers) {
    if ((TIER_RANK[t] || 0) > (TIER_RANK[best] || 0)) best = t;
  }
  return best;
}

module.exports = {
  PRODUCT_TIER,
  CUSTOMER_ALIAS_CMID,
  TIER_RANK,
  ACCESS_STATUSES,
  tierForProduct,
  isGrandfathered,
  highestTier
};
