// netlify/functions/_lib/prefs-token.js
//
// A tamper-proof, purpose-scoped token that lets a member manage their email
// preferences from an email link WITHOUT logging in. Same HMAC construction and
// secret as the session token (SESSION_SIGNING_SECRET), but purpose:'email-prefs'
// and NO expiry — an unsubscribe/manage link must keep working indefinitely.
// It authorizes exactly one thing: reading/writing that email's notify_email_*
// flags. It is not a session and grants no other access.

const crypto = require('crypto');
const SECRET = process.env.SESSION_SIGNING_SECRET || '';

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

function mintPrefsToken(email) {
  if (!SECRET) throw new Error('SESSION_SIGNING_SECRET not configured');
  const payload = JSON.stringify({ email: String(email || '').toLowerCase().trim(), purpose: 'email-prefs' });
  return b64url(payload) + '.' + sign(payload);
}

function verifyPrefsToken(token) {
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
  if (claims.purpose !== 'email-prefs' || !claims.email) return { valid: false };
  return { valid: true, email: String(claims.email).toLowerCase().trim() };
}

module.exports = { mintPrefsToken, verifyPrefsToken };
