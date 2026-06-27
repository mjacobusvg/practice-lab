// netlify/functions/assessment-list.js
//
// Provider-authenticated. Returns the assessments the provider has sent.
//
// SECURITY (hardened): provider identity comes from the SIGNED SESSION TOKEN
// (verified via _lib/session.js), NOT a client-supplied providerEmail. The list
// is scoped to the token's verified email, so a caller cannot enumerate another
// provider's patient list.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET

const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('./_lib/session');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
  if (!SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request' }) }; }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.', reason: session.reason }) };
  }
  if (session.claims.scope !== 'member') {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'This tool requires full membership.' }) };
  }
  const providerEmail = (session.claims.email || '').trim().toLowerCase();
  if (!providerEmail) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Session missing identity.' }) };
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

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
