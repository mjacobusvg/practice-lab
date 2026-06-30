// netlify/functions/letter-sign-submit.js
// Flavor B e-sign submit. The patient-facing signing page (medicaid-sign.html) POSTs the
// typed patient fields + typed-name signature here. This function:
//   1. Validates the single-use signing token (pending + not expired).
//   2. Loads the standard + provider vault, resolves placeholders, fills the patient-typed
//      fields, and builds the EXECUTED PDF in memory (patient identifiers + provider signature).
//   3. Emails the executed PDF to the return address (Jesse) via SES.
//   4. Marks the token signed.
// It stores NO patient PHI: the typed fields live only in this request and the in-memory PDF,
// which is emailed and discarded. Nothing patient-identifying is written to the database.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SES_AWS_*, PUBLIC_BASE_URL

const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const { buildLetterPdf } = require('./_lib/build-letter-pdf');

const FROM_NAME = 'Think Beyond Practice';
const FROM_ADDRESS = 'support@thinkbeyondpractice.com';

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const token = (body.token || '').trim();
  const fields = body.fields || {};      // { patient_name, patient_dob, p1_id, mco_plan }
  const typedName = (body.typed_name || '').trim();
  const attested = body.attested === true;

  if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing token' }) };
  if (!typedName || typedName.length < 2) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please type your full name to sign.' }) };
  if (!attested) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please confirm the acknowledgment to sign.' }) };
  if (!fields.patient_name || !fields.patient_dob) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name and date of birth are required.' }) };
  }

  function sb(path, opts) {
    opts = opts || {};
    return fetch(SUPABASE_URL + '/rest/v1/' + path, {
      method: opts.method || 'GET',
      headers: Object.assign({
        'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json', 'Accept': 'application/json'
      }, opts.headers || {}),
      body: opts.body
    });
  }

  try {
    // 1. Validate token.
    const tokRes = await sb('letter_sign_tokens?token=eq.' + encodeURIComponent(token) + '&select=*&limit=1');
    const tokArr = await tokRes.json();
    const tok = tokArr && tokArr[0];
    if (!tok) return { statusCode: 404, headers, body: JSON.stringify({ error: 'This signing link is not valid.' }) };
    if (tok.status === 'signed') return { statusCode: 409, headers, body: JSON.stringify({ error: 'This form has already been signed.' }) };
    if (tok.status === 'expired' || new Date(tok.expires_at) < new Date()) {
      return { statusCode: 410, headers, body: JSON.stringify({ error: 'This signing link has expired. Please contact your provider for a new one.' }) };
    }

    // 2. Load standard + provider vault.
    const stdRes = await sb('tbp_letter_standards?id=eq.' + tok.standard_id +
      '&select=body_template,placeholders,optional_toggles,spec');
    const std = (await stdRes.json())[0];
    if (!std) throw new Error('standard not found');
    const noLetterhead = !!(std.spec && std.spec.no_letterhead);

    const vaultRes = await sb('user_tool_data?tool_id=eq.vault_profile&email=eq.' +
      encodeURIComponent(tok.provider_email) + '&select=data&limit=1');
    const vault = ((await vaultRes.json())[0] || {}).data || {};

    // Resolve provider/auto placeholders.
    const placeholders = {};
    const defs = std.placeholders || [];
    defs.forEach(function (p) {
      if (p.source === 'vault') placeholders[p.key] = vaultValue(vault, p.key);
      else if (p.source === 'auto' && p.default_value === 'today') placeholders[p.key] = formatToday(0);
      else if (p.source === 'auto' && /^today\+\d+$/.test(p.default_value || '')) placeholders[p.key] = formatToday(parseInt(p.default_value.split('+')[1], 10));
      else if (p.default_value) placeholders[p.key] = p.default_value;
    });

    const toggles = {};
    (std.optional_toggles || []).forEach(function (t) { toggles[t.key] = t.default_value; });
    Object.assign(toggles, tok.toggles || {});

    // 3. Build the EXECUTED PDF in memory: start from the standard body, then overlay the
    // patient-typed fields and the typed-name patient signature into the patient block.
    // The provider signature is composited from vault as usual (sign flag from the token).
    const filledBody = fillPatientBlock(std.body_template, fields, typedName);

    const pdfBytes = await buildLetterPdf({
      bodyTemplate: filledBody,
      placeholders: placeholders,
      toggles: toggles,
      placeholderDefs: defs,
      vault: vault,
      sign: tok.sign !== false,
      noLetterhead: noLetterhead
    });
    const pdfB64 = Buffer.from(pdfBytes).toString('base64');

    // 4. Email the executed PDF to the return address (Jesse). Patient name in subject only
    // so Jesse can file it; nothing stored server-side.
    const returnEmail = tok.return_email || 'jesse@corspokane.com';
    const subj = 'Signed Private-Pay Acknowledgment - ' + fields.patient_name;
    const noteLines = [
      'A patient has completed and signed the Private-Pay Acknowledgment online.',
      '',
      'The executed PDF is attached. Please upload it to the patient chart.',
      '',
      'Patient: ' + fields.patient_name,
      'Signed (typed name): ' + typedName,
      'Signed at: ' + new Date().toISOString(),
      '',
      'This copy was generated at signing and is not retained by the platform.'
    ].join('\n');

    const rawMime = buildRawMime({
      fromName: FROM_NAME, fromAddress: FROM_ADDRESS, to: returnEmail,
      subject: subj, textBody: noteLines,
      attachmentBase64: pdfB64,
      attachmentFilename: 'Signed-Private-Pay-Acknowledgment.pdf',
      attachmentContentType: 'application/pdf'
    });

    await sesClient().send(new SendEmailCommand({
      FromEmailAddress: FROM_NAME + ' <' + FROM_ADDRESS + '>',
      Destination: { ToAddresses: [returnEmail] },
      Content: { Raw: { Data: Buffer.from(rawMime, 'utf8') } }
    }));

    // Mark token signed (no patient data recorded - just state + timestamp).
    await sb('letter_sign_tokens?id=eq.' + tok.id, {
      method: 'PATCH', headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: 'signed', signed_at: new Date().toISOString() })
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

// Replaces the blank patient lines in the form body with the patient's typed values, and
// drops their typed name onto the "Patient/Legal Representative Signature" line. Operates on
// the template text only; nothing is persisted.
function fillPatientBlock(tpl, f, typedName) {
  let out = tpl;
  out = out.replace(/Patient Name: _+/, 'Patient Name: ' + (f.patient_name || ''));
  out = out.replace(/Date of Birth: _+/, 'Date of Birth: ' + (f.patient_dob || ''));
  out = out.replace(/ProviderOne Client ID Number: _+/, 'ProviderOne Client ID Number: ' + (f.p1_id || ''));
  out = out.replace(/Apple Health Managed Care Plan, if applicable: _+/, 'Apple Health Managed Care Plan, if applicable: ' + (f.mco_plan || ''));
  out = out.replace(/Patient\/Legal Representative Signature: _+/, 'Patient/Legal Representative Signature: ' + typedName + '  (signed electronically)');
  out = out.replace(/Printed Name: _+/, 'Printed Name: ' + (f.patient_name || ''));
  // Patient "Date:" line directly after the printed-name line -> today.
  out = out.replace(/(Patient\/Legal Representative Signature:[^\n]*\nPrinted Name:[^\n]*\nDate: )_+/, '$1' + formatToday(0));
  return out;
}

function sesClient() {
  const region = process.env.SES_AWS_REGION || process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1';
  const accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const cfg = { region: region };
  if (accessKeyId && secretAccessKey) cfg.credentials = { accessKeyId: accessKeyId, secretAccessKey: secretAccessKey };
  return new SESv2Client(cfg);
}

function vaultValue(v, key) {
  switch (key) {
    case 'PROVIDER_NAME': return v.legalName || v.providerName || v.name || '';
    case 'PROVIDER_CREDENTIALS': return v.credentials || '';
    case 'PROVIDER_PRACTICE': return v.practiceName || '';
    case 'PROVIDER_NPI': return v.npi1 || v.npi || '';
    default: return '';
  }
}
function formatToday(o) {
  const m = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const d = new Date(); d.setDate(d.getDate() + (o || 0));
  return m[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}
function buildRawMime(o) {
  const CRLF = '\r\n';
  const mixed = 'mixed_' + Math.random().toString(36).slice(2);
  function header(n, v) { return n + ': ' + v + CRLF; }
  let msg = '';
  msg += header('From', o.fromName + ' <' + o.fromAddress + '>');
  msg += header('To', o.to);
  if (o.replyTo) msg += header('Reply-To', o.replyTo);
  msg += header('Subject', mimeEncodeHeader(o.subject));
  msg += header('MIME-Version', '1.0');
  msg += header('Content-Type', 'multipart/mixed; boundary="' + mixed + '"');
  msg += CRLF;
  msg += '--' + mixed + CRLF;
  msg += header('Content-Type', 'text/plain; charset="UTF-8"');
  msg += header('Content-Transfer-Encoding', 'base64');
  msg += CRLF;
  msg += chunk76(Buffer.from(o.textBody, 'utf8').toString('base64')) + CRLF;
  msg += '--' + mixed + CRLF;
  msg += header('Content-Type', o.attachmentContentType + '; name="' + o.attachmentFilename + '"');
  msg += header('Content-Transfer-Encoding', 'base64');
  msg += header('Content-Disposition', 'attachment; filename="' + o.attachmentFilename + '"');
  msg += CRLF;
  msg += chunk76(o.attachmentBase64) + CRLF;
  msg += '--' + mixed + '--' + CRLF;
  return msg;
}
function chunk76(b64) { return (b64 || '').replace(/(.{76})/g, '$1\r\n'); }
function mimeEncodeHeader(s) {
  s = s || '';
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}
