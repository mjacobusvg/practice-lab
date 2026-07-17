//.netlify/functions/azure-transcribe.mjs
// Batch transcription via Azure AI Speech "Fast Transcription" (synchronous).
// The browser records the whole visit to one audio file, uploads it here (base64),
// and this function forwards it to Azure, returning a speaker-labeled transcript.
//
// Why batch, not streaming: psychiatry doesn't need live captions, and batch is
// cheaper, simpler, and more accurate (the model sees the whole recording). The
// note is generated after the visit anyway.
//
// HIPAA: Azure AI Speech is HIPAA-eligible under the account's Microsoft BAA. The
// AZURE_SPEECH_KEY never reaches the browser. Audio is processed transiently and
// not stored server-side.
//
// Auth mirrors the other clinical functions: a valid signed member session is
// required so this can't be used to burn Azure spend anonymously.

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
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return { valid: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;
  let payloadJson;
  try { payloadJson = b64urlDecode(payloadB64); } catch (e) { return { valid: false, reason: 'malformed' }; }
  const expectedSig = b64url(crypto.createHmac('sha256', SECRET).update(payloadJson).digest());
  const a = Buffer.from(sigB64), b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'bad_signature' };
  let claims;
  try { claims = JSON.parse(payloadJson); } catch (e) { return { valid: false, reason: 'malformed' }; }
  if (!claims.exp || Date.now() > claims.exp) return { valid: false, reason: 'expired' };
  return { valid: true, claims };
}

// Turn Azure's phrase list into a speaker-labeled transcript. With diarization,
// each phrase carries a numeric `speaker`; we group consecutive same-speaker
// phrases into one line ("Speaker 1: ..."). Roles (patient vs clinician) are the
// clinician's to confirm — Azure separates voices but doesn't know who's who.
function formatTranscript(data) {
  const phrases = Array.isArray(data.phrases) ? data.phrases : [];
  const hasSpeakers = phrases.some(p => p.speaker !== undefined && p.speaker !== null);
  if (phrases.length && hasSpeakers) {
    let out = '', last = null;
    for (const p of phrases) {
      const text = (p.text || '').trim();
      if (!text) continue;
      const label = (p.speaker !== undefined && p.speaker !== null) ? ('Speaker ' + p.speaker) : null;
      if (label && label !== last) { out += (out ? '\n' : '') + label + ': ' + text; last = label; }
      else { out += (out && !out.endsWith('\n') ? ' ' : '') + text; }
    }
    return out.trim();
  }
  if (Array.isArray(data.combinedPhrases) && data.combinedPhrases.length) {
    return data.combinedPhrases.map(c => c.text || '').join(' ').trim();
  }
  if (phrases.length) return phrases.map(p => p.text || '').join(' ').trim();
  return '';
}

function extFor(ct) {
  ct = (ct || '').toLowerCase();
  if (ct.indexOf('webm') !== -1) return '.webm';
  if (ct.indexOf('ogg') !== -1) return '.ogg';
  if (ct.indexOf('mp4') !== -1 || ct.indexOf('m4a') !== -1) return '.mp4';
  if (ct.indexOf('wav') !== -1) return '.wav';
  if (ct.indexOf('mpeg') !== -1 || ct.indexOf('mp3') !== -1) return '.mp3';
  return '.webm';
}

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

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Bad request.' }, 400); }

  const auth = verifyToken(body && body.token);
  if (!auth.valid) return json({ error: 'Unauthorized.' }, 401);

  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION || 'eastus';
  if (!key) return json({ error: 'Transcription is not configured yet.' }, 500);

  const audioB64 = body.audioBase64 || '';
  if (!audioB64) return json({ error: 'No audio received.' }, 400);
  let audio;
  try { audio = Buffer.from(audioB64, 'base64'); } catch (e) { return json({ error: 'Bad audio.' }, 400); }
  if (!audio.length) return json({ error: 'Empty recording.' }, 400);

  const contentType = body.contentType || 'audio/webm';
  const definition = JSON.stringify({
    locales: ['en-US'],
    profanityFilterMode: 'None',
    diarization: body.diarize === false ? undefined : { maxSpeakers: 2, enabled: true }
  });

  // Build the multipart/form-data body by hand (no external deps): an `audio` file
  // part and a `definition` JSON part.
  const boundary = '----tbpAzure' + crypto.randomBytes(8).toString('hex');
  const pre = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="audio"; filename="visit' + extFor(contentType) + '"\r\n' +
    'Content-Type: ' + contentType + '\r\n\r\n', 'utf8');
  const mid = Buffer.from(
    '\r\n--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="definition"\r\n' +
    'Content-Type: application/json\r\n\r\n' + definition + '\r\n' +
    '--' + boundary + '--\r\n', 'utf8');
  const multipart = Buffer.concat([pre, audio, mid]);

  const url = 'https://' + region + '.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15';

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'multipart/form-data; boundary=' + boundary
      },
      body: multipart
    });
  } catch (e) {
    return json({ error: 'Could not reach the transcription service.' }, 502);
  }

  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 400); } catch (e) {}
    return json({ error: 'Transcription failed (' + resp.status + ').', detail }, 502);
  }

  let data;
  try { data = await resp.json(); } catch (e) { return json({ error: 'Unexpected transcription response.' }, 502); }

  const transcript = formatTranscript(data);
  if (!transcript) return json({ error: 'No speech was recognized in the recording.' }, 200);
  return json({ transcript, durationMs: data.durationMilliseconds || null });
}
