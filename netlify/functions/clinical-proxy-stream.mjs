//.netlify/functions/clinical-proxy-stream.mjs
// Dedicated STREAMING Anthropic proxy for PHI-handling clinical tools
// (Chart Coder, Letter Generator, Interaction Checker, etc.).
//
// Uses Netlify's modern streaming function API: returns a Response whose body
// is a ReadableStream. Anthropic is called with stream:true, and its SSE bytes
// are passed straight through to the browser as they arrive. Because bytes flow
// continuously, the function never trips Netlify's idle/inactivity timeout that
// kills a blocking (buffered) proxy on slow generations.
//
// Does NOT log message content. Covered by the Anthropic API BAA.
//
// Request body: raw Anthropic /v1/messages payload { model, max_tokens, system?, messages, tools? }
// Response: text/event-stream (Anthropic SSE passed through verbatim). The
// browser is responsible for reassembling the text from content_block_delta events.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { verifyToken } = require('./_lib/session.js');

// Models this proxy may call (locks out caller-chosen expensive models).
const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const TRIAL_DAYS = 7;

// READ-ONLY: does this member have an unexpired trial row? Lets a forum-tier member
// through the full-tier gate during their trial. Never creates a trial (that side
// effect belongs to trial-check.mjs). Both trial tools share one clock (version 'v1').
async function hasActiveTrial(cmid, email) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  const keyId = (cmid != null && String(cmid).trim()) ? String(cmid).trim() : (email || '').toString().trim().toLowerCase();
  if (!keyId) return false;
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/note_builder_trials?community_member_id=eq.' +
      encodeURIComponent(keyId) + '&select=started_at',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return false;
    const msInDay = 24 * 60 * 60 * 1000;
    for (let i = 0; i < rows.length; i++) {
      const started = new Date(rows[i].started_at).getTime();
      if (!isNaN(started) && (Date.now() - started) / msInDay < TRIAL_DAYS) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

export default async function handler(request) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: cors });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured.' }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  let body;
  try { body = await request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid request body.' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  // AUTH: full-tier OR a forum member with a live 7-day trial (shared clock).
  // Identity from signed token (body.token or Authorization: Bearer). Closes the
  // open credit-burn hole while keeping trial users working.
  const authHeader = request.headers.get('authorization') || '';
  const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) {
    return new Response(JSON.stringify({ error: 'Invalid or expired session.' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
  if (session.claims.scope !== 'member') {
    return new Response(JSON.stringify({ error: 'This tool requires the full Think Beyond Practice membership.' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
  if (session.claims.tier !== 'full') {
    const trialOk = await hasActiveTrial(session.claims.cmid, session.claims.email);
    if (!trialOk) {
      return new Response(JSON.stringify({ error: 'This tool requires the full Think Beyond Practice membership.' }), {
        status: 403, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
  }

  const payload = {
    model: (ALLOWED_MODELS.indexOf(body.model) !== -1 ? body.model : DEFAULT_MODEL),
    max_tokens: body.max_tokens || 1000,
    system: body.system || '',
    messages: body.messages || [],
    stream: true
  };
  if (body.tools && Array.isArray(body.tools)) payload.tools = body.tools;

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload)
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(JSON.stringify({ error: 'Anthropic API error ' + upstream.status + ': ' + errText.substring(0, 300) }), {
      status: 502, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  // Pass the Anthropic SSE stream straight through to the browser.
  // Bytes flow continuously, so the idle timeout never fires.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no'
    }
  });
}

export const config = { path: '/.netlify/functions/clinical-proxy-stream' };
