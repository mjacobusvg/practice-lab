// netlify/functions/scribe-activation-nudge.js
//
// One-time activation nudge for FREE members who signed up but never ran the AI
// Scribe. The Scribe is what people convert on, so a free member who never touches
// it is the single biggest conversion leak. This emails them once, AFTER the welcome
// drip, pointing them at their first note (which starts the free 2-week trial). It
// also doubles as a re-invite for anyone who bounced off the old sign-in wall
// (2-emails/hour bug, now fixed) and never got the chance to activate.
//
// Enrolled = tier 'free', genuine self-signup (circle_member_id IS NULL, created
// on/after DRIP_START), created at least ACTIVATION_MIN_AGE_DAYS ago (past the
// drip's last step), NOT an internal/alt/comp account, NOT unsubscribed, and with
// NO 'AI Scribe' tool_usage ever. Idempotent: one send per account, tracked in
// onboarding_sends at step ACTIVATION_STEP (distinct from the drip's 0-3 and the
// paid welcome's 100). Capped per run so the first backlog rolls out gradually.
//
// Trigger: netlify.toml scheduled function, or manual POST { secret: BACKFILL_SECRET }.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SES_*, SESSION_SIGNING_SECRET, BACKFILL_SECRET

const { prefsFooter } = require('./_lib/notify');
const { mintSigninToken } = require('./_lib/signin-token');

const DRIP_START = '2026-07-20T00:00:00Z';
const ACTIVATION_MIN_AGE_DAYS = 10; // only nudge accounts older than this (past the drip)
const ACTIVATION_STEP = 200;        // distinct from drip (0-3) and paid welcome (100)
const MAX_PER_RUN = 150;            // pace the first backlog; steady-state is a trickle
const SITE = 'https://thinkbeyondpractice.com';
const REPLY_TO = 'michael@thinkbeyondpractice.com';

function btn(href, label) {
  return '<p style="margin:22px 0"><a href="' + href + '" style="display:inline-block;background:#0d3b4f;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:6px">' + label + '</a></p>';
}

// Route member-gated links through one-click-signin so they land ALREADY signed in.
// (Same rule as onboarding-drip / broadcast-send.)
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
const SUBJECT = "You haven't tried the one thing most members join for";

function emailHtml() {
  return shell(
    "<p>You signed up a little while back, but I noticed you haven't run the <strong>AI Scribe</strong> yet, and honestly it's the thing most members come for and the fastest way to tell whether Think Beyond Practice is worth it to you.</p>" +
    "<p>It turns a real visit into a finished, audit-ready note in your own structure, then checks the coding before you sign. You get a <strong>free 2-week trial</strong> to run it on your own visits, so there's no reason to let it sit unused.</p>" +
    "<p>Two ways to try it in the next couple of minutes:</p>" +
    btn(SITE + '/pm-ai-scribe.html', 'Run it on a visit (starts your free trial) &rarr;') +
    "<p>Or watch it work on a sample first, no login needed: <a href=\"" + SITE + "/ai-scribe-workspace.html?demo=1\">see the 2-minute demo</a>.</p>" +
    "<p>One more thing: if you tried to get in before and couldn't, that was a sign-in bug on my end that's now fixed, so it should be smooth. Either way, if you get stuck, just reply. It comes straight to me.</p>" +
    SIGNOFF
  );
}

// Supabase REST + SES clients from env. ses is null if SES isn't configured.
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

async function sendOne(sb, ses, account) {
  const email = String(account.email || '').toLowerCase();
  if (!email || email.indexOf('@') === -1) return false;
  const html = oneClickify(emailHtml(), email) + prefsFooter(email);
  await ses.client.send(new ses.SendEmailCommand({
    FromEmailAddress: ses.from,
    Destination: { ToAddresses: [email] },
    ReplyToAddresses: [REPLY_TO],
    Content: { Simple: { Subject: { Data: SUBJECT, Charset: 'UTF-8' }, Body: { Html: { Data: html, Charset: 'UTF-8' } } } }
  }));
  await sb('onboarding_sends?on_conflict=account_id,step', 'POST',
    { account_id: account.id, step: ACTIVATION_STEP }, 'return=minimal,resolution=merge-duplicates');
  return true;
}

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
    const cutoff = new Date(Date.now() - ACTIVATION_MIN_AGE_DAYS * 864e5).toISOString();
    // Free self-signups, past the drip, not alts/comps.
    const accts = await sb('accounts?tier=eq.free&circle_member_id=is.null&internal_label=is.null'
      + '&created_at=gte.' + encodeURIComponent(DRIP_START)
      + '&created_at=lte.' + encodeURIComponent(cutoff)
      + '&select=id,email,name,created_at&limit=2000');
    if (!accts || !accts.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, sent: 0, eligible: 0 }) };

    const ids = accts.map(function (a) { return a.id; });
    const emails = accts.map(function (a) { return String(a.email || '').toLowerCase(); }).filter(Boolean);

    // Already nudged (idempotent).
    const sentRows = await sb('onboarding_sends?account_id=in.(' + ids.join(',') + ')&step=eq.' + ACTIVATION_STEP + '&select=account_id');
    const sent = {}; (sentRows || []).forEach(function (r) { sent[r.account_id] = true; });

    // Anyone who HAS run the Scribe (exclude — they're activated).
    const scribeUsed = {};
    try {
      const su = await sb('tool_usage?tool=eq.' + encodeURIComponent('AI Scribe') + '&select=account_email&limit=50000');
      (su || []).forEach(function (r) { const e = String(r.account_email || '').toLowerCase(); if (e) scribeUsed[e] = true; });
    } catch (e) { /* if unreadable, we simply may re-nudge someone who used it; low harm */ }

    // Unsubscribed.
    const unsub = {};
    try {
      const urows = await sb('contacts?subscribed=is.false&email=in.(' + emails.map(encodeURIComponent).join(',') + ')&select=email');
      (urows || []).forEach(function (r) { unsub[String(r.email || '').toLowerCase()] = true; });
    } catch (e) { /* if contacts unavailable, default to send */ }

    let count = 0, eligible = 0;
    for (const a of accts) {
      const email = String(a.email || '').toLowerCase();
      if (!email || email.indexOf('@') === -1) continue;
      if (sent[a.id] || scribeUsed[email] || unsub[email]) continue;
      eligible++;
      if (count >= MAX_PER_RUN) continue;
      try { if (await sendOne(sb, ses, a)) count++; }
      catch (e) { console.log('activation nudge send error for', email, ':', e && e.message); }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, eligible: eligible, sent: count }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
