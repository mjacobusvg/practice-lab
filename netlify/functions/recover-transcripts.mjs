// netlify/functions/recover-transcripts.mjs
//
// ⚠️ TEMPORARY, ADMIN-ONLY RECOVERY TOOL — DELETE THIS FILE ONCE RECOVERY IS DONE. ⚠️
//
// When a visit's transcript is lost client-side, the finished Azure batch-transcription JOB
// and/or the uploaded AUDIO BLOB may still live on Azure — the post-transcription cleanup in
// azure-transcribe.mjs is best-effort/fire-and-forget (two independent DELETEs) and fails
// silently. This endpoint checks BOTH:
//   action 'list' (default): recent transcription jobs (+ their transcripts) AND the audio blobs
//                            still in the ambient-audio container. A raw count is included so an
//                            empty window can be distinguished from a query miss.
//   action 'retranscribe':   start a NEW transcription job over an existing audio blob (recovers
//                            a visit whose job was deleted but whose audio survived). Returns jobUrl.
//   action 'poll':           poll a jobUrl started by 'retranscribe' and return the transcript.
//
// Returns PHI. Jobs/blobs are NOT tagged per user, so access is gated to the owner's email(s).
// Remove this function after use.

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

const SPEECH_KEY = process.env.AZURE_SPEECH_KEY || '';
const REGION = process.env.AZURE_SPEECH_REGION || 'eastus';
const SPEECH_BASE = 'https://' + REGION + '.api.cognitive.microsoft.com/speechtotext/v3.2';
const ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT || '';
const STORAGE_KEY = process.env.AZURE_STORAGE_KEY || '';
const CONTAINER = 'ambient-audio';

const ADMIN = ['michael@thinkbeyondpsych.com', 'michael.vangelder@gmail.com'];

function cred(){ return new StorageSharedKeyCredential(ACCOUNT, STORAGE_KEY); }
function containerClient(){
  return BlobServiceClient.fromConnectionString(
    'DefaultEndpointsProtocol=https;AccountName='+ACCOUNT+';AccountKey='+STORAGE_KEY+';EndpointSuffix=core.windows.net'
  ).getContainerClient(CONTAINER);
}
function blobReadSas(name, minutes){
  const now = Date.now();
  const sas = generateBlobSASQueryParameters({
    containerName: CONTAINER, blobName: name,
    permissions: BlobSASPermissions.parse('r'),
    startsOn: new Date(now - 5*60*1000), expiresOn: new Date(now + minutes*60*1000), protocol: 'https'
  }, cred()).toString();
  return 'https://'+ACCOUNT+'.blob.core.windows.net/'+CONTAINER+'/'+name + '?' + sas;
}
const safeBlob = (n) => typeof n==='string' && /^visit-[a-f0-9]{16,}\.(webm|ogg|mp4|wav|mp3)$/.test(n);
const safeJob  = (u) => typeof u==='string' && u.indexOf(SPEECH_BASE + '/transcriptions/') === 0;

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
  const v = verifyToken(body && body.token);
  if(!v.valid) return json({ error:'Unauthorized.' }, 401);
  const email = ((v.claims && v.claims.email) || '').toLowerCase();
  if(ADMIN.indexOf(email) === -1) return json({ error:'Forbidden — recovery is owner-only.', youAre: email }, 403);
  if(!SPEECH_KEY) return json({ error:'Azure Speech key not configured.' }, 500);

  const action = body.action || 'list';
  try {
    // ── Re-transcribe an audio blob that survived (its job was deleted) ──
    if(action==='retranscribe'){
      if(!ACCOUNT || !STORAGE_KEY) return json({ error:'Storage not configured.' }, 500);
      if(!safeBlob(body.blobName)) return json({ error:'Bad blob name.' }, 400);
      const readUrl = blobReadSas(body.blobName, 180);
      const resp = await fetch(SPEECH_BASE + '/transcriptions', {
        method:'POST', headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY, 'Content-Type':'application/json' },
        body: JSON.stringify({ contentUrls:[readUrl], locale:'en-US', displayName:'ambient-recovery',
          properties:{ diarizationEnabled:true, diarization:{ speakers:{ minCount:1, maxCount:2 } }, punctuationMode:'DictatedAndAutomatic', profanityFilterMode:'None' } })
      });
      if(!resp.ok){ let d=''; try{ d=(await resp.text()).slice(0,300); }catch(e){} return json({ error:'Could not start ('+resp.status+').', detail:d }, 502); }
      const j = await resp.json();
      return json({ started:true, jobUrl:j.self });
    }

    // ── Poll a recovery job started above ──
    if(action==='poll'){
      if(!safeJob(body.jobUrl)) return json({ error:'Bad job url.' }, 400);
      const st = await fetch(body.jobUrl, { headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY } });
      if(!st.ok) return json({ status:'error', detail:'poll '+st.status });
      const jobj = await st.json();
      if(jobj.status==='Failed') return json({ status:'failed', error:(jobj.properties&&jobj.properties.error&&jobj.properties.error.message)||'failed' });
      if(jobj.status!=='Succeeded') return json({ status:'running' });
      const fr = await fetch(body.jobUrl + '/files', { headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY } });
      if(!fr.ok) return json({ status:'running' });
      const files = await fr.json();
      const file = (files.values||[]).find(f => f.kind==='Transcription');
      if(!file || !file.links || !file.links.contentUrl) return json({ status:'failed', error:'no transcript file' });
      const cr = await fetch(file.links.contentUrl);
      const result = await cr.json();
      return json({ status:'done', transcript: formatBatch(result) });
    }

    // ── Default: list jobs (+transcripts) and surviving audio blobs ──
    const hours = Math.min(Math.max(parseInt(body.hours || 12, 10) || 12, 1), 72);
    const cutoff = Date.now() - hours*3600*1000;

    // Transcription jobs
    let jobsListedRaw = 0, hasMorePages = false, jobs = [];
    try {
      const lr = await fetch(SPEECH_BASE + '/transcriptions?top=100', { headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY } });
      if(lr.ok){
        const list = await lr.json();
        const vals = list.values || [];
        jobsListedRaw = vals.length;
        hasMorePages = !!list['@nextLink'];
        const recent = vals.filter(j => (Date.parse(j.createdDateTime||'')||0) >= cutoff)
                           .sort((a,b) => (Date.parse(b.createdDateTime||'')||0) - (Date.parse(a.createdDateTime||'')||0));
        for(const j of recent.slice(0,20)){
          const rec = { created:j.createdDateTime, status:j.status, displayName:j.displayName, self:j.self };
          if(j.status==='Succeeded'){
            try {
              const fr = await fetch(j.self + '/files', { headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY } });
              if(fr.ok){ const files=await fr.json(); const file=(files.values||[]).find(f=>f.kind==='Transcription');
                if(file&&file.links&&file.links.contentUrl){ const cr=await fetch(file.links.contentUrl); rec.transcript=formatBatch(await cr.json()); } }
            } catch(e){ rec.transcriptError = String(e&&e.message||e).slice(0,120); }
          }
          jobs.push(rec);
        }
      } else { jobs = []; jobsListedRaw = -1; }
    } catch(e){ jobsListedRaw = -1; }

    // Surviving audio blobs (the OTHER copy — its job may have been deleted while it lingered)
    let blobs = [], blobsListedRaw = 0, storageNote = null;
    if(ACCOUNT && STORAGE_KEY){
      try {
        const cc = containerClient();
        for await (const b of cc.listBlobsFlat()){
          blobsListedRaw++;
          const created = b.properties && b.properties.createdOn ? b.properties.createdOn.getTime() : 0;
          blobs.push({ name:b.name, createdOn: b.properties && b.properties.createdOn ? b.properties.createdOn.toISOString() : null, bytes: b.properties && b.properties.contentLength || 0, recent: created >= cutoff });
          if(blobs.length >= 50) break;
        }
        blobs.sort((a,b)=> (Date.parse(b.createdOn||'')||0) - (Date.parse(a.createdOn||'')||0));
      } catch(e){ storageNote = 'blob list failed: ' + String(e&&e.message||e).slice(0,140); }
    } else { storageNote = 'storage env not configured'; }

    return json({
      windowHours: hours,
      jobsListedRaw, hasMorePages, jobCountInWindow: jobs.length, jobs,
      blobsListedRaw, blobCount: blobs.length, blobs,
      storageNote,
      hint: 'If a visit-*.webm/wav/mp4 blob matches the lost visit time, call again with {action:"retranscribe", blobName:"<name>"} to get a jobUrl, then {action:"poll", jobUrl:"<jobUrl>"} until status=done.'
    });
  } catch(e){
    return json({ error:'Recovery error.', detail: String(e && e.message || e).slice(0,200) }, 500);
  }
}
