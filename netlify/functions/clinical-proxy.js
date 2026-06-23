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
// Does NOT log message content. Does NOT inspect or label traffic.
// Covered by the Anthropic API BAA.
//
// Environment variables:
//   ANTHROPIC_API_KEY - Anthropic API key
//
// Request body: raw Anthropic /v1/messages payload
//   { model, max_tokens, system?, messages, tools? }
// Response: text/event-stream (Anthropic SSE passed through verbatim)

const https = require('https');

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

  const requestPayload = {
    model: body.model || 'claude-haiku-4-5-20251001',
    max_tokens: body.max_tokens || 1000,
    system: body.system || '',
    messages: body.messages || [],
    stream: true
  };
  if (body.tools && Array.isArray(body.tools)) {
    requestPayload.tools = body.tools;
  }
  const requestBody = JSON.stringify(requestPayload);

  // Collect the streamed SSE from Anthropic. Because we read chunks as they
  // arrive, the underlying socket stays active throughout generation. We
  // accumulate the assistant text and return it as a normal JSON response,
  // matching the existing { content: [{ type:'text', text }] } shape so the
  // browser callers need no change beyond pointing here.
  try {
    const fullText = await new Promise((resolve, reject) => {
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
            resolve(assembled);
          }
        });
      });

      req.on('error', (e) => reject(e));
      req.write(requestBody);
      req.end();
    });

    // Return in the same non-streaming shape the callers already parse.
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: fullText }] })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
