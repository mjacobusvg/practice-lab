// netlify/functions/assessment-schedule.js
//
// Provider-authenticated CRUD for recurring autosend schedules.
//   action: 'create' - new recurring schedule (requires match key + patient email)
//   action: 'list'   - the provider's schedules
//   action: 'pause'  - pause an active schedule
//   action: 'resume' - resume a paused schedule
//   action: 'end'    - permanently end a schedule
//
// Stored-PHI-under-BAA; email-path only (no SMS/TCPA). Match key is hashed
// server-side identically to assessment-create (links autosends into trends);
// the raw name+DOB is never stored. patient_email IS stored long-term here —
// the one place it persists — because autosend must re-send unattended.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, MATCH_KEY_SALT (opt)

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const instruments = require('./assessment-instruments.js');
const { verifyToken } = require('./_lib/session');
const phiGate = require('./_lib/assessments-phi-gate');
const phiS3 = require('./_lib/phi-s3');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function addCadence(date, cadence) {
  const d = new Date(date);
  if (cadence === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (cadence === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (cadence === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
  return d;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ubcrrrapedaxkguxniwv.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Identity from signed token (body.token or Authorization: Bearer) — NOT a
  // client-supplied providerEmail. Assessment Suite is a full-member tool.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.', reason: session.reason }) };
  }
  if (!(session.claims.scope === 'member' && session.claims.tier === 'full')) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'This tool requires the full Think Beyond Practice membership.' }) };
  }
  const providerEmail = (session.claims.email || '').trim().toLowerCase();
  if (!providerEmail) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Session missing identity.' }) };
  }
  const action = (body.action || 'list').trim();

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── list ──
  if (action === 'list') {
    const { data, error } = await sb
      .from('assessment_schedules')
      .select('id, patient_label, patient_s3_key, instrument_set, cadence, next_run_at, end_date, status, sends_count, last_run_at, created_at')
      .eq('provider_email', providerEmail)
      .neq('status', 'ended')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not load schedules' }) };
    }
    // Patient label lives in S3 (new rows); resolve it, fall back to legacy column.
    const schedules = await Promise.all((data || []).map(async function (s) {
      var label = s.patient_label || null;
      if (s.patient_s3_key) { try { var p = await phiS3.getJson(s.patient_s3_key); if (p && p.patient_label) label = p.patient_label; } catch (e) {} }
      return { id: s.id, patient_label: label, instrument_set: s.instrument_set, cadence: s.cadence, next_run_at: s.next_run_at, end_date: s.end_date, status: s.status, sends_count: s.sends_count, last_run_at: s.last_run_at, created_at: s.created_at };
    }));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, schedules: schedules }) };
  }

  // ── pause / resume / end ──
  if (action === 'pause' || action === 'resume' || action === 'end') {
    const scheduleId = body.scheduleId;
    if (!scheduleId) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'scheduleId required' }) };
    }
    // Verify ownership.
    const { data: sch } = await sb
      .from('assessment_schedules')
      .select('id, provider_email, status')
      .eq('id', scheduleId)
      .maybeSingle();
    if (!sch || sch.provider_email !== providerEmail) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Not found' }) };
    }
    const newStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'ended';
    const { error: upErr } = await sb
      .from('assessment_schedules')
      .update({ status: newStatus })
      .eq('id', scheduleId);
    if (upErr) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Update failed' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, status: newStatus }) };
  }

  // ── create ──
  if (action === 'create') {
    // Compliance pause: a new schedule stores the patient email (PHI) long-term in
    // Supabase (no BAA). Blocked until schedule PHI moves to S3. List/pause/end stay open.
    if (phiGate.PAUSED) {
      return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: phiGate.MESSAGE }) };
    }
    const matchKeyRaw = (body.matchKey || '').trim();
    const patientEmail = (body.patientEmail || '').trim();
    const patientLabel = (body.patientLabel || '').trim() || null;
    const instrumentSet = Array.isArray(body.instrumentSet) ? body.instrumentSet : [];
    const cadence = (body.cadence || '').trim();
    const reasonSent = (body.reasonSent || 'monitoring').trim();
    const endDate = (body.endDate || '').trim() || null;

    if (!matchKeyRaw) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'A patient match key (name + DOB) is required for recurring sends.' }) };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmail)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'A valid patient email is required for autosend.' }) };
    }
    if (!instrumentSet.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Select at least one instrument.' }) };
    }
    for (let i = 0; i < instrumentSet.length; i++) {
      if (!instruments.isPatientSendAllowed(instrumentSet[i])) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Instrument not permitted: ' + instrumentSet[i] }) };
      }
    }
    if (['weekly', 'monthly', 'quarterly'].indexOf(cadence) === -1) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Cadence must be weekly, monthly, or quarterly.' }) };
    }

    // Hash the match key identically to assessment-create.
    const normalized = matchKeyRaw.toLowerCase().replace(/\s+/g, ' ').trim();
    const salt = (process.env.MATCH_KEY_SALT || 'tbp_assessment_v1') + '|' + providerEmail;
    const patientHash = crypto.createHmac('sha256', salt).update(normalized).digest('hex');

    const optOutToken = crypto.randomBytes(24).toString('base64url');
    // First send fires on the next cron tick (next_run_at = now).
    const nextRun = new Date();

    // Patient email + label (PHI) go to S3 under the AWS BAA, not Supabase. The row
    // keeps only the S3 key plus the non-identifying patient_hash used for matching.
    let schedPatientS3Key;
    try {
      schedPatientS3Key = await phiS3.putJson('assessments/schedule', { patient_email: patientEmail, patient_label: patientLabel });
    } catch (e) {
      console.error('schedule create: patient S3 store failed:', e);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not securely store patient details. Please try again.' }) };
    }

    const { data, error } = await sb
      .from('assessment_schedules')
      .insert({
        provider_email: providerEmail,
        patient_hash: patientHash,
        patient_s3_key: schedPatientS3Key,
        instrument_set: instrumentSet,
        reason_sent: reasonSent,
        cadence: cadence,
        next_run_at: nextRun.toISOString(),
        end_date: endDate,
        status: 'active',
        opt_out_token: optOutToken
      })
      .select('id, cadence, next_run_at, status')
      .single();

    if (error) {
      console.error('schedule create failed:', error);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not create schedule' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, schedule: data }) };
  }

  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
};
