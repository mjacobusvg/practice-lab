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

async function verifyMember(email, siteUrl) {
  try {
    const res = await fetch(siteUrl.replace(/\/$/, '') + '/.netlify/functions/circle-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    });
    const data = await res.json().catch(() => ({}));
    return !!data.verified;
  } catch (e) { return false; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ubcrrrapedaxkguxniwv.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const SITE_URL = process.env.SITE_URL || 'https://thinkbeyondpractice.com';
  if (!SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const providerEmail = (body.providerEmail || '').trim().toLowerCase();
  const action = (body.action || 'list').trim();
  if (!providerEmail) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'providerEmail required' }) };
  }

  const verified = await verifyMember(providerEmail, SITE_URL);
  if (!verified) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'No active membership found.' }) };
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── list ──
  if (action === 'list') {
    const { data, error } = await sb
      .from('assessment_schedules')
      .select('id, patient_label, instrument_set, cadence, next_run_at, end_date, status, sends_count, last_run_at, created_at')
      .eq('provider_email', providerEmail)
      .neq('status', 'ended')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not load schedules' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, schedules: data || [] }) };
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

    const { data, error } = await sb
      .from('assessment_schedules')
      .insert({
        provider_email: providerEmail,
        patient_hash: patientHash,
        patient_email: patientEmail,
        patient_label: patientLabel,
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
