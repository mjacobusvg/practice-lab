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
// grants no access on its own. Bearer risk is identical to any magic link (a forwarded
// email could be used by the recipient), which is acceptable for free-tier sign-in.

const crypto = require('crypto');
const SECRET = process.env.SESSION_SIGNING_SECRET || '';

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
    exp: Date.now() + TTL_MS
  });
  return b64url(payload) + '.' + sign(payload);
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
  if (!claims.exp || Date.now() > claims.exp) return { valid: false, reason: 'expired' };
  return { valid: true, email: String(claims.email).toLowerCase().trim() };
}

module.exports = { mintSigninToken, verifySigninToken };
