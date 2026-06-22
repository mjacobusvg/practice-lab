// netlify/functions/assessment-list.js
//
// Provider-authenticated. Returns the list of assessments the provider has sent
// (pending + completed + retrieved), with patient_name and status so they can
// find and retrieve results. Verifies Circle membership and that the requesting
// provider owns each row (provider_email match).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CIRCLE_API_V2_TOKEN

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ubcrrrapedaxkguxniwv.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const CIRCLE_TOKEN = process.env.CIRCLE_API_V2_TOKEN;
  if (!SERVICE_KEY || !CIRCLE_TOKEN) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request' }) }; }

  const providerEmail = (body.providerEmail || '').trim().toLowerCase();
  if (!providerEmail) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'providerEmail required' }) };
  }

  // Verify Circle membership.
  try {
    const verifyRes = await fetch(
      'https://app.circle.so/api/v1/community_members/search?email=' + encodeURIComponent(providerEmail),
      { headers: { 'Authorization': 'Token ' + CIRCLE_TOKEN } }
    );
    if (!verifyRes.ok) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Could not verify membership.' }) };
    }
    const memberData = await verifyRes.json();
    const member = Array.isArray(memberData) ? memberData[0] : memberData;
    if (!member || !member.id) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'No active membership found.' }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Membership verification failed.' }) };
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data, error } = await sb
    .from('assessments')
    .select('id, token, patient_name, instrument_set, status, created_at, expires_at, completed_at, retrieved_at, deidentified_meta, purged_at')
    .eq('provider_email', providerEmail)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.error('assessment-list query failed:', error);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not load assessments' }) };
  }

  // Shape for the dashboard. Include a hasFlags hint from deidentified_meta so the
  // provider sees a risk indicator before retrieving (without exposing scores).
  const items = (data || []).map(function (r) {
    var hasFlags = false;
    if (Array.isArray(r.deidentified_meta)) {
      for (var i = 0; i < r.deidentified_meta.length; i++) {
        if ((r.deidentified_meta[i].flagTypes || []).length) { hasFlags = true; break; }
      }
    }
    return {
      id: r.id,
      token: r.status === 'pending' ? r.token : null,
      patientName: r.patient_name,
      instrumentSet: r.instrument_set,
      status: r.status,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      completedAt: r.completed_at,
      retrievedAt: r.retrieved_at,
      purged: !!r.purged_at,
      hasFlags: hasFlags
    };
  });

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, assessments: items }) };
};
