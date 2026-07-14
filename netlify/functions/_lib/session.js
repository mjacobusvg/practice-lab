// netlify/functions/_lib/session.js
//
// LAYER 2 — Session signing/verification. This file is the durable core of auth.
// It has NO dependency on Circle, Supabase, or any identity provider.
// It only does one thing: mint a tamper-proof session token, and verify one.
//
// At platform migration (off Circle), THIS FILE DOES NOT CHANGE.
// Only the Layer 1 membership check (in circle-auth.js) gets swapped.
//
// A token is:  base64url(payloadJson) + "." + base64url(hmacSha256(payloadJson))
// The signature is keyed with SESSION_SIGNING_SECRET (a Netlify env var).
// Without that secret you cannot forge a token. The old base64(email:timestamp)
// had no secret, so anyone could mint one — that is the hole this closes.

const crypto = require('crypto');

const SECRET = process.env.SESSION_SIGNING_SECRET || '';

// How long a session is valid. 30 days = "trusted device": the user verifies
// once, then the signed token rides for 30 days before re-verification.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function sign(payloadJson) {
  return b64url(crypto.createHmac('sha256', SECRET).update(payloadJson).digest());
}

/**
 * Mint a signed session token.
 * @param {object} claims - { email, scope, tier, communityMemberId? }
 *   scope: 'member' (full platform) | 'hub' (standalone Credentialing Hub only)
 * @returns {string} signed token
 */
function mintToken(claims) {
  if (!SECRET) throw new Error('SESSION_SIGNING_SECRET not configured');
  const now = Date.now();
  const payload = {
    email: (claims.email || '').toLowerCase().trim(),
    scope: claims.scope || 'member',
    tier: claims.tier || null,
    cmid: claims.communityMemberId || null,
    iat: now,
    exp: now + SESSION_TTL_MS
  };
  const payloadJson = JSON.stringify(payload);
  return b64url(payloadJson) + '.' + sign(payloadJson);
}

/**
 * Verify a signed session token.
 * @param {string} token
 * @returns {object} { valid:boolean, reason?:string, claims?:object }
 */
function verifyToken(token) {
  if (!SECRET) return { valid: false, reason: 'server_misconfigured' };
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) {
    return { valid: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };

  const [payloadB64, sigB64] = parts;
  let payloadJson;
  try {
    payloadJson = b64urlDecode(payloadB64);
  } catch (e) {
    return { valid: false, reason: 'malformed' };
  }

  // Constant-time signature comparison
  const expectedSig = sign(payloadJson);
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'bad_signature' };
  }

  let claims;
  try {
    claims = JSON.parse(payloadJson);
  } catch (e) {
    return { valid: false, reason: 'malformed' };
  }

  if (!claims.exp || Date.now() > claims.exp) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, claims };
}

/**
 * Check whether a verified session's scope is allowed for a given tool.
 * 'member' scope can reach anything. 'hub' scope reaches only the Hub.
 * Extend ALLOW as tools become standalone-eligible.
 */
function scopeAllowsTool(scope, toolId) {
  if (scope === 'member') return true;
  const ALLOW = {
    hub: ['credentialing-hub']
  };
  return (ALLOW[scope] || []).indexOf(toolId) !== -1;
}

module.exports = { mintToken, verifyToken, scopeAllowsTool, SESSION_TTL_MS };
