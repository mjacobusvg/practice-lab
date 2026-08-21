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

exports.handler = async function (event) {
  const gate = { statusCode: 302, headers: { Location: SITE + '/platform', 'Cache-Control': 'no-store' }, body: '' };

  const q = event.queryStringParameters || {};
  const v = verifySigninToken(q.t || '');
  if (!v.valid) return gate; // expired or tampered → normal login gate

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return gate;

  // Optional deep-link: where they should land AFTER sign-in (the ?r= param that
  // broadcast-send stamps onto member-gated links). Only a same-origin RELATIVE path
  // is honored — must start with a single "/", never a scheme or "//" — so this can
  // never be turned into an open redirect. A /platform URL is used directly (that
  // path is allowlisted in Supabase Auth); any other member path rides as a returnTo
  // so platform.html routes them there once the session is set.
  let dest = '';
  if (/^\/(?!\/)/.test(q.r || '')) dest = q.r;
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
