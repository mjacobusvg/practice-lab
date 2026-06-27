// netlify/functions/assessment-autosend-run.js
//
// Cron-invoked (hourly via pg_cron + pg_net). Finds due active recurring
// schedules and, for each, creates a normal pending tokenized assessment and
// emails the patient the secure link — identical to a manual email send, just
// fired on a schedule. Advances next_run_at by the cadence; ends schedules that
// have passed their end_date.
//
// Protected by AUTOSEND_SECRET (must match the header the cron sends) so the
// endpoint cannot be triggered by the public.
//
// Stored-PHI-under-BAA feature; email-path only (no SMS/TCPA). See
// COMPLIANCE-INTEGRATION.md.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SITE_URL, AUTOSEND_SECRET

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Autosend-Secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const TOKEN_TTL_DAYS = 14;

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
  const SITE_URL = (process.env.SITE_URL || 'https://thinkbeyondpractice.com').replace(/\/$/, '');
  const AUTOSEND_SECRET = process.env.AUTOSEND_SECRET;

  if (!SERVICE_KEY || !AUTOSEND_SECRET) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  // Authenticate the caller (cron). Reject anything without the shared secret.
  const provided = event.headers['x-autosend-secret'] || event.headers['X-Autosend-Secret'];
  if (provided !== AUTOSEND_SECRET) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const now = new Date();

  // End any schedules past their end_date.
  await sb.from('assessment_schedules')
    .update({ status: 'ended' })
    .eq('status', 'active')
    .not('end_date', 'is', null)
    .lte('end_date', now.toISOString());

  // Find due active schedules.
  const { data: due, error: dueErr } = await sb
    .from('assessment_schedules')
    .select('*')
    .eq('status', 'active')
    .lte('next_run_at', now.toISOString())
    .limit(200);

  if (dueErr) {
    console.error('autosend-run due query failed:', dueErr);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Query failed' }) };
  }

  let fired = 0, failed = 0;

  for (const sch of (due || [])) {
    try {
      const token = crypto.randomBytes(24).toString('base64url');
      const expiresAt = new Date(now.getTime() + TOKEN_TTL_DAYS * 86400000);

      // Create the pending assessment (mirrors assessment-create insert).
      const { error: insErr } = await sb
        .from('assessments')
        .insert({
          token: token,
          provider_email: sch.provider_email,
          patient_name: sch.patient_label || null,
          instrument_set: sch.instrument_set,
          reason_sent: sch.reason_sent || 'monitoring',
          patient_hash: sch.patient_hash,
          status: 'pending',
          expires_at: expiresAt.toISOString()
        });
      if (insErr) { console.error('autosend insert failed for schedule', sch.id, insErr); failed++; continue; }

      // Email the patient the secure link + the opt-out link.
      const link = SITE_URL + '/assessment.html?t=' + encodeURIComponent(token);
      const optOut = SITE_URL + '/.netlify/functions/assessment-optout?k=' + encodeURIComponent(sch.opt_out_token);
      const emailBody =
        'Your healthcare provider has asked you to complete a brief, confidential questionnaire as part of ongoing monitoring of your care.\n\n' +
        'Please use the secure link below. It will expire in ' + TOKEN_TTL_DAYS + ' days and can be used once.\n\n' +
        link + '\n\n' +
        'This is not an emergency service. If you are in crisis or may harm yourself or someone else, call or text 988 (Suicide & Crisis Lifeline) or go to the nearest emergency department.\n\n' +
        '---\n' +
        'You are receiving this on a recurring schedule set up by your provider. To stop receiving these scheduled questionnaires at any time, use this link: ' + optOut + '\n' +
        'Stopping these messages will not affect any other communication from your provider\u2019s office.';

      try {
        await fetch(SITE_URL + '/.netlify/functions/send-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: sch.patient_email,
            subject: 'A questionnaire from your provider',
            body: emailBody,
            tool: 'Assessment Suite'
          })
        });
      } catch (e) {
        console.error('autosend email failed for schedule', sch.id, e);
        // Assessment was created; the clinician will still see it. Continue.
      }

      // Advance the schedule.
      const nextRun = addCadence(sch.next_run_at, sch.cadence);
      const update = {
        next_run_at: nextRun.toISOString(),
        last_run_at: now.toISOString(),
        sends_count: (sch.sends_count || 0) + 1
      };
      // If the advanced next run is past the end_date, end it now.
      if (sch.end_date && new Date(nextRun) > new Date(sch.end_date)) {
        update.status = 'ended';
      }
      await sb.from('assessment_schedules').update(update).eq('id', sch.id);
      fired++;
    } catch (e) {
      console.error('autosend-run unexpected error for schedule', sch.id, e);
      failed++;
    }
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, fired: fired, failed: failed }) };
};
