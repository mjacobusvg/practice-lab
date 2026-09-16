// netlify/functions/anthropic-proxy.js
// Non-PHI Anthropic proxy (Practice Lab simulations, member chat tools).
//
// Usage tracking: after each generation we log ONE tool_usage row via
// _lib/usage.logUsage — WHO (account_email + tier from the signed token, when the
// caller sends one), which tool (from Referer / body.tool), the model, real token
// counts from the Anthropic response, and the computed cost. Logging is
// best-effort and never blocks or breaks the response.

const https = require('https');
const { verifyToken } = require('./_lib/session');
const { logUsage, toolFromReferer, detectPracticeLabMode } = require('./_lib/usage');

// Models this proxy may call, and the output ceiling it will honour. Locks out a
// caller-chosen expensive model and an unbounded completion. The two ids are the
// ones this proxy's callers already use per MODEL-REGISTRY.md; the ceiling sits
// well above the largest max_tokens any caller asks for (3000).
const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS_CEILING = 8000;

exports.handler = async function(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'API key not configured.' })
    };
  }

  try {
    const body = JSON.parse(event.body);
    const systemPrompt = body.system || '';
    const messages = body.messages || [];

    // AUTH. This endpoint used to be ungated — with CORS '*', a caller-chosen model
    // and no max_tokens ceiling, it was a free Anthropic API for the whole internet
    // on our key. It now requires a valid signed session token, the same credential
    // every other gated function takes. Audit finding C3.
    //
    // Deliberately a token check and NOT a tier check: every caller (Practice Lab
    // billing + clinical sim, Interaction Checker, archive diagnostics) already sits
    // behind auth-gate.js, so requiring authentication changes nothing for real users.
    // Tightening to scope 'member' or tier 'full' would be an access-policy change,
    // which belongs to the page's own gate, not to the proxy.
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
    const session = verifyToken(sessionToken);
    if (!session.valid) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }
    const email = session.claims.email || null;
    const tier = session.claims.tier || null;

    // Tool label: explicit body.tool wins, then the calling page (Referer),
    // then default to Practice Lab (this proxy's primary caller).
    const referer = event.headers.referer || event.headers.Referer || '';
    const tool = body.tool || toolFromReferer(referer) || 'Practice Lab';
    const mode = body.mode || detectPracticeLabMode(systemPrompt) || null;

    // Model, ceiling and tools are all fixed server-side. Previously the caller chose
    // the model with no allowlist, set max_tokens with no ceiling, and could pass
    // arbitrary tools — so a single request could be pointed at the most expensive
    // model and asked for a 200k-token completion. Same shape as clinical-proxy.js:93.
    //
    // Model ids are the two this proxy's callers already use (MODEL-REGISTRY.md).
    // An unrecognised model silently falls back to the default rather than erroring,
    // so archive-diagnostics.html's stale id keeps working.
    const requestPayload = {
      model: (ALLOWED_MODELS.indexOf(body.model) !== -1 ? body.model : DEFAULT_MODEL),
      max_tokens: Math.min(Math.max(parseInt(body.max_tokens, 10) || 1000, 1), MAX_TOKENS_CEILING),
      system: systemPrompt,
      messages: messages
    };
    // Caller-supplied tools are dropped. No caller of this proxy uses tool calling,
    // and accepting them is a way to smuggle expensive work through a cheap endpoint.
    const requestBody = JSON.stringify(requestPayload);

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
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error('Anthropic API error ' + res.statusCode + ': ' + data));
            } else {
              resolve(parsed);
            }
          } catch(e) {
            reject(new Error('Invalid JSON from Anthropic (status ' + res.statusCode + '): ' + data));
          }
        });
      });
      req.on('error', (e) => { reject(e); });
      req.write(requestBody);
      req.end();
    });

    // Log AFTER the call so token counts and cost are real (from result.usage).
    const usage = (result && result.usage) || {};
    logUsage({
      tool: tool,
      mode: mode,
      event: 'interaction',
      email: email,
      tier: tier,
      model: requestPayload.model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens
    });

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch(err) {
    // err.message here can carry the raw upstream Anthropic response body, which is
    // internal detail the browser has no use for. Log it, return something generic.
    console.error('anthropic-proxy upstream failure:', err && err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Generation failed. Please try again.' }) };
  }
};
