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

// Prompt caching: mark a large system prompt as an ephemeral cache breakpoint so calls that
// reuse the same system prompt within the cache window are billed at ~10% on the cached tokens.
// Standard ephemeral cache (supported on Bedrock for these Claude models; no beta flag needed).
function cacheableSystem(sys) {
  const text = (typeof sys === 'string') ? sys : '';
  if (!text) return undefined;
  if (text.length < 4096) return text;
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

const bedrock = new BedrockRuntimeClient({ region: REGION });

// Invoke Claude on Bedrock and reassemble the streamed events into one text answer
// plus usage counts (Bedrock returns the same Anthropic event objects).
async function callBedrock(modelId, payloadObj) {
  const resp = await bedrock.send(new InvokeModelWithResponseStreamCommand({
    modelId: modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payloadObj)
  }));
  const decoder = new TextDecoder();
  let assembled = '', apiErr = null;
  let inputTokens = null, outputTokens = null, cacheCreationTokens = null, cacheReadTokens = null;
  for await (const ev of resp.body) {
    if (!ev.chunk || !ev.chunk.bytes) continue;
    const text = decoder.decode(ev.chunk.bytes);
    try {
      const evt = JSON.parse(text);
      if (evt.type === 'content_block_delta' && evt.delta && typeof evt.delta.text === 'string') {
        assembled += evt.delta.text;
      } else if (evt.type === 'message_start' && evt.message && evt.message.usage) {
        if (typeof evt.message.usage.input_tokens === 'number') inputTokens = evt.message.usage.input_tokens;
        if (typeof evt.message.usage.output_tokens === 'number') outputTokens = evt.message.usage.output_tokens;
        if (typeof evt.message.usage.cache_creation_input_tokens === 'number') cacheCreationTokens = evt.message.usage.cache_creation_input_tokens;
        if (typeof evt.message.usage.cache_read_input_tokens === 'number') cacheReadTokens = evt.message.usage.cache_read_input_tokens;
      } else if (evt.type === 'message_delta' && evt.usage && typeof evt.usage.output_tokens === 'number') {
        outputTokens = evt.usage.output_tokens;
      } else if (evt.type === 'error') {
        apiErr = evt.error ? (evt.error.message || JSON.stringify(evt.error)) : 'stream error';
      }
    } catch (e) { /* keep-alive / metrics event */ }
  }
  if (apiErr) throw new Error(apiErr);
  return { text: assembled, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens };
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

  const logicalModel = (ALLOWED_MODELS.indexOf(body.model) !== -1 ? body.model : DEFAULT_MODEL);
  const modelId = BEDROCK_ID[logicalModel];
  if (!modelId) return json(500, { error: 'Bedrock model id not configured for ' + logicalModel + '. Set BEDROCK_MODEL_SONNET / BEDROCK_MODEL_HAIKU env vars.' });

  const payloadObj = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: body.max_tokens || 1000,
    messages: body.messages || []
  };
  const sysBlock = cacheableSystem(body.system);
  if (sysBlock) payloadObj.system = sysBlock;
  if (body.tools && Array.isArray(body.tools)) payloadObj.tools = body.tools;

  const usageTool = body.tool || qsTool || toolFromReferer(referer) || 'Clinical Tool';
  const usageMode = body.mode || null;

  try {
    const result = await callBedrock(modelId, payloadObj);
    await logUsage({
      tool: usageTool, mode: usageMode, event: 'interaction',
      email: session.claims.email, tier: session.claims.tier, model: logicalModel,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      cacheCreationTokens: result.cacheCreationTokens, cacheReadTokens: result.cacheReadTokens
    });
    return json(200, { content: [{ type: 'text', text: result.text }] });
  } catch (err) {
    return json(502, { error: 'Bedrock invoke failed: ' + String(err && err.message || err).slice(0, 400) });
  }
};
