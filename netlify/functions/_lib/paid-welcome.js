// netlify/functions/_lib/paid-welcome.js
//
// The welcome a member gets the moment they become a PAYING member (full or forum).
// The free-signup drip (onboarding-drip.js) is tier='free' only, so anyone who goes
// straight to paid, or upgrades from free to paid, previously heard nothing at the
// exact moment first-week retention is decided. This closes that gap.
//
// Called from stripe-webhook.js after a subscription event resolves to an ACTIVE
// paying tier. Idempotent: a marker row in onboarding_sends (step = PAID_WELCOME_STEP)
// means it only ever sends once per account, so renewals / repeated subscription
// events never re-email. A one-time suppression backfill marks the pre-existing book
// so shipping this never retro-emails long-standing members.
//
// The email points straight at the AI Scribe (day-one value) and ends with ONE
// lightweight, one-click "what brought you in?" question (signup-reason.js records
// the answer and lands them signed in). No form, so it never competes with the CTA.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SES_*, SESSION_SIGNING_SECRET

const { prefsFooter } = require('./notify');
const { mintSigninToken } = require('./signin-token');

const SITE = 'https://thinkbeyondpractice.com';
const REPLY_TO = 'michael@thinkbeyondpractice.com';

// Distinct from the free drip's steps 0-3 so the two never collide in onboarding_sends.
const PAID_WELCOME_STEP = 100;

// The survey answers offered in the welcome. Keep in sync with the allowlist in
// signup-reason.js.
const REASONS = [
  { slug: 'scribe', label: 'The AI Scribe (documentation)' },
  { slug: 'coding', label: 'Coding & audit support' },
  { slug: 'community', label: 'The community & archive' },
  { slug: 'tools', label: 'Practice & credentialing tools' }
];

function btn(href, label) {
  return '<p style="margin:22px 0"><a href="' + href + '" style="display:inline-block;background:#0d3b4f;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:6px">' + label + '</a></p>';
}
function shell(inner) {
  return '<div style="max-width:560px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222">' + inner + '</div>';
}
const SIGNOFF = '<p style="margin:22px 0 0">Michael<br><span style="color:#777;font-size:13px">Michael Van Gelder, PMHNP-BC</span></p>';

// One-click survey row: each answer is a link that records the reason and lands the
// member signed in. Falls back to nothing if a token can't be minted.
function surveyBlock(token) {
  if (!token) return '';
  var rows = REASONS.map(function (r) {
    var href = SITE + '/.netlify/functions/signup-reason?t=' + token + '&r=' + r.slug;
    return '<tr><td style="padding:5px 0"><a href="' + href + '" style="color:#0d3b4f;text-decoration:none;font-weight:600">&rarr; ' + r.label + '</a></td></tr>';
  }).join('');
  return '<div style="margin:26px 0 0;padding-top:18px;border-top:1px solid #eee">' +
    '<p style="margin:0 0 8px;color:#555"><strong>One quick question:</strong> what brought you to Think Beyond Practice? (one tap, it helps me build the right things)</p>' +
    '<table cellpadding="0" cellspacing="0" role="presentation">' + rows + '</table>' +
    '</div>';
}

function buildEmail(account, token) {
  var scribe = SITE + '/pm-ai-scribe.html';
  var inner =
    "<p>Michael here, founder of Think Beyond Practice. I saw you came on as a paying member, and I wanted to reach out personally. Thank you, genuinely.</p>" +
    "<p>You've got the real tools now, not demos, plus the full community and the complete archive. The fastest way to feel the value today is the one I'm proudest of: the <strong>AI Scribe</strong>.</p>" +
    "<p>Open it, run it on your next visit (or a sample first), and watch it draft the HPI, assessment, and plan in your own structure, carrying forward what mattered from last time, into an audit-ready note. Then the <strong>Auditor and Coder</strong> checks the E/M level your documentation actually supports before you submit.</p>" +
    btn(scribe, 'Open the AI Scribe &rarr;') +
    "<p>If anything is confusing or doesn't work the way you expect, just reply to this email. It comes straight to me.</p>" +
    "<p>Welcome aboard.</p>" +
    SIGNOFF +
    surveyBlock(token);
  return shell(inner);
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

// Send the paid welcome to one account, exactly once. Best-effort: never throws to
// the caller (a send hiccup must not break the webhook's 200). Returns true if an
// email went out.
//   { accountId } — the account that just became a paying member.
async function sendPaidWelcomeIfNew(opts) {
  try {
    const accountId = opts && opts.accountId;
    if (!accountId) return false;
    const { sb, ses } = makeClients();
    if (!sb || !ses) return false;

    // Load the member (email + name).
    const accts = await sb('accounts?id=eq.' + encodeURIComponent(accountId) + '&select=id,email,name&limit=1');
    const acct = accts && accts[0];
    const email = acct && String(acct.email || '').toLowerCase().trim();
    if (!email || email.indexOf('@') === -1) return false;

    // Already welcomed? (marker, or the suppression backfill for existing members.)
    try {
      const done = await sb('onboarding_sends?account_id=eq.' + encodeURIComponent(accountId) + '&step=eq.' + PAID_WELCOME_STEP + '&select=account_id&limit=1');
      if (done && done.length) return false;
    } catch (e) { /* if unreadable, the merge-duplicates insert below still guards us */ }

    // Hard-unsubscribed? Skip.
    try {
      const urows = await sb('contacts?subscribed=is.false&email=eq.' + encodeURIComponent(email) + '&select=email&limit=1');
      if (urows && urows.length) return false;
    } catch (e) { /* if contacts unavailable, default to send */ }

    let token = '';
    try { token = mintSigninToken(email); } catch (e) { token = ''; }

    const html = buildEmail(acct, token) + prefsFooter(email);
    await ses.client.send(new ses.SendEmailCommand({
      FromEmailAddress: ses.from,
      Destination: { ToAddresses: [email] },
      ReplyToAddresses: [REPLY_TO],
      Content: { Simple: { Subject: { Data: "Welcome to Think Beyond Practice", Charset: 'UTF-8' }, Body: { Html: { Data: html, Charset: 'UTF-8' } } } }
    }));

    // Record the marker (idempotent: a concurrent send / retry is swallowed).
    await sb('onboarding_sends?on_conflict=account_id,step', 'POST',
      { account_id: accountId, step: PAID_WELCOME_STEP }, 'return=minimal,resolution=merge-duplicates');
    return true;
  } catch (e) {
    console.log('sendPaidWelcomeIfNew error:', e && e.message);
    return false;
  }
}

module.exports = { sendPaidWelcomeIfNew, PAID_WELCOME_STEP, REASONS };
