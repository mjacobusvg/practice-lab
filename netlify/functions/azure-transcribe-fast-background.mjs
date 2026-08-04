// netlify/functions/azure-transcribe-fast-background.mjs
// SPIKE (new-patient evals only): Azure AI Speech FAST transcription.
//
// Why this exists: batch transcription (azure-transcribe.mjs) queues the job and can take
// minutes — fine for short follow-ups, but it's what made a long new-patient eval feel slow.
// Fast transcription is SYNCHRONOUS (one blocking call, seconds), but a long eval can run past
// the 26s synchronous-function ceiling, so the blocking call lives here in a BACKGROUND function
// (900s ceiling, see netlify.toml). It downloads the already-uploaded audio blob, calls the fast
// endpoint with diarization, writes the transcript + timing to a RESULT blob, and deletes the
// audio. The client kicks this off and then polls `fast-poll` (in azure-transcribe.mjs) for the
// result blob. Batch is untouched and still serves follow-ups.
//
// Measurement: the result blob carries elapsedMs (the fast call round-trip), audioBytes, and
// durationMs, so we can read the real timing off a representative eval before wiring it live.
//
// HIPAA: audio + transcript live only in the account's Azure Blob storage (Microsoft BAA) and
// are deleted after use, same posture as the batch path. Keys never reach the browser.

import crypto from 'crypto';
import { StorageSharedKeyCredential, BlobServiceClient } from '@azure/storage-blob';

// ── Token verification (same algorithm as the other clinical functions) ──
const SECRET = process.env.SESSION_SIGNING_SECRET || '';
function b64urlDecode(str){ str=str.replace(/-/g,'+').replace(/_/g,'/'); while(str.length%4)str+='='; return Buffer.from(str,'base64').toString('utf8'); }
function b64url(buf){ return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function verifyToken(token){
  if(!SECRET) return { valid:false };
  if(!token || typeof token!=='string' || token.indexOf('.')===-1) return { valid:false };
  const parts=token.split('.'); if(parts.length!==2) return { valid:false };
  let payloadJson; try{ payloadJson=b64urlDecode(parts[0]); }catch(e){ return { valid:false }; }
  const expected=b64url(crypto.createHmac('sha256',SECRET).update(payloadJson).digest());
  const a=Buffer.from(parts[1]), b=Buffer.from(expected);
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return { valid:false };
  let claims; try{ claims=JSON.parse(payloadJson); }catch(e){ return { valid:false }; }
  if(!claims.exp || Date.now()>claims.exp) return { valid:false };
  return { valid:true, claims };
}

const ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT || '';
const STORAGE_KEY = process.env.AZURE_STORAGE_KEY || '';
const SPEECH_KEY = process.env.AZURE_SPEECH_KEY || '';
const REGION = process.env.AZURE_SPEECH_REGION || 'eastus';
const CONTAINER = 'ambient-audio';
// Fast transcription is a synchronous endpoint distinct from the batch /transcriptions job API.
const FAST_URL = 'https://' + REGION + '.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15';

const safeBlob  = (n) => typeof n==='string' && /^visit-[a-f0-9]{16,}\.(webm|ogg|mp4|wav|mp3)$/.test(n);
const safeJobId = (n) => typeof n==='string' && /^[a-f0-9-]{16,64}$/i.test(n);
const resName   = (jobId) => 'fastres-' + jobId + '.json';

function serviceClient(){
  return BlobServiceClient.fromConnectionString(
    'DefaultEndpointsProtocol=https;AccountName='+ACCOUNT+';AccountKey='+STORAGE_KEY+';EndpointSuffix=core.windows.net'
  );
}
function containerClient(){ return serviceClient().getContainerClient(CONTAINER); }

function ctForBlob(name){
  if(/\.ogg$/.test(name)) return 'audio/ogg';
  if(/\.mp4$/.test(name)) return 'audio/mp4';
  if(/\.wav$/.test(name)) return 'audio/wav';
  if(/\.mp3$/.test(name)) return 'audio/mpeg';
  return 'audio/webm';
}

// Turn a FAST-transcription result into a speaker-labeled transcript. The fast API's shape differs
// from batch: per-phrase objects live in `phrases` (each with `speaker` + `text`), and the whole
// thing is also in `combinedPhrases[].text`. Mirror the batch formatter's speaker-grouping.
function formatFast(result){
  const phrases = Array.isArray(result.phrases) ? result.phrases : [];
  const hasSpk = phrases.some(p => p.speaker !== undefined && p.speaker !== null);
  if(phrases.length && hasSpk){
    let out='', last=null;
    for(const p of phrases){
      const text = (p.text || '').trim();
      if(!text) continue;
      const label = 'Speaker ' + p.speaker;
      if(label !== last){ out += (out?'\n':'') + label + ': ' + text; last = label; }
      else { out += (out && !out.endsWith('\n') ? ' ' : '') + text; }
    }
    return out.trim();
  }
  const combined = Array.isArray(result.combinedPhrases) ? result.combinedPhrases : [];
  if(combined.length) return combined.map(c => c.text || '').join(' ').trim();
  if(phrases.length) return phrases.map(p => p.text || '').join(' ').trim();
  return '';
}

async function writeResult(jobId, payload){
  const data = Buffer.from(JSON.stringify(payload));
  await containerClient().getBlockBlobClient(resName(jobId)).uploadData(data, {
    blobHTTPHeaders: { blobContentType: 'application/json' }
  });
}

// Netlify background function: named *-background, returns 202 immediately, runs up to 900s.
export default async function handler(request){
  if(request.method !== 'POST') return new Response('', { status: 405 });

  let body; try{ body = await request.json(); }catch(e){ return new Response('', { status: 400 }); }
  if(!verifyToken(body && body.token).valid) return new Response('', { status: 401 });
  if(!SPEECH_KEY || !ACCOUNT || !STORAGE_KEY) return new Response('', { status: 500 });

  const blobName = body.blobName, jobId = body.jobId;
  if(!safeBlob(blobName) || !safeJobId(jobId)) return new Response('', { status: 400 });

  // Netlify sends the caller a 202 at INVOCATION for a *-background function; this handler then
  // runs to completion (up to 900s). So AWAIT the work here — do NOT return early or fire it as a
  // floating promise, or the invocation can end before the transcription finishes. Persist success
  // OR failure to the result blob so the client's poll always resolves instead of hanging.
  let audioBytes = 0;
  try {
    const audio = await containerClient().getBlockBlobClient(blobName).downloadToBuffer();
    audioBytes = audio.length;

    const form = new FormData();
    form.append('audio', new Blob([audio], { type: ctForBlob(blobName) }), blobName);
    form.append('definition', JSON.stringify({
      locales: ['en-US'],
      profanityFilterMode: 'None',
      diarization: { maxSpeakers: 2, enabled: true }
    }));

    const t0 = Date.now();
    const resp = await fetch(FAST_URL, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': SPEECH_KEY },  // let fetch set the multipart boundary
      body: form
    });
    const elapsedMs = Date.now() - t0;

    if(!resp.ok){
      let detail=''; try{ detail = (await resp.text()).slice(0,400); }catch(e){}
      await writeResult(jobId, { status:'failed', error:'Fast transcription failed ('+resp.status+').', detail, elapsedMs, audioBytes });
    } else {
      const result = await resp.json();
      const transcript = formatFast(result);
      await writeResult(jobId, {
        status: transcript ? 'done' : 'failed',
        error: transcript ? undefined : 'No speech recognized.',
        transcript,
        elapsedMs,
        audioBytes,
        durationMs: (typeof result.durationMilliseconds === 'number') ? result.durationMilliseconds : null
      });
    }
  } catch(e){
    try { await writeResult(jobId, { status:'failed', error:'Transcription error.', detail: String(e && e.message || e).slice(0,200), audioBytes }); } catch(_){}
  } finally {
    // Best-effort: delete the audio blob (the transcript is what we keep, briefly, in the result blob).
    try { await containerClient().deleteBlob(blobName); } catch(_){}
  }

  return new Response('', { status: 200 });
}
