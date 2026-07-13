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

    // Identity for attribution only — this endpoint is NOT gated (Practice Lab
    // is open to members without a hard token requirement). If the caller sent a
    // valid signed token, capture email + tier; otherwise the row is anonymous.
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
    let email = null, tier = null;
    if (sessionToken) {
      const session = verifyToken(sessionToken);
      if (session.valid) {
        email = session.claims.email || null;
        tier = session.claims.tier || null;
      }
    }

    // Tool label: explicit body.tool wins, then the calling page (Referer),
    // then default to Practice Lab (this proxy's primary caller).
    const referer = event.headers.referer || event.headers.Referer || '';
    const tool = body.tool || toolFromReferer(referer) || 'Practice Lab';
    const mode = body.mode || detectPracticeLabMode(systemPrompt) || null;

    const requestPayload = {
      model: body.model || 'claude-haiku-4-5-20251001',
      max_tokens: body.max_tokens || 1000,
      system: systemPrompt,
      messages: messages
    };
    if (body.tools && Array.isArray(body.tools)) {
      requestPayload.tools = body.tools;
    }
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
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
