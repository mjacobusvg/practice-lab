// netlify/functions/phi-drift-check.js
//
// Daily: does any PHI-capable column in Supabase hold data again?
// Security audit 2026-09-16, Tier 3.
//
// WHY THIS EXISTS
// The letters and assessments work moved patient PHI out of Supabase and into S3 under
// the AWS BAA, leaving the DB holding only keys. That is a property of the CODE, and code
// changes. PHI-STORAGE-STATE.md recorded "zero inline PHI at rest" on 2026-09-09 and was
// wrong by 2026-09-16 — letter_schedules had been carrying patient_email, patient_label,
// patient_message and first_message the whole time, because that table was never in the
// inventory. Nobody noticed, because nothing was looking.
//
// This looks, every day, and says so. It is a smoke alarm, not a fix: it never deletes,
// never edits, never touches S3. phi-purge-expired.js does the cleaning.
//
// WHAT IT NEVER DOES
// It never reads a PHI VALUE into the alert. Every check is a COUNT, or a boolean over a
// value that stays inside the function. The email carries labels and numbers, because an
// alert that quotes the leak is a second copy of the leak — in an inbox, forever.
//
// NOISE
// A daily email that says the same thing every day gets filtered, and then the one that
// matters gets filtered too. So: an alert goes out when the failing set CHANGES, when
// something clears, and otherwise at most once every 7 days while it stays broken. State
// rides in function_run_log.summary from the previous run — no new table.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SES_AWS_ACCESS_KEY_ID, SES_AWS_SECRET_ACCESS_KEY,
//      SES_AWS_REGION, optional SES_FROM / NOTIFY_TO.

var SESv2 = require('@aws-sdk/client-sesv2');
var guard = require('./_lib/scheduled-guard');

var REALERT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// ── Columns that must be NULL, because the value belongs in S3 ────────────────────────
// `filter` is PostgREST. Each entry is one row in the alert.
var COUNT_CHECKS = [
  { id: 'ls.patient_email',   table: 'letter_schedules', filter: 'patient_email=not.is.null',   label: 'Letter schedules holding a patient email inline' },
  { id: 'ls.patient_label',   table: 'letter_schedules', filter: 'patient_label=not.is.null',   label: 'Letter schedules holding a patient label inline' },
  { id: 'ls.patient_message', table: 'letter_schedules', filter: 'patient_message=not.is.null', label: 'Letter schedules holding a patient message inline' },
  { id: 'ls.first_message',   table: 'letter_schedules', filter: 'first_message=not.is.null',   label: 'Letter schedules holding a first message inline' },
  { id: 'ls.last_error',      table: 'letter_schedules', filter: 'last_error=not.is.null',      label: 'Letter schedules with a stored error string (can echo a patient address)' },

  { id: 'lc.patient_email',   table: 'letter_charges',   filter: 'patient_email=not.is.null',   label: 'Letter charges holding a patient email inline' },
  { id: 'lc.pdf_base64',      table: 'letter_charges',   filter: 'pdf_base64=not.is.null',      label: 'Letter charges holding a PDF inline' },
  { id: 'lsl.pdf_base64',     table: 'letter_send_log',  filter: 'pdf_base64=not.is.null',      label: 'Letter send log holding a PDF inline' },

  { id: 'a.patient_name',     table: 'assessments',         filter: 'patient_name=not.is.null', label: 'Assessments holding a patient name inline' },
  { id: 'ar.responses',       table: 'assessment_results',  filter: 'responses=not.is.null',    label: 'Assessment results holding raw responses inline' },
  { id: 'ar.scores',          table: 'assessment_results',  filter: 'scores=not.is.null',       label: 'Assessment results holding scores inline' },
  { id: 'ar.flags',           table: 'assessment_results',  filter: 'flags=not.is.null',        label: 'Assessment results holding flags inline' },
  { id: 'asch.patient_email', table: 'assessment_schedules', filter: 'patient_email=not.is.null', label: 'Assessment schedules holding a patient email inline' },
  { id: 'asch.patient_label', table: 'assessment_schedules', filter: 'patient_label=not.is.null', label: 'Assessment schedules holding a patient label inline' },

  // The certified-mail stub is blocked at its write path and must stay empty. If these go
  // non-zero, the block came off without the mail-vendor BAA. See PHI-STORAGE-STATE.md.
  { id: 'cmj.letter_text',    table: 'certified_mail_jobs', filter: 'letter_text=not.is.null',  label: 'Certified mail jobs holding letter text (write path should be blocked)' },
  { id: 'cmj.to_name',        table: 'certified_mail_jobs', filter: 'to_name=not.is.null',      label: 'Certified mail jobs holding a recipient name (write path should be blocked)' },
  { id: 'cmj.to_address',     table: 'certified_mail_jobs', filter: 'to_address=not.is.null',   label: 'Certified mail jobs holding a recipient address (write path should be blocked)' }
];

// ── Columns that may hold a value, but only of a safe SHAPE ───────────────────────────
// Evaluated in JS rather than SQL: PostgREST regex support varies by version, and getting
// this silently wrong would be worse than the extra round trip. Values are read into the
// function and tested; they are never logged and never reach the email.
var SHAPE_CHECKS = [
  {
    id: 'lsl.recipient_masked', table: 'letter_send_log', column: 'recipient_masked',
    filter: 'recipient_masked=not.is.null',
    label: 'Letter send log rows whose recipient is not masked',
    // Masked forms the UI produces: a bare "@domain.tld", or a fax as "••••1234".
    ok: function (v) { return /^@[^@\s]+\.[^@\s]+$/.test(v) || /^[^0-9]*\d{4}$/.test(v); }
  },
  {
    id: 'lsl.pdf_filename', table: 'letter_send_log', column: 'pdf_filename',
    filter: 'pdf_filename=not.is.null',
    label: 'Letter send log filenames not generated from the letter type',
    // What _lib/letters-phi.js safePdfFilename() produces. Anything else is a string the
    // browser chose, which is how a patient name ends up in a filename.
    ok: function (v) { return /^[a-z0-9-]+\.pdf$/.test(v); }
  },
  {
    id: 'lc.pdf_filename', table: 'letter_charges', column: 'pdf_filename',
    filter: 'pdf_filename=not.is.null',
    label: 'Letter charge filenames not generated from the letter type',
    ok: function (v) { return /^[a-z0-9-]+\.pdf$/.test(v); }
  }
];

var SHAPE_SCAN_LIMIT = 1000;

function sbHeaders() {
  var KEY = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
}

// PostgREST exact count without transferring any rows.
async function countRows(base, table, filter) {
  var url = base + '/rest/v1/' + table + '?select=id&limit=0' + (filter ? '&' + filter : '');
  var res = await fetch(url, { headers: Object.assign({ Prefer: 'count=exact' }, sbHeaders()) });
  if (!res.ok) throw new Error(table + ' count failed: ' + res.status);
  var range = res.headers.get('content-range') || '';      // e.g. "*/12"
  var n = parseInt(String(range).split('/')[1], 10);
  if (isNaN(n)) throw new Error(table + ' count unparseable: ' + range);
  return n;
}

// Returns how many values fail the shape test. Values stay here.
async function countBadShapes(base, check) {
  var url = base + '/rest/v1/' + check.table + '?select=' + encodeURIComponent(check.column) +
    '&' + check.filter + '&limit=' + SHAPE_SCAN_LIMIT;
  var res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) throw new Error(check.table + '.' + check.column + ' read failed: ' + res.status);
  var rows = await res.json();
  var bad = 0;
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i][check.column];
    if (v != null && !check.ok(String(v))) bad++;
  }
  return { bad: bad, scanned: rows.length, truncated: rows.length >= SHAPE_SCAN_LIMIT };
}

// The previous run's failing set, so an unchanged alert can stay quiet.
async function previousState(base) {
  try {
    var res = await fetch(base + '/rest/v1/function_run_log?function_name=eq.phi-drift-check' +
      '&ok=eq.true&select=summary,started_at&order=started_at.desc&limit=1', { headers: sbHeaders() });
    if (!res.ok) return null;
    var rows = await res.json();
    return (rows && rows[0] && rows[0].summary) || null;
  } catch (e) { return null; }
}

function sameSet(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  var x = a.slice().sort().join('|');
  var y = b.slice().sort().join('|');
  return x === y;
}

async function sendAlert(subject, lines) {
  var accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID;
  var secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) { console.error('phi-drift-check: SES not configured, alert not sent'); return false; }
  var client = new SESv2.SESv2Client({
    region: process.env.SES_AWS_REGION || 'us-east-1',
    credentials: { accessKeyId: accessKeyId, secretAccessKey: secretAccessKey }
  });
  await client.send(new SESv2.SendEmailCommand({
    FromEmailAddress: process.env.SES_FROM || 'Think Beyond Practice <notifications@thinkbeyondpractice.com>',
    Destination: { ToAddresses: [process.env.NOTIFY_TO || 'michael@thinkbeyondpractice.com'] },
    Content: { Simple: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Text: { Data: lines.join('\n'), Charset: 'UTF-8' } }
    } }
  }));
  return true;
}

exports.handler = async function (event) {
  var auth = guard.authorize(event, { name: 'phi-drift-check', secrets: [process.env.BACKFILL_SECRET] });
  if (!auth.ok) return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  var claim = await guard.claimRun('phi-drift-check', 12 * 60 * 60 * 1000, auth.via);
  if (!claim.claimed) return { statusCode: 429, body: JSON.stringify({ skipped: 'ran too recently', last_run_at: claim.lastRunAt }) };

  var base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!base || !process.env.SUPABASE_SERVICE_KEY) {
    await guard.finishRun(claim.runId, false, null, 'Server not configured');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  var prior = await previousState(base);
  var counts = {};
  var failing = [];
  var errors = [];
  var truncated = [];

  for (var i = 0; i < COUNT_CHECKS.length; i++) {
    var c = COUNT_CHECKS[i];
    try {
      var n = await countRows(base, c.table, c.filter);
      counts[c.id] = n;
      if (n > 0) failing.push({ id: c.id, label: c.label, count: n });
    } catch (e) {
      // A check that could not run is not a pass. Say so rather than reporting all clear.
      counts[c.id] = null;
      errors.push(c.id + ': ' + (e && e.message));
    }
  }

  for (var j = 0; j < SHAPE_CHECKS.length; j++) {
    var sc = SHAPE_CHECKS[j];
    try {
      var r = await countBadShapes(base, sc);
      counts[sc.id] = r.bad;
      if (r.truncated) truncated.push(sc.id);
      if (r.bad > 0) failing.push({ id: sc.id, label: sc.label, count: r.bad });
    } catch (e2) {
      counts[sc.id] = null;
      errors.push(sc.id + ': ' + (e2 && e2.message));
    }
  }

  var failingIds = failing.map(function (f) { return f.id; });
  var priorIds = (prior && prior.failing_ids) || [];
  var lastAlertAt = (prior && prior.last_alert_at) ? Date.parse(prior.last_alert_at) : 0;
  var ageOfLastAlert = lastAlertAt ? (Date.now() - lastAlertAt) : Infinity;

  var reason = null;
  if (errors.length) reason = 'checks_failed_to_run';
  else if (failing.length && !sameSet(failingIds, priorIds)) reason = 'changed';
  else if (failing.length && ageOfLastAlert >= REALERT_AFTER_MS) reason = 'still_open';
  else if (!failing.length && priorIds.length) reason = 'resolved';

  var alerted = false;
  if (reason) {
    var subject, lines;
    if (reason === 'resolved') {
      subject = 'PHI drift check: clear';
      lines = ['Every PHI-capable column in Supabase is back to zero.', '',
               'Previously flagged: ' + priorIds.join(', ')];
    } else {
      subject = 'PHI drift check: ' + failing.length + ' finding' + (failing.length === 1 ? '' : 's') +
                (reason === 'still_open' ? ' (still open)' : '');
      lines = ['Supabase is holding data in columns that should be empty, or in a shape that is not safe.',
               'Counts only — this alert never carries a value.', ''];
      failing.forEach(function (f) { lines.push('  ' + f.count + '  ' + f.label + '  [' + f.id + ']'); });
    }
    if (errors.length) {
      lines.push('', 'CHECKS THAT COULD NOT RUN (treat as unknown, not as clear):');
      errors.forEach(function (e) { lines.push('  ' + e); });
    }
    if (truncated.length) {
      lines.push('', 'Scanned only the first ' + SHAPE_SCAN_LIMIT + ' rows for: ' + truncated.join(', '));
    }
    lines.push('', 'Cleaning is phi-purge-expired.js (daily 08:00 UTC). This job only looks.',
               'Inventory and rules: netlify/functions/phi-drift-check.js');
    try { alerted = await sendAlert(subject, lines); }
    catch (e3) { console.error('phi-drift-check: alert send failed:', e3 && e3.message); errors.push('ses: ' + (e3 && e3.message)); }
  }

  var summary = {
    counts: counts,
    failing_ids: failingIds,
    errors: errors,
    truncated: truncated,
    alert_reason: reason,
    // Only advance the clock when an alert actually went out, so a failed send retries
    // tomorrow instead of going quiet for a week.
    last_alert_at: alerted ? new Date().toISOString() : (prior && prior.last_alert_at) || null
  };
  await guard.finishRun(claim.runId, errors.length === 0, summary);

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: errors.length === 0, failing: failing, errors: errors, alerted: alerted, alert_reason: reason })
  };
};
