// netlify/functions/assessment-create.js
//
// Provider-authenticated. Creates a pending tokenized assessment, stores the
// record (including the patient name as PHI), and returns the token URL. If
// delivery === 'email', also posts to send-document with the patient link.
//
// Verifies the requesting email is an active Circle member (same pattern as
// user-tool-data.js). The provider identity comes from the client's
// tbp_verified_email.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CIRCLE_API_V2_TOKEN, SITE_URL (opt)

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const instruments = require('./assessment-instruments.js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const TOKEN_TTL_DAYS = 14;

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
  const patientName = (body.patientName || '').trim() || null;
  const instrumentSet = Array.isArray(body.instrumentSet) ? body.instrumentSet : [];
  const delivery = (body.delivery || 'link').trim();           // 'link' | 'email'
  const patientEmail = (body.patientEmail || '').trim();
  const replyTo = (body.replyTo || '').trim() || null;

  if (!providerEmail) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'providerEmail required' }) };
  }
  if (!instrumentSet.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'At least one instrument required' }) };
  }

  // Validate every instrument is in the patient-send allowlist (rejects C-SSRS/ASQ
  // and anything not cleared).
  for (let i = 0; i < instrumentSet.length; i++) {
    if (!instruments.isPatientSendAllowed(instrumentSet[i])) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'Instrument not permitted in patient-send: ' + instrumentSet[i] })
      };
    }
  }
  if (delivery === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmail)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Valid patientEmail required for email delivery' }) };
  }

  // Verify provider is an active member via the SAME path that gates the page:
  // the circle-auth function. Direct Circle v1 calls fail because the available
  // token is a v2 token (v1 endpoints reject it as unauthorized). circle-auth
  // uses the correct credentials server-side.
  try {
    const base = (process.env.SITE_URL || 'https://thinkbeyondpractice.com').replace(/\/$/, '');
    const verifyRes = await fetch(base + '/.netlify/functions/circle-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: providerEmail })
    });
    const verifyData = await verifyRes.json().catch(() => ({}));
    if (!verifyData.verified) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'No active membership found.' }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Membership verification failed.' }) };
  }

  // Generate an unguessable token (URL-safe).
  const token = crypto.randomBytes(24).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data, error } = await sb
    .from('assessments')
    .insert({
      token: token,
      provider_email: providerEmail,
      patient_name: patientName,
      instrument_set: instrumentSet,
      status: 'pending',
      expires_at: expiresAt.toISOString()
    })
    .select('id, token, expires_at')
    .single();

  if (error) {
    console.error('assessment create insert failed:', error);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not create assessment' }) };
  }

  const link = SITE_URL.replace(/\/$/, '') + '/assessment.html?t=' + encodeURIComponent(token);

  // Optional email delivery via the shared send-document function.
  let emailSent = null;
  if (delivery === 'email') {
    const emailBody =
      'Your healthcare provider has asked you to complete a brief, confidential questionnaire before your appointment.\n\n' +
      'Please use the secure link below. It will expire in ' + TOKEN_TTL_DAYS + ' days and can be used once.\n\n' +
      link + '\n\n' +
      'This is not an emergency service. If you are in crisis or may harm yourself or someone else, call or text 988 (Suicide & Crisis Lifeline) or go to the nearest emergency department.';
    try {
      const sendRes = await fetch(SITE_URL.replace(/\/$/, '') + '/.netlify/functions/send-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: patientEmail,
          subject: 'A questionnaire from your provider',
          body: emailBody,
          replyTo: replyTo,
          tool: 'Assessment Suite'
        })
      });
      const sendData = await sendRes.json().catch(() => ({}));
      emailSent = !!sendData.success;
    } catch (e) {
      emailSent = false;
    }
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      assessmentId: data.id,
      token: data.token,
      link: link,
      expiresAt: data.expires_at,
      delivery: delivery,
      emailSent: emailSent
    })
  };
};
