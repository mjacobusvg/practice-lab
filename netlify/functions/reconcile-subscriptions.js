// netlify/functions/reconcile-subscriptions.js
//
// Weekly billing watchdog. Reads the LIVE Stripe subscriptions in this account,
// matches each to an account (same logic as backfill/stripe-webhook), and emails
// Michael a short report of anything that needs a human decision:
//
//   1) PAYMENT FAILING  - a member whose card is failing right now (past_due /
//      unpaid / incomplete). Reach out before Stripe gives up and cancels. This
//      is exactly the case Circle silently dropped: D'Arthana's $89 charge failed
//      and nobody told him to update his card.
//   2) PAID TIER, NO ACTIVE PAYMENT - an account still on forum/full (no comp
//      override) with no access-granting subscription in Stripe. Either a
//      free-rider left over from Circle, or a failed card that already lapsed.
//      The report shows their latest sub's status/date so you can tell which.
//   3) UNDER-PROVISIONED - paying for a higher tier than their account grants.
//   4) UNMATCHED STRIPE SUB - an active/past_due Stripe subscription with no
//      matching account row.
//
// SAFE BY DESIGN: this function NEVER changes a tier, a subscription, or a charge.
// It only reads and emails. A "canceled" subscription can be a recoverable failed
// card (see D'Arthana), so every fix stays a human decision.
//
// Accounts with tier_override (lifetime/comped members) are intentional and are
// excluded from buckets 2 and 3.
//
// Trigger: the Netlify scheduler (body carries next_run), or a manual POST with
// header x-reconcile-secret: <RECONCILE_SECRET|BACKFILL_SECRET>. A manual call may
// pass { "email": false } to get the JSON report back without sending mail.
//
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
//      SES_* (via _lib/notify), RECONCILE_TO (fallback NOTIFY_TO), RECONCILE_SECRET

const {
  CUSTOMER_ALIAS_CMID,
  TIER_RANK,
  ACCESS_STATUSES,
  tierForProduct
} = require('./_lib/subscription-tier');
const { emailEach } = require('./_lib/notify');

// Stripe statuses that mean "the card is failing" — access may still be granted
// (past_due rides while Stripe retries) but a human should nudge the member.
const FAILING_STATUSES = new Set(['past_due', 'unpaid', 'incomplete']);

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function money(cents, interval) {
  if (cents == null) return '—';
  const d = '$' + (cents / 100).toFixed(cents % 100 ? 2 : 0);
  return interval ? d + '/' + interval : d;
}
function day(iso) { return iso ? String(iso).slice(0, 10) : '—'; }

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !STRIPE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  // Authorize: Netlify scheduler (body has next_run) or the manual secret header.
  let scheduled = false, wantEmail = true;
  try { const b = JSON.parse(event.body || '{}'); if (b && b.next_run) scheduled = true; if (b && b.email === false) wantEmail = false; } catch (e) {}
  const secret = event.headers && (event.headers['x-reconcile-secret'] || event.headers['X-Reconcile-Secret']);
  const secretOk = secret && (secret === process.env.RECONCILE_SECRET || secret === process.env.BACKFILL_SECRET);
  if (!scheduled && !secretOk) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const stripe = require('stripe')(STRIPE_KEY);
  const sb = (path) => fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
  });

  try {
    // 1) Load accounts (email + circle_member_id + tier + override + stripe id).
    const acctRes = await sb('accounts?select=id,email,name,tier,tier_override,circle_member_id,stripe_customer_id');
    if (!acctRes.ok) throw new Error('accounts fetch failed: ' + acctRes.status);
    const accounts = await acctRes.json();
    const acctByEmail = new Map();
    const acctByCmid = new Map();
    for (const a of accounts) {
      if (a.email) acctByEmail.set(String(a.email).toLowerCase().trim(), a);
      if (a.circle_member_id != null) acctByCmid.set(String(a.circle_member_id), a);
    }

    // 2) Page through ALL Stripe subscriptions (any status), expand customer.
    const subs = [];
    for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.customer'] })) {
      subs.push(s);
    }

    // 3) Fold subscriptions onto accounts.
    // perAccount: account.id -> { account, subs:[...] }
    const perAccount = new Map();
    const unmatched = [];
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
      const aliasCmid = customer.id ? CUSTOMER_ALIAS_CMID[customer.id] : null;
      const account = (aliasCmid ? acctByCmid.get(aliasCmid) : null)
        || acctByEmail.get(email)
        || (cmid ? acctByCmid.get(String(cmid)) : null);

      const rec = {
        status: s.status,
        tier: tierForProduct(productId, null) || 'forum',
        amount_cents: amount,
        interval,
        period_end: (item && item.current_period_end) || s.current_period_end || null,
        canceled_at: s.canceled_at || null,
        created: s.created || 0,
        stripe_subscription_id: s.id
      };

      if (!account) {
        // Only surface unmatched subs that would grant access (active/past_due);
        // a long-dead canceled orphan is noise.
        if (ACCESS_STATUSES.has(s.status)) {
          unmatched.push({ email: email || '(no email)', cmid, status: s.status, amount: money(amount, interval), stripe_subscription_id: s.id });
        }
        continue;
      }
      if (!perAccount.has(account.id)) perAccount.set(account.id, { account, subs: [] });
      perAccount.get(account.id).subs.push(rec);
    }

    // 4) Classify.
    const rank = (t) => (TIER_RANK[t] || 0);
    const paymentFailing = [];      // bucket 1
    const paidNoActive = [];        // bucket 2
    const underProvisioned = [];    // bucket 3

    for (const a of accounts) {
      const bundle = perAccount.get(a.id);
      const subList = bundle ? bundle.subs : [];
      const accessSubs = subList.filter((r) => ACCESS_STATUSES.has(r.status));
      const entitled = accessSubs.reduce((best, r) => (rank(r.tier) > rank(best) ? r.tier : best), 'free');

      // Bucket 1: any failing card, regardless of override (a comped account has no
      // sub, so this only ever fires for real payers).
      const failing = subList.filter((r) => FAILING_STATUSES.has(r.status));
      for (const f of failing) {
        paymentFailing.push({
          name: a.name || '', email: a.email || '', tier: a.tier,
          sub_status: f.status, amount: money(f.amount_cents, f.interval),
          renews: day(f.period_end && new Date(f.period_end * 1000).toISOString())
        });
      }

      if (a.tier_override) continue; // intentional comp: skip provisioning checks

      // Bucket 2: paid tier in our DB, but Stripe shows nothing active.
      if ((a.tier === 'forum' || a.tier === 'full') && entitled === 'free') {
        // Show the latest sub so Michael can tell failed-card from a real quit.
        const latest = subList.slice().sort((x, y) => y.created - x.created)[0] || null;
        paidNoActive.push({
          name: a.name || '', email: a.email || '', account_tier: a.tier,
          linked: !!a.stripe_customer_id,
          last_sub: latest ? (latest.status + ' ' + money(latest.amount_cents, latest.interval)) : 'none on record',
          last_canceled: latest && latest.canceled_at ? day(new Date(latest.canceled_at * 1000).toISOString()) : '—'
        });
      }

      // Bucket 3: paying for a higher tier than the account grants.
      if (rank(entitled) > rank(a.tier)) {
        underProvisioned.push({ name: a.name || '', email: a.email || '', account_tier: a.tier, entitled });
      }
    }

    const issueCount = paymentFailing.length + paidNoActive.length + underProvisioned.length + unmatched.length;
    const report = {
      generated_at: new Date().toISOString(),
      stripe_subscriptions_scanned: subs.length,
      accounts_scanned: accounts.length,
      issue_count: issueCount,
      payment_failing: paymentFailing,
      paid_tier_no_active_payment: paidNoActive,
      under_provisioned: underProvisioned,
      unmatched_active_stripe_subs: unmatched
    };

    // 5) Email Michael (unless a manual debug call asked for JSON only).
    if (wantEmail) {
      const to = process.env.RECONCILE_TO || process.env.NOTIFY_TO || 'michael@thinkbeyondpsych.com';
      const subject = issueCount === 0
        ? '✓ TBP billing reconcile — all clear'
        : 'TBP billing reconcile — ' + issueCount + ' item' + (issueCount === 1 ? '' : 's') + ' to review';
      await emailEach([to], subject, function () { return buildEmail(report); });
    }

    return { statusCode: 200, headers, body: JSON.stringify(report, null, 2) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

function table(title, note, cols, rows) {
  if (!rows.length) return '';
  const th = cols.map((c) => '<th align="left" style="padding:6px 10px;border-bottom:2px solid #ddd;font-size:13px">' + esc(c.label) + '</th>').join('');
  const trs = rows.map(function (r) {
    const tds = cols.map((c) => '<td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px">' + esc(r[c.key]) + '</td>').join('');
    return '<tr>' + tds + '</tr>';
  }).join('');
  return '<h3 style="margin:22px 0 4px">' + esc(title) + ' <span style="color:#888;font-weight:normal">(' + rows.length + ')</span></h3>' +
    '<p style="margin:0 0 8px;color:#666;font-size:13px">' + esc(note) + '</p>' +
    '<table style="border-collapse:collapse;width:100%"><thead><tr>' + th + '</tr></thead><tbody>' + trs + '</tbody></table>';
}

function buildEmail(report) {
  const head = '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:720px;color:#222">' +
    '<p style="margin:0 0 4px">Weekly billing reconcile against live Stripe.</p>' +
    '<p style="margin:0 0 12px;color:#666;font-size:13px">Scanned ' + report.stripe_subscriptions_scanned +
    ' Stripe subscriptions and ' + report.accounts_scanned + ' accounts. This report only flags — it never changes anyone’s access.</p>';

  if (report.issue_count === 0) {
    return head + '<p style="font-size:15px">✓ Everything reconciles. No failing cards, no paid tiers without payment, nothing under-provisioned.</p></div>';
  }

  const b1 = table(
    'Payment failing — reach out',
    'Card is failing now. Email them to update it before Stripe gives up (this is the D’Arthana case).',
    [{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'sub_status', label: 'Stripe status' }, { key: 'amount', label: 'Amount' }, { key: 'renews', label: 'Period ends' }],
    report.payment_failing);

  const b2 = table(
    'Paid tier, no active payment',
    'Has forum/full access but nothing is paying in Stripe. Check "last sub": a failed/past_due card may be recoverable; a real cancel means downgrade.',
    [{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'account_tier', label: 'Our tier' }, { key: 'linked', label: 'Stripe-linked' }, { key: 'last_sub', label: 'Last sub' }, { key: 'last_canceled', label: 'Canceled' }],
    report.paid_tier_no_active_payment);

  const b3 = table(
    'Under-provisioned',
    'Paying for more than their account grants. Bump them up.',
    [{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'account_tier', label: 'Our tier' }, { key: 'entitled', label: 'Paid for' }],
    report.under_provisioned);

  const b4 = table(
    'Unmatched Stripe subscriptions',
    'Active/past_due subscription in Stripe with no matching account. Usually a masked email — link it.',
    [{ key: 'email', label: 'Customer email' }, { key: 'status', label: 'Status' }, { key: 'amount', label: 'Amount' }, { key: 'stripe_subscription_id', label: 'Sub ID' }],
    report.unmatched_active_stripe_subs);

  return head + b1 + b2 + b3 + b4 + '</div>';
}
