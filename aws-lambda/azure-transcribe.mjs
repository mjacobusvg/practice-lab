// AWS Lambda (Function URL, BUFFERED) port of netlify/functions/azure-transcribe.mjs
// Paste this as the function's index.mjs. Runtime: Node.js 20.x or 24.x.
// Function URL: Auth type = NONE, Invoke mode = BUFFERED. Set Timeout ~30s.
// ENABLE CORS on the Function URL: Allow origin https://thinkbeyondpractice.com,
// Allow methods POST, Allow headers content-type, authorization. (This handler does
// not emit CORS itself — the console CORS config is the single source of truth.)
//
// Env vars required: SESSION_SIGNING_SECRET, AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_KEY,
// AZURE_SPEECH_KEY, AZURE_SPEECH_REGION (US region, e.g. eastus).
//
// DEPENDENCY-FREE: the Netlify original used @azure/storage-blob, which does not
// paste-deploy. This port implements the one primitive that actually needs the SDK —
// a blob Service SAS (HMAC-SHA256 over the account key) — directly, and does every
// blob operation over a SAS URL with plain fetch. No node_modules.
//
// Scope: the BATCH path only (upload-url / start / poll), which is the live production
// transcription path. The FAST path (fast-poll here + azure-transcribe-fast-background)
// is a dev spike gated behind localStorage 'tbp_fast_tx' and stays on Netlify; fast-poll
// is kept here so a flag flip still resolves, but the background writer is not ported.
//
// HIPAA: audio + transcript live only in the account's Azure Blob storage (Microsoft BAA)
// and are deleted after transcription. Keys never reach the browser. This function only
// relays SAS handles and the finished transcript; nothing PHI rests here or in Supabase.
//
// IMPORTANT: the Azure Storage account must keep a CORS rule allowing browser PUT
// (Allowed origins *, methods GET,PUT,OPTIONS,HEAD) — the Netlify version set this
// programmatically; it persists on the account, so this port relies on it already being
// present rather than re-setting it (that used the XML service-properties API + SDK).

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

// .trim() every env var: a stray leading/trailing space (easy to paste into the
// console by accident) in REGION or ACCOUNT builds a malformed URL that fetch rejects,
// and in a key silently breaks signing/auth. Trimming is safe for base64 keys and slugs.
const ACCOUNT = (process.env.AZURE_STORAGE_ACCOUNT || '').trim();
const STORAGE_KEY = (process.env.AZURE_STORAGE_KEY || '').trim();
const SPEECH_KEY = (process.env.AZURE_SPEECH_KEY || '').trim();
const REGION = (process.env.AZURE_SPEECH_REGION || 'eastus').trim();
const CONTAINER = 'ambient-audio';
const SPEECH_BASE = 'https://' + REGION + '.api.cognitive.microsoft.com/speechtotext/v3.2';
const SAS_VERSION = '2020-08-04';

function extFor(ct){
  ct=(ct||'').toLowerCase();
  if(ct.indexOf('ogg')!==-1) return 'ogg';
  if(ct.indexOf('mp4')!==-1||ct.indexOf('m4a')!==-1) return 'mp4';
  if(ct.indexOf('wav')!==-1) return 'wav';
  if(ct.indexOf('mpeg')!==-1||ct.indexOf('mp3')!==-1) return 'mp3';
  return 'webm';
}
function blobUrl(name){ return 'https://'+ACCOUNT+'.blob.core.windows.net/'+CONTAINER+'/'+name; }

// Truncate an ISO timestamp to whole seconds (YYYY-MM-DDTHH:mm:ssZ), matching what the
// Azure SDK signs. Milliseconds in the SAS would break the signature.
function truncISO(d){ return d.toISOString().replace(/\.\d+Z$/, 'Z'); }

// Generate a blob Service SAS (sv=2020-08-04). This reproduces exactly what
// @azure/storage-blob's generateBlobSASQueryParameters produced for a blob resource:
// HMAC-SHA256 over the canonical string-to-sign, keyed by the base64-decoded account key.
// `perms` must already be in Azure's canonical order (r,a,c,w,d,...) — callers pass 'cw',
// 'r', 'd', all canonical.
function sasFor(blobName, perms, minutes){
  const now = Date.now();
  const st = truncISO(new Date(now - 5*60*1000));
  const se = truncISO(new Date(now + minutes*60*1000));
  const canon = '/blob/' + ACCOUNT + '/' + CONTAINER + '/' + blobName;
  const stringToSign = [
    perms,        // signedPermissions
    st,           // signedStart
    se,           // signedExpiry
    canon,        // canonicalizedResource
    '',           // signedIdentifier
    '',           // signedIP
    'https',      // signedProtocol
    SAS_VERSION,  // signedVersion
    'b',          // signedResource (blob)
    '',           // signedSnapshotTime
    '',           // rscc  (Cache-Control)
    '',           // rscd  (Content-Disposition)
    '',           // rsce  (Content-Encoding)
    '',           // rscl  (Content-Language)
    ''            // rsct  (Content-Type)
  ].join('\n');
  const key = Buffer.from(STORAGE_KEY, 'base64');
  const sig = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('base64');
  const qs =
    'sv=' + encodeURIComponent(SAS_VERSION) +
    '&sr=b' +
    '&st=' + encodeURIComponent(st) +
    '&se=' + encodeURIComponent(se) +
    '&sp=' + encodeURIComponent(perms) +
    '&spr=https' +
    '&sig=' + encodeURIComponent(sig);
  return blobUrl(blobName) + '?' + qs;
}

const safeBlob  = (n) => typeof n==='string' && /^visit-[a-f0-9]{16,}\.(webm|ogg|mp4|wav|mp3)$/.test(n);
const safeJob   = (u) => typeof u==='string' && u.indexOf(SPEECH_BASE + '/transcriptions/') === 0;
const safeJobId = (n) => typeof n==='string' && /^[a-f0-9-]{16,64}$/i.test(n);
const resName   = (jobId) => 'fastres-' + jobId + '.json';

// Best-effort blob delete over a short-lived delete SAS.
async function deleteBlobSAS(name){
  if(!name) return;
  try {
    await fetch(sasFor(name, 'd', 10), { method:'DELETE', headers:{ 'x-ms-version': SAS_VERSION } });
  } catch(e){ /* fire-and-forget */ }
}

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

// Best-effort cleanup: delete the Azure transcription job and the audio blob.
function cleanup(jobUrl, blobName){
  try { if(safeJob(jobUrl)) fetch(jobUrl, { method:'DELETE', headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY } }).catch(()=>{}); } catch(e){}
  deleteBlobSAS(safeBlob(blobName) ? blobName : null);
}

// CORS handled by the Function URL config; no CORS headers emitted here.
function json(status, obj){ return { statusCode: status, headers: { 'Content-Type':'application/json' }, body: JSON.stringify(obj) }; }

export const handler = async (event) => {
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'POST';
  if(method === 'OPTIONS') return { statusCode: 200, body: '' };
  if(method !== 'POST') return json(405, { error:'Method Not Allowed' });

  let raw = event.body || '';
  if(event.isBase64Encoded){ try{ raw = Buffer.from(raw,'base64').toString('utf8'); }catch(e){} }
  let body; try{ body = JSON.parse(raw); }catch(e){ return json(400, { error:'Bad request.' }); }

  if(!verifyToken(body && body.token).valid) return json(401, { error:'Unauthorized.' });
  if(!SPEECH_KEY || !ACCOUNT || !STORAGE_KEY) return json(500, { error:'Transcription is not fully configured yet (Azure Speech + Storage keys).' });

  const action = body.action;
  try {
    // 1) Mint a write SAS; the browser uploads the recording straight to blob storage.
    if(action==='upload-url'){
      const name = 'visit-' + crypto.randomBytes(12).toString('hex') + '.' + extFor(body.contentType);
      // Container is assumed to exist (created long ago by the Netlify path); account CORS
      // rule for browser PUT is assumed present (persists on the account).
      return json(200, { blobName: name, uploadUrl: sasFor(name, 'cw', 30), cors: 'account-managed' });
    }

    // 2) Submit the batch job over a read SAS to the uploaded blob.
    if(action==='start'){
      if(!safeBlob(body.blobName)) return json(400, { error:'Bad reference.' });
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
      if(!resp.ok){ let d=''; try{ d=(await resp.text()).slice(0,300); }catch(e){} return json(502, { error:'Could not start transcription ('+resp.status+').', detail:d }); }
      const j = await resp.json();
      return json(200, { jobUrl: j.self, blobName: body.blobName });
    }

    // 3) Poll the job; when done, return the transcript and clean up.
    if(action==='poll'){
      if(!safeJob(body.jobUrl)) return json(400, { error:'Bad reference.' });
      const st = await fetch(body.jobUrl, { headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY } });
      if(!st.ok) return json(502, { error:'Could not check transcription.' });
      const jobObj = await st.json();
      const status = jobObj.status;
      if(status==='Failed'){
        cleanup(body.jobUrl, body.blobName);
        return json(200, { status:'failed', error: (jobObj.properties && jobObj.properties.error && jobObj.properties.error.message) || 'Transcription failed.' });
      }
      if(status!=='Succeeded') return json(200, { status:'running' });

      const fr = await fetch(body.jobUrl + '/files', { headers:{ 'Ocp-Apim-Subscription-Key':SPEECH_KEY } });
      if(!fr.ok) return json(200, { status:'running' });
      const files = await fr.json();
      const file = (files.values||[]).find(f => f.kind==='Transcription');
      if(!file || !file.links || !file.links.contentUrl){ cleanup(body.jobUrl, body.blobName); return json(200, { status:'failed', error:'No transcript produced.' }); }
      const cr = await fetch(file.links.contentUrl);
      const result = await cr.json();
      const transcript = formatBatch(result);
      cleanup(body.jobUrl, body.blobName);
      return json(200, { status:'done', transcript });
    }

    // 4) FAST path poll (dev spike; kept so a flag flip resolves). Reads the result blob the
    //    background writer would have produced, over a read SAS, then deletes it. NOTE: the
    //    background writer is not ported to Lambda, so under this endpoint fast-poll returns
    //    'running' until the (Netlify) background writes the blob.
    if(action==='fast-poll'){
      if(!safeJobId(body.jobId)) return json(400, { error:'Bad reference.' });
      const rn = resName(body.jobId);
      let res;
      try {
        const g = await fetch(sasFor(rn, 'r', 10), { headers:{ 'x-ms-version': SAS_VERSION } });
        if(g.status===404) return json(200, { status:'running' });   // not written yet
        if(!g.ok) return json(200, { status:'running' });
        const txt = await g.text();
        try { res = JSON.parse(txt); } catch(e){ res = null; }
      } catch(e){ return json(200, { status:'running' }); }
      deleteBlobSAS(rn);   // read-once: delete so the PHI transcript never lingers
      if(!res) return json(200, { status:'failed', error:'Result unreadable.' });
      return json(200, res);
    }

    return json(400, { error:'Unknown action.' });
  } catch(e){
    return json(500, { error:'Transcription error.', detail: String(e && e.message || e).slice(0,200) });
  }
};
