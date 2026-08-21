// netlify/functions/onboarding-drip.js
//
// Welcome drip for NEW free members.
//
//   • Step 0 (the welcome) is sent IMMEDIATELY at signup — platform-auth.js calls
//     sendWelcomeNow(account) the moment it creates a brand-new free account row,
//     so a new member hears from us within seconds, at peak curiosity, instead of
//     waiting for the next daily cron.
//   • Steps 1-3 (days 2/4/7) are sent by the scheduled cron below: for each
//     enrolled account it sends at most ONE email per run — the lowest un-sent step
//     that has come due — so a member is caught up one email at a time (never a
//     burst). The cron also backstops step 0 for anyone the instant-send missed.
//
// Enrolled = tier 'free', created on/after DRIP_START (excludes the pre-created
// contact batches), genuinely new (circle_member_id IS NULL), and not
// unsubscribed (contacts.subscribed = false). If a member upgrades to paid, the
// tier filter drops them and the drip stops.
//
// Reply-To is Michael's address so "just reply" actually reaches him.
//
// Trigger: netlify.toml scheduled function, or manual POST { secret: BACKFILL_SECRET }.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SES_*, BACKFILL_SECRET

const { prefsFooter } = require('./_lib/notify');
const { mintSigninToken } = require('./_lib/signin-token');

// Only free accounts created on/after this instant are eligible — this is the
// line between the 300-ish pre-created contacts (May 24 + Jul 19 batches) and
// genuine self-signups (Jul 21 onward).
const DRIP_START = '2026-07-20T00:00:00Z';
const SITE = 'https://thinkbeyondpractice.com';
const REPLY_TO = 'michael@thinkbeyondpractice.com';

function btn(href, label) {
  return '<p style="margin:22px 0"><a href="' + href + '" style="display:inline-block;background:#0d3b4f;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:6px">' + label + '</a></p>';
}

// Route member-gated links through one-click-signin so a new member lands ALREADY
// signed in, not at the cold magic-link gate. Public demos, signup routes, and links
// already one-click are left alone. (Same rule as broadcast-send.oneClickify.)
function needsAuth(path) {
  if (/^\/start-scribe/i.test(path)) return false;
  if (/[?&]join(&|=|$)/i.test(path)) return false;
  if (/[?&]demo=1(&|$)/i.test(path)) return false;
  return /^\/platform(\.html)?([\/?#]|$)/i.test(path)
      || /^\/pm-/i.test(path)
      || /^\/ai-scribe-workspace\.html/i.test(path)
      || /^\/eps-quick-reference/i.test(path);
}
function oneClickify(html, email) {
  if (!email) return html;
  var token;
  try { token = mintSigninToken(email); } catch (e) { return html; }
  return String(html).replace(/href="(https?:\/\/thinkbeyondpractice\.com(\/[^"]*)?)"/gi, function (m, full, path) {
    if (/one-click-signin/i.test(full)) return m;
    path = path || '/';
    if (!needsAuth(path)) return m;
    return 'href="' + SITE + '/.netlify/functions/one-click-signin?t=' + token + '&r=' + encodeURIComponent(path) + '"';
  });
}
function shell(inner) {
  return '<div style="max-width:560px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222">' + inner + '</div>';
}
const SIGNOFF = '<p style="margin:22px 0 0">Michael<br><span style="color:#777;font-size:13px">Michael Van Gelder, PMHNP-BC</span></p>';

// The sequence. day = days after signup the step becomes due.
const STEPS = [
  {
    n: 0, day: 0,
    subject: "Welcome — here's what you can dig into right now",
    html: function () {
      return shell(
        "<p>Glad you're here. Think Beyond Practice is built by and for psychiatric prescribers, and you don't need to pay a thing to start getting real value out of it.</p>" +
        "<p>The one I'd try first: <strong>Ask the Archive.</strong> Ask it any clinical, billing, or practice question and it answers from the prescriber discussions inside the forum — real, worked-through thinking, not a generic AI guess. And if it's something we haven't covered yet, it tells you so honestly <em>and</em> quietly flags it to me, so I go write the post that answers it. Either you get an answer now, or you help shape what gets answered next.</p>" +
        "<p>Ask it something you're chewing on this week:</p>" +
        btn(SITE + '/platform.html', 'Ask the Archive &rarr;') +
        "<p>Over the next few days I'll show you a couple of the tools we've built — run them on sample charts, no setup. And if you get stuck, just reply. It comes straight to me.</p>" +
        SIGNOFF
      );
    }
  },
  {
    n: 1, day: 2,
    subject: "Watch the AI Scribe turn a visit into a finished note",
    html: function () {
      return shell(
        "<p>This is the one I'm proudest of, and the one I'd show a colleague first: the <strong>AI Scribe</strong>. It turns a visit into a finished, audit-ready note, drafted in your own structure instead of a generic template.</p>" +
        "<p>It carries forward what mattered from the last visit, drafts the HPI, the assessment, and the plan, keeps the psychotherapy and assessment sections defensible, and hands the coder a note that already holds up. The parts that usually eat your evening, or your audit risk, are the parts it takes off your plate.</p>" +
        "<p>You can watch it work on a sample visit right now, with a guided walkthrough, no setup and no login:</p>" +
        btn(SITE + '/ai-scribe-workspace.html?demo=1', 'See the AI Scribe in action &rarr;') +
        "<p>It's in active beta and getting sharper every week from prescriber feedback. If something feels off, or you want it to do something it doesn't yet, just reply. It comes straight to me.</p>" +
        SIGNOFF
      );
    }
  },
  {
    n: 2, day: 4,
    subject: "Is that a 99214 or a 99213?",
    html: function () {
      return shell(
        "<p>The <strong>Audit and Coder</strong> reads your finished note the way a chart auditor would. It tells you the E/M level your documentation actually supports and the reasoning behind it, checks the note for internal consistency, and flags whether your psychotherapy add-on and other codes are defensible — so you can fix a soft spot before you submit, rather than after a denial.</p>" +
        "<p>Run it on a sample chart:</p>" +
        btn(SITE + '/chart-coder-demo', 'Try the Chart Auditor + Coder demo &rarr;') +
        "<p>Michael</p>"
      );
    }
  },
  {
    n: 3, day: 7,
    subject: "What's real here, and what Full unlocks",
    html: function () {
      return shell(
        "<p>Two things.</p>" +
        "<p>First, the tools you've tried this week, the AI Scribe, the Auditor and Coder, and Ask the Archive, are the real thing, in daily use by prescribers right now. The Scribe especially keeps getting sharper from their feedback.</p>" +
        "<p>Second, everything you've tried this week has been the free side. <strong>Full membership</strong> opens the real tools (not just demos), the whole community, and the complete archive, for about the cost of a couple of denied claims a month. If TBP's earned it this week, take a look:</p>" +
        btn(SITE + '/platform.html?plan=full_monthly_119', 'See what Full includes &rarr;') +
        "<p>Either way — glad you're here. Reply anytime.</p>" +
        "<p>Michael</p>"
      );
    }
  }
];

function firstName(name) {
  const n = String(name || '').trim();
  return n ? n.split(/\s+/)[0] : 'there';
}

// Build a Supabase REST caller and an SES client from env. Returns { sb, ses };
// ses is null if SES isn't configured (callers should no-op the send).
function makeClients() {
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { sb: null, ses: null };
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const sb = async (path, method, body, prefer) => {
    const h = Object.assign({}, auth); if (prefer) h['Prefer'] = prefer;
    const res = await fetch(URL + '/rest/v1/' + path, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
    const t = await res.text();
    if (!res.ok) throw new Error('sb ' + res.status + ': ' + t.slice(0, 150));
    return t ? JSON.parse(t) : null;
  };

  let ses = null;
  const accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    const region = process.env.SES_AWS_REGION || process.env.SES_REGION || 'us-east-1';
    const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
    ses = { client: new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } }), SendEmailCommand, from: process.env.SES_FROM || 'Michael Van Gelder <michael@thinkbeyondpractice.com>' };
  }
  return { sb, ses };
}

// Send one step to one account and record it in onboarding_sends. Idempotent on
// (account_id, step): a duplicate insert is swallowed so a double-fire (instant
// send racing the cron) never double-emails past the first success. Returns true
// if an email went out.
async function sendOneStep(sb, ses, account, step) {
  const email = String(account.email || '').toLowerCase();
  if (!email || email.indexOf('@') === -1) return false;
  const body = step.html().replace(/\{first_name\}/g, firstName(account.name));
  const html = oneClickify(body, email) + prefsFooter(email);
  await ses.client.send(new ses.SendEmailCommand({
    FromEmailAddress: ses.from,
    Destination: { ToAddresses: [email] },
    ReplyToAddresses: [REPLY_TO],
    Content: { Simple: { Subject: { Data: step.subject, Charset: 'UTF-8' }, Body: { Html: { Data: html, Charset: 'UTF-8' } } } }
  }));
  // resolution=merge-duplicates: if the row already exists (cron already sent, or
  // a concurrent instant-send won), the insert is a no-op instead of a 409.
  await sb('onboarding_sends?on_conflict=account_id,step', 'POST',
    { account_id: account.id, step: step.n }, 'return=minimal,resolution=merge-duplicates');
  return true;
}

// Called by platform-auth.js the instant a brand-new free account is created.
// Sends step 0 (the welcome) right away — unless the member is already unsubscribed
// or step 0 was somehow already sent. Best-effort: never throws to the caller, so a
// send hiccup can't block login. The cron still backstops missed step 0s.
async function sendWelcomeNow(account) {
  try {
    if (!account || !account.id || !account.email) return false;
    const { sb, ses } = makeClients();
    if (!sb || !ses) return false;

    const email = String(account.email).toLowerCase();
    // Skip if unsubscribed.
    try {
      const urows = await sb('contacts?subscribed=is.false&email=eq.' + encodeURIComponent(email) + '&select=email&limit=1');
      if (urows && urows.length) return false;
    } catch (e) { /* if contacts unavailable, default to send */ }
    // Skip if step 0 already recorded (idempotent across retries/relogins).
    try {
      const done = await sb('onboarding_sends?account_id=eq.' + encodeURIComponent(account.id) + '&step=eq.0&select=account_id&limit=1');
      if (done && done.length) return false;
    } catch (e) { /* if unreadable, the merge-duplicates insert still guards us */ }

    return await sendOneStep(sb, ses, account, STEPS[0]);
  } catch (e) {
    console.log('sendWelcomeNow error:', e && e.message);
    return false;
  }
}

exports.sendWelcomeNow = sendWelcomeNow;
exports.STEPS = STEPS;

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  const scheduled = !!(p && p.next_run);
  const secretOk = process.env.BACKFILL_SECRET && p.secret === process.env.BACKFILL_SECRET;
  if (!scheduled && !secretOk) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };

  const { sb, ses } = makeClients();
  if (!sb) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };
  if (!ses) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'SES not configured', sent: 0 }) };

  try {
    // Enrolled: new free self-signups only.
    const accts = await sb('accounts?tier=eq.free&circle_member_id=is.null&created_at=gte.' + encodeURIComponent(DRIP_START) + '&select=id,email,name,created_at&limit=1000');
    if (!accts || !accts.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, sent: 0, enrolled: 0 }) };

    const ids = accts.map(function (a) { return a.id; });
    const sentRows = await sb('onboarding_sends?account_id=in.(' + ids.join(',') + ')&select=account_id,step');
    const sentByAcct = {};
    (sentRows || []).forEach(function (r) { (sentByAcct[r.account_id] = sentByAcct[r.account_id] || {})[r.step] = true; });

    // Unsubscribed emails (contacts.subscribed=false).
    const emails = accts.map(function (a) { return String(a.email || '').toLowerCase(); }).filter(Boolean);
    const unsub = {};
    try {
      const urows = await sb('contacts?subscribed=is.false&email=in.(' + emails.map(encodeURIComponent).join(',') + ')&select=email');
      (urows || []).forEach(function (r) { unsub[String(r.email || '').toLowerCase()] = true; });
    } catch (e) { /* if contacts unavailable, default to send */ }

    let sent = 0;
    const now = Date.now();
    for (const a of accts) {
      const email = String(a.email || '').toLowerCase();
      if (!email || email.indexOf('@') === -1 || unsub[email]) continue;
      const days = Math.floor((now - new Date(a.created_at).getTime()) / 864e5);
      const already = sentByAcct[a.id] || {};
      // Lowest un-sent step that has come due.
      const step = STEPS.find(function (s) { return !already[s.n] && days >= s.day; });
      if (!step) continue;

      try {
        if (await sendOneStep(sb, ses, a, step)) sent++;
      } catch (e) { console.log('drip send error for', email, ':', e && e.message); }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, enrolled: accts.length, sent: sent }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
