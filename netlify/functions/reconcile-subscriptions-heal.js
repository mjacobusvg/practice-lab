// netlify/functions/reconcile-subscriptions-heal.js
//
// Daily SELF-HEALING billing reconcile. The webhook (stripe-webhook.js) is the
// live path that keeps our `subscriptions` table + accounts.tier in sync with
// Stripe. But a webhook event can be lost or arrive out of order (a fast Checkout
// fires subscription.created[incomplete] and subscription.updated[active] almost
// at once — the stale one could win and freeze a PAID member at free; that was the
// Tara case). This job is the safety net that trues the table back up every day so
// the data Michael uses to check paid members can be trusted even if an event drops.
//
// WHAT IT DOES — the one direction that is ALWAYS safe: Stripe is the source of
// truth, so for every subscription Stripe reports as access-granting
// (active/trialing/past_due) it (a) upserts our matching `subscriptions` row to
// Stripe's current state and (b) RAISES the account's tier if ours is lower than
// what that live payment grants (respecting tier_override — comps are never
// touched).
//
// WHAT IT DELIBERATELY DOES NOT DO — anything that removes access. It never
// downgrades, cancels, or clears a row. A "paid tier but nothing active in Stripe"
// can be a recoverable failed card (past_due) or a comp; yanking access there is a
// human call. Those keep flowing to the weekly read-only report
// (reconcile-subscriptions.js), which flags them for Michael. Heal only ever moves
// access UP to match money that is really being collected.
//
// Trigger: Netlify scheduler (body carries next_run), or a manual POST with header
// x-reconcile-secret: <RECONCILE_SECRET|BACKFILL_SECRET>. Manual calls may pass
// { "dry_run": true } to see what it WOULD heal without writing.
//
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
//      SES_* (via _lib/notify), RECONCILE_TO (fallback NOTIFY_TO)

const {
  CUSTOMER_ALIAS_CMID,
  TIER_RANK,
  ACCESS_STATUSES,
  tierForProduct,
  isGrandfathered
} = require('./_lib/subscription-tier');
const { emailEach } = require('./_lib/notify');

const toIso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);
const rank = (t) => (TIER_RANK[t] || 0);
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !STRIPE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  // Authorize: Netlify scheduler (body has next_run) or the manual secret header.
  let scheduled = false, dryRun = false;
  try { const b = JSON.parse(event.body || '{}'); if (b && b.next_run) scheduled = true; if (b && b.dry_run === true) dryRun = true; } catch (e) {}
  const secret = event.headers && (event.headers['x-reconcile-secret'] || event.headers['X-Reconcile-Secret']);
  const secretOk = secret && (secret === process.env.RECONCILE_SECRET || secret === process.env.BACKFILL_SECRET);
  if (!scheduled && !secretOk) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const stripe = require('stripe')(STRIPE_KEY);
  const sbGet = async (path) => {
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
    return r.ok ? r.json() : [];
  };
  const sbWrite = (path, init) => fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', ...(init && init.headers) }
  });

  try {
    // 1) Load accounts and index them the same way the webhook resolves identity.
    const accounts = await sbGet('accounts?select=id,email,name,tier,tier_override,circle_member_id,stripe_customer_id');
    const acctByEmail = new Map();
    const acctByCmid = new Map();
    const acctById = new Map();
    for (const a of accounts) {
      if (a.email) acctByEmail.set(String(a.email).toLowerCase().trim(), a);
      if (a.circle_member_id != null) acctByCmid.set(String(a.circle_member_id), a);
      acctById.set(a.id, a);
    }

    // 2) Load our current subscription rows, keyed by stripe_subscription_id.
    const ourRows = await sbGet('subscriptions?select=id,stripe_subscription_id,status,tier,account_id');
    const ourBySubId = new Map();
    for (const r of ourRows) if (r.stripe_subscription_id) ourBySubId.set(r.stripe_subscription_id, r);

    // 3) Page through every live Stripe subscription (expand customer for matching).
    const healedRows = [];      // rows we synced (missing/stale status)
    const raisedTiers = [];     // accounts we bumped UP to match a live payment
    let accessSubsSeen = 0;

    for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.customer'] })) {
      if (!ACCESS_STATUSES.has(s.status)) continue; // heal only follows money that grants access
      accessSubsSeen++;

      const item = s.items && s.items.data && s.items.data[0];
      const price = item && item.price;
      const productId = price && price.product;
      const amount = price ? price.unit_amount : null;
      const interval = price && price.recurring ? price.recurring.interval : null;
      const customer = (s.customer && typeof s.customer === 'object') ? s.customer : {};
      const customerId = customer.id || (typeof s.customer === 'string' ? s.customer : null);

      // Resolve the owning account: existing row wins, then alias, then email, then cmid.
      const ourRow = ourBySubId.get(s.id) || null;
      const email = (customer.email || '').toLowerCase().trim();
      const cmid = (customer.metadata && customer.metadata.community_member_id)
        || (s.metadata && s.metadata.community_member_id) || null;
      const aliasCmid = customerId ? CUSTOMER_ALIAS_CMID[customerId] : null;
      const account = (ourRow ? acctById.get(ourRow.account_id) : null)
        || (aliasCmid ? acctByCmid.get(aliasCmid) : null)
        || acctByEmail.get(email)
        || (cmid ? acctByCmid.get(String(cmid)) : null);
      if (!account) continue; // unmatched active subs are the human report's job, not heal's

      const liveTier = tierForProduct(productId, 'forum');

      // (a) Sync the row if it's MISSING or its status/tier drifted from Stripe.
      const needsRowSync = !ourRow || ourRow.status !== s.status || ourRow.tier !== liveTier;
      if (needsRowSync) {
        const row = {
          account_id: account.id,
          product: productId,
          tier: liveTier,
          status: s.status,
          is_grandfathered: isGrandfathered(amount, interval),
          stripe_subscription_id: s.id,
          stripe_customer_id: customerId || null,
          current_period_start: toIso((item && item.current_period_start) || s.current_period_start),
          current_period_end: toIso((item && item.current_period_end) || s.current_period_end),
          canceled_at: toIso(s.canceled_at),
          updated_at: new Date().toISOString()
        };
        if (!dryRun) {
          // Upsert on the unique stripe_subscription_id (idempotent; no dup rows).
          await sbWrite('subscriptions?on_conflict=stripe_subscription_id', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(row)
          });
        }
        healedRows.push({ email: account.email || email, sub: s.id, was: ourRow ? ourRow.status : 'MISSING', now: s.status, tier: liveTier });
      }

      // (b) RAISE the account tier if this live payment grants more than we show.
      //     Never lower; never touch a comp (tier_override).
      if (!account.tier_override && rank(liveTier) > rank(account.tier)) {
        const prevTier = account.tier;
        if (!dryRun) {
          await sbWrite('accounts?id=eq.' + account.id, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ tier: liveTier, updated_at: new Date().toISOString() })
          });
        }
        account.tier = liveTier; // reflect locally so a second sub for the same acct compares correctly
        raisedTiers.push({ email: account.email || email, from: prevTier, to: liveTier });
      }
    }

    const healedCount = healedRows.length + raisedTiers.length;
    const report = {
      generated_at: new Date().toISOString(),
      dry_run: dryRun,
      access_subscriptions_scanned: accessSubsSeen,
      accounts_scanned: accounts.length,
      healed_count: healedCount,
      rows_synced: healedRows,
      tiers_raised: raisedTiers
    };

    // 4) Only email when it actually healed something — silence on a clean day so
    //    this never becomes noise Michael tunes out.
    if (healedCount > 0 && !dryRun) {
      const to = process.env.RECONCILE_TO || process.env.NOTIFY_TO || 'michael@thinkbeyondpsych.com';
      const subject = 'TBP billing self-heal — corrected ' + healedCount + ' item' + (healedCount === 1 ? '' : 's');
      await emailEach([to], subject, function () { return buildEmail(report); });
    }

    return { statusCode: 200, headers, body: JSON.stringify(report, null, 2) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

function rowTable(title, note, cols, rows) {
  if (!rows.length) return '';
  const th = cols.map((c) => '<th align="left" style="padding:6px 10px;border-bottom:2px solid #ddd;font-size:13px">' + esc(c.label) + '</th>').join('');
  const trs = rows.map(function (r) {
    return '<tr>' + cols.map((c) => '<td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px">' + esc(r[c.key]) + '</td>').join('') + '</tr>';
  }).join('');
  return '<h3 style="margin:22px 0 4px">' + esc(title) + ' <span style="color:#888;font-weight:normal">(' + rows.length + ')</span></h3>' +
    '<p style="margin:0 0 8px;color:#666;font-size:13px">' + esc(note) + '</p>' +
    '<table style="border-collapse:collapse;width:100%"><thead><tr>' + th + '</tr></thead><tbody>' + trs + '</tbody></table>';
}

function buildEmail(report) {
  const head = '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:720px;color:#222">' +
    '<p style="margin:0 0 4px">Daily self-heal against live Stripe corrected the members table.</p>' +
    '<p style="margin:0 0 12px;color:#666;font-size:13px">Scanned ' + report.access_subscriptions_scanned +
    ' access-granting Stripe subscriptions. This job only ever RAISES access to match a real payment — it never downgrades or cancels. Anything needing a human decision is in the separate weekly reconcile.</p>';
  const t1 = rowTable(
    'Subscription rows re-synced to Stripe',
    'Our row was missing or its status/tier had drifted from Stripe (usually a dropped/out-of-order webhook event). Set to Stripe’s current state.',
    [{ key: 'email', label: 'Member' }, { key: 'was', label: 'Our status was' }, { key: 'now', label: 'Now (Stripe)' }, { key: 'tier', label: 'Tier' }, { key: 'sub', label: 'Sub ID' }],
    report.rows_synced);
  const t2 = rowTable(
    'Account tiers raised to match a live payment',
    'Account showed a lower tier than a live paid subscription grants. Bumped up to what they’re paying for.',
    [{ key: 'email', label: 'Member' }, { key: 'from', label: 'Was' }, { key: 'to', label: 'Raised to' }],
    report.tiers_raised);
  return head + t1 + t2 + '</div>';
}
