// netlify/functions/assessment-submit.js
//
// PUBLIC (no auth). Patient form posts the token + responses + consent. Scores
// server-side, stores the PHI-bearing result, records consent (IP/UA captured
// here), marks the token consumed, and writes deidentified_meta to the parent
// row. Returns ONLY a neutral confirmation — never scores, never interpretation.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');
const instruments = require('./assessment-instruments.js');

const CURRENT_ASSESSMENT_CONSENT_VERSION = 'assessment_v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const GENERIC_UNAVAILABLE = 'This questionnaire link is not available. It may have expired or already been completed. Please contact your provider\u2019s office.';

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
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request' }) }; }

  const token = (body.token || '').trim();
  const responsesByInstrument = body.responses && typeof body.responses === 'object' ? body.responses : null;
  const consentGiven = body.consent === true;

  if (!token || !responsesByInstrument) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, message: 'Missing token or responses.' }) };
  }
  if (!consentGiven) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, message: 'Consent acknowledgment is required to submit.' }) };
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Load and validate the assessment (must be pending + unexpired).
  const { data: assessment, error: loadErr } = await sb
    .from('assessments')
    .select('id, instrument_set, status, expires_at, provider_email')
    .eq('token', token)
    .maybeSingle();

  if (loadErr) {
    console.error('assessment-submit load failed:', loadErr);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, message: GENERIC_UNAVAILABLE }) };
  }
  if (!assessment || assessment.status !== 'pending' || new Date(assessment.expires_at) < new Date()) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, message: GENERIC_UNAVAILABLE }) };
  }

  // Score server-side. Only score instruments that belong to this assessment AND
  // have at least one answered item (guard against empty/zero artifacts).
  const scopedResponses = {};
  for (let i = 0; i < assessment.instrument_set.length; i++) {
    const id = assessment.instrument_set[i];
    const r = responsesByInstrument[id];
    if (r && typeof r === 'object' && Object.keys(r).length > 0) {
      scopedResponses[id] = r;
    }
  }
  if (Object.keys(scopedResponses).length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, message: 'No responses were provided.' }) };
  }
  const battery = instruments.scoreBattery(scopedResponses);
  const meta = instruments.deidentifiedMetadata(battery);

  const completedAt = new Date().toISOString();

  // Store PHI-bearing result.
  const { error: resultErr } = await sb
    .from('assessment_results')
    .insert({
      assessment_id: assessment.id,
      responses: scopedResponses,
      scores: battery.results,
      flags: battery.flags
    });

  if (resultErr) {
    console.error('assessment-submit result insert failed:', resultErr);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, message: 'Could not submit. Please try again.' }) };
  }

  // Mark consumed + write deidentified metadata to the parent row.
  const { error: updErr } = await sb
    .from('assessments')
    .update({ status: 'completed', completed_at: completedAt, deidentified_meta: meta })
    .eq('id', assessment.id);

  if (updErr) {
    console.error('assessment-submit status update failed:', updErr);
    // Result is stored; don't block the patient. Log and continue.
  }

  // Record patient consent (IP/UA captured server-side; mirrors record-terms-acceptance).
  const ip =
    (event.headers['x-nf-client-connection-ip']) ||
    (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    null;
  const userAgent = event.headers['user-agent'] || null;

  const { error: consentErr } = await sb
    .from('assessment_consents')
    .insert({
      assessment_id: assessment.id,
      token: token,
      consent_version: CURRENT_ASSESSMENT_CONSENT_VERSION,
      ip_address: ip,
      user_agent: userAgent
    });
  if (consentErr) {
    console.error('assessment-submit consent insert failed:', consentErr);
    // Non-fatal for the patient experience; logged.
  }

  // Notify the provider that a screener has returned. PHI-FREE by design:
  // no patient name, no instruments, no scores, no risk flag in the email body.
  // Best-effort; never blocks the patient confirmation.
  try {
    if (assessment.provider_email) {
      const base = (process.env.SITE_URL || 'https://thinkbeyondpractice.com').replace(/\/$/, '');
      await fetch(base + '/.netlify/functions/send-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: assessment.provider_email,
          subject: 'A patient assessment has been returned',
          body: 'A patient assessment has been returned and is ready to review in the Assessment Suite. Log in to view the results.\n\nThis message intentionally contains no patient information.',
          tool: 'Assessment Suite'
        })
      });
    }
  } catch (e) {
    console.error('assessment-submit provider notification failed (non-fatal):', e);
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      message: 'Your responses have been submitted to your provider.'
    })
  };
};
