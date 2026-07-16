//.netlify/functions/transcribe-presign.mjs
// Returns a short-lived SigV4-presigned WebSocket URL for Amazon Transcribe
// MEDICAL streaming. The AWS secret NEVER leaves the server — only the temporary
// signed URL (valid 5 min) reaches the browser, which then streams mic audio
// directly to AWS over that URL. Direct-to-AWS (not proxied) because a 30-minute
// visit can't fit inside Netlify's function timeout.
//
// HIPAA note: Transcribe MEDICAL is HIPAA-eligible and covered by the account's
// AWS BAA; standard Transcribe is NOT — this function only ever signs the medical
// endpoint. Audio is streamed over TLS (wss) and nothing is stored server-side.
//
// Auth mirrors clinical-proxy-stream.mjs: a valid signed member session is required
// so this can't be used to burn AWS spend anonymously.

import crypto from 'crypto';

// ── Inlined token verification (identical algorithm to _lib/session.js) ──
const SECRET = process.env.SESSION_SIGNING_SECRET || '';
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function verifyToken(token) {
  if (!SECRET) return { valid: false, reason: 'server_misconfigured' };
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) {
    return { valid: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;
  let payloadJson;
  try { payloadJson = b64urlDecode(payloadB64); }
  catch (e) { return { valid: false, reason: 'malformed' }; }
  const expectedSig = b64url(crypto.createHmac('sha256', SECRET).update(payloadJson).digest());
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'bad_signature' };
  }
  let claims;
  try { claims = JSON.parse(payloadJson); }
  catch (e) { return { valid: false, reason: 'malformed' }; }
  if (!claims.exp || Date.now() > claims.exp) return { valid: false, reason: 'expired' };
  return { valid: true, claims };
}

// ── SigV4 helpers ──
function hmac(key, str) { return crypto.createHmac('sha256', key).update(str, 'utf8').digest(); }
function sha256hex(str) { return crypto.createHash('sha256').update(str, 'utf8').digest('hex'); }
// RFC-3986 encoding AWS expects (encodeURIComponent + the extra reserved chars).
function awsEnc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Transcribe Medical streaming specialties (psychiatry is not a listed specialty;
// PRIMARYCARE is the general fallback). type: CONVERSATION for multi-party visit audio.
const SPECIALTIES = ['PRIMARYCARE', 'CARDIOLOGY', 'NEUROLOGY', 'ONCOLOGY', 'RADIOLOGY', 'UROLOGY'];
const CONV_TYPES = ['CONVERSATION', 'DICTATION'];

export default async function handler(request) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200, headers: { ...cors, 'Content-Type': 'application/json' }
  });

  if (request.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  const region = process.env.TRANSCRIBE_REGION || 'us-east-1';
  const access = process.env.TRANSCRIBE_ACCESS_KEY_ID;
  const secret = process.env.TRANSCRIBE_SECRET_ACCESS_KEY;
  if (!access || !secret) return json({ error: 'Transcription is not configured on the server.' }, 500);

  let body = {};
  try { body = await request.json(); } catch (e) { /* body optional */ }

  // AUTH: valid signed member session required (same gate as the clinical proxy).
  const authHeader = request.headers.get('authorization') || '';
  const sessionToken = ((body && body.token) || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) return json({ error: 'Invalid or expired session.' }, 401);
  if (session.claims.scope !== 'member') {
    return json({ error: 'This feature requires the full Think Beyond Practice membership.' }, 403);
  }

  const specialty = (body && SPECIALTIES.indexOf(body.specialty) !== -1) ? body.specialty : 'PRIMARYCARE';
  const convType = (body && CONV_TYPES.indexOf(body.convType) !== -1) ? body.convType : 'CONVERSATION';

  const service = 'transcribe';
  const host = 'transcribestreaming.' + region + '.amazonaws.com:8443';
  const path = '/medical-stream-transcription-websocket';

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = dateStamp + '/' + region + '/' + service + '/aws4_request';

  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': access + '/' + credentialScope,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '300',
    'X-Amz-SignedHeaders': 'host',
    'language-code': 'en-US',
    'media-encoding': 'pcm',
    'sample-rate': '16000',
    'specialty': specialty,
    'type': convType
  };

  // Telehealth: two audio channels (mic = clinician, call audio = patient) → channel
  // identification gives reliable, named speaker attribution. In person: one mic →
  // optional speaker partitioning (diarization) splits voices but not roles. The two
  // features are mutually exclusive, so only one is ever added.
  const channels = (body && Number(body.channels) === 2) ? 2 : 1;
  if (channels === 2) {
    query['enable-channel-identification'] = 'true';
    query['number-of-channels'] = '2';
  } else if (body && body.speakerLabels) {
    query['show-speaker-label'] = 'true';
  }

  const canonicalQuery = Object.keys(query).sort()
    .map(k => awsEnc(k) + '=' + awsEnc(query[k])).join('&');
  const canonicalHeaders = 'host:' + host + '\n';
  const canonicalRequest = ['GET', path, canonicalQuery, canonicalHeaders, 'host', sha256hex('')].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secret, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const url = 'wss://' + host + path + '?' + canonicalQuery + '&X-Amz-Signature=' + signature;
  return json({ url, sampleRate: 16000, region, channels });
}
