// netlify/functions/anthropic-proxy-demo.js
//
// PUBLIC, UNAUTHENTICATED demo proxy for the Practice Lab marketing demo
// (non-members try "Angela" without logging in). This is intentionally open,
// so it is locked down to limit abuse value:
//   - Model is FORCED to Haiku (the demo already used Haiku — no quality change).
//   - max_tokens is hard-capped.
//   - Caller-supplied tools are STRIPPED (no expensive tool use smuggled in).
//   - No system-prompt-driven model selection; caller cannot pick the model.
//
// The authenticated proxy (anthropic-proxy.js, members only) is used by the real
// in-product tools. This demo endpoint is ONLY for the public demo page.
//
// Usage tracking: logs one anonymous tool_usage row (no identity — these are
// logged-out visitors) with real token counts + cost, so demo volume/cost is
// visible alongside member usage.
//
// Env: ANTHROPIC_API_KEY (+ optional SUPABASE_URL/SUPABASE_SERVICE_KEY for usage log)

const https = require('https');
const { logUsage } = require('./_lib/usage');

const DEMO_MODEL = 'claude-haiku-4-5-20251001'; // forced; demo already used this
const DEMO_MAX_TOKENS = 1000;                    // hard cap

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
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured.' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const systemPrompt = body.system || '';
    const messages = body.messages || [];

    // LOCKED payload: forced model, capped tokens, NO caller-supplied tools, and
    // max_tokens can only go DOWN from the cap, never up.
    const requestPayload = {
      model: DEMO_MODEL,
      max_tokens: Math.min(body.max_tokens || DEMO_MAX_TOKENS, DEMO_MAX_TOKENS),
      system: systemPrompt,
      messages: messages
    };
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

    // Anonymous usage row (logged-out visitors) with real token counts + cost.
    const usage = (result && result.usage) || {};
    logUsage({
      tool: 'Practice Lab Demo',
      mode: 'public_demo',
      event: 'interaction',
      email: null,
      tier: null,
      model: DEMO_MODEL,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens
    });

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
