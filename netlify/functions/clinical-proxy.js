// netlify/functions/clinical-proxy.js
// Dedicated Anthropic proxy for PHI-handling clinical tools
// (Letter Generator, Chart Coder, Interaction Checker, etc.).
//
// Transparent pass-through: forwards the request body to Anthropic and
// returns the raw response. Does NOT log message content. Does NOT inspect
// or label traffic. Kept separate from anthropic-proxy.js (which serves
// non-PHI Practice Lab / Ask the Archive traffic) so PHI and non-PHI tools
// run on clearly distinct backend paths.
//
// Covered by the Anthropic API BAA.
//
// Environment variables:
//   ANTHROPIC_API_KEY - Anthropic API key
//
// Request body: raw Anthropic /v1/messages payload
//   { model, max_tokens, system?, messages, tools? }
// Response: raw Anthropic response (e.g. { content: [...], ... })

const https = require('https');

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: 'API key not configured.' })
    };
  }

  try {
    const body = JSON.parse(event.body);

    const requestPayload = {
      model: body.model || 'claude-haiku-4-5-20251001',
      max_tokens: body.max_tokens || 1000,
      system: body.system || '',
      messages: body.messages || []
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
          } catch (e) {
            reject(new Error('Invalid JSON from Anthropic (status ' + res.statusCode + '): ' + data));
          }
        });
      });
      req.on('error', (e) => { reject(e); });
      req.write(requestBody);
      req.end();
    });

    return { statusCode: 200, headers: headers, body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: err.message }) };
  }
};
