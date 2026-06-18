// netlify/functions/record-terms-acceptance.js
//
// Records a member's acceptance of the Practice Manager Terms of Use.
// Uses the Supabase service key (server-side only) so the client never holds it,
// and captures the real client IP from the request headers.
//
// Mirrors the existing function pattern (CORS preflight, JSON body, Supabase insert).
// Env vars required (already set for the other functions):
//   SUPABASE_URL              -> https://ubcrrrapedaxkguxniwv.supabase.co
//   SUPABASE_SERVICE_KEY      -> service role key (server-side only)

const { createClient } = require('@supabase/supabase-js');

const CURRENT_TERMS_VERSION = 'interim_v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const action = (body.action || 'record').trim();        // 'check' or 'record'
  const email = (body.member_email || '').trim().toLowerCase();
  const name = (body.member_name || '').trim() || null;
  const version = (body.terms_version || CURRENT_TERMS_VERSION).trim();

  if (!email) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'member_email required' }) };
  }

  const SUPABASE_URL_EARLY = process.env.SUPABASE_URL || 'https://ubcrrrapedaxkguxniwv.supabase.co';
  const SERVICE_KEY_EARLY = process.env.SUPABASE_SERVICE_KEY;
  if (!SERVICE_KEY_EARLY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  // CHECK: has this member accepted the given terms version?
  if (action === 'check') {
    const sb = createClient(SUPABASE_URL_EARLY, SERVICE_KEY_EARLY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await sb
      .from('terms_acceptances')
      .select('id')
      .eq('member_email', email)
      .eq('terms_version', version)
      .maybeSingle();
    if (error) {
      console.error('terms check failed:', error);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'check failed' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, accepted: !!data, terms_version: version }) };
  }

  // Real client IP from Netlify / proxy headers
  const ip =
    (event.headers['x-nf-client-connection-ip']) ||
    (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    null;
  const userAgent = event.headers['user-agent'] || null;

  const supabase = createClient(SUPABASE_URL_EARLY, SERVICE_KEY_EARLY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Idempotent: one row per (email, version). If they already accepted this
  // version, treat as success and don't duplicate.
  const { error } = await supabase
    .from('terms_acceptances')
    .upsert(
      {
        member_email: email,
        member_name: name,
        terms_version: version,
        ip_address: ip,
        user_agent: userAgent
      },
      { onConflict: 'member_email,terms_version', ignoreDuplicates: true }
    );

  if (error) {
    console.error('terms acceptance insert failed:', error);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not record acceptance' }) };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, terms_version: version })
  };
};
