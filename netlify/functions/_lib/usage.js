// netlify/functions/_lib/usage.js
//
// TRACKING CORE — one place that writes a row to public.tool_usage.
// Every AI-calling surface routes its logging through here so that WHO
// (account_email), at what TIER, on which model, and at what token cost is
// captured consistently. Before this, tool_usage rows had a null account_email
// on every row and no token/cost data, so usage was unattributable.
//
// This module logs USAGE METADATA ONLY — tool label, model, token COUNTS, cost,
// and the caller's email/tier from their signed session. It never receives or
// writes message content, so it is safe to call from the PHI clinical proxies
// (counts are not PHI; content never reaches this file).
//
// Fire-and-forget: logUsage() never throws and never blocks the caller's
// response. A logging failure must never break a tool.

// ── Model cost table ────────────────────────────────────────────────────────
// USD per 1,000,000 tokens (input, output). Published Anthropic list prices.
// Editable in one place; unknown models yield a null cost rather than a guess
// (we never fabricate a number). Keep model strings in sync with MODEL-REGISTRY.md.
const MODEL_COST_PER_MTOK = {
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
  'claude-sonnet-4-6':         { in: 3.0, out: 15.0 },
  'claude-sonnet-4-5':         { in: 3.0, out: 15.0 }
};

// OpenAI embedding model used by the RAG pipeline (input-only pricing).
const EMBED_COST_PER_MTOK = {
  'text-embedding-3-small': { in: 0.02, out: 0.0 }
};

function estCostUsd(model, inputTokens, outputTokens) {
  const price = MODEL_COST_PER_MTOK[model] || EMBED_COST_PER_MTOK[model];
  if (!price) return null; // unknown model -> do not fabricate a cost
  const inTok = Number(inputTokens) || 0;
  const outTok = Number(outputTokens) || 0;
  const cost = (inTok * price.in + outTok * price.out) / 1e6;
  // Round to 6 dp; sub-cent precision matters at per-call granularity.
  return Math.round(cost * 1e6) / 1e6;
}

// ── Tool labeling from the calling page ─────────────────────────────────────
// The proxies are shared by many tools, so the tool label cannot be inferred
// from the endpoint. The browser's Referer header carries the calling page path
// (same-origin fetch), which is a reliable, non-overfit signal. A caller may
// also pass an explicit `tool` in the body, which always wins.
const REFERER_TOOL_MAP = [
  ['pm-letter-generator',      'Letter Generator'],
  ['pm-chart-coder',           'Chart Coder'],
  ['pm-clinical-note-builder', 'Clinical Note Builder'],
  ['pm-interaction-checker',   'Interaction Checker'],
  ['pm-termination-workflow',  'Termination Workflow'],
  ['pm-monitoring-protocol',   'Monitoring Protocol'],
  ['pm-crisis-safety-plan',    'Crisis Safety Plan'],
  ['pm-compliance-tracker',    'Compliance Tracker'],
  ['pm-hipaa-hub',             'HIPAA Hub'],
  ['pm-assessment-suite',      'Assessment Suite'],
  ['pm-lai',                   'LAI Protocol'],
  ['note-builder-trial',       'Note Builder (Trial)'],
  ['chart-coder-trial',        'Chart Coder (Trial)'],
  ['practice-lab-billing',     'Practice Lab'],
  ['practice-lab-private',     'Practice Lab'],
  ['practice-lab-hub',         'Practice Lab'],
  ['practice-lab-demo',        'Practice Lab Demo'],
  ['ai-scribe-demo',           'AI Scribe Demo'],
  ['note-deidentifier',        'Note De-identifier'],
  ['fact-checker',             'Fact Checker'],
  ['archive-diagnostics',      'Archive Diagnostics'],
  ['ask-archive',              'Ask the Archive'],
  ['practice-manager',         'Practice Manager']
];

function toolFromReferer(referer) {
  if (!referer || typeof referer !== 'string') return null;
  let path = referer;
  try { path = new URL(referer).pathname; } catch (e) { /* use raw */ }
  path = path.toLowerCase();
  for (let i = 0; i < REFERER_TOOL_MAP.length; i++) {
    if (path.indexOf(REFERER_TOOL_MAP[i][0]) !== -1) return REFERER_TOOL_MAP[i][1];
  }
  return null;
}

// Practice Lab sub-mode from the system prompt (Practice Lab is one page with
// many simulation modes). Kept from the original anthropic-proxy detector.
function detectPracticeLabMode(systemPrompt) {
  const p = String(systemPrompt || '').toLowerCase();
  if (p.includes('billing simulator') || p.includes('era') || p.includes('remittance')) return 'Billing Simulator';
  if (p.includes('denial drill') || p.includes('denial scenario')) return 'Denial Drills';
  if (p.includes('chart coder') || p.includes('coding judgment')) return 'Chart Coder';
  if (p.includes('mdm foundation') || p.includes('medical decision')) return 'MDM Foundations';
  if (p.includes('psychotherapy') || p.includes('therapeutic')) return 'Psychotherapy Documentation';
  if (p.includes('paper remittance')) return 'Paper Remittance';
  if (p.includes('angela') || p.includes('insurance representative')) return 'Insurance Rep Chat';
  return null;
}

// ── The single writer ───────────────────────────────────────────────────────
/**
 * Best-effort insert of one tool_usage row. Never throws; never blocks.
 * @param {object} row
 *   tool          {string}  required label ("Letter Generator", "Practice Lab", ...)
 *   mode          {string?} sub-mode within the tool
 *   event         {string?} defaults to 'interaction'
 *   email         {string?} account_email from the verified session (null if anon)
 *   tier          {string?} 'full' | 'forum' | 'free' from the session
 *   model         {string?} model string the call used
 *   inputTokens   {number?} prompt tokens
 *   outputTokens  {number?} completion tokens
 *   costUsd       {number?} pass to override; otherwise computed from model+tokens
 * @param {object} env optional { SUPABASE_URL, SUPABASE_SERVICE_KEY } override
 * @returns {Promise<void>}
 */
function logUsage(row, env) {
  try {
    const SUPABASE_URL = (env && env.SUPABASE_URL) || process.env.SUPABASE_URL;
    const SERVICE_KEY = (env && env.SUPABASE_SERVICE_KEY) || process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) return Promise.resolve();

    const email = row.email ? String(row.email).toLowerCase().trim() : null;
    const model = row.model || null;
    const inputTokens = (row.inputTokens != null) ? Number(row.inputTokens) : null;
    const outputTokens = (row.outputTokens != null) ? Number(row.outputTokens) : null;
    const cost = (row.costUsd != null)
      ? row.costUsd
      : (model ? estCostUsd(model, inputTokens, outputTokens) : null);

    const payload = {
      tool: row.tool || 'Unknown',
      mode: row.mode || null,
      event: row.event || 'interaction',
      created_at: new Date().toISOString(),
      account_email: email,
      tier: row.tier || null,
      model: model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      est_cost_usd: cost
    };

    return fetch(SUPABASE_URL + '/rest/v1/tool_usage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(payload)
    }).then(function () {}).catch(function (e) {
      console.log('tool_usage log error:', e && e.message);
    });
  } catch (e) {
    console.log('tool_usage log error:', e && e.message);
    return Promise.resolve();
  }
}

module.exports = {
  logUsage,
  estCostUsd,
  toolFromReferer,
  detectPracticeLabMode,
  MODEL_COST_PER_MTOK
};
