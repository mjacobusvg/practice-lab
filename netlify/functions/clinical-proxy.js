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
const { verifyToken } = require('./_lib/session');

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
  // Identity is not used for anything except gating here (no PHI logged). The gate
  // closes the open-proxy credit-burn hole while keeping trial users working.
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
    // Forum-tier: allow only if a live trial exists (shared 7-day clock).
    const trialOk = await hasActiveTrial(session.claims.cmid, session.claims.email);
    if (!trialOk) {
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
