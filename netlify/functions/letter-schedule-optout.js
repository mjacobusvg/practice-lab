// netlify/functions/letter-schedule-optout.js
// Patient-facing opt-out. The recurring cover email includes a link to this endpoint with
// the schedule's opt_out_token. Clicking it sets the schedule status to 'opted_out' so no
// further recurring sends occur. No auth/login: the unguessable token IS the authorization
// (same model as the Assessment Suite patient opt-out). Returns a simple HTML confirmation.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

exports.handler = async function (event) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const htmlHeaders = { 'Content-Type': 'text/html; charset=utf-8' };

  const token = ((event.queryStringParameters || {}).token || '').trim();
  if (!token) {
    return { statusCode: 400, headers: htmlHeaders, body: page('Invalid link', 'This unsubscribe link is missing its token.') };
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers: htmlHeaders, body: page('Something went wrong', 'Please contact the practice directly.') };
  }

  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/letter_schedules?opt_out_token=eq.' +
      encodeURIComponent(token) + '&select=id,status', {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY, 'Accept': 'application/json' }
    });
    const arr = await res.json();
    const sch = arr && arr[0];
    if (!sch) {
      return { statusCode: 200, headers: htmlHeaders, body: page('Already unsubscribed', 'This link is no longer active. You will not receive further renewal emails.') };
    }
    if (sch.status !== 'active') {
      return { statusCode: 200, headers: htmlHeaders, body: page('Already unsubscribed', 'You have already been unsubscribed from these renewal emails.') };
    }
    await fetch(SUPABASE_URL + '/rest/v1/letter_schedules?id=eq.' + sch.id, {
      method: 'PATCH',
      headers: {
        'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ status: 'opted_out', updated_at: new Date().toISOString() })
    });
    return { statusCode: 200, headers: htmlHeaders, body: page('Unsubscribed', 'You will no longer receive renewal emails for this agreement. If this was a mistake, please contact the practice directly.') };
  } catch (err) {
    return { statusCode: 500, headers: htmlHeaders, body: page('Something went wrong', 'Please contact the practice directly.') };
  }
};

function page(title, msg) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title><style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f7f7f5;color:#1c2138;' +
    'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#fff;max-width:460px;padding:32px 28px;' +
    'border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);text-align:center}h1{font-size:1.25rem;margin:0 0 10px}p{line-height:1.5;color:#444}</style></head>' +
    '<body><div class="card"><h1>' + esc(title) + '</h1><p>' + esc(msg) + '</p></div></body></html>';
}
function esc(s) { return String(s || '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
