// netlify/functions/clinical-proxy.js
// Dedicated Anthropic proxy for PHI-handling clinical tools
// (Letter Generator, Chart Coder, Interaction Checker, etc.).
//
// STREAMING pass-through: forwards the request to Anthropic with stream=true
// and relays Server-Sent Events back to the browser as they arrive. Because
// bytes flow continuously while the model generates, the serverless inactivity
// timeout is not tripped by long generations the way a single blocking request
// is. The browser reassembles the streamed text.
//
// Does NOT log message content. It logs USAGE METADATA ONLY — tool label, model,
// token COUNTS, cost, and the member's email/tier from their signed session.
// Token counts are not PHI and message content never leaves this function, so
// this stays consistent with the Anthropic API BAA.
//
// Environment variables:
//   ANTHROPIC_API_KEY - Anthropic API key
//
// Request body: raw Anthropic /v1/messages payload
//   { model, max_tokens, system?, messages, tools?, tool? }   (tool = usage label)
// Response: text/event-stream (Anthropic SSE passed through verbatim)

const https = require('https');
const { verifyToken } = require('./_lib/session');
const { logUsage, toolFromReferer } = require('./_lib/usage');

const TRIAL_DAYS = 7;

// READ-ONLY check: does this member have an unexpired trial row? Used to let a
// forum-tier member through the full-tier clinical gate DURING their trial.
// Must never create a trial (that side effect belongs to trial-check.mjs only) —
// this only SELECTs. Both trial tools share one clock (trial_version 'v1').
async function hasActiveTrial(cmid, email) {
  var SUPABASE_URL = process.env.SUPABASE_URL;
  var SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  var keyId = (cmid != null && String(cmid).trim()) ? String(cmid).trim() : (email || '').toString().trim().toLowerCase();
  if (!keyId) return false;
  try {
    var res = await fetch(
      SUPABASE_URL + '/rest/v1/note_builder_trials?community_member_id=eq.' +
      encodeURIComponent(keyId) + '&select=started_at',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    if (!res.ok) return false;
    var rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return false;
    var msInDay = 24 * 60 * 60 * 1000;
    for (var i = 0; i < rows.length; i++) {
      var started = new Date(rows[i].started_at).getTime();
      if (!isNaN(started) && (Date.now() - started) / msInDay < TRIAL_DAYS) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// READ-ONLY: does this member hold an unexpired entitlement for a specific feature?
// Lets a forum-tier member through the full-tier gate for ONE named tool (e.g. a
// hand-granted "try the Letter Generator for a week" pass) without touching their
// tier or Stripe. SELECT only; grants live in feature_entitlements, seeded by admin
// action, and expire automatically at expires_at (nothing to remember to revoke).
async function hasActiveEntitlement(email, feature) {
  var SUPABASE_URL = process.env.SUPABASE_URL;
  var SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  var em = (email || '').toString().trim().toLowerCase();
  if (!em || !feature) return false;
  try {
    var nowIso = new Date().toISOString();
    var res = await fetch(
      SUPABASE_URL + '/rest/v1/feature_entitlements?email=eq.' + encodeURIComponent(em) +
      '&feature=eq.' + encodeURIComponent(feature) +
      '&expires_at=gt.' + encodeURIComponent(nowIso) + '&select=id&limit=1',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    if (!res.ok) return false;
    var rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    return false;
  }
}

// Which entitlement feature unlocks a given usage-tool label. ONLY tools listed here
// can be opened by a per-feature entitlement; every other clinical tool stays
// full-tier-only. This map is the feature-scope guard: a 'letter_generator'
// entitlement can open the Letter Generator and nothing else.
const FEATURE_BY_TOOL = { 'Letter Generator': 'letter_generator' };

// Models this proxy is permitted to call. Locks out caller-chosen expensive models.
const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

exports.handler = async function (event, context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'API key not configured.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid request body.' })
    };
  }

  // AUTH: clinical tools are full-tier OR a forum member with a live 7-day trial.
  // The gate closes the open-proxy credit-burn hole while keeping trial users
  // working. The verified claims also feed usage attribution below.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) {
    return { statusCode: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
  }
  if (session.claims.scope !== 'member') {
    return { statusCode: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'This tool requires the full Think Beyond Practice membership.' }) };
  }
  if (session.claims.tier !== 'full') {
    // Forum-tier: allow if a live shared-clock trial exists, OR a per-feature
    // entitlement for THIS specific tool. Feature-scoped via FEATURE_BY_TOOL so a
    // single-tool pass (e.g. a hand-granted Letter Generator trial) can never open
    // the Scribe, Coder, or any other Full tool. Fail-closed: an unknown/absent tool
    // maps to no feature, so it falls straight through to the 403.
    const gateReferer = event.headers.referer || event.headers.Referer || '';
    const gateTool = body.tool || toolFromReferer(gateReferer) || '';
    const gateFeature = FEATURE_BY_TOOL[gateTool] || null;
    const trialOk = await hasActiveTrial(session.claims.cmid, session.claims.email);
    const entitledOk = (!trialOk && gateFeature)
      ? await hasActiveEntitlement(session.claims.email, gateFeature)
      : false;
    if (!trialOk && !entitledOk) {
      return { statusCode: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'This tool requires the full Think Beyond Practice membership.' }) };
    }
  }

  const requestPayload = {
    model: (ALLOWED_MODELS.indexOf(body.model) !== -1 ? body.model : DEFAULT_MODEL),
    max_tokens: body.max_tokens || 1000,
    system: body.system || '',
    messages: body.messages || [],
    stream: true
  };
  if (body.tools && Array.isArray(body.tools)) {
    requestPayload.tools = body.tools;
  }
  const requestBody = JSON.stringify(requestPayload);

  // Usage-label inputs resolved before the call. Content is never captured.
  const referer = event.headers.referer || event.headers.Referer || '';
  const usageTool = body.tool || toolFromReferer(referer) || 'Clinical Tool';
  const usageMode = body.mode || null;

  // Collect the streamed SSE from Anthropic. Because we read chunks as they
  // arrive, the underlying socket stays active throughout generation. We
  // accumulate the assistant text and the token-usage counters (from the
  // message_start / message_delta events), then return the text as a normal JSON
  // response matching the existing { content: [{ type:'text', text }] } shape.
  try {
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(requestBody)
        }
      };

      const req = https.request(options, (res) => {
        let buffer = '';
        let assembled = '';
        let apiErr = null;
        let inputTokens = null;
        let outputTokens = null;

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          // SSE events are separated by double newlines
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const lines = rawEvent.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              const dataStr = line.slice(5).trim();
              if (!dataStr || dataStr === '[DONE]') continue;
              try {
                const evt = JSON.parse(dataStr);
                if (evt.type === 'content_block_delta' && evt.delta && typeof evt.delta.text === 'string') {
                  assembled += evt.delta.text;
                } else if (evt.type === 'message_start' && evt.message && evt.message.usage) {
                  // input_tokens is final at message_start; output_tokens starts small.
                  if (typeof evt.message.usage.input_tokens === 'number') inputTokens = evt.message.usage.input_tokens;
                  if (typeof evt.message.usage.output_tokens === 'number') outputTokens = evt.message.usage.output_tokens;
                } else if (evt.type === 'message_delta' && evt.usage && typeof evt.usage.output_tokens === 'number') {
                  // Cumulative output token count; last one wins.
                  outputTokens = evt.usage.output_tokens;
                } else if (evt.type === 'error') {
                  apiErr = evt.error ? (evt.error.message || JSON.stringify(evt.error)) : 'stream error';
                }
              } catch (e) {
                // ignore non-JSON keep-alive lines
              }
            }
          }
        });

        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error('Anthropic API error ' + res.statusCode + (assembled ? ': ' + assembled : '')));
          } else if (apiErr) {
            reject(new Error('Anthropic stream error: ' + apiErr));
          } else {
            resolve({ text: assembled, inputTokens: inputTokens, outputTokens: outputTokens });
          }
        });
      });

      req.on('error', (e) => reject(e));
      req.write(requestBody);
      req.end();
    });

    // Usage metadata only (no content). Attributed to the verified member.
    logUsage({
      tool: usageTool,
      mode: usageMode,
      event: 'interaction',
      email: session.claims.email,
      tier: session.claims.tier,
      model: requestPayload.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens
    });

    // Return in the same non-streaming shape the callers already parse.
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: result.text }] })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
