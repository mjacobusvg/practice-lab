// AWS Lambda (Function URL, RESPONSE_STREAM) — clinical streaming proxy on AWS BEDROCK.
// This is the BAA-correct version: Claude is invoked through Amazon Bedrock (a HIPAA-
// eligible service under your AWS BAA) instead of api.anthropic.com (which needs a
// separate Anthropic BAA you do not have). Paste this into the tbp-clinical-proxy-stream
// function's index.mjs, replacing the Anthropic version. The Function URL stays the same,
// so no front-end change is needed.
//
// ── One-time AWS setup for this to work (see the cutover notes) ────────────────
// 1. Bedrock console (in AWS_REGION) → Model access → enable the Claude models you use.
// 2. This function's execution role → attach an inline policy allowing
//    bedrock:InvokeModelWithResponseStream (and bedrock:InvokeModel) on the model ARNs
//    (or "*" to start).
// 3. Set env vars BEDROCK_MODEL_SONNET and BEDROCK_MODEL_HAIKU to the exact Bedrock
//    model IDs / inference-profile IDs from your Model catalog (Claude 4-class models
//    require the cross-region inference profile, e.g. the "us." prefixed id).
// 4. Invoke mode = RESPONSE_STREAM, Auth = NONE, CORS on the Function URL (unchanged).
//    ANTHROPIC_API_KEY is no longer used and can be removed once this is verified.
//
// Env vars: SESSION_SIGNING_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY,
//           BEDROCK_MODEL_SONNET, BEDROCK_MODEL_HAIKU, (optional) BEDROCK_REGION.
//
// Behavior is otherwise identical to the Anthropic version: same auth gate, streams the
// model's SSE straight through to the browser, logs usage-metadata only (token counts),
// never message content. Bedrock returns the SAME Anthropic event objects, so they are
// re-emitted as `data: {...}` SSE and the existing browser parser works unchanged.

import crypto from 'crypto';
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';

const SECRET = process.env.SESSION_SIGNING_SECRET || '';

// ── Signed-session verification (unchanged) ──
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

// ── Usage metering (keyed on the logical model name, not the Bedrock id) ──
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

// ── Model + Bedrock config ──
const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
// Map the logical model name the front end sends to the Bedrock model id / inference-profile
// id. Set these from your Bedrock Model catalog (Claude 4-class models require the "us."
// cross-region inference profile). No hardcoded default so a misconfig fails loudly rather
// than silently calling the wrong model.
const BEDROCK_ID = {
  'claude-sonnet-4-6': process.env.BEDROCK_MODEL_SONNET || '',
  'claude-haiku-4-5-20251001': process.env.BEDROCK_MODEL_HAIKU || ''
};

const TRIAL_DAYS = 7;
const SCRIBE_TRIAL_DAYS = 14;
const SCRIBE_TRIAL_VERSION = 'ai-scribe-v1';
const SCRIBE_FORUM_BETA_UNTIL = Date.parse('2026-08-17T07:00:00Z');

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
async function hasActiveScribeTrial(cmid, email) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  const keyId = (cmid != null && String(cmid).trim()) ? String(cmid).trim() : (email || '').toString().trim().toLowerCase();
  if (!keyId) return false;
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/note_builder_trials?community_member_id=eq.' + encodeURIComponent(keyId) + '&trial_version=eq.' + encodeURIComponent(SCRIBE_TRIAL_VERSION) + '&select=started_at',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
    if (!res.ok) return false;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return false;
    const msInDay = 24 * 60 * 60 * 1000;
    for (let i = 0; i < rows.length; i++) {
      const started = new Date(rows[i].started_at).getTime();
      if (!isNaN(started) && (Date.now() - started) / msInDay < SCRIBE_TRIAL_DAYS) return true;
    }
    return false;
  } catch (e) { return false; }
}

// CORS handled by the Function URL config; no CORS headers emitted here.
function respondJson(responseStream, status, obj) {
  const s = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' }
  });
  s.write(JSON.stringify(obj));
  s.end();
}

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

// Bedrock returns transient failures under several names, and losing one costs the clinician the
// whole step they just waited for. ONE retry after a short pause: enough for a blip, not enough to
// double-bill a genuine failure or leave the request hanging.
//
// This retry can ONLY wrap the initial InvokeModelWithResponseStream call, which is why it is a
// separate function from the streaming loop below. Once the first byte has been written to the
// response stream the browser is already parsing SSE, so there is nothing left to retry into — a
// mid-stream failure ends the stream and the front end keeps whatever it assembled.
const BEDROCK_TRANSIENT = /^(ThrottlingException|ServiceUnavailableException|InternalServerException|ModelTimeoutException|ModelNotReadyException|TooManyRequestsException)$/;
function bedrockTransient(err) {
  if (!err) return false;
  if (BEDROCK_TRANSIENT.test(String(err.name || ''))) return true;
  const code = err.$metadata && err.$metadata.httpStatusCode;
  return code === 429 || code === 500 || code === 502 || code === 503 || code === 504;
}
async function invokeStreamWithRetry(modelId, payloadObj) {
  const cmd = () => new InvokeModelWithResponseStreamCommand({
    modelId: modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payloadObj)
  });
  try {
    return await bedrock.send(cmd());
  } catch (err) {
    if (!bedrockTransient(err)) throw err;
    console.log('bedrock transient, retrying once:', err && err.name, err.$metadata && err.$metadata.httpStatusCode);
    await new Promise(function (r) { setTimeout(r, 900); });
    return await bedrock.send(cmd());
  }
}

export const handler = awslambda.streamifyResponse(async (event, responseStream, context) => {
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'POST';
  const headers = event.headers || {};
  const getH = (name) => headers[name] || headers[name.toLowerCase()] || '';

  if (method === 'OPTIONS') {
    const s = awslambda.HttpResponseStream.from(responseStream, { statusCode: 200, headers: {} });
    s.end();
    return;
  }
  if (method !== 'POST') { respondJson(responseStream, 405, { error: 'Method Not Allowed' }); return; }

  let raw = event.body || '';
  if (event.isBase64Encoded) { try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) {} }
  let body;
  try { body = JSON.parse(raw); } catch (e) { respondJson(responseStream, 400, { error: 'Invalid request body.' }); return; }

  const authHeader = getH('authorization') || '';
  const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) { respondJson(responseStream, 401, { error: 'Invalid or expired session.' }); return; }

  const claimScope = session.claims.scope;
  const claimTier = session.claims.tier;
  const referer = getH('referer') || getH('referrer') || '';
  const isScribe = (body.tool === 'AI Scribe') || (toolFromReferer(referer) === 'AI Scribe');

  const deny = () => respondJson(responseStream, 403, { error: 'This tool requires the full Think Beyond Practice membership.' });
  if (isScribe) {
    let ok = (claimScope === 'member' && claimTier === 'full');
    if (!ok && claimTier === 'forum' && Date.now() < SCRIBE_FORUM_BETA_UNTIL) ok = true;
    if (!ok) ok = await hasActiveScribeTrial(session.claims.cmid, session.claims.email);
    if (!ok) { deny(); return; }
  } else {
    if (claimScope !== 'member') { deny(); return; }
    if (claimTier !== 'full') {
      const trialOk = await hasActiveTrial(session.claims.cmid, session.claims.email);
      if (!trialOk) { deny(); return; }
    }
  }

  // Resolve the logical model, then the Bedrock id. Fail loudly if not configured.
  const logicalModel = (ALLOWED_MODELS.indexOf(body.model) !== -1 ? body.model : DEFAULT_MODEL);
  const modelId = BEDROCK_ID[logicalModel];
  if (!modelId) {
    respondJson(responseStream, 500, { error: 'Bedrock model id not configured for ' + logicalModel + '. Set BEDROCK_MODEL_SONNET / BEDROCK_MODEL_HAIKU env vars.' });
    return;
  }

  // Bedrock Anthropic request shape: anthropic_version + messages/system/max_tokens in the
  // body; the model is the command's modelId, NOT a body field, and there is no "stream" flag
  // (streaming is the command). system is passed as a plain string.
  const payloadObj = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: body.max_tokens || 2000,
    messages: body.messages || []
  };
  // The tool has to be resolved BEFORE the payload is built, because it decides the cache
  // TTL, which goes inside cache_control on the system block.
  const usageTool = body.tool || toolFromReferer(referer) || 'Clinical Tool';
  const cacheTtl = cacheTtlFor(usageTool);

  const sysBlock = cacheableSystem(body.system, logicalModel, cacheTtl);
  if (sysBlock) payloadObj.system = sysBlock;
  if (body.tools && Array.isArray(body.tools)) payloadObj.tools = body.tools;

  const usageMode = body.mode || null;
  // Hex-only and length-bounded: an analytics grouping key, never a channel for content.
  const usageSession = (typeof body.session_id === 'string' && /^[a-f0-9]{8,40}$/.test(body.session_id)) ? body.session_id : null;

  let bedrockResp;
  try {
    bedrockResp = await invokeStreamWithRetry(modelId, payloadObj);
  } catch (e) {
    // A bare "Bedrock is unable to process your request" is undiagnosable: it names no exception
    // class, no HTTP status and no request id, so neither the clinician nor AWS support can act on
    // it. Surface what the SDK actually knows. None of this is PHI.
    const meta = (e && e.$metadata) || {};
    const bits = [String((e && e.message) || e).slice(0, 300)];
    if (e && e.name) bits.push('[' + e.name + ']');
    if (meta.httpStatusCode) bits.push('HTTP ' + meta.httpStatusCode);
    if (meta.requestId) bits.push('reqId ' + meta.requestId);
    console.log('bedrock invoke failed:', e && e.name, meta.httpStatusCode, meta.requestId, String((e && e.message) || e).slice(0, 300));
    respondJson(responseStream, 502, { error: 'Bedrock invoke failed: ' + bits.join(' ') });
    return;
  }

  const out = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' }
  });

  const decoder = new TextDecoder();
  const usage = newUsageAcc();

  try {
    for await (const ev of bedrockResp.body) {
      if (!ev.chunk || !ev.chunk.bytes) continue;
      const text = decoder.decode(ev.chunk.bytes);   // JSON string of an Anthropic SSE event
      // Re-emit to the browser as the exact SSE the front end already parses.
      out.write('data: ' + text + '\n\n');
      // Meter usage counts inline (never disrupt passthrough). Every event is offered to
      // readUsage, including the final chunk carrying amazon-bedrock-invocationMetrics,
      // which the old code parsed and then dropped on the floor because it matched no branch.
      try { readUsage(JSON.parse(text), usage); } catch (e) { /* keep-alive, not JSON */ }
    }
  } finally {
    out.end();
    await logUsage({
      tool: usageTool, mode: usageMode, event: 'interaction', sessionId: usageSession,
      email: session.claims.email, tier: session.claims.tier, model: logicalModel,
      cacheTtl: cacheTtl, usageSource: usage.usageSource,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens, cacheReadTokens: usage.cacheReadTokens
    });
  }
});
