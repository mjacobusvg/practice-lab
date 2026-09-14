// netlify/functions/scribe-event.js
//
// WORKFLOW TELEMETRY for the AI Scribe — the events that involve NO model call.
//
// Model calls already log themselves: the clinical proxies send `mode` through to
// _lib/usage.js, which writes public.tool_usage. But the most revealing part of how a
// clinician works never touches the model at all — opening Prep and not running it,
// starting Ambient, choosing a visit type, pasting a note instead of recording. Those
// events land here, in the SAME table, so one query reconstructs a whole visit.
//
// PHI: this endpoint cannot carry any. `mode` is matched against a fixed ALLOWED list and
// anything else is rejected; no free text, no note content, no transcript, no patient
// identifier is read from the body at all. That is why it is safe on Netlify (which is
// NOT under a BAA) while the clinical text paths stay on AWS — see BAA-AND-PHI-ROUTING.md.
// The only identity written is the clinician's own account email, taken from their SIGNED
// SESSION TOKEN rather than the request body, so a caller cannot attribute events to
// someone else.

const { verifyToken } = require('./_lib/session');
const { logUsage } = require('./_lib/usage');

// The complete vocabulary. An allowlist, not a blocklist: an unknown value is dropped
// rather than stored, so a future typo or a crafted request can never write free text
// into the analytics table.
const ALLOWED = new Set([
  // how the visit was set up
  'visit_new_eval',        // visit type chosen: new patient evaluation
  'visit_follow_up',       // visit type chosen: follow-up
  // how the encounter material arrived — the question we cannot answer today
  'input_ambient',         // recording used
  'input_paste',           // text pasted into the working note
  'input_typed',           // text typed by hand
  'ambient_start',
  'ambient_stop',
  'ambient_transcript',    // transcript landed back in the note
  // the prep / records path
  'prep_opened',           // the panel was opened
  'records_added',         // a document was attached (either text PDF or scanned)
  // the reasoning tools, and WHEN they were reached for
  'discern_opened_before_visit',
  'discern_opened_during_recording',
  'discern_opened_after_transcript',
  'framework_opened',
  'framework_questions_added',
  'framework_reassess',    // "what did today establish?"
  // the end of the workflow
  'draft_clicked',
  'audit_opened'
]);

// A client-generated random id grouping one patient workspace's rows. Shape-checked so it
// cannot smuggle anything: hex only, bounded length.
const SAFE_SESSION = /^[a-f0-9]{8,40}$/;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Identity comes from the signed session, never from the body.
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = body.token || auth.replace(/^Bearer\s+/i, '');
  const session = verifyToken(token);
  if (!session.valid) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const mode = typeof body.mode === 'string' ? body.mode : '';
  if (!ALLOWED.has(mode)) {
    // Silent 204 rather than an error: a stale tab emitting a retired event name should
    // never surface a failure to a clinician mid-visit.
    return { statusCode: 204, headers, body: '' };
  }
  const sessionId = (typeof body.session_id === 'string' && SAFE_SESSION.test(body.session_id))
    ? body.session_id : null;

  // Fire-and-forget by contract, but awaited here so the Lambda is not frozen mid-write.
  await logUsage({
    tool: 'AI Scribe',
    mode: mode,
    event: 'workflow',          // distinguishes these from the 'interaction' model-call rows
    email: session.claims && session.claims.email,
    tier: session.claims && session.claims.tier,
    sessionId: sessionId
  });

  return { statusCode: 204, headers, body: '' };
};
