// AWS Lambda (Function URL, RESPONSE_STREAM) port of clinical-proxy-stream.mjs
// Paste this as the function's index.mjs. Runtime: Node.js 20.x or 24.x.
// Deploy with a Function URL, Invoke mode = RESPONSE_STREAM, Auth type = NONE
// (auth is enforced in-code via the signed session token, same as Netlify).
// Do NOT also enable CORS on the Function URL: this handler emits CORS itself,
// and a second Access-Control-Allow-Origin would break the browser.
//
// Env vars required: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
// SESSION_SIGNING_SECRET.
//
// Behavior is identical to the Netlify version: streams Anthropic SSE straight
// through, logs usage-metadata only (token counts), never message content.

import crypto from 'crypto';

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
function cacheableSystem(sys) {
  const text = (typeof sys === 'string') ? sys : '';
  if (text.length < 4096) return sys || '';
  return [{ type: 'text', text, cache_control: { type: 'ephemeral', ttl: '1h' } }];
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

// CORS is handled by the Lambda Function URL's built-in CORS config (which also
// answers the OPTIONS preflight), so this handler does NOT emit CORS headers —
// emitting them here too would produce a duplicate Access-Control-Allow-Origin
// on the streamed response and the browser would reject it.

function respondJson(responseStream, status, obj) {
  const s = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' }
  });
  s.write(JSON.stringify(obj));
  s.end();
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { respondJson(responseStream, 500, { error: 'API key not configured.' }); return; }

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
  const isScribe = toolFromReferer(referer) === 'AI Scribe';

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

  const payload = {
    model: (ALLOWED_MODELS.indexOf(body.model) !== -1 ? body.model : DEFAULT_MODEL),
    max_tokens: body.max_tokens || 1000,
    system: cacheableSystem(body.system),
    messages: body.messages || [],
    stream: true
  };
  if (body.tools && Array.isArray(body.tools)) payload.tools = body.tools;

  const usageTool = body.tool || toolFromReferer(referer) || 'Clinical Tool';
  const usageMode = body.mode || null;

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(payload)
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    respondJson(responseStream, 502, { error: 'Anthropic API error ' + upstream.status + ': ' + errText.substring(0, 300) });
    return;
  }

  // Stream the Anthropic SSE straight through; meter usage counts inline.
  const out = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' }
  });

  const decoder = new TextDecoder();
  let sseBuf = '';
  let inputTokens = null, outputTokens = null, cacheCreationTokens = null, cacheReadTokens = null;

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));            // passthrough, unchanged
      try {
        sseBuf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = sseBuf.indexOf('\n\n')) !== -1) {
          const rawEvent = sseBuf.slice(0, idx);
          sseBuf = sseBuf.slice(idx + 2);
          const lines = rawEvent.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const dataStr = line.slice(5).trim();
            if (!dataStr || dataStr === '[DONE]') continue;
            try {
              const evt = JSON.parse(dataStr);
              if (evt.type === 'message_start' && evt.message && evt.message.usage) {
                if (typeof evt.message.usage.input_tokens === 'number') inputTokens = evt.message.usage.input_tokens;
                if (typeof evt.message.usage.output_tokens === 'number') outputTokens = evt.message.usage.output_tokens;
                if (typeof evt.message.usage.cache_creation_input_tokens === 'number') cacheCreationTokens = evt.message.usage.cache_creation_input_tokens;
                if (typeof evt.message.usage.cache_read_input_tokens === 'number') cacheReadTokens = evt.message.usage.cache_read_input_tokens;
              } else if (evt.type === 'message_delta' && evt.usage && typeof evt.usage.output_tokens === 'number') {
                outputTokens = evt.usage.output_tokens;
              }
            } catch (e) { /* keep-alive / non-JSON */ }
          }
        }
      } catch (e) { /* metering must never disrupt passthrough */ }
    }
  } finally {
    out.end();
    await logUsage({
      tool: usageTool, mode: usageMode, event: 'interaction',
      email: session.claims.email, tier: session.claims.tier, model: payload.model,
      inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens
    });
  }
});
