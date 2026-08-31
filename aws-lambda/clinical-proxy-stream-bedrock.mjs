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
function estCostUsd(model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens) {
  const price = MODEL_COST_PER_MTOK[model];
  if (!price) return null;
  const inTok = Number(inputTokens) || 0;
  const outTok = Number(outputTokens) || 0;
  const ccTok = Number(cacheCreationTokens) || 0;
  const crTok = Number(cacheReadTokens) || 0;
  const cost = (inTok * price.in + ccTok * price.in * 2.0 + crTok * price.in * 0.1 + outTok * price.out) / 1e6;
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
    const cost = model ? estCostUsd(model, inputTokens, outputTokens, cacheCreation, cacheRead) : null;
    const totalInput = (inputTokens != null) ? inputTokens + cacheCreation + cacheRead : null;
    await fetch(SUPABASE_URL + '/rest/v1/tool_usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        tool: row.tool || 'Clinical Tool', mode: row.mode || null, event: row.event || 'interaction',
        created_at: new Date().toISOString(), account_email: email, tier: row.tier || null, model: model,
        input_tokens: totalInput, output_tokens: outputTokens, est_cost_usd: cost
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

const bedrock = new BedrockRuntimeClient({ region: REGION });

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
  const sys = (typeof body.system === 'string') ? body.system : '';
  if (sys) payloadObj.system = sys;
  if (body.tools && Array.isArray(body.tools)) payloadObj.tools = body.tools;

  const usageTool = body.tool || toolFromReferer(referer) || 'Clinical Tool';
  const usageMode = body.mode || null;

  let bedrockResp;
  try {
    bedrockResp = await bedrock.send(new InvokeModelWithResponseStreamCommand({
      modelId: modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payloadObj)
    }));
  } catch (e) {
    respondJson(responseStream, 502, { error: 'Bedrock invoke failed: ' + String(e && e.message || e).slice(0, 400) });
    return;
  }

  const out = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' }
  });

  const decoder = new TextDecoder();
  let inputTokens = null, outputTokens = null, cacheCreationTokens = null, cacheReadTokens = null;

  try {
    for await (const ev of bedrockResp.body) {
      if (!ev.chunk || !ev.chunk.bytes) continue;
      const text = decoder.decode(ev.chunk.bytes);   // JSON string of an Anthropic SSE event
      // Re-emit to the browser as the exact SSE the front end already parses.
      out.write('data: ' + text + '\n\n');
      // Meter usage counts inline (never disrupt passthrough).
      try {
        const evt = JSON.parse(text);
        if (evt.type === 'message_start' && evt.message && evt.message.usage) {
          if (typeof evt.message.usage.input_tokens === 'number') inputTokens = evt.message.usage.input_tokens;
          if (typeof evt.message.usage.output_tokens === 'number') outputTokens = evt.message.usage.output_tokens;
          if (typeof evt.message.usage.cache_creation_input_tokens === 'number') cacheCreationTokens = evt.message.usage.cache_creation_input_tokens;
          if (typeof evt.message.usage.cache_read_input_tokens === 'number') cacheReadTokens = evt.message.usage.cache_read_input_tokens;
        } else if (evt.type === 'message_delta' && evt.usage && typeof evt.usage.output_tokens === 'number') {
          outputTokens = evt.usage.output_tokens;
        }
      } catch (e) { /* keep-alive / metrics event */ }
    }
  } finally {
    out.end();
    await logUsage({
      tool: usageTool, mode: usageMode, event: 'interaction',
      email: session.claims.email, tier: session.claims.tier, model: logicalModel,
      inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens
    });
  }
});
