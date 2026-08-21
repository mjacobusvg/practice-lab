// netlify/functions/letter-view.js
//
// Patient-facing letter retrieval for the pay-to-release flow. Given the row's
// access_token (?c=), returns the letter PDF inline — but ONLY while the charge is
// paid and the retention window is open. Possession of the (192-bit random) token is
// the credential; no login, since patients are not members.
//
// Returns:
//   200 application/pdf   - paid + unexpired: the letter bytes
//   402                   - found but not paid yet
//   410                   - expired or the PDF was purged/deleted
//   404                   - unknown token
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const token = String(q.c || q.token || '').trim();
  const jsonHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!token) return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Missing link token.' }) };

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Server configuration error.' }) };
  const sbHeaders = { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY };

  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/letter_charges?access_token=eq.' +
      encodeURIComponent(token) +
      '&select=status,pdf_base64,pdf_filename,expires_at,pdf_purged_at,deleted_at&limit=1', { headers: sbHeaders });
    const rows = res.ok ? await res.json() : [];
    const row = rows[0];
    if (!row) return { statusCode: 404, headers: jsonHeaders, body: JSON.stringify({ error: 'This letter link is not valid.' }) };

    if (row.status !== 'paid') {
      return { statusCode: 402, headers: jsonHeaders, body: JSON.stringify({ error: 'This letter has not been paid for yet.' }) };
    }
    const expired = row.expires_at && new Date(row.expires_at) < new Date();
    if (row.deleted_at || row.pdf_purged_at || expired || !row.pdf_base64) {
      return { statusCode: 410, headers: jsonHeaders, body: JSON.stringify({ error: 'This letter link has expired. Please contact your clinician for a new copy.' }) };
    }

    const filename = (row.pdf_filename || 'letter.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="' + filename + '"',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      },
      body: row.pdf_base64,          // already base64
      isBase64Encoded: true
    };
  } catch (err) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
