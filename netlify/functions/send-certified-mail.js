// netlify/functions/send-certified-mail.js
// Vendor-abstracted certified-mail sender. Invoked by the Stripe webhook
// AFTER payment is confirmed, with a job_id. Loads the job from Supabase,
// hands it to the configured vendor adapter, writes the result back.
//
// OPTION B POSTURE: the PostGrid adapter's actual HTTP call is a STUB.
// It is intentionally NOT a guessed production request. It must be filled in
// against the live PostGrid API docs + a real account, then verified with a
// test-mode send, before live mode is enabled. Until then this FAILS CLOSED.
//
// Activation gate (ALL required for a live send):
//   CERTIFIED_MAIL_VENDOR=postgrid
//   CERTIFIED_MAIL_BAA_CONFIRMED=true
//   POSTGRID_API_KEY
//   (Supabase service key + table)
// Plus: a successful test_mode send must have been completed first.
//
// Export submitCertifiedMail(jobId) so the webhook can call it directly,
// and also expose an HTTP handler for manual/testing invocation.

var { verifyToken } = require('./_lib/session');

var SUPABASE_URL = process.env.SUPABASE_URL;
var SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };
}

async function loadJob(jobId) {
  var res = await fetch(SUPABASE_URL + '/rest/v1/certified_mail_jobs?id=eq.' + jobId + '&select=*', { headers: sbHeaders() });
  if (!res.ok) throw new Error('Job load failed: ' + (await res.text()));
  var arr = await res.json();
  return arr && arr[0];
}

async function updateJob(jobId, patch) {
  patch.updated_at = new Date().toISOString();
  var res = await fetch(SUPABASE_URL + '/rest/v1/certified_mail_jobs?id=eq.' + jobId, {
    method: 'PATCH',
    headers: Object.assign(sbHeaders(), { 'Prefer': 'return=minimal' }),
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error('Job update failed: ' + (await res.text()));
}

// ── Vendor adapters ─────────────────────────────────────────────
// Each adapter returns { vendorJobId, vendorStatus, trackingNumber|null }.
// MUST throw if it cannot actually submit (fail closed), never fake success.

var VENDOR_ADAPTERS = {
  postgrid: async function(job) {
    var apiKey = process.env.POSTGRID_API_KEY;
    if (!apiKey) throw new Error('POSTGRID_API_KEY not set');
    if (process.env.CERTIFIED_MAIL_BAA_CONFIRMED !== 'true') {
      throw new Error('CERTIFIED_MAIL_BAA_CONFIRMED is not true; refusing to transmit PHI to vendor.');
    }

    // ===================== TODO (Option B) =====================
    // DO NOT enable live mode until this block is implemented against the
    // LIVE PostGrid API docs and verified with a test-mode send.
    //
    // Verify before implementing:
    //   - exact endpoint for certified letter creation
    //   - request payload shape (to/from address objects, file/HTML/PDF source)
    //   - certified-mail flag + electronic return-receipt option names
    //   - test vs live key handling (PostGrid test keys)
    //   - response fields: vendor job id, status, tracking number availability
    //   - whether tracking returns immediately or via webhook (likely webhook)
    //   - BAA coverage confirmed for the plan/account in use
    //
    // Example skeleton (NON-FUNCTIONAL placeholder — verify everything):
    //
    //   var resp = await fetch('https://api.postgrid.com/print-mail/v1/letters', {
    //     method: 'POST',
    //     headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    //     body: JSON.stringify({
    //       to: { /* parsed job.to_address */ },
    //       from: { /* parsed job.from_address */ },
    //       html: '<pre>' + job.letter_text + '</pre>',
    //       extraService: 'certified',            // VERIFY field name
    //       returnEnvelope: job.return_receipt,   // VERIFY field name
    //       // test mode handling per PostGrid
    //     })
    //   });
    //   var data = await resp.json();
    //   if (!resp.ok) throw new Error('PostGrid error: ' + JSON.stringify(data));
    //   return { vendorJobId: data.id, vendorStatus: data.status, trackingNumber: data.trackingNumber || null };
    // ===========================================================

    throw new Error('PostGrid adapter not yet implemented (Option B stub). Verify live API + BAA, implement, then test-mode send before enabling.');
  }
};

async function submitCertifiedMail(jobId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase not configured');
  var job = await loadJob(jobId);
  if (!job) throw new Error('Job not found: ' + jobId);
  if (job.status !== 'paid') {
    // Only send paid jobs. Webhook sets 'paid' before calling.
    throw new Error('Job not in paid status (was: ' + job.status + ')');
  }

  var vendorName = process.env.CERTIFIED_MAIL_VENDOR || 'postgrid';
  var adapter = VENDOR_ADAPTERS[vendorName];
  if (!adapter) throw new Error('Unknown vendor: ' + vendorName);

  try {
    var result = await adapter(job);
    await updateJob(jobId, {
      status: result.trackingNumber ? 'tracking' : 'submitted',
      vendor: vendorName,
      vendor_job_id: result.vendorJobId || null,
      vendor_status: result.vendorStatus || null,
      tracking_number: result.trackingNumber || null
    });
    return { ok: true, status: result.trackingNumber ? 'tracking' : 'submitted' };
  } catch (err) {
    await updateJob(jobId, { status: 'failed', error_message: err.message }).catch(function(){});
    throw err;
  }
}

exports.submitCertifiedMail = submitCertifiedMail;

// HTTP handler for manual/testing invocation: POST { jobId }
exports.handler = async function(event) {
  var headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  try {
    var body = JSON.parse(event.body || '{}');

    // AUTH: the public HTTP handler is full-tier only. (The Stripe webhook does NOT use this
    // handler — it calls submitCertifiedMail() directly after verifying the Stripe signature.)
    // This closes the 'trigger a send by jobId' hole that becomes live once the vendor adapter
    // is implemented.
    var authHeader = event.headers.authorization || event.headers.Authorization || '';
    var sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
    var session = verifyToken(sessionToken);
    if (!session.valid) return { statusCode: 401, headers: headers, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    if (!(session.claims.scope === 'member' && session.claims.tier === 'full')) {
      return { statusCode: 403, headers: headers, body: JSON.stringify({ error: 'This tool requires the full Think Beyond Practice membership.' }) };
    }

    if (!body.jobId) return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'jobId required' }) };
    var r = await submitCertifiedMail(body.jobId);
    return { statusCode: 200, headers: headers, body: JSON.stringify(r) };
  } catch (err) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: err.message }) };
  }
};
