//.netlify/functions/azure-transcribe.mjs
// Ambient transcription via Azure AI Speech BATCH transcription — no length limit.
//
// Flow (three actions, all short calls; the big audio never passes through here):
//   1) upload-url : mint a short-lived write SAS; the browser PUTs the recording
//                   DIRECTLY to Azure Blob storage (so any visit length works).
//   2) start      : submit an Azure batch transcription job over a read SAS to that
//                   blob, with diarization (speaker separation).
//   3) poll       : check the job; when done, return the speaker-labeled transcript
//                   and delete the blob + job. The client polls every few seconds.
//
// HIPAA: audio lives only in the account's Azure Blob storage (covered by the
// Microsoft BAA) and is deleted after transcription. AZURE_SPEECH_KEY and the
// storage key never reach the browser. Auth requires a valid signed member session.

import crypto from 'crypto';
import { StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions, BlobServiceClient } from '@azure/storage-blob';

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
const SPEECH_BASE = 'https://' + REGION + '.api.cognitive.microsoft.com/speechtotext/v3.2';

function extFor(ct){
  ct=(ct||'').toLowerCase();
  if(ct.indexOf('ogg')!==-1) return 'ogg';
  if(ct.indexOf('mp4')!==-1||ct.indexOf('m4a')!==-1) return 'mp4';
  if(ct.indexOf('wav')!==-1) return 'wav';
  if(ct.indexOf('mpeg')!==-1||ct.indexOf('mp3')!==-1) return 'mp3';
  return 'webm';
}
function cred(){ return new StorageSharedKeyCredential(ACCOUNT, STORAGE_KEY); }
function serviceClient(){
  return BlobServiceClient.fromConnectionString(
    'DefaultEndpointsProtocol=https;AccountName='+ACCOUNT+';AccountKey='+STORAGE_KEY+';EndpointSuffix=core.windows.net'
  );
}
function containerClient(){ return serviceClient().getContainerClient(CONTAINER); }

// The browser uploads the recording with a direct cross-origin PUT to
// <account>.blob.core.windows.net. Azure Blob storage blocks any browser
// request unless the ACCOUNT has CORS rules allowing it — without them the PUT
// fails in the browser as a raw "Failed to fetch" (the SAS itself is the real
// security boundary, so allowing all origins here is fine). We ensure the rule
// programmatically (account key has permission) so there is no manual portal
// step; guarded to run once per warm function instance, and best-effort so a
// permission hiccup never blocks an upload if CORS was set by hand.
let corsEnsured = false;
async function ensureCors(){
  if(corsEnsured) return 'cached';
  const svc = serviceClient();
  let props;
  try { props = await svc.getProperties(); }
  catch(e){ return 'get-failed: ' + String(e && e.message || e).slice(0,120); }
  const rules = Array.isArray(props.cors) ? props.cors : [];
  const ok = rules.some(r =>
    (r.allowedOrigins||'').indexOf('*') !== -1 &&
    (r.allowedMethods||'').toUpperCase().indexOf('PUT') !== -1);
  if(ok){ corsEnsured = true; return 'already-present'; }
  // Build a CLEAN properties object (never round-trip the raw getProperties
  // response — its _response/metadata fields can make setProperties throw, which
  // is what silently swallowed the fix before). Preserve the other subsections.
  const newProps = {
    cors: rules.concat([{
      allowedOrigins: '*',
      allowedMethods: 'GET,PUT,OPTIONS,HEAD',
      allowedHeaders: '*',
      exposedHeaders: '*',
      maxAgeInSeconds: 3600
    }]),
    blobAnalyticsLogging: props.blobAnalyticsLogging,
    hourMetrics: props.hourMetrics,
    minuteMetrics: props.minuteMetrics,
    deleteRetentionPolicy: props.deleteRetentionPolicy,
    staticWebsite: props.staticWebsite,
    defaultServiceVersion: props.defaultServiceVersion
  };
  try { await svc.setProperties(newProps); }
  catch(e){ return 'set-failed: ' + String(e && e.message || e).slice(0,120); }
  corsEnsured = true;
  return 'set-now';
}
function blobUrl(name){ return 'https://'+ACCOUNT+'.blob.core.windows.net/'+CONTAINER+'/'+name; }
function sasFor(name, perms, minutes){
  const now = Date.now();
  const sas = generateBlobSASQueryParameters({
    containerName: CONTAINER,
    blobName: name,
    permissions: BlobSASPermissions.parse(perms),
    startsOn: new Date(now - 5*60*1000),
    expiresOn: new Date(now + minutes*60*1000),
    protocol: 'https'
  }, cred()).toString();
  return blobUrl(name) + '?' + sas;
}
const safeBlob = (n) => typeof n==='string' && /^visit-[a-f0-9]{16,}\.(webm|ogg|mp4|wav|mp3)$/.test(n);
const safeJob  = (u) => typeof u==='string' && u.indexOf(SPEECH_BASE + '/transcriptions/') === 0;

// Turn a batch-transcription result JSON into a speaker-labeled transcript.
function formatBatch(result){
  const rp = Array.isArray(result.recognizedPhrases) ? result.recognizedPhrases : [];
  const hasSpk = rp.some(p => p.speaker !== undefined && p.speaker !== null);
  if(rp.length && hasSpk){
    let out='', last=null;
    for(const p of rp){
      const text = (p.nBest && p.nBest[0] && (p.nBest[0].display||p.nBest[0].lexical) || '').trim();
      if(!text) continue;
      const label = (p.speaker!==undefined && p.speaker!==null) ? ('Speaker '+p.speaker) : null;
      if(label && label!==last){ out += (out?'\n':'') + label + ': ' + text; last=label; }
      else { out += (out && !out.endsWith('\n') ? ' ' : '') + text; }
    }
    return out.trim();
  }
  const crp = Array.isArray(result.combinedRecognizedPhrases) ? result.combinedRecognizedPhrases : [];
  if(crp.length) return crp.map(c => c.display || c.lexical || '').join(' ').trim();
  if(rp.length) return rp.map(p => (p.nBest && p.nBest[0] && p.nBest[0].display) || '').join(' ').trim();
  return '';
}

export default async function handler(request){
  const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type, Authorization', 'Access-Control-Allow-Methods':'POST, OPTIONS' };
  const json = (o,s)=> new Response(JSON.stringify(o), { status:s||200, headers:{ ...cors, 'Content-Type':'application/json' } });
  if(request.method==='OPTIONS') return new Response('', { status:200, headers:cors });
  if(request.method!=='POST') return json({ error:'Method Not Allowed' }, 405);

  let body; try{ body=await request.json(); }catch(e){ return json({ error:'Bad request.' }, 400); }
  if(!verifyToken(body && body.token).valid) return json({ error:'Unauthorized.' }, 401);
  if(!SPEECH_KEY || !ACCOUNT || !STORAGE_KEY) return json({ error:'Transcription is not fully configured yet (Azure Speech + Storage keys).' }, 500);

  const action = body.action;
  try {
    // 1) Mint a write SAS; the browser uploads the recording straight to blob storage.
    if(action==='upload-url'){
      let corsStatus;
      try { corsStatus = await ensureCors(); } catch(e){ corsStatus = 'threw: ' + String(e && e.message || e).slice(0,120); }
      await containerClient().createIfNotExists();
      const name = 'visit-' + crypto.randomBytes(12).toString('hex') + '.' + extFor(body.contentType);
      return json({ blobName: name, uploadUrl: sasFor(name, 'cw', 30), cors: corsStatus });
    }

    // 2) Submit the batch job over a read SAS to the uploaded blob.
    if(action==='start'){
      if(!safeBlob(body.blobName)) return json({ error:'Bad reference.' }, 400);
      const readUrl = sasFor(body.blobName, 'r', 180);
      const resp = await fetch(SPEECH_BASE + '/transcriptions', {
        method:'POST', headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY, 'Content-Type':'application/json' },
        body: JSON.stringify({
          contentUrls: [ readUrl ],
          locale: 'en-US',
          displayName: 'ambient-visit',
          properties: {
            diarizationEnabled: true,
            diarization: { speakers: { minCount: 1, maxCount: 2 } },
            punctuationMode: 'DictatedAndAutomatic',
            profanityFilterMode: 'None'
          }
        })
      });
      if(!resp.ok){ let d=''; try{ d=(await resp.text()).slice(0,300); }catch(e){} return json({ error:'Could not start transcription ('+resp.status+').', detail:d }, 502); }
      const j = await resp.json();
      return json({ jobUrl: j.self, blobName: body.blobName });
    }

    // 3) Poll the job; when done, return the transcript and clean up.
    if(action==='poll'){
      if(!safeJob(body.jobUrl)) return json({ error:'Bad reference.' }, 400);
      const st = await fetch(body.jobUrl, { headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY } });
      if(!st.ok) return json({ error:'Could not check transcription.' }, 502);
      const job = await st.json();
      const status = job.status;
      if(status==='Failed'){
        cleanup(body.jobUrl, body.blobName);
        return json({ status:'failed', error: (job.properties && job.properties.error && job.properties.error.message) || 'Transcription failed.' });
      }
      if(status!=='Succeeded') return json({ status:'running' });

      // Fetch the files list → the Transcription result file → its content.
      const fr = await fetch(body.jobUrl + '/files', { headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY } });
      if(!fr.ok) return json({ status:'running' });
      const files = await fr.json();
      const file = (files.values||[]).find(f => f.kind==='Transcription');
      if(!file || !file.links || !file.links.contentUrl){ cleanup(body.jobUrl, body.blobName); return json({ status:'failed', error:'No transcript produced.' }); }
      const cr = await fetch(file.links.contentUrl);
      const result = await cr.json();
      const transcript = formatBatch(result);
      cleanup(body.jobUrl, body.blobName);
      return json({ status:'done', transcript });
    }

    return json({ error:'Unknown action.' }, 400);
  } catch(e){
    return json({ error:'Transcription error.', detail: String(e && e.message || e).slice(0,200) }, 500);
  }
}

// Best-effort cleanup: delete the transcription job and the audio blob. Fire-and-forget.
function cleanup(jobUrl, blobName){
  try { if(safeJob(jobUrl)) fetch(jobUrl, { method:'DELETE', headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY } }).catch(()=>{}); } catch(e){}
  try { if(safeBlob(blobName)) containerClient().deleteBlob(blobName).catch(()=>{}); } catch(e){}
}
