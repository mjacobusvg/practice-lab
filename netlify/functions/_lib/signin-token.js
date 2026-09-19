// netlify/functions/_lib/signin-token.js
//
// A tamper-proof, purpose-scoped, EXPIRING token that lets a member click a link in
// an email and land on the platform already signed in — no "enter your email, wait for
// a magic link" inbox round-trip. Same HMAC construction and secret as the session
// token (SESSION_SIGNING_SECRET), purpose 'one-click-signin', with a 30-day expiry so a
// broadcast link stays valid across the campaign but not forever.
//
// It authorizes exactly one thing: the one-click-signin endpoint minting a FRESH
// Supabase magic link for that email at click time. It is not itself a session and
// grants no access on its own.
//
// AUDIT H10 (2026-09-19). The paragraph that used to sit here called the bearer risk
// "acceptable for free-tier sign-in". That was wrong on its own terms: the token is
// minted per EMAIL, not per tier, and `_lib/paid-welcome.js` sends one to every new
// PAID member — whose account holds the Vault (NPI, license numbers) and the PHI
// tools. And it was worse than a magic link, not equal to one: a magic link is short
// lived and single use, while this was deterministic for a THIRTY DAY window, reusable
// for every one of those days, and revocable by nothing. It rides in a URL in
// marketing email, so it also lives in forwarded mail, corporate mail-scanning
// appliances, browser history, and anything that logs query strings.
//
// Three changes, and they work together:
//   * TTL 30 days -> 7.
//   * A random `jti`, so two tokens for the same address are not the same string, and
//     redemption can be recorded. one-click-signin.js marks it spent; a second
//     redemption is refused.
//   * Redemption happens behind a CONFIRMATION, not on the GET (see
//     one-click-signin.js). That is what makes single-use survivable: mail scanners
//     and link prefetchers issue the GET, and if the GET spent the token they would
//     burn it before the human ever clicked.
//
// Tokens minted BEFORE this change carry no `jti` and a 30-day `exp`. They are still
// accepted, but their expiry is recomputed as if the TTL had always been 7 days (see
// effectiveExp), so the long tail of already-sent links retires within a week instead
// of riding out the old window. They cannot be single-use enforced — there is no jti
// to record — which is precisely why they should not live for another month.

const crypto = require('crypto');
const SECRET = process.env.SESSION_SIGNING_SECRET || '';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;        // 7 days
const LEGACY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // what pre-H10 tokens were minted with

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function sign(payloadJson) {
  return b64url(crypto.createHmac('sha256', SECRET).update(payloadJson).digest());
}

function mintSigninToken(email) {
  if (!SECRET) throw new Error('SESSION_SIGNING_SECRET not configured');
  const payload = JSON.stringify({
    email: String(email || '').toLowerCase().trim(),
    purpose: 'one-click-signin',
    // Random per token. Without it, every link minted for one address inside the
    // window was the same string, so "this one was used" was not a question that
    // could even be asked.
    jti: crypto.randomBytes(16).toString('hex'),
    exp: Date.now() + TTL_MS
  });
  return b64url(payload) + '.' + sign(payload);
}

/**
 * When this token really expires.
 *
 * A pre-H10 token has no `jti` and was minted with a 30-day TTL, so its mint time is
 * `exp - LEGACY_TTL_MS`. Re-expire it 7 days after that instead. A current token is
 * already 7-day and its own `exp` stands.
 */
function effectiveExp(claims) {
  if (!claims || !claims.exp) return 0;
  if (claims.jti) return claims.exp;
  return (claims.exp - LEGACY_TTL_MS) + TTL_MS;
}

function verifySigninToken(token) {
  if (!SECRET) return { valid: false };
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return { valid: false };
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false };
  let payloadJson;
  try { payloadJson = b64urlDecode(parts[0]); } catch (e) { return { valid: false }; }
  const expected = sign(payloadJson);
  const a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false };
  let claims;
  try { claims = JSON.parse(payloadJson); } catch (e) { return { valid: false }; }
  if (claims.purpose !== 'one-click-signin' || !claims.email) return { valid: false };
  const exp = effectiveExp(claims);
  if (!exp || Date.now() > exp) return { valid: false, reason: 'expired' };
  return {
    valid: true,
    email: String(claims.email).toLowerCase().trim(),
    // Absent on pre-H10 tokens. The caller must treat "no jti" as "cannot be
    // recorded as spent", not as "fine to replay".
    jti: claims.jti || null
  };
}

module.exports = { mintSigninToken, verifySigninToken, TTL_MS };
