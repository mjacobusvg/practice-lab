// netlify/functions/one-click-signin.js
//
// One-click sign-in from an email link. A member clicks the CTA in a broadcast and
// lands on the platform ALREADY signed in — no "email me a sign-in link → check inbox →
// click → come back" round-trip. That round-trip is what kills free-member activation.
//
// Flow: our signed, expiring token (email + purpose 'one-click-signin') is verified here,
// then we mint a FRESH Supabase magic link for that email AT CLICK TIME (so Supabase's
// own short OTP expiry never matters — it's consumed within milliseconds) and 302 to it.
// Supabase verifies, sets the session, and redirects to /platform, where they land logged
// in with the AI Scribe trial one tap away.
//
// Any bad/expired/failed path falls back to the normal login gate — never an error page.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET (via _lib/signin-token)

const { verifySigninToken } = require('./_lib/signin-token');

const SITE = 'https://thinkbeyondpractice.com';

// AUDIT H10 (2026-09-19). Two changes to how a click is honoured.
//
// 1) A GET NO LONGER SIGNS ANYONE IN. It renders a confirmation page, and the
//    sign-in happens on the POST from that page. This exists for two reasons that
//    point the same way:
//      * A link in email gets FETCHED by things that are not the member — Outlook
//        Safe Links, corporate mail scanners, prefetchers. If the GET spent the
//        token, every one of those would burn it before the human clicked, and
//        single use would be unshippable.
//      * A forwarded email would otherwise silently sign the WRONG PERSON in, with
//        no moment at which anyone could notice. Now the page names the account.
//    Scanners fetch; they do not submit forms.
//
// 2) REDEMPTION IS RECORDED AND SINGLE USE. The token's `jti` is written to
//    signin_token_uses; a second attempt is refused. Pre-H10 tokens have no jti and
//    cannot be recorded — they are still honoured, but _lib/signin-token.js has
//    already shortened them to 7 days from mint so that tail is short.
//
// Everything still fails soft to the normal login gate. Nobody sees an error page.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// "michael@thinkbeyondpsych.com" -> "mic•••@thinkbeyondpsych.com". Enough for the
// right person to recognise their own account, not a fresh disclosure to someone
// holding a forwarded email (who already has the address in the To: line anyway).
function maskEmail(email) {
  const at = String(email).indexOf('@');
  if (at < 1) return '';
  const local = String(email).slice(0, at), domain = String(email).slice(at);
  const keep = local.length <= 3 ? 1 : 3;
  return local.slice(0, keep) + '•••' + domain;
}

function confirmPage(email, token, r) {
  const masked = maskEmail(email);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow">' +
    '<title>Sign in to Think Beyond Practice</title><style>' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#0B1120;color:#F5F1E8;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px;box-sizing:border-box}' +
    '.card{max-width:420px;width:100%;background:#111a2e;border:1px solid #23304a;border-radius:12px;padding:28px;text-align:center}' +
    'h1{font-size:1.15rem;margin:0 0 10px}p{margin:0 0 18px;color:#c3ccdb;font-size:.93rem}' +
    '.who{font-weight:700;color:#F5F1E8}' +
    'button{width:100%;padding:13px;background:#2FA8A0;color:#0B1120;border:0;border-radius:8px;' +
    'font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}' +
    'button:hover{background:#38bdb4}.alt{margin:16px 0 0;font-size:.82rem}' +
    '.alt a{color:#2FA8A0;text-decoration:none}' +
    '</style></head><body><div class="card">' +
    '<h1>Continue to Think Beyond Practice</h1>' +
    '<p>This link will sign you in as <span class="who">' + esc(masked) + '</span>.</p>' +
    '<form method="POST">' +
    '<input type="hidden" name="t" value="' + esc(token) + '">' +
    (r ? '<input type="hidden" name="r" value="' + esc(r) + '">' : '') +
    '<button type="submit">Continue</button></form>' +
    '<p class="alt">Not you? <a href="' + SITE + '/platform">Sign in with your own account</a></p>' +
    '</div></body></html>';
}

function parseForm(body, isB64) {
  const raw = isB64 ? Buffer.from(body || '', 'base64').toString('utf8') : (body || '');
  const out = {};
  String(raw).split('&').forEach(function (kv) {
    if (!kv) return;
    const i = kv.indexOf('=');
    const k = decodeURIComponent((i === -1 ? kv : kv.slice(0, i)).replace(/\+/g, ' '));
    const val = i === -1 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
    out[k] = val;
  });
  return out;
}

exports.handler = async function (event) {
  const gate = { statusCode: 302, headers: { Location: SITE + '/platform', 'Cache-Control': 'no-store' }, body: '' };

  const q = event.queryStringParameters || {};
  const posted = event.httpMethod === 'POST' ? parseForm(event.body, event.isBase64Encoded) : {};
  const token = String(posted.t || q.t || '');
  const v = verifySigninToken(token);
  if (!v.valid) return gate; // expired or tampered → normal login gate

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return gate;

  // GET = show the confirmation. Nothing is spent, nobody is signed in.
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
                 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' },
      body: confirmPage(v.email, token, /^\/(?!\/)/.test(q.r || '') ? q.r : '')
    };
  }

  // POST = the member pressed Continue. Spend the token, once.
  if (v.jti) {
    const svc = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
    try {
      const ins = await fetch(URL + '/rest/v1/signin_token_uses', {
        method: 'POST',
        headers: Object.assign({ Prefer: 'return=minimal' }, svc),
        body: JSON.stringify({
          jti: v.jti, email: v.email,
          ip: (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'])) || null
        })
      });
      // 409 = primary key conflict = already redeemed. Anything else that is not ok
      // is Supabase being unhappy; fail to the login gate rather than letting a
      // failed write become an unlimited-use token.
      if (!ins.ok) return gate;
    } catch (e) { return gate; }
  }

  // Optional deep-link: where they should land AFTER sign-in (the ?r= param that
  // broadcast-send stamps onto member-gated links). Only a same-origin RELATIVE path
  // is honored — must start with a single "/", never a scheme or "//" — so this can
  // never be turned into an open redirect. A /platform URL is used directly (that
  // path is allowlisted in Supabase Auth); any other member path rides as a returnTo
  // so platform.html routes them there once the session is set.
  let dest = '';
  const rParam = String(posted.r || q.r || '');
  if (/^\/(?!\/)/.test(rParam)) dest = rParam;
  let redirectTo = SITE + '/platform';
  if (dest) {
    redirectTo = (dest === '/platform' || /^\/platform[?#]/.test(dest))
      ? SITE + dest
      : SITE + '/platform?returnTo=' + encodeURIComponent(dest);
  }

  // Mint a fresh Supabase magic link for that email AT CLICK TIME and 302 to it.
  async function genLink(redir) {
    try {
      const r = await fetch(URL + '/auth/v1/admin/generate_link', {
        method: 'POST',
        headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'magiclink', email: v.email, redirect_to: redir })
      });
      if (!r.ok) return '';
      const d = await r.json().catch(function () { return {}; });
      return d.action_link || (d.properties && d.properties.action_link) || '';
    } catch (e) { return ''; }
  }

  // Try the deep-link redirect; if Supabase rejects that redirect_to (not allowlisted),
  // fall back to the always-allowlisted /platform so they STILL land signed in, never cold.
  let link = await genLink(redirectTo);
  if (!link && redirectTo !== SITE + '/platform') link = await genLink(SITE + '/platform');
  if (!link) return gate;
  return { statusCode: 302, headers: { Location: link, 'Cache-Control': 'no-store' }, body: '' };
};
