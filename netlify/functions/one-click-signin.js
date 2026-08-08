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

  const t = (event.queryStringParameters && event.queryStringParameters.t) || '';
  const v = verifySigninToken(t);
  if (!v.valid) return gate; // expired or tampered → normal login gate

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return gate;

  // Where they land after Supabase verifies the fresh link. Must be an allowlisted
  // redirect in Supabase Auth (the normal magic-link flow already redirects to /platform,
  // so it is). The Supabase JS client on that page picks the session out of the URL.
  const redirectTo = SITE + '/platform';

  try {
    const r = await fetch(URL + '/auth/v1/admin/generate_link', {
      method: 'POST',
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', email: v.email, redirect_to: redirectTo })
    });
    if (!r.ok) return gate;
    const d = await r.json().catch(function () { return {}; });
    const link = d.action_link || (d.properties && d.properties.action_link) || '';
    if (!link) return gate;
    return { statusCode: 302, headers: { Location: link, 'Cache-Control': 'no-store' }, body: '' };
  } catch (e) {
    return gate;
  }
};
