// AWS Lambda (Function URL, BUFFERED) — non-stream clinical proxy on AWS BEDROCK.
// BAA-correct version of clinical-proxy.mjs: Claude is invoked through Amazon Bedrock
// (HIPAA-eligible under your AWS BAA) instead of api.anthropic.com. Paste into the
// tbp-clinical-proxy function's index.mjs, replacing the Anthropic version. Same
// Function URL, so no front-end change. Handles Letters, Monitoring, Termination.
//
// One-time AWS setup (same as the streaming function): the execution role needs
// bedrock:InvokeModel + bedrock:InvokeModelWithResponseStream, and env vars
// BEDROCK_MODEL_SONNET / BEDROCK_MODEL_HAIKU set to the US inference-profile IDs.
//
// ALSO HANDLES OCR (action:'ocr'). Scanned records -- faxes above all -- arrive as page
// images with no text layer, so nothing can be extracted in the browser. The Scribe
// renders each page to an image locally and posts it here one page at a time; this
// function runs Amazon Textract over it and returns the text it actually read.
// Textract is HIPAA-eligible under the same AWS BAA that already covers Bedrock, so
// this adds no new vendor and no new agreement. Deliberately Textract and NOT a vision
// model: OCR must fail loudly rather than invent a plausible dose. Textract returns
// garbage or nothing when a page is unreadable; it does not fabricate.
// Nothing is stored -- no S3, no async job, bytes in and text out.
//
// One-time IAM: add textract:DetectDocumentText to this function's execution role.
//
// Env vars: SESSION_SIGNING_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY,
//           BEDROCK_MODEL_SONNET, BEDROCK_MODEL_HAIKU, (optional) BEDROCK_REGION.
//
// Returns the same { content:[{type:'text',text}] } shape callers already parse.
// Logs usage-metadata only; never message content.

import crypto from 'crypto';
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';

const SECRET = process.env.SESSION_SIGNING_SECRET || '';

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signPayload(payloadJson) {
  return b64url(crypto.createHmac('sha256', SECRET).update(payloadJson).digest());
}
function verifyToken(token) {
  if (!SECRET) return { valid: false, reason: 'server_misconfigured' };
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return { valid: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;
  let payloadJson;
  try { payloadJson = b64urlDecode(payloadB64); } catch (e) { return { valid: false, reason: 'malformed' }; }
  const expectedSig = signPayload(payloadJson);
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'bad_signature' };
  let claims;
  try { claims = JSON.parse(payloadJson); } catch (e) { return { valid: false, reason: 'malformed' }; }
  if (!claims.exp || Date.now() > claims.exp) return { valid: false, reason: 'expired' };
  return { valid: true, claims };
}

const MODEL_COST_PER_MTOK = {
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
  'claude-sonnet-4-6':         { in: 3.0, out: 15.0 },
  'claude-sonnet-4-5':         { in: 3.0, out: 15.0 }
};
// Bedrock bills the three kinds of input token at three different rates. A cache WRITE
// depends on the TTL that was requested: 1.25x the base input rate for the default five
// minute window, 2x for the one hour window. A cache READ is 0.1x either way.
//
// This used to hardcode the 2x write multiplier while sending no ttl at all, so every
// cache write was estimated 60% above what it actually cost. It now takes the TTL that
// was actually requested for the call.
const CACHE_WRITE_MULTIPLIER = { '5m': 1.25, '1h': 2.0 };
function estCostUsd(model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, cacheTtl) {
  const price = MODEL_COST_PER_MTOK[model];
  if (!price) return null;
  const inTok = Number(inputTokens) || 0;
  const outTok = Number(outputTokens) || 0;
  const ccTok = Number(cacheCreationTokens) || 0;
  const crTok = Number(cacheReadTokens) || 0;
  const writeMult = CACHE_WRITE_MULTIPLIER[cacheTtl === '1h' ? '1h' : '5m'];
  const cost = (inTok * price.in + ccTok * price.in * writeMult + crTok * price.in * 0.1 + outTok * price.out) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}
const REFERER_TOOL_MAP = [
  ['pm-ai-scribe', 'AI Scribe'],
  ['pm-letter-generator', 'Letter Generator'],
  ['pm-chart-coder', 'Chart Coder'],
  ['pm-clinical-note-builder', 'Clinical Note Builder'],
  ['pm-interaction-checker', 'Interaction Checker'],
  ['pm-termination-workflow', 'Termination Workflow'],
  ['pm-monitoring-protocol', 'Monitoring Protocol'],
  ['note-builder-trial', 'Note Builder (Trial)'],
  ['chart-coder-trial', 'Chart Coder (Trial)']
];
function toolFromReferer(referer) {
  if (!referer || typeof referer !== 'string') return null;
  let path = referer;
  try { path = new URL(referer).pathname; } catch (e) {}
  path = path.toLowerCase();
  for (let i = 0; i < REFERER_TOOL_MAP.length; i++) {
    if (path.indexOf(REFERER_TOOL_MAP[i][0]) !== -1) return REFERER_TOOL_MAP[i][1];
  }
  return null;
}
async function logUsage(row) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) return;
    const email = row.email ? String(row.email).toLowerCase().trim() : null;
    const model = row.model || null;
    const inputTokens = (row.inputTokens != null) ? Number(row.inputTokens) : null;
    const outputTokens = (row.outputTokens != null) ? Number(row.outputTokens) : null;
    const cacheCreation = (row.cacheCreationTokens != null) ? Number(row.cacheCreationTokens) : 0;
    const cacheRead = (row.cacheReadTokens != null) ? Number(row.cacheReadTokens) : 0;
    const cost = model ? estCostUsd(model, inputTokens, outputTokens, cacheCreation, cacheRead, row.cacheTtl) : null;
    // input_tokens stays the TOTAL (non-cached + write + read), which is what every existing
    // dashboard reads it as. The breakdown now goes in its own columns so cache behaviour is
    // queryable instead of being inferred from the bill.
    const totalInput = (inputTokens != null) ? inputTokens + cacheCreation + cacheRead : null;
    await fetch(SUPABASE_URL + '/rest/v1/tool_usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        tool: row.tool || 'Clinical Tool', mode: row.mode || null, event: row.event || 'interaction',
        created_at: new Date().toISOString(), account_email: email, tier: row.tier || null, model: model,
        input_tokens: totalInput, output_tokens: outputTokens, est_cost_usd: cost,
        cache_creation_tokens: cacheCreation, cache_read_tokens: cacheRead,
        cache_ttl: row.cacheTtl || null, usage_source: row.usageSource || null,
        // Groups this call with the rest of one patient workspace's rows. Random, client-
        // generated, no patient identity and no content — see netlify/functions/scribe-event.js.
        session_id: row.sessionId || null
      })
    });
  } catch (e) { console.log('tool_usage log error:', e && e.message); }
}

const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
const BEDROCK_ID = {
  'claude-sonnet-4-6': process.env.BEDROCK_MODEL_SONNET || '',
  'claude-haiku-4-5-20251001': process.env.BEDROCK_MODEL_HAIKU || ''
};
const TRIAL_DAYS = 7;

async function hasActiveTrial(cmid, email) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  const keyId = (cmid != null && String(cmid).trim()) ? String(cmid).trim() : (email || '').toString().trim().toLowerCase();
  if (!keyId) return false;
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/note_builder_trials?community_member_id=eq.' + encodeURIComponent(keyId) + '&select=started_at,trial_version',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
    if (!res.ok) return false;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return false;
    const msInDay = 24 * 60 * 60 * 1000;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].trial_version || '').toLowerCase().indexOf('ai-scribe') === 0) continue;
      const started = new Date(rows[i].started_at).getTime();
      if (!isNaN(started) && (Date.now() - started) / msInDay < TRIAL_DAYS) return true;
    }
    return false;
  } catch (e) { return false; }
}
async function hasActiveEntitlement(email, feature) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  const em = (email || '').toString().trim().toLowerCase();
  if (!em || !feature) return false;
  try {
    const nowIso = new Date().toISOString();
    const res = await fetch(SUPABASE_URL + '/rest/v1/feature_entitlements?email=eq.' + encodeURIComponent(em) +
      '&feature=eq.' + encodeURIComponent(feature) + '&expires_at=gt.' + encodeURIComponent(nowIso) + '&select=id&limit=1',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) { return false; }
}
const FEATURE_BY_TOOL = { 'Letter Generator': 'letter_generator' };

// ── Prompt caching ───────────────────────────────────────────────────────────────────
// Mark a large system prompt as an ephemeral cache breakpoint so calls reusing the same
// prompt inside the cache window are billed at ~10% on the cached tokens.
//
// The minimum size for a checkpoint is per model and differs FOURFOLD, which is the thing
// this code previously got wrong. Below the minimum the checkpoint is silently ignored and
// nothing is cached. The old threshold was 4096 CHARACTERS, roughly 1,170 tokens: about
// right for Sonnet, and nowhere near Haiku's 4,096 token floor. So every Haiku checkpoint
// we have ever sent was discarded, which is why Haiku bills at essentially the uncached
// estimate while Sonnet bills well under it.
const CACHE_MIN_TOKENS = {
  'claude-sonnet-4-6':         1024,
  'claude-sonnet-4-5':         1024,
  'claude-haiku-4-5-20251001': 4096
};
// Chars per token for English clinical prose. Deliberately low, i.e. permissive: a
// checkpoint sent below the minimum is ignored and costs nothing, whereas one we decline to
// send is savings left on the table. The asymmetry favours marking early.
const CHARS_PER_TOKEN = 3.5;

// AWS confirmed (support case 178934455100974) that ttl '1h' is supported on both models
// via the cache_control object, and that omitting it gives the default five minute window.
//
// The Netlify predecessor (clinical-proxy-stream.mjs) used '1h', chosen from real traffic:
// calls on this path cluster about 26 minutes apart and roughly 75% of reuse falls inside an
// hour. The Bedrock port silently dropped the ttl while keeping the 2x write multiplier in
// the cost formula, so we have been paying for five minute caching and estimating one hour
// caching. This restores the ttl rather than lowering the multiplier, because the traffic
// still says the hour is the cheaper option:
//
//   two calls 26 minutes apart, 5m ttl -> write 1.25x + write 1.25x = 2.50x
//   two calls 26 minutes apart, 1h ttl -> write 2.00x + read  0.10x = 2.10x
//
// and the gap widens with every further call in the session. A five minute window would only
// win for a tool whose prompt is written once and never re-read, and this proxy serves no
// such tool: every caller is a clinician working through one patient's chart.
const CACHE_TTL_DEFAULT = '1h';
const CACHE_5M_TOOLS = [];   // opt a tool out here if its calls stop clustering
function cacheTtlFor(tool) {
  return CACHE_5M_TOOLS.indexOf(tool) !== -1 ? '5m' : CACHE_TTL_DEFAULT;
}

function cacheableSystem(sys, model, ttl) {
  const text = (typeof sys === 'string') ? sys : '';
  if (!text) return undefined;
  const minTokens = CACHE_MIN_TOKENS[model];
  if (!minTokens) return text;
  if (text.length < minTokens * CHARS_PER_TOKEN) return text;
  const cacheControl = { type: 'ephemeral' };
  if (ttl === '1h') cacheControl.ttl = '1h';
  return [{ type: 'text', text, cache_control: cacheControl }];
}

// ── Reading the cache counters ───────────────────────────────────────────────────────
// Per AWS support case 178934455100974: the cache fields are NOT final on message_start,
// where they read as absent or zero. That is why metering saw no cache activity at all
// while the bill plainly showed caching was working. The finalized counts arrive later, in
// two places, and the second is authoritative:
//
//   message_delta.usage                the Anthropic-shaped final usage
//   amazon-bedrock-invocationMetrics   appended by Bedrock to the final chunk
//
// Cached input is counted SEPARATELY from input_tokens, so the real total is
// input_tokens + cache_read + cache_write and each part bills at its own rate.
function newUsageAcc() {
  return { inputTokens: null, outputTokens: null, cacheCreationTokens: null,
           cacheReadTokens: null, usageSource: null, authoritative: false };
}
function readUsage(evt, acc) {
  if (!evt || typeof evt !== 'object') return;

  // Bedrock's own metrics, appended to the final chunk. Authoritative: once seen, the
  // Anthropic-shaped numbers no longer overwrite the cache counters.
  const m = evt['amazon-bedrock-invocationMetrics'];
  if (m && typeof m === 'object') {
    if (typeof m.inputTokenCount === 'number') acc.inputTokens = m.inputTokenCount;
    if (typeof m.outputTokenCount === 'number') acc.outputTokens = m.outputTokenCount;
    if (typeof m.cacheReadInputTokenCount === 'number') acc.cacheReadTokens = m.cacheReadInputTokenCount;
    if (typeof m.cacheWriteInputTokenCount === 'number') acc.cacheCreationTokens = m.cacheWriteInputTokenCount;
    acc.usageSource = 'bedrock-metrics';
    acc.authoritative = true;
    return;
  }

  // message_start seeds the counts so a stream that dies early still meters something;
  // message_delta carries the finalized Anthropic usage and supersedes it.
  let u = null, source = null;
  if (evt.type === 'message_start' && evt.message && evt.message.usage) { u = evt.message.usage; source = 'message_start'; }
  else if (evt.type === 'message_delta' && evt.usage) { u = evt.usage; source = 'message_delta'; }
  if (!u) return;

  if (typeof u.input_tokens === 'number') acc.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === 'number') acc.outputTokens = u.output_tokens;
  if (!acc.authoritative) {
    if (typeof u.cache_creation_input_tokens === 'number') acc.cacheCreationTokens = u.cache_creation_input_tokens;
    if (typeof u.cache_read_input_tokens === 'number') acc.cacheReadTokens = u.cache_read_input_tokens;
  }
  if (!acc.authoritative) acc.usageSource = source;
}

const bedrock = new BedrockRuntimeClient({ region: REGION });

// Invoke Claude on Bedrock and reassemble the streamed events into one text answer
// plus usage counts (Bedrock returns the same Anthropic event objects).
// Bedrock returns transient failures under several names, and losing one costs the clinician a
// whole assessment they must re-request. ONE retry after a short pause: enough for a blip, not
// enough to double-bill a genuine failure or leave the request hanging.
const BEDROCK_TRANSIENT = /^(ThrottlingException|ServiceUnavailableException|InternalServerException|ModelTimeoutException|ModelNotReadyException|TooManyRequestsException)$/;
function bedrockTransient(err) {
  if (!err) return false;
  if (BEDROCK_TRANSIENT.test(String(err.name || ''))) return true;
  const code = err.$metadata && err.$metadata.httpStatusCode;
  return code === 429 || code === 500 || code === 502 || code === 503 || code === 504;
}
async function callBedrock(modelId, payloadObj) {
  try {
    return await callBedrockOnce(modelId, payloadObj);
  } catch (err) {
    if (!bedrockTransient(err)) throw err;
    console.log('bedrock transient, retrying once:', err && err.name);
    await new Promise(function (r) { setTimeout(r, 900); });
    return await callBedrockOnce(modelId, payloadObj);
  }
}
async function callBedrockOnce(modelId, payloadObj) {
  const resp = await bedrock.send(new InvokeModelWithResponseStreamCommand({
    modelId: modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payloadObj)
  }));
  const decoder = new TextDecoder();
  let assembled = '', apiErr = null;
  const usage = newUsageAcc();
  for await (const ev of resp.body) {
    if (!ev.chunk || !ev.chunk.bytes) continue;
    const text = decoder.decode(ev.chunk.bytes);
    try {
      const evt = JSON.parse(text);
      if (evt.type === 'content_block_delta' && evt.delta && typeof evt.delta.text === 'string') {
        assembled += evt.delta.text;
      } else if (evt.type === 'error') {
        apiErr = evt.error ? (evt.error.message || JSON.stringify(evt.error)) : 'stream error';
      }
      // Offered unconditionally, including the final chunk carrying
      // amazon-bedrock-invocationMetrics, which is where the cache counts actually land.
      readUsage(evt, usage);
    } catch (e) { /* keep-alive, not JSON */ }
  }
  if (apiErr) throw new Error(apiErr);
  return {
    text: assembled,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens, cacheReadTokens: usage.cacheReadTokens,
    usageSource: usage.usageSource
  };
}

// CORS handled by the Function URL config; no CORS headers emitted here.
function json(status, obj) { return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }; }

export const handler = async (event) => {
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'POST';
  const headers = event.headers || {};
  const getH = (name) => headers[name] || headers[name.toLowerCase()] || '';

  if (method === 'OPTIONS') return { statusCode: 200, body: '' };
  if (method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let raw = event.body || '';
  if (event.isBase64Encoded) { try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) {} }
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json(400, { error: 'Invalid request body.' }); }

  const authHeader = getH('authorization') || '';
  const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) return json(401, { error: 'Invalid or expired session.' });
  if (session.claims.scope !== 'member') return json(403, { error: 'This tool requires the full Think Beyond Practice membership.' });

  const referer = getH('referer') || getH('referrer') || '';
  const qsTool = (event.queryStringParameters && event.queryStringParameters.tool) || '';
  if (session.claims.tier !== 'full') {
    const gateTool = body.tool || qsTool || toolFromReferer(referer) || '';
    const gateFeature = FEATURE_BY_TOOL[gateTool] || null;
    const trialOk = await hasActiveTrial(session.claims.cmid, session.claims.email);
    const entitledOk = (!trialOk && gateFeature) ? await hasActiveEntitlement(session.claims.email, gateFeature) : false;
    if (!trialOk && !entitledOk) return json(403, { error: 'This tool requires the full Think Beyond Practice membership.' });
  }

  // --- OCR a single rendered page (scanned records) -------------------------------
  // One page per request keeps every call inside the synchronous Textract limits and
  // inside the Function URL's 6 MB request cap, and lets the browser show real progress.
  if (body.action === 'ocr') {
    const b64 = typeof body.image === 'string' ? body.image.replace(/^data:[^,]*,/, '') : '';
    if (!b64) return json(400, { error: 'No page image supplied.' });
    let bytes;
    try { bytes = Buffer.from(b64, 'base64'); } catch (e) { return json(400, { error: 'Page image could not be decoded.' }); }
    if (!bytes.length) return json(400, { error: 'Page image was empty.' });
    if (bytes.length > 5 * 1024 * 1024) return json(413, { error: 'Page image is too large. Lower the render scale.' });

    let Textract;
    try {
      Textract = await import('@aws-sdk/client-textract');
    } catch (e) {
      return json(500, { error: 'Textract client unavailable in this runtime. Add @aws-sdk/client-textract to the function or a layer.' });
    }
    const tx = new Textract.TextractClient({ region: REGION });
    let out;
    try {
      out = await tx.send(new Textract.DetectDocumentTextCommand({ Document: { Bytes: bytes } }));
    } catch (err) {
      const m = String(err && err.message || err);
      const denied = /AccessDenied|not authorized/i.test(m);
      return json(denied ? 403 : 502, {
        error: denied
          ? 'This account is not permitted to run Textract yet. Add textract:DetectDocumentText to the function execution role.'
          : 'Could not read this page: ' + m.slice(0, 300)
      });
    }
    const lines = (out.Blocks || [])
      .filter(function (b) { return b.BlockType === 'LINE' && typeof b.Text === 'string'; })
      .map(function (b) { return b.Text; });
    await logUsage({
      tool: body.tool || toolFromReferer(referer) || 'AI Scribe', mode: 'ocr_page', event: 'interaction',
      email: session.claims.email, tier: session.claims.tier, model: 'textract',
      cacheTtl: null, usageSource: 'textract',
      inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0
    });
    return json(200, { text: lines.join('\n') });
  }

  const logicalModel = (ALLOWED_MODELS.indexOf(body.model) !== -1 ? body.model : DEFAULT_MODEL);
  const modelId = BEDROCK_ID[logicalModel];
  if (!modelId) return json(500, { error: 'Bedrock model id not configured for ' + logicalModel + '. Set BEDROCK_MODEL_SONNET / BEDROCK_MODEL_HAIKU env vars.' });

  const payloadObj = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: body.max_tokens || 1000,
    messages: body.messages || []
  };
  // The tool has to be resolved BEFORE the payload is built, because it decides the cache
  // TTL, which goes inside cache_control on the system block.
  const usageTool = body.tool || qsTool || toolFromReferer(referer) || 'Clinical Tool';
  const cacheTtl = cacheTtlFor(usageTool);

  const sysBlock = cacheableSystem(body.system, logicalModel, cacheTtl);
  if (sysBlock) payloadObj.system = sysBlock;
  if (body.tools && Array.isArray(body.tools)) payloadObj.tools = body.tools;

  const usageMode = body.mode || null;
  // Hex-only and length-bounded: an analytics grouping key, never a channel for content.
  const usageSession = (typeof body.session_id === 'string' && /^[a-f0-9]{8,40}$/.test(body.session_id)) ? body.session_id : null;

  try {
    const result = await callBedrock(modelId, payloadObj);
    await logUsage({
      tool: usageTool, mode: usageMode, event: 'interaction', sessionId: usageSession,
      email: session.claims.email, tier: session.claims.tier, model: logicalModel,
      cacheTtl: cacheTtl, usageSource: result.usageSource,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      cacheCreationTokens: result.cacheCreationTokens, cacheReadTokens: result.cacheReadTokens
    });
    return json(200, { content: [{ type: 'text', text: result.text }] });
  } catch (err) {
    // A bare "Bedrock is unable to process your request" is undiagnosable: it names no exception
    // class, no HTTP status and no request id, so neither the clinician nor AWS support can act
    // on it. Surface what the SDK actually knows. None of this is PHI.
    const meta = (err && err.$metadata) || {};
    const bits = [String((err && err.message) || err).slice(0, 300)];
    if (err && err.name) bits.push('[' + err.name + ']');
    if (meta.httpStatusCode) bits.push('HTTP ' + meta.httpStatusCode);
    if (meta.requestId) bits.push('reqId ' + meta.requestId);
    console.log('bedrock invoke failed:', err && err.name, meta.httpStatusCode, meta.requestId, String((err && err.message) || err).slice(0, 300));
    return json(502, { error: 'Bedrock invoke failed: ' + bits.join(' ') });
  }
};
