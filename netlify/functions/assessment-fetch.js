// netlify/functions/assessment-fetch.js
//
// PUBLIC (no auth). Patient form calls this with the token to learn which
// instruments to render. Returns ONLY render definitions (item text + options),
// never scoring logic, never provider PII beyond a generic display name.
//
// Fail-closed and generic: any invalid/expired/used token returns the same
// generic "not available" message to avoid token enumeration signal.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');
const instruments = require('./assessment-instruments.js');

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
  if (!token) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ ok: false, message: GENERIC_UNAVAILABLE }) };
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data, error } = await sb
    .from('assessments')
    .select('id, instrument_set, status, expires_at')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    console.error('assessment-fetch query failed:', error);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, message: GENERIC_UNAVAILABLE }) };
  }

  // Generic response for any non-usable state (fail-closed, no enumeration signal).
  if (!data || data.status !== 'pending' || new Date(data.expires_at) < new Date()) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, message: GENERIC_UNAVAILABLE }) };
  }

  // Build sanitized render definitions for each instrument in the set.
  const renderDefs = [];
  for (let i = 0; i < data.instrument_set.length; i++) {
    const def = instruments.getRenderDef(data.instrument_set[i]);
    if (def) renderDefs.push(def);
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      instruments: renderDefs,
      consentVersion: 'assessment_v1'
    })
  };
};
