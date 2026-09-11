// netlify/functions/membership-billing-notices.js
//
// Transactional membership billing notices, run on a schedule for ALL members
// nationwide. Two jobs live here so the legal/operational rule has one source of truth:
//   1) Post-purchase acknowledgment for newly-created membership subscriptions.
//      The email is retainable and restates price/frequency, auto-renewal, cancellation,
//      the next charge/renewal date, the 15-day new-subscription guarantee, and links.
//   2) Renewal/anniversary reminder 25-40 days before the applicable renewal.
//      Annual plans are reminded before each annual renewal. Shorter plans are reminded
//      before the first renewal that crosses each continuous 12-month anniversary.
//
// Notices are transactional billing/legal communications. They are intentionally not
// tied to marketing-email preferences or unsubscribe state.
//
// Idempotence is stored on the Stripe subscription metadata itself so webhook retries,
// deploys, and repeated scheduled runs cannot re-send the same notice.
//
// IMPORTANT: ACK_CUTOFF_UNIX is the deployment cutover. It prevents this feature from
// retroactively emailing the existing member book an initial "post-purchase" notice.
// Subscriptions created after the cutover get the acknowledgment automatically.
//
// Env: STRIPE_SECRET_KEY, SES_AWS_ACCESS_KEY_ID / SES_ACCESS_KEY_ID,
//      SES_AWS_SECRET_ACCESS_KEY / SES_SECRET_ACCESS_KEY,
//      SES_AWS_REGION / SES_REGION

const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const { ACCESS_STATUSES, tierForProduct } = require('./_lib/subscription-tier');

const SITE = 'https://thinkbeyondpractice.com';
const CANCEL_URL = SITE + '/cancel-subscription.html';
const TERMS_URL = SITE + '/terms-of-service.html';
const FROM = process.env.SES_FROM || 'Think Beyond Practice <michael@thinkbeyondpractice.com>';
const REPLY_TO = 'billing@thinkbeyondpractice.com';
const ACK_CUTOFF_UNIX = 1789166400; // 2026-09-11 22:40:00 UTC
const DAY_MS = 24 * 60 * 60 * 1000;

function money(cents, currency) {
  if (typeof cents !== 'number') return 'the price shown for your plan';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: String(currency || 'usd').toUpperCase()
    }).format(cents / 100);
  } catch (e) {
    return '$' + (cents / 100).toFixed(2);
  }
}

function intervalLabel(interval, count) {
  count = count || 1;
  if (interval === 'year') return count === 1 ? 'year' : count + ' years';
  if (interval === 'month') return count === 1 ? 'month' : count + ' months';
  if (interval === 'week') return count === 1 ? 'week' : count + ' weeks';
  if (interval === 'day') return count === 1 ? 'day' : count + ' days';
  return 'billing period';
}

function dateLabel(unix) {
  if (!unix) return 'your next billing date';
  return new Date(unix * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
}

function planLabel(tier) {
  if (tier === 'full') return 'Full membership';
  if (tier === 'forum') return 'Forum membership';
  return 'Think Beyond Practice membership';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function button(href, label) {
  return '<p style="margin:22px 0"><a href="' + esc(href) + '" style="display:inline-block;background:#0d3b4f;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px">' + esc(label) + '</a></p>';
}

function shell(inner) {
  return '<div style="max-width:600px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222">' + inner + '</div>';
}

function subscriptionFacts(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const price = item && item.price;
  const recurring = price && price.recurring;
  const product = price && price.product;
  const productId = typeof product === 'string' ? product : product && product.id;
  const tier = tierForProduct(productId, null);
  const periodEnd = (item && item.current_period_end) || sub.current_period_end || null;
  const periodStart = (item && item.current_period_start) || sub.current_period_start || null;
  const interval = recurring && recurring.interval;
  const intervalCount = (recurring && recurring.interval_count) || 1;
  return {
    item, price, tier, periodEnd, periodStart, interval, intervalCount,
    amount: price && price.unit_amount,
    currency: price && price.currency,
    cadence: intervalLabel(interval, intervalCount)
  };
}

function buildAcknowledgment(sub, facts) {
  const label = planLabel(facts.tier);
  const price = money(facts.amount, facts.currency);
  const nextUnix = (sub.status === 'trialing' && sub.trial_end) ? sub.trial_end : facts.periodEnd;
  const nextDate = dateLabel(nextUnix);
  const isTrial = sub.status === 'trialing' || (sub.metadata && (sub.metadata.tbp_source === 'toolkit_trial' || sub.metadata.tbp_purchase === 'marketplace_trial'));

  let text = 'Thank you for subscribing to Think Beyond Practice.\n\n' +
    'Plan: ' + label + '\n' +
    'Current recurring price: ' + price + ' every ' + facts.cadence + ' (before any applicable taxes or discounts).\n' +
    (isTrial ? 'Trial/promotional period: your recurring paid billing begins or resumes when the trial/offer ends unless you cancel first.\n' : '') +
    'Next renewal/charge date: ' + nextDate + '.\n\n' +
    'AUTOMATIC RENEWAL\nYour membership automatically renews at the end of each billing period at the then-current price for your plan unless you cancel before renewal. By subscribing, you authorize recurring charges to your saved payment method.\n\n' +
    'CANCELLATION\nYou may cancel online at any time. Cancellation takes effect at the end of the current paid billing period unless Stripe shows otherwise.\n' +
    'Cancel online: ' + CANCEL_URL + '\n\n' +
    'NEW-SUBSCRIPTION GUARANTEE\nNew paid subscriptions include a 15-day money-back guarantee. Promotional or trial offers may have separate stated terms.\n\n' +
    'Terms of Service: ' + TERMS_URL + '\n\n' +
    'Please keep this email for your records.\n\nThink Beyond Practice';

  const html = shell(
    '<h2 style="color:#0d3b4f;margin-bottom:8px">Your Think Beyond Practice subscription</h2>' +
    '<p>Thank you for subscribing. This email confirms the recurring billing terms for your records.</p>' +
    '<div style="background:#f6f7f8;border:1px solid #e2e5e8;border-radius:8px;padding:16px;margin:18px 0">' +
      '<p style="margin:0 0 6px"><strong>Plan:</strong> ' + esc(label) + '</p>' +
      '<p style="margin:0 0 6px"><strong>Current recurring price:</strong> ' + esc(price) + ' every ' + esc(facts.cadence) + ' <span style="color:#666">(before any applicable taxes or discounts)</span></p>' +
      (isTrial ? '<p style="margin:0 0 6px"><strong>Trial/promotional period:</strong> recurring paid billing begins or resumes when the trial/offer ends unless you cancel first.</p>' : '') +
      '<p style="margin:0"><strong>Next renewal/charge date:</strong> ' + esc(nextDate) + '</p>' +
    '</div>' +
    '<p><strong>Automatic renewal.</strong> Your membership automatically renews at the end of each billing period at the then-current price for your plan unless you cancel before renewal. By subscribing, you authorize recurring charges to your saved payment method.</p>' +
    '<p><strong>Cancellation.</strong> You may cancel online at any time. Cancellation takes effect at the end of the current paid billing period unless Stripe shows otherwise.</p>' +
    button(CANCEL_URL, 'Cancel subscription online') +
    '<p><strong>15-day new-subscription guarantee.</strong> New paid subscriptions include a 15-day money-back guarantee. Promotional or trial offers may have separate stated terms.</p>' +
    '<p><a href="' + TERMS_URL + '">View the Terms of Service</a></p>' +
    '<p style="color:#666;font-size:13px">Please keep this email for your records. This is a transactional billing notice, not a marketing email.</p>'
  );

  return { subject: 'Your Think Beyond Practice subscription confirmation', text, html };
}

function anniversaryInYear(startDate, year) {
  const month = startDate.getUTCMonth();
  const day = startDate.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay), startDate.getUTCHours(), startDate.getUTCMinutes(), startDate.getUTCSeconds()));
}

// Return the annual-cycle reminder that applies to the CURRENT billing period.
// For annual plans, every period end is an annual renewal. For monthly/shorter plans,
// only the period whose end crosses a continuous 12-month anniversary qualifies.
function renewalTarget(sub, facts) {
  if (!facts.periodEnd) return null;
  const startUnix = sub.start_date || sub.created;
  if (!startUnix) return null;

  if (facts.interval === 'year') {
    return {
      targetUnix: facts.periodEnd,
      key: 'annual-' + new Date(facts.periodEnd * 1000).toISOString().slice(0, 10)
    };
  }

  if (!facts.periodStart) return null;
  const start = new Date(startUnix * 1000);
  const pStart = new Date(facts.periodStart * 1000);
  const pEnd = new Date(facts.periodEnd * 1000);
  const firstYear = start.getUTCFullYear() + 1;
  const lastYear = pEnd.getUTCFullYear();

  for (let year = firstYear; year <= lastYear; year++) {
    const anniv = anniversaryInYear(start, year);
    if (anniv > pStart && anniv <= pEnd) {
      const cycle = year - start.getUTCFullYear();
      return { targetUnix: facts.periodEnd, key: 'anniversary-' + cycle };
    }
  }
  return null;
}

function buildRenewalReminder(sub, facts, target, daysUntil) {
  const label = planLabel(facts.tier);
  const price = money(facts.amount, facts.currency);
  const renewalDate = dateLabel(target.targetUnix);
  const text = 'This is a reminder that your Think Beyond Practice membership is scheduled to renew.\n\n' +
    'Plan: ' + label + '\n' +
    'Current recurring price: ' + price + ' every ' + facts.cadence + ' (before any applicable taxes or discounts).\n' +
    'Scheduled renewal date: ' + renewalDate + '\n\n' +
    'Unless you cancel before renewal, your membership will renew automatically and your saved payment method will be charged at the then-current price for your plan.\n\n' +
    'You may cancel online at any time. Cancellation takes effect at the end of the current paid billing period unless Stripe shows otherwise.\n' +
    'Cancel online: ' + CANCEL_URL + '\n\n' +
    'Terms of Service: ' + TERMS_URL + '\n\n' +
    'This reminder is being sent ' + daysUntil + ' days before the applicable renewal. Please keep it for your records.\n\nThink Beyond Practice';

  const html = shell(
    '<h2 style="color:#0d3b4f;margin-bottom:8px">Upcoming membership renewal</h2>' +
    '<p>Your Think Beyond Practice membership is scheduled to renew on <strong>' + esc(renewalDate) + '</strong>.</p>' +
    '<div style="background:#f6f7f8;border:1px solid #e2e5e8;border-radius:8px;padding:16px;margin:18px 0">' +
      '<p style="margin:0 0 6px"><strong>Plan:</strong> ' + esc(label) + '</p>' +
      '<p style="margin:0 0 6px"><strong>Current recurring price:</strong> ' + esc(price) + ' every ' + esc(facts.cadence) + ' <span style="color:#666">(before any applicable taxes or discounts)</span></p>' +
      '<p style="margin:0"><strong>Scheduled renewal date:</strong> ' + esc(renewalDate) + '</p>' +
    '</div>' +
    '<p>Unless you cancel before renewal, your membership will renew automatically and your saved payment method will be charged at the then-current price for your plan.</p>' +
    '<p>You may cancel online at any time. Cancellation takes effect at the end of the current paid billing period unless Stripe shows otherwise.</p>' +
    button(CANCEL_URL, 'Cancel subscription online') +
    '<p><a href="' + TERMS_URL + '">View the Terms of Service</a></p>' +
    '<p style="color:#666;font-size:13px">This reminder is being sent ' + esc(daysUntil) + ' days before the applicable renewal. This is a transactional billing notice, not a marketing email.</p>'
  );

  return { subject: 'Your Think Beyond Practice membership renews ' + renewalDate, text, html };
}

function makeSes() {
  const accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  const region = process.env.SES_AWS_REGION || process.env.SES_REGION || 'us-east-1';
  return new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

async function send(ses, to, msg) {
  await ses.send(new SendEmailCommand({
    FromEmailAddress: FROM,
    Destination: { ToAddresses: [to] },
    ReplyToAddresses: [REPLY_TO],
    Content: {
      Simple: {
        Subject: { Data: msg.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: msg.text, Charset: 'UTF-8' },
          Html: { Data: msg.html, Charset: 'UTF-8' }
        }
      }
    }
  }));
}

async function customerEmail(stripe, sub) {
  const fromMeta = sub.metadata && String(sub.metadata.tbp_account_email || '').toLowerCase().trim();
  if (fromMeta && fromMeta.includes('@')) return fromMeta;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
  if (!customerId) return '';
  try {
    const c = await stripe.customers.retrieve(customerId);
    const email = c && !c.deleted ? String(c.email || '').toLowerCase().trim() : '';
    return email.includes('@') ? email : '';
  } catch (e) {
    return '';
  }
}

async function allSubscriptions(stripe) {
  const out = [];
  let startingAfter = null;
  do {
    const params = { status: 'all', limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe.subscriptions.list(params);
    out.push.apply(out, page.data || []);
    if (!page.has_more || !page.data || !page.data.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  } while (startingAfter);
  return out;
}

exports.handler = async function () {
  if (!process.env.STRIPE_SECRET_KEY) return { statusCode: 500, body: 'Missing STRIPE_SECRET_KEY' };
  const ses = makeSes();
  if (!ses) return { statusCode: 500, body: 'Missing SES credentials' };

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const nowMs = Date.now();
  let ackSent = 0, remindersSent = 0, skipped = 0, failed = 0;

  let subs;
  try { subs = await allSubscriptions(stripe); }
  catch (e) {
    console.error('membership billing notices: Stripe list failed:', e.message);
    return { statusCode: 500, body: 'Stripe list failed' };
  }

  for (const sub of subs) {
    try {
      const facts = subscriptionFacts(sub);
      if (!facts.tier) { skipped++; continue; } // not a TBP membership product
      if (!ACCESS_STATUSES.has(sub.status)) { skipped++; continue; }
      if (sub.cancel_at_period_end) { skipped++; continue; }

      const email = await customerEmail(stripe, sub);
      if (!email) { skipped++; continue; }

      // Post-purchase acknowledgment for new subscriptions only. The fixed cutover
      // prevents retroactive confirmation emails to members who subscribed before
      // this feature existed.
      if ((sub.created || 0) >= ACK_CUTOFF_UNIX && !(sub.metadata && sub.metadata.tbp_billing_ack_sent_at)) {
        const msg = buildAcknowledgment(sub, facts);
        await send(ses, email, msg);
        await stripe.subscriptions.update(sub.id, {
          metadata: { tbp_billing_ack_sent_at: new Date().toISOString() }
        });
        ackSent++;
        // Update our local copy so later logic in this same run sees the marker.
        sub.metadata = Object.assign({}, sub.metadata || {}, { tbp_billing_ack_sent_at: new Date().toISOString() });
      }

      // National renewal baseline: 25-40 days before each annual renewal, or before
      // the renewal that crosses each continuous 12-month anniversary on a shorter plan.
      const target = renewalTarget(sub, facts);
      if (!target) continue;
      const daysUntil = Math.ceil((target.targetUnix * 1000 - nowMs) / DAY_MS);
      if (daysUntil < 25 || daysUntil > 40) continue;
      const already = sub.metadata && sub.metadata.tbp_renewal_notice_key;
      if (already === target.key) continue;

      const msg = buildRenewalReminder(sub, facts, target, daysUntil);
      await send(ses, email, msg);
      await stripe.subscriptions.update(sub.id, {
        metadata: {
          tbp_renewal_notice_key: target.key,
          tbp_renewal_notice_sent_at: new Date().toISOString()
        }
      });
      remindersSent++;
    } catch (e) {
      failed++;
      console.error('membership billing notice failed for', sub && sub.id, e && e.message);
    }
  }

  console.log('membership billing notices:', { subscriptions: subs.length, ackSent, remindersSent, skipped, failed });
  return {
    statusCode: 200,
    body: JSON.stringify({ subscriptions: subs.length, acknowledgments_sent: ackSent, renewal_reminders_sent: remindersSent, failed })
  };
};

module.exports._test = { subscriptionFacts, renewalTarget, buildAcknowledgment, buildRenewalReminder };
