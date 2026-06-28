// netlify/functions/assessment-optout.js
//
// Public (no auth). A patient clicks the opt-out link in an autosend email;
// this ends the matching recurring schedule by its opt_out_token and returns a
// simple HTML confirmation. GET so it works directly from an email link.
//
// No PHI is exposed: the token is opaque and maps to a single schedule. We never
// echo patient details back.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

function page(message) {
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Scheduled questionnaires</title>' +
    '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1b2d;color:#ede6d8;' +
    'display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}' +
    '.card{max-width:460px;background:#16243a;border:1px solid #24344d;border-radius:12px;padding:32px;text-align:center}' +
    'h1{font-size:1.15rem;margin:0 0 12px}p{font-size:.92rem;line-height:1.6;color:#c8bfae;margin:0}</style>' +
    '</head><body><div class="card"><h1>Scheduled questionnaires</h1><p>' + message + '</p></div></body></html>';
}

exports.handler = async (event) => {
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ubcrrrapedaxkguxniwv.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const HTML = { 'Content-Type': 'text/html; charset=utf-8' };

  if (!SERVICE_KEY) {
    return { statusCode: 500, headers: HTML, body: page('This service is temporarily unavailable. Please contact your provider\u2019s office.') };
  }

  const token = (event.queryStringParameters && event.queryStringParameters.k) || '';
  if (!token) {
    return { statusCode: 400, headers: HTML, body: page('This link is not valid. Please contact your provider\u2019s office if you wish to stop receiving questionnaires.') };
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // End the schedule with this opt-out token (idempotent).
  const { data, error } = await sb
    .from('assessment_schedules')
    .update({ status: 'ended' })
    .eq('opt_out_token', token)
    .select('id')
    .maybeSingle();

  if (error) {
    return { statusCode: 500, headers: HTML, body: page('Something went wrong. Please contact your provider\u2019s office to stop these questionnaires.') };
  }
  if (!data) {
    // Token not found OR already ended — present success either way (no info leak).
    return { statusCode: 200, headers: HTML, body: page('You will not receive further scheduled questionnaires. If you continue to receive them, please contact your provider\u2019s office.') };
  }

  return { statusCode: 200, headers: HTML, body: page('You have been unsubscribed. You will not receive further scheduled questionnaires from your provider through this service. Any questionnaire your provider sends you individually will still reach you.') };
};
