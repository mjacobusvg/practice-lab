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
// Does NOT log message content. It logs USAGE METADATA ONLY — tool label, model,
// token COUNTS, cost, and the member's email/tier — by TEEing the passthrough
// stream (the client still receives every byte unchanged) and reading the
// message_start / message_delta usage events. Token counts are not PHI and no
// content is captured, so this stays consistent with the Anthropic API BAA.
//
// Request body: raw Anthropic /v1/messages payload { model, max_tokens, system?, messages, tools?, tool? }
// Response: text/event-stream (Anthropic SSE passed through verbatim). The
// browser is responsible for reassembling the text from content_block_delta events.

import crypto from 'crypto';

// ── Inlined token verification ──────────────────────────────────────────────
// verifyToken() from _lib/session.js, inlined. Netlify's ESM (.mjs) bundler does
// not trace a createRequire('./_lib/session.js') dependency into the bundle, so the
// relative require throws "Cannot find module './_lib/session.js'" at runtime and
// the function 502s. Inlining (crypto is a Node built-in) removes that failure mode.
// Algorithm MUST stay identical to _lib/session.js so tokens verify everywhere.
const SECRET = process.env.SESSION_SIGNING_SECRET || '';

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signPayload(payloadJson) {
  return b64url(crypto.createHmac('sha256', SECRET).update(payloadJson).digest());
}
function verifyToken(token) {
  if (!SECRET) return { valid: false, reason: 'server_misconfigured' };
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) {
    return { valid: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;
  let payloadJson;
  try { payloadJson = b64urlDecode(payloadB64); }
  catch (e) { return { valid: false, reason: 'malformed' }; }
  const expectedSig = signPayload(payloadJson);
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'bad_signature' };
  }
  let claims;
  try { claims = JSON.parse(payloadJson); }
  catch (e) { return { valid: false, reason: 'malformed' }; }
  if (!claims.exp || Date.now() > claims.exp) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, claims };
}
// ────────────────────────────────────────────────────────────────────────────

// ── Inlined usage logging (mirror of _lib/usage.js; .mjs can't require _lib) ──
// Keep MODEL_COST_PER_MTOK and the referer map in sync with _lib/usage.js.
const MODEL_COST_PER_MTOK = {
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
  'claude-sonnet-4-6':         { in: 3.0, out: 15.0 },
  'claude-sonnet-4-5':         { in: 3.0, out: 15.0 }
};
// Cache-aware. Prompt caching (below) bills cache writes at 2x input (1-hour TTL) and cache
// reads at 0.1x input; plain input and output bill as usual. cacheCreation/cacheRead default to
// 0, so a call without caching prices exactly as before.
function estCostUsd(model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens) {
  const price = MODEL_COST_PER_MTOK[model];
  if (!price) return null;
  const inTok = Number(inputTokens) || 0;
  const outTok = Number(outputTokens) || 0;
  const ccTok = Number(cacheCreationTokens) || 0;   // 1h cache write = 2x input
  const crTok = Number(cacheReadTokens) || 0;        // cache read = 0.1x input
  const cost = (inTok * price.in + ccTok * price.in * 2.0 + crTok * price.in * 0.1 + outTok * price.out) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

// Prompt caching: wrap a large, static system prompt in a cache_control block so repeat calls
// within the cache window bill it at 0.1x instead of full price. We use the 1-HOUR TTL, chosen from
// real traffic: notes cluster ~26 min apart (median), so ~75% land within an hour of a prior note
// (a warm read) but only ~5% within 5 min — the 5-min default would pay the write premium and rarely
// read. Only prompts at/above Sonnet's ~1024-token minimum (~4096 chars) are worth caching; shorter
// ones (e.g. the Plan fill on Haiku) pass through as a plain string and never attempt a cache write.
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
    // With caching, Anthropic reports the cached prefix in separate fields; input_tokens is only the
    // uncached remainder. Price all three (cache-aware) and log the TOTAL input so the token count
    // still reflects the full prompt while est_cost reflects the caching discount.
    const cacheCreation = (row.cacheCreationTokens != null) ? Number(row.cacheCreationTokens) : 0;
    const cacheRead = (row.cacheReadTokens != null) ? Number(row.cacheReadTokens) : 0;
    const cost = model ? estCostUsd(model, inputTokens, outputTokens, cacheCreation, cacheRead) : null;
    const totalInput = (inputTokens != null) ? inputTokens + cacheCreation + cacheRead : null;
    await fetch(SUPABASE_URL + '/rest/v1/tool_usage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        tool: row.tool || 'Clinical Tool',
        mode: row.mode || null,
        event: row.event || 'interaction',
        created_at: new Date().toISOString(),
        account_email: email,
        tier: row.tier || null,
        model: model,
        input_tokens: totalInput,
        output_tokens: outputTokens,
        est_cost_usd: cost
      })
    });
  } catch (e) {
    console.log('tool_usage log error:', e && e.message);
  }
}
// ────────────────────────────────────────────────────────────────────────────

// Models this proxy may call (locks out caller-chosen expensive models).
const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const TRIAL_DAYS = 7;

// Self-serve AI Scribe trial: a PER-USER 14-day clock, evergreen (a member starts it
// whenever they first open the Scribe). Kept in its OWN trial_version namespace so it
// never collides with the 7-day Note Builder / Chart Coder trials in the same table.
// This is the only path that lets a non-'member' scope (free tier) reach the Scribe.
// Started by trial-check.mjs; read-only here. Keep in sync with pm-ai-scribe.html.
const SCRIBE_TRIAL_DAYS = 14;
const SCRIBE_TRIAL_VERSION = 'ai-scribe-v1';

// Forum-tier AI Scribe beta: a single SHARED window with a fixed end date (NOT a
// per-user clock). Every forum member may use the Scribe until this instant, then
// forum reverts to the wall and only full tier (or an active trial) passes. This is
// deliberately not the note_builder_trials clock — that starts on each person's first
// open and would run past the shared window for late starters. Keep in sync with the
// same constant in pm-ai-scribe.html's gate. End of Aug 16, 2026 (Pacific).
const SCRIBE_FORUM_BETA_UNTIL = Date.parse('2026-08-17T07:00:00Z');

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
      encodeURIComponent(keyId) + '&select=started_at,trial_version',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return false;
    const msInDay = 24 * 60 * 60 * 1000;
    for (let i = 0; i < rows.length; i++) {
      // The Scribe trial lives in the same table but is its own 14-day product; never let
      // it satisfy the 7-day gate for the OTHER clinical tools.
      if (String(rows[i].trial_version || '').toLowerCase().indexOf('ai-scribe') === 0) continue;
      const started = new Date(rows[i].started_at).getTime();
      if (!isNaN(started) && (Date.now() - started) / msInDay < TRIAL_DAYS) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// READ-ONLY: does this member have an unexpired 14-day Scribe trial (version-scoped)?
// Mirrors hasActiveTrial but filters to the Scribe trial_version and its 14-day window,
// so a Note Builder / Chart Coder trial can never open the Scribe and vice versa. Never
// creates a row (that side effect lives in trial-check.mjs).
async function hasActiveScribeTrial(cmid, email) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  const keyId = (cmid != null && String(cmid).trim()) ? String(cmid).trim() : (email || '').toString().trim().toLowerCase();
  if (!keyId) return false;
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/note_builder_trials?community_member_id=eq.' +
      encodeURIComponent(keyId) + '&trial_version=eq.' + encodeURIComponent(SCRIBE_TRIAL_VERSION) + '&select=started_at',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return false;
    const msInDay = 24 * 60 * 60 * 1000;
    for (let i = 0; i < rows.length; i++) {
      const started = new Date(rows[i].started_at).getTime();
      if (!isNaN(started) && (Date.now() - started) / msInDay < SCRIBE_TRIAL_DAYS) return true;
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
  // open credit-burn hole while keeping trial users working. The claims also feed
  // usage attribution below.
  const authHeader = request.headers.get('authorization') || '';
  const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) {
    return new Response(JSON.stringify({ error: 'Invalid or expired session.' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
  const denyMembership = () => new Response(JSON.stringify({ error: 'This tool requires the full Think Beyond Practice membership.' }), {
    status: 403, headers: { ...cors, 'Content-Type': 'application/json' }
  });

  const claimScope = session.claims.scope;
  const claimTier = session.claims.tier;
  const referer = request.headers.get('referer') || request.headers.get('referrer') || '';
  const isScribe = toolFromReferer(referer) === 'AI Scribe';

  // The AI Scribe has a BROADER access policy than the other clinical tools. Besides
  // full tier, it is open to every forum member during the shared beta window, AND to
  // ANY logged-in member (including free tier, scope 'free') who has started the
  // self-serve 14-day trial. That trial is the ONLY reason a non-'member' scope may
  // pass, and only for the Scribe (referer-scoped) — every other tool keeps the strict
  // members-only gate in the else branch. The trial row is created by trial-check.mjs;
  // read-only here, so this can never grant access without an actually-started trial.
  if (isScribe) {
    let ok = (claimScope === 'member' && claimTier === 'full');
    if (!ok && claimTier === 'forum' && Date.now() < SCRIBE_FORUM_BETA_UNTIL) ok = true;
    if (!ok) ok = await hasActiveScribeTrial(session.claims.cmid, session.claims.email);
    if (!ok) return denyMembership();
  } else {
    // Every other clinical tool: strict members-only (unchanged). Full tier passes; a
    // forum member passes only with a live 7-day trial (shared clock). Free/hub scope
    // never passes — this is the credit-burn boundary for the PHI-processing tools.
    if (claimScope !== 'member') return denyMembership();
    if (claimTier !== 'full') {
      const trialOk = await hasActiveTrial(session.claims.cmid, session.claims.email);
      if (!trialOk) return denyMembership();
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

  // Usage-label inputs. Content is never captured — only counts + labels.
  // (referer/isScribe already derived in the auth gate above.)
  const usageTool = body.tool || toolFromReferer(referer) || 'Clinical Tool';
  const usageMode = body.mode || null;

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

  // TEE the passthrough: every byte still flows to the browser unchanged, while a
  // TransformStream reads the SSE usage events to capture token counts. On flush
  // (upstream complete) we log one usage-metadata row for the member. No content
  // is retained — only the numeric input/output token counts.
  const decoder = new TextDecoder();
  let sseBuf = '';
  let inputTokens = null;
  let outputTokens = null;
  let cacheCreationTokens = null;   // prompt-cache write tokens (billed 2x, 1h TTL)
  let cacheReadTokens = null;       // prompt-cache read tokens (billed 0.1x)

  const meter = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk); // passthrough, unchanged
      try {
        sseBuf += decoder.decode(chunk, { stream: true });
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
    },
    async flush() {
      await logUsage({
        tool: usageTool,
        mode: usageMode,
        event: 'interaction',
        email: session.claims.email,
        tier: session.claims.tier,
        model: payload.model,
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        cacheCreationTokens: cacheCreationTokens,
        cacheReadTokens: cacheReadTokens
      });
    }
  });

  const metered = upstream.body.pipeThrough(meter);

  // Pass the (metered) Anthropic SSE stream straight through to the browser.
  return new Response(metered, {
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
