var { verifyToken } = require('./_lib/session');
// netlify/functions/letter-log.js
// Sent-log for the Letter Generator. Stores a delivery record and, optionally, the
// composited PDF for a clinician-set retention window. Identity is derived from the
// verified signed token, never client-supplied email. RLS is enabled on the table;
// this function uses the service key and is the only writer/reader.
//
// Retention model (per platform principle: retention is permissible under the BAA as a
// risk decision): the PDF is stored with an expires_at; a pg_cron job nulls the PDF
// after expiry while keeping the metadata row as a permanent delivery record. The
// clinician can also delete the PDF early via action:'delete'.
//
// Actions:
//   'log'    (default) - insert a delivery record; optionally store pdf_base64 + retention
//   'list'   - return this clinician's recent records (no PDF bytes, just metadata + flags)
//   'delete' - early-purge the PDF for one record id owned by this clinician

var DEFAULT_RETENTION_DAYS = 14;
var MAX_RETENTION_DAYS = 90;

function resp(headers, status, obj) {
  return { statusCode: status, headers: headers, body: JSON.stringify(obj) };
}

exports.handler = async function(event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') return resp(headers, 405, { error: 'Method not allowed' });

  try {
    var payload = JSON.parse(event.body || '{}');

    // AUTH: full-tier member only; identity from the signed token.
    var authHeader = event.headers.authorization || event.headers.Authorization || '';
    var sessionToken = (payload.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
    var session = verifyToken(sessionToken);
    if (!session.valid) return resp(headers, 401, { error: 'Invalid or expired session.' });
    if (!(session.claims.scope === 'member' && session.claims.tier === 'full')) {
      return resp(headers, 403, { error: 'Full membership required.' });
    }

    var clinicianEmail = (session.claims.email || '').toLowerCase();
    var supabaseUrl = process.env.SUPABASE_URL;
    var supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return resp(headers, 200, { ok: false, reason: 'storage_not_configured' });
    }

    var sb = supabaseUrl.replace(/\/$/, '') + '/rest/v1/letter_send_log';
    var sbHeaders = {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': 'Bearer ' + supabaseKey
    };
    var action = payload.action || 'log';

    // ---- LIST: clinician's own records, newest first, metadata only ----
    if (action === 'list') {
      var sel = sb +
        '?clinician_email=eq.' + encodeURIComponent(clinicianEmail) +
        '&deleted_at=is.null' +
        '&select=id,letter_type,channel,recipient_masked,subject,status,created_at,expires_at,pdf_purged_at,pdf_filename,pdf_base64' +
        '&order=created_at.desc&limit=100';
      var listRes = await fetch(sel, { headers: sbHeaders });
      if (!listRes.ok) return resp(headers, 200, { ok: false, detail: (await listRes.text()).slice(0, 200) });
      var rows = await listRes.json();
      // Strip the heavy pdf_base64 from the response; expose only whether a PDF is retained.
      var out = rows.map(function (r) {
        return {
          id: r.id,
          letter_type: r.letter_type,
          channel: r.channel,
          recipient_masked: r.recipient_masked,
          subject: r.subject,
          status: r.status,
          created_at: r.created_at,
          expires_at: r.expires_at,
          pdf_retained: !!r.pdf_base64,
          pdf_purged_at: r.pdf_purged_at,
          pdf_filename: r.pdf_filename
        };
      });
      return resp(headers, 200, { ok: true, records: out });
    }

    // ---- DELETE: early-purge the PDF for one record owned by this clinician ----
    if (action === 'delete') {
      var id = String(payload.id || '');
      if (!id) return resp(headers, 400, { error: 'Missing id.' });
      var patchUrl = sb +
        '?id=eq.' + encodeURIComponent(id) +
        '&clinician_email=eq.' + encodeURIComponent(clinicianEmail);
      var delRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ pdf_base64: null, pdf_purged_at: new Date().toISOString() })
      });
      if (!delRes.ok) return resp(headers, 200, { ok: false, detail: (await delRes.text()).slice(0, 200) });
      return resp(headers, 200, { ok: true, deleted: id });
    }

    // ---- LOG (default): insert a delivery record, optionally storing the PDF ----
    var recipientMasked = String(payload.recipientMasked || '').slice(0, 64);
    var storePdf = payload.pdfBase64 ? String(payload.pdfBase64) : null;
    var retentionDays = parseInt(payload.retentionDays, 10);
    if (isNaN(retentionDays) || retentionDays < 1) retentionDays = DEFAULT_RETENTION_DAYS;
    if (retentionDays > MAX_RETENTION_DAYS) retentionDays = MAX_RETENTION_DAYS;

    var expiresAt = null;
    if (storePdf) {
      expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
    }

    var row = {
      clinician_email: clinicianEmail,
      letter_type: String(payload.letterType || 'Clinical Letter').slice(0, 120),
      channel: (payload.channel === 'fax' ? 'fax' : 'email'),
      recipient_masked: recipientMasked,
      subject: String(payload.subject || '').slice(0, 200),
      status: String(payload.status || 'sent').slice(0, 24),
      pdf_base64: storePdf,
      pdf_filename: storePdf ? String(payload.pdfFilename || 'letter.pdf').slice(0, 160) : null,
      expires_at: expiresAt,
      created_at: new Date().toISOString()
    };

    var insRes = await fetch(sb, {
      method: 'POST',
      headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=minimal' }),
      body: JSON.stringify(row)
    });
    if (!insRes.ok) {
      return resp(headers, 200, { ok: false, logged: false, detail: (await insRes.text()).slice(0, 200) });
    }
    return resp(headers, 200, { ok: true, logged: true, retainedUntil: expiresAt });

  } catch (err) {
    // Logging must never break a successful send.
    return resp(headers, 200, { ok: false, error: err.message });
  }
};
