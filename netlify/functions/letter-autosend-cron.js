// netlify/functions/letter-autosend-cron.js
// Hourly worker (pg_cron -> this endpoint) that auto-sends scheduled recurring letters
// (e.g. the Medicaid Private-Pay Acknowledgment) to patients.
//
// For each DUE active schedule:
//   1. Load the standard (body_template/placeholders/toggles) + the provider's vault profile.
//   2. Build the finished PDF server-side (letterhead + signature composited) via _lib/build-letter-pdf.
//   3. Email the patient via SES: PDF attached + cover note listing fields they must hand-complete
//      + a one-click opt-out link.
//   4. Advance next_run_at by cadence_days, bump sends_count. On error, record last_error (don't advance).
//
// Auth: shared secret in AUTOSEND_SECRET (must match the pg_cron job header), same pattern as the
// Assessment Suite autosend. Patient PHI handling: only patient_email + a provider-chosen label are
// stored; patient name/DOB/ProviderOne/plan are NEVER stored (hand-filled on the form).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, AUTOSEND_SECRET,
//      SES_AWS_ACCESS_KEY_ID, SES_AWS_SECRET_ACCESS_KEY, SES_AWS_REGION,
//      PUBLIC_BASE_URL (e.g. https://thinkbeyondpractice.com) for the opt-out link.

const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const { buildLetterPdf } = require('./_lib/build-letter-pdf');

const FROM_NAME = 'Think Beyond Practice';
const FROM_ADDRESS = 'support@thinkbeyondpractice.com';

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };

  // Auth: only the cron (or an admin with the secret) may trigger sends.
  const provided = (event.headers['x-autosend-secret'] || event.headers['X-Autosend-Secret'] || '').trim();
  const secret = process.env.AUTOSEND_SECRET;
  if (!secret || provided !== secret) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing Supabase credentials' }) };
  }
  const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://thinkbeyondpractice.com';

  function sb(path, opts) {
    opts = opts || {};
    return fetch(SUPABASE_URL + '/rest/v1/' + path, {
      method: opts.method || 'GET',
      headers: Object.assign({
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }, opts.headers || {}),
      body: opts.body
    });
  }

  const results = { processed: 0, sent: 0, errors: 0, details: [] };

  try {
    const nowIso = new Date().toISOString();
    // Due = active, next_run_at passed, not past end_date.
    const dueRes = await sb('letter_schedules?status=eq.active&next_run_at=lte.' + encodeURIComponent(nowIso) +
      '&select=*&order=next_run_at.asc&limit=50');
    if (!dueRes.ok) {
      const t = await dueRes.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Schedule query failed', detail: t }) };
    }
    const due = await dueRes.json();

    for (const sch of due) {
      results.processed++;
      try {
        // End-dated schedules: close them out instead of sending.
        if (sch.end_date && new Date(sch.end_date) <= new Date()) {
          await sb('letter_schedules?id=eq.' + sch.id, {
            method: 'PATCH', headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ status: 'ended', updated_at: nowIso })
          });
          results.details.push({ id: sch.id, action: 'ended (past end_date)' });
          continue;
        }

        // 1. Load the standard.
        const stdRes = await sb('tbp_letter_standards?id=eq.' + sch.standard_id +
          '&select=body_template,placeholders,optional_toggles,category_label,spec');
        const stdArr = await stdRes.json();
        const std = stdArr && stdArr[0];
        if (!std) throw new Error('standard not found: ' + sch.standard_id);
        const noLetterhead = !!(std.spec && std.spec.no_letterhead);

        // Load the provider's vault profile (letterhead, signature, name, practice, npi).
        const vaultRes = await sb('user_tool_data?tool_id=eq.vault_profile&email=eq.' +
          encodeURIComponent(sch.provider_email) + '&select=data&limit=1');
        const vaultArr = await vaultRes.json();
        const vault = (vaultArr && vaultArr[0] && vaultArr[0].data) || {};

        // Resolve placeholders: vault-sourced + auto dates (today / today+N), per the standard's defs.
        const placeholders = {};
        const defs = std.placeholders || [];
        defs.forEach(function (p) {
          if (p.source === 'vault') {
            placeholders[p.key] = vaultValue(vault, p.key);
          } else if (p.source === 'auto' && p.default_value === 'today') {
            placeholders[p.key] = formatToday(0);
          } else if (p.source === 'auto' && /^today\+\d+$/.test(p.default_value || '')) {
            placeholders[p.key] = formatToday(parseInt(p.default_value.split('+')[1], 10));
          } else if (p.default_value) {
            placeholders[p.key] = p.default_value;
          }
        });

        // Toggles: use the schedule's stored toggle choices, else the standard defaults.
        const toggles = {};
        (std.optional_toggles || []).forEach(function (t) { toggles[t.key] = t.default_value; });
        Object.assign(toggles, sch.toggles || {});

        const esign = !!(std.spec && std.spec.esign);
        const returnEmail = sch.return_email || 'jesse@corspokane.com';
        const optOutUrl = BASE_URL + '/.netlify/functions/letter-schedule-optout?token=' +
          encodeURIComponent(sch.opt_out_token);
        const ses = sesClient();

        if (esign) {
          // E-SIGN (Flavor B): mint a single-use signing token and email the patient a link.
          // No PDF is attached and no patient PHI is stored; the patient types their fields
          // on the signing page, which builds the executed PDF in memory and sends it to Jesse.
          const signToken = require('crypto').randomBytes(24).toString('hex');
          const expires = new Date();
          expires.setDate(expires.getDate() + 21); // 21-day signing window
          const tokRes = await sb('letter_sign_tokens', {
            method: 'POST', headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({
              token: signToken,
              schedule_id: sch.id,
              standard_id: sch.standard_id,
              provider_email: sch.provider_email,
              toggles: toggles,
              sign: sch.sign !== false,
              return_email: returnEmail,
              status: 'pending',
              expires_at: expires.toISOString()
            })
          });
          if (!tokRes.ok) { const t = await tokRes.text(); throw new Error('sign-token insert failed: ' + t); }

          const signUrl = BASE_URL + '/medicaid-sign.html?t=' + encodeURIComponent(signToken);
          const subject = 'Action needed: sign your Private-Pay Acknowledgment';
          const textBody = buildSignLinkNote(signUrl, optOutUrl);
          const rawMime = buildRawMime({
            fromName: FROM_NAME, fromAddress: FROM_ADDRESS, to: sch.patient_email,
            replyTo: returnEmail, subject: subject, textBody: textBody
          });
          await ses.send(new SendEmailCommand({
            FromEmailAddress: FROM_NAME + ' <' + FROM_ADDRESS + '>',
            Destination: { ToAddresses: [sch.patient_email] },
            ReplyToAddresses: [returnEmail],
            Content: { Raw: { Data: Buffer.from(rawMime, 'utf8') } }
          }));
        } else {
          // Blank-PDF path (print, hand-fill, sign, return).
          const pdfBytes = await buildLetterPdf({
            bodyTemplate: std.body_template,
            placeholders: placeholders,
            toggles: toggles,
            placeholderDefs: defs,
            vault: vault,
            sign: sch.sign !== false,
            noLetterhead: noLetterhead
          });
          const pdfB64 = Buffer.from(pdfBytes).toString('base64');
          const subject = 'Action needed: Private-Pay Acknowledgment to review and sign';
          const textBody = buildCoverNote(returnEmail, optOutUrl);
          const rawMime = buildRawMime({
            fromName: FROM_NAME, fromAddress: FROM_ADDRESS, to: sch.patient_email,
            replyTo: returnEmail, subject: subject, textBody: textBody,
            attachmentBase64: pdfB64, attachmentFilename: 'Private-Pay-Acknowledgment.pdf',
            attachmentContentType: 'application/pdf'
          });
          await ses.send(new SendEmailCommand({
            FromEmailAddress: FROM_NAME + ' <' + FROM_ADDRESS + '>',
            Destination: { ToAddresses: [sch.patient_email] },
            ReplyToAddresses: [returnEmail],
            Content: { Raw: { Data: Buffer.from(rawMime, 'utf8') } }
          }));
        }

        // 4. Advance schedule.
        const next = new Date();
        next.setDate(next.getDate() + (sch.cadence_days || 80));
        await sb('letter_schedules?id=eq.' + sch.id, {
          method: 'PATCH', headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            next_run_at: next.toISOString(),
            last_run_at: nowIso,
            sends_count: (sch.sends_count || 0) + 1,
            last_error: null,
            updated_at: nowIso
          })
        });
        results.sent++;
        results.details.push({ id: sch.id, action: 'sent', next_run_at: next.toISOString() });
      } catch (errOne) {
        results.errors++;
        results.details.push({ id: sch.id, action: 'error', error: errOne.message });
        // Record the error but do NOT advance next_run_at, so it retries next hour.
        await sb('letter_schedules?id=eq.' + sch.id, {
          method: 'PATCH', headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({ last_error: String(errOne.message).slice(0, 500), updated_at: new Date().toISOString() })
        }).catch(function () {});
        console.log('[letter-autosend] schedule', sch.id, 'error:', errOne.message);
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(results) };
  } catch (err) {
    console.log('[letter-autosend] fatal:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function sesClient() {
  const region = process.env.SES_AWS_REGION || process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1';
  const accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const cfg = { region: region };
  if (accessKeyId && secretAccessKey) cfg.credentials = { accessKeyId: accessKeyId, secretAccessKey: secretAccessKey };
  return new SESv2Client(cfg);
}

// Map a placeholder key to a vault field. Mirrors the client generator's vault mapping.
function vaultValue(v, key) {
  switch (key) {
    case 'PROVIDER_NAME': return v.legalName || v.providerName || v.name || '';
    case 'PROVIDER_CREDENTIALS': return v.credentials || '';
    case 'PROVIDER_PRACTICE': return v.practiceName || '';
    case 'PROVIDER_NPI': return v.npi1 || v.npi || '';
    case 'PROVIDER_ADDRESS': return v.practiceAddress || v.address || '';
    case 'PROVIDER_PHONE': return v.practicePhone || v.phone || '';
    case 'PROVIDER_EMAIL': return v.practiceEmail || v.email || '';
    default: return '';
  }
}

function formatToday(offsetDays) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

function buildSignLinkNote(signUrl, optOutUrl) {
  return [
    'Hello,',
    '',
    'Your provider needs you to review and sign a Private-Pay Acknowledgment for your psychiatric care.',
    '',
    'You can complete and sign it online in about a minute here:',
    '  ' + signUrl,
    '',
    'You will fill in your name, date of birth, ProviderOne Client ID, and managed care plan (if any),',
    'then type your name to sign. A signed copy is sent to your provider\u2019s office automatically.',
    '',
    'This link is for you only and expires in 21 days.',
    '',
    'This agreement is renewed about every 90 days. If you no longer wish to receive these renewal',
    'requests by email (for example, if your coverage or provider has changed), you can stop them here:',
    '  ' + optOutUrl,
    '',
    'Think Beyond Practice'
  ].join('\n');
}

function buildCoverNote(returnEmail, optOutUrl) {
  return [
    'Hello,',
    '',
    'Attached is a Private-Pay Acknowledgment for your psychiatric care that needs to be reviewed and signed.',
    '',
    'Please print the attached form, then complete the following by hand:',
    '  - Patient Name',
    '  - Date of Birth',
    '  - ProviderOne Client ID Number',
    '  - Apple Health Managed Care Plan (if applicable)',
    '  - Your signature, printed name, and date at the bottom',
    '',
    'Once signed, please scan and return the completed form by secure email to:',
    '  ' + returnEmail,
    '',
    'This agreement is renewed about every 90 days. If you no longer wish to receive these',
    'renewal forms by email (for example, if your coverage or provider has changed), you can',
    'stop them here:',
    '  ' + optOutUrl,
    '',
    'Think Beyond Practice'
  ].join('\n');
}

// --- Raw MIME builder (multipart/mixed: text cover + base64 PDF attachment). ---
function buildRawMime(o) {
  const CRLF = '\r\n';
  const mixed = 'mixed_' + Math.random().toString(36).slice(2);
  function header(name, val) { return name + ': ' + val + CRLF; }
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
