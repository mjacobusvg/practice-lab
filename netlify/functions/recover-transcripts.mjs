// netlify/functions/recover-transcripts.mjs
//
// ⚠️ TEMPORARY, ADMIN-ONLY RECOVERY TOOL — DELETE THIS FILE ONCE RECOVERY IS DONE. ⚠️
//
// When a visit's transcript is lost client-side (e.g. the draft-sync bug), the finished
// Azure batch-transcription JOB often still lives on Azure — the post-transcription cleanup
// in azure-transcribe.mjs is best-effort/fire-and-forget and fails silently. This endpoint
// lists recent transcription jobs and returns their transcripts so the owner can recover the
// lost visit by matching on the job's creation time.
//
// It returns PHI (raw transcripts) and the jobs are NOT tagged per user, so access is gated
// to the owner's email(s) only. Remove this function after use.

import crypto from 'crypto';

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

// Owner emails allowed to run recovery. A session's email comes from the signed token.
const ADMIN = ['michael@thinkbeyondpsych.com', 'michael.vangelder@gmail.com'];

// Turn a batch-transcription result JSON into a speaker-labeled transcript (copied from azure-transcribe.mjs).
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

  const hours = Math.min(Math.max(parseInt(body.hours || 6, 10) || 6, 1), 48);
  const cutoff = Date.now() - hours*3600*1000;
  try {
    const lr = await fetch(SPEECH_BASE + '/transcriptions?top=100', { headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY } });
    if(!lr.ok){ let d=''; try{ d=(await lr.text()).slice(0,300); }catch(e){} return json({ error:'List failed ('+lr.status+').', detail:d }, 502); }
    const list = await lr.json();
    const jobs = (list.values || [])
      .filter(j => (Date.parse(j.createdDateTime||'')||0) >= cutoff)
      .sort((a,b) => (Date.parse(b.createdDateTime||'')||0) - (Date.parse(a.createdDateTime||'')||0));

    const out = [];
    for(const j of jobs.slice(0, 20)){
      const rec = { created: j.createdDateTime, status: j.status, displayName: j.displayName, self: j.self };
      if(j.status === 'Succeeded'){
        try {
          const fr = await fetch(j.self + '/files', { headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY } });
          if(fr.ok){
            const files = await fr.json();
            const file = (files.values||[]).find(f => f.kind === 'Transcription');
            if(file && file.links && file.links.contentUrl){
              const cr = await fetch(file.links.contentUrl);
              const result = await cr.json();
              rec.transcript = formatBatch(result);
            }
          }
        } catch(e){ rec.transcriptError = String(e && e.message || e).slice(0,120); }
      }
      out.push(rec);
    }
    return json({ count: out.length, windowHours: hours, jobs: out });
  } catch(e){
    return json({ error:'Recovery error.', detail: String(e && e.message || e).slice(0,200) }, 500);
  }
}
