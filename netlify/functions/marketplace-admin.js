// netlify/functions/marketplace-admin.js
//
// Admin funnel summary for the marketplace pilot. Secret-gated (same BACKFILL_SECRET
// pattern as admin-dashboard.js). Returns sellers, order/revenue rollups, bookings,
// promo-trial grants + how many converted to paid, and per-seller attribution
// (visits -> purchases -> members) — the "is the flywheel working" view.
//
// Body: { secret }
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, BACKFILL_SECRET

const { sb } = require('./_lib/marketplace');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};
const j = (s, o) => ({ statusCode: s, headers: CORS, body: JSON.stringify(o) });

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return j(200, {});
  if (event.httpMethod !== 'POST') return j(405, { error: 'POST only' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return j(400, { error: 'Bad JSON' }); }
  if (!process.env.BACKFILL_SECRET || b.secret !== process.env.BACKFILL_SECRET) return j(401, { error: 'Unauthorized' });

  try {
    const sellers = await sb('marketplace_sellers?select=id,slug,display_name,status&order=created_at.asc');
    const orders = await sb('marketplace_orders?select=id,seller_id,kind,pricing_context,amount_total_cents,application_fee_cents,status,test_mode,created_at&order=created_at.desc&limit=500');
    const bookings = await sb('marketplace_bookings?select=id,seller_id,status,toolkit_included,starts_at&order=starts_at.desc&limit=500');
    const grants = await sb('marketplace_trial_grants?select=id,source_seller_id,stripe_subscription_id,status,granted_at&order=granted_at.desc&limit=500');
    const attribution = await sb('marketplace_attribution?select=seller_id,visitor_id,order_id,buyer_email,utm_source&limit=1000');

    // Conversion: which trial subscriptions are now active (paid), not trialing?
    const subIds = grants.map(function (g) { return g.stripe_subscription_id; }).filter(Boolean);
    let paidSubs = new Set();
    if (subIds.length) {
      const inList = subIds.map(function (id) { return '"' + id + '"'; }).join(',');
      const subs = await sb('subscriptions?stripe_subscription_id=in.(' + inList + ')&select=stripe_subscription_id,status');
      (subs || []).forEach(function (s) { if (s.status === 'active') paidSubs.add(s.stripe_subscription_id); });
    }

    const paidOrders = orders.filter(function (o) { return o.status === 'paid'; });
    const gross = paidOrders.reduce(function (a, o) { return a + (o.amount_total_cents || 0); }, 0);
    const tbpFees = paidOrders.reduce(function (a, o) { return a + (o.application_fee_cents || 0); }, 0);
    const convertedTrials = grants.filter(function (g) { return paidSubs.has(g.stripe_subscription_id); }).length;

    // Per-seller rollup
    const bySeller = {};
    sellers.forEach(function (s) {
      bySeller[s.id] = { seller: s.display_name, slug: s.slug, visits: 0, purchases: 0, gross_cents: 0, tbp_fee_cents: 0, trials: 0, converted: 0 };
    });
    attribution.forEach(function (a) { if (bySeller[a.seller_id]) { bySeller[a.seller_id].visits++; if (a.order_id) bySeller[a.seller_id].purchases++; } });
    paidOrders.forEach(function (o) { if (bySeller[o.seller_id]) { bySeller[o.seller_id].gross_cents += (o.amount_total_cents || 0); bySeller[o.seller_id].tbp_fee_cents += (o.application_fee_cents || 0); } });
    grants.forEach(function (g) { if (bySeller[g.source_seller_id]) { bySeller[g.source_seller_id].trials++; if (paidSubs.has(g.stripe_subscription_id)) bySeller[g.source_seller_id].converted++; } });

    return j(200, {
      totals: {
        sellers: sellers.length,
        paid_orders: paidOrders.length,
        gross_cents: gross,
        tbp_fee_income_cents: tbpFees,
        promo_trials: grants.length,
        trials_converted_to_paid: convertedTrials,
        confirmed_bookings: bookings.filter(function (bk) { return bk.status === 'confirmed'; }).length
      },
      by_seller: Object.keys(bySeller).map(function (k) { return bySeller[k]; }),
      recent_orders: paidOrders.slice(0, 25),
      recent_bookings: bookings.slice(0, 25)
    });
  } catch (e) {
    return j(500, { error: e.message });
  }
};
