// netlify/functions/_lib/baa-link.js
//
// The one-document download token that goes in the BAA confirmation email.
// Security audit 2026-09-16, finding H3 — see baa-document.js for the full write-up.
//
// A token is  base64url(payloadJson) + "." + base64url(hmac)  over {sid, exp}, keyed
// with SESSION_SIGNING_SECRET. It is NAMESPACED ('baa-link.v1:') so that a token signed
// here can never be presented as a session token, or the reverse, even though both are
// signed with the same secret.

const crypto = require('crypto');

const SECRET = process.env.SESSION_SIGNING_SECRET || '';
const LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function linkSign(payloadJson) {
  return b64url(crypto.createHmac('sha256', SECRET).update('baa-link.v1:' + payloadJson).digest());
}

function mintLinkToken(signatureId, ttlMs) {
  if (!SECRET) throw new Error('SESSION_SIGNING_SECRET not configured');
  const payloadJson = JSON.stringify({ sid: String(signatureId), exp: Date.now() + (ttlMs || LINK_TTL_MS) });
  return b64url(payloadJson) + '.' + linkSign(payloadJson);
}

function verifyLinkToken(token) {
  if (!SECRET) return { valid: false, reason: 'server_misconfigured' };
  if (!token || typeof token !== 'string') return { valid: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };
  let payloadJson;
  try { payloadJson = b64urlDecode(parts[0]); } catch (e) { return { valid: false, reason: 'malformed' }; }
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(linkSign(payloadJson));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'bad_signature' };
  let claims;
  try { claims = JSON.parse(payloadJson); } catch (e) { return { valid: false, reason: 'malformed' }; }
  if (!claims.exp || Date.now() > claims.exp) return { valid: false, reason: 'expired' };
  if (!claims.sid) return { valid: false, reason: 'malformed' };
  return { valid: true, claims };
}

module.exports = { mintLinkToken, verifyLinkToken, LINK_TTL_MS };
