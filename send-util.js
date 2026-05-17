/* ══════════════════════════════════════════════════════════════
   PRACTICE MANAGER SEND UTILITY (shared module)
   Include this in any tool that needs send functionality.
   
   Usage:
     openSendModal({
       content: "The text to send",
       subject: "Medication Information from Your Prescriber",
       tool: "Interaction Interpreter",
       type: "patient_summary",    // patient_summary | letter | safety_plan | attestation
       replyTo: "provider@example.com"  // optional, from vault
     });
   ══════════════════════════════════════════════════════════════ */

/* ── Inject CSS ── */
(function() {
  if (document.getElementById('send-util-css')) return;
  var style = document.createElement('style');
  style.id = 'send-util-css';
  style.textContent = [
    '.send-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.65);z-index:9999;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s}',
    '.send-overlay.active{opacity:1}',
    '.send-modal{background:var(--navy-card,#152238);border:1px solid var(--rule,rgba(42,171,184,0.15));border-radius:12px;padding:28px;max-width:480px;width:90%;max-height:90vh;overflow-y:auto}',
    '.send-modal h3{font-family:var(--font-display,"DM Serif Display",serif);color:var(--white,#f5f4f2);font-size:1.1rem;margin-bottom:16px}',
    '.send-tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--rule,rgba(42,171,184,0.15));padding-bottom:8px}',
    '.send-tab{padding:8px 16px;font-size:.82rem;font-family:var(--font-body,"Plus Jakarta Sans",sans-serif);border:1px solid var(--rule,rgba(42,171,184,0.15));border-radius:6px 6px 0 0;background:var(--navy-mid,#111c30);color:var(--cream-dim,#b0aa9e);cursor:pointer;font-weight:500}',
    '.send-tab.active{background:var(--teal-glow,rgba(42,171,184,0.12));color:var(--teal,#2aabb8);border-color:var(--teal,#2aabb8)}',
    '.send-field{margin-bottom:14px}',
    '.send-field label{display:block;font-size:.78rem;color:var(--cream-dim,#b0aa9e);margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}',
    '.send-field input,.send-field textarea{width:100%;padding:10px 12px;border-radius:6px;border:1px solid var(--rule,rgba(42,171,184,0.15));background:var(--navy-mid,#111c30);color:var(--white,#f5f4f2);font-family:var(--font-body,"Plus Jakarta Sans",sans-serif);font-size:.88rem}',
    '.send-field input:focus,.send-field textarea:focus{outline:none;border-color:var(--teal,#2aabb8)}',
    '.send-field textarea{min-height:100px;resize:vertical}',
    '.send-preview{background:var(--navy,#0b1120);border:1px solid var(--rule,rgba(42,171,184,0.15));border-radius:6px;padding:12px 14px;font-size:.82rem;color:var(--cream,#e8e2d6);line-height:1.6;max-height:200px;overflow-y:auto;white-space:pre-wrap;margin-bottom:14px}',
    '.send-actions{display:flex;gap:8px;justify-content:flex-end}',
    '.send-btn{padding:10px 20px;border-radius:8px;font-family:var(--font-body,"Plus Jakarta Sans",sans-serif);font-weight:600;font-size:.85rem;cursor:pointer;border:none}',
    '.send-btn-primary{background:var(--teal,#2aabb8);color:var(--navy,#0b1120)}',
    '.send-btn-primary:hover{opacity:.85}',
    '.send-btn-primary:disabled{opacity:.4;cursor:not-allowed}',
    '.send-btn-secondary{background:var(--navy-mid,#111c30);color:var(--cream,#e8e2d6);border:1px solid var(--rule,rgba(42,171,184,0.15))}',
    '.send-btn-secondary:hover{border-color:var(--teal,#2aabb8)}',
    '.send-status{font-size:.82rem;margin-top:10px;padding:8px 12px;border-radius:6px;display:none}',
    '.send-status.success{display:block;background:rgba(52,211,153,0.1);color:var(--green,#34d399);border:1px solid rgba(52,211,153,0.2)}',
    '.send-status.error{display:block;background:rgba(248,113,113,0.1);color:var(--red,#f87171);border:1px solid rgba(248,113,113,0.2)}',
    '.send-status.sending{display:block;background:rgba(42,171,184,0.1);color:var(--teal,#2aabb8);border:1px solid rgba(42,171,184,0.2)}',
    '.send-disclaimer{font-size:.72rem;color:var(--cream-dim,#b0aa9e);margin-top:12px;line-height:1.4}'
  ].join('\n');
  document.head.appendChild(style);
})();

/* ── State ── */
var _sendConfig = null;
var _sendTab = 'email';

/* ── Public API ── */
function openSendModal(config) {
  _sendConfig = config;
  _sendTab = 'email';

  // Remove existing modal if any
  var existing = document.getElementById('send-overlay');
  if (existing) existing.remove();

  // Get provider info from vault if available
  var vault = {};
  try {
    vault = JSON.parse(localStorage.getItem('credentialing-hub-profile') || '{}');
  } catch(e) {}

  var overlay = document.createElement('div');
  overlay.className = 'send-overlay';
  overlay.id = 'send-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) closeSendModal(); };

  var typeLabels = {
    patient_summary: 'Patient Summary',
    letter: 'Letter',
    safety_plan: 'Safety Plan',
    attestation: 'Attestation',
    superbill: 'Superbill'
  };
  var docLabel = typeLabels[config.type] || 'Document';

  var html = '<div class="send-modal">';
  html += '<h3>Send ' + docLabel + '</h3>';

  // Tabs
  html += '<div class="send-tabs">';
  html += '<div class="send-tab active" onclick="switchSendTab(\'email\')">Email</div>';
  html += '<div class="send-tab" onclick="switchSendTab(\'fax\')">Fax Cover Sheet</div>';
  html += '</div>';

  // Email panel
  html += '<div id="send-panel-email">';
  html += '<div class="send-field"><label>Recipient Email</label><input type="email" id="send-to" placeholder="patient@email.com"></div>';
  html += '<div class="send-field"><label>Subject</label><input type="text" id="send-subject" value="' + escAttr(config.subject || 'Information from Your Prescriber') + '"></div>';
  html += '<div class="send-field"><label>Add a personal note (optional)</label><textarea id="send-note" placeholder="Hi [name], here is the information we discussed today..."></textarea></div>';
  html += '<div style="font-size:.78rem;color:var(--cream-dim);margin-bottom:10px;font-weight:600">Document preview:</div>';
  html += '<div class="send-preview">' + escHtml(config.content || '') + '</div>';
  html += '<div class="send-actions">';
  html += '<button class="send-btn send-btn-secondary" onclick="closeSendModal()">Cancel</button>';
  html += '<button class="send-btn send-btn-primary" id="send-email-btn" onclick="sendEmail()">Send Email</button>';
  html += '</div>';
  html += '<div class="send-status" id="send-status"></div>';
  html += '<div class="send-disclaimer">This email is sent from ' + escHtml(vault.practiceName || 'your practice') + ' through a HIPAA-compliant email service. The recipient should be informed that this communication contains health-related information. By sending, you confirm the recipient has consented to receive this information via email.</div>';
  html += '</div>';

  // Fax cover sheet panel
  html += '<div id="send-panel-fax" style="display:none">';
  html += '<div class="send-field"><label>Recipient Name / Office</label><input type="text" id="fax-to-name" placeholder="Dr. Smith / ABC Clinic"></div>';
  html += '<div class="send-field"><label>Fax Number</label><input type="text" id="fax-number" placeholder="(509) 555-1234"></div>';
  html += '<div class="send-field"><label>Number of Pages (including cover)</label><input type="number" id="fax-pages" value="2"></div>';
  html += '<div class="send-field"><label>Notes</label><textarea id="fax-notes" placeholder="Please see attached document regarding your patient..."></textarea></div>';
  html += '<div class="send-actions">';
  html += '<button class="send-btn send-btn-secondary" onclick="closeSendModal()">Cancel</button>';
  html += '<button class="send-btn send-btn-primary" onclick="generateFaxCover()">Generate Fax Cover Sheet</button>';
  html += '</div>';
  html += '<div class="send-status" id="fax-status"></div>';
  html += '</div>';

  html += '</div>';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  // Animate in
  requestAnimationFrame(function() { overlay.classList.add('active'); });

  // Focus email field
  setTimeout(function() { document.getElementById('send-to').focus(); }, 200);
}

function closeSendModal() {
  var overlay = document.getElementById('send-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    setTimeout(function() { overlay.remove(); }, 200);
  }
  _sendConfig = null;
}

function switchSendTab(tab) {
  _sendTab = tab;
  document.querySelectorAll('.send-tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.send-tab').forEach(function(t) {
    if ((tab === 'email' && t.textContent === 'Email') || (tab === 'fax' && t.textContent === 'Fax Cover Sheet')) {
      t.classList.add('active');
    }
  });
  document.getElementById('send-panel-email').style.display = tab === 'email' ? 'block' : 'none';
  document.getElementById('send-panel-fax').style.display = tab === 'fax' ? 'block' : 'none';
}

/* ── Email Send ── */
async function sendEmail() {
  var to = document.getElementById('send-to').value.trim();
  var subject = document.getElementById('send-subject').value.trim();
  var note = document.getElementById('send-note').value.trim();
  var status = document.getElementById('send-status');
  var btn = document.getElementById('send-email-btn');

  if (!to || !subject) {
    status.className = 'send-status error';
    status.textContent = 'Please enter a recipient email and subject.';
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    status.className = 'send-status error';
    status.textContent = 'Please enter a valid email address.';
    return;
  }

  // Build email body
  var body = '';
  if (note) body += note + '\n\n---\n\n';
  body += _sendConfig.content;
  body += '\n\n---\nThis communication was sent by your healthcare provider and may contain health-related information. If you received this in error, please notify the sender immediately.';

  // Get vault for reply-to
  var vault = {};
  try { vault = JSON.parse(localStorage.getItem('credentialing-hub-profile') || '{}'); } catch(e) {}

  btn.disabled = true;
  btn.textContent = 'Sending...';
  status.className = 'send-status sending';
  status.textContent = 'Sending email...';

  try {
    var resp = await fetch('/.netlify/functions/send-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: to,
        subject: subject,
        body: body,
        replyTo: _sendConfig.replyTo || vault.email || null,
        tool: _sendConfig.tool || 'Practice Manager'
      })
    });

    var data = await resp.json();

    if (data.success) {
      status.className = 'send-status success';
      status.textContent = 'Email sent successfully to ' + to;
      btn.textContent = 'Sent';
      setTimeout(function() { closeSendModal(); }, 2000);
    } else {
      status.className = 'send-status error';
      status.textContent = 'Failed to send: ' + (data.error || 'Unknown error');
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  } catch(err) {
    status.className = 'send-status error';
    status.textContent = 'Network error. Check your connection and try again.';
    btn.disabled = false;
    btn.textContent = 'Retry';
  }
}

/* ── Fax Cover Sheet ── */
function generateFaxCover() {
  var toName = document.getElementById('fax-to-name').value.trim();
  var faxNum = document.getElementById('fax-number').value.trim();
  var pages = document.getElementById('fax-pages').value || '2';
  var notes = document.getElementById('fax-notes').value.trim();
  var status = document.getElementById('fax-status');

  if (!toName || !faxNum) {
    status.className = 'send-status error';
    status.textContent = 'Please enter recipient name and fax number.';
    return;
  }

  // Get provider info from vault
  var vault = {};
  try { vault = JSON.parse(localStorage.getItem('credentialing-hub-profile') || '{}'); } catch(e) {}

  var fromName = vault.legalName || '[Your Name]';
  var fromCreds = vault.credentials || '';
  var fromPractice = vault.practiceName || '';
  var fromFax = vault.fax || '[Your Fax]';
  var fromPhone = vault.phone || '[Your Phone]';

  // Open print-friendly fax cover sheet
  var win = window.open('', '_blank');
  win.document.write('<!DOCTYPE html><html><head><title>Fax Cover Sheet</title>');
  win.document.write('<style>');
  win.document.write('body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;color:#111;line-height:1.5}');
  win.document.write('h1{text-align:center;font-size:24px;margin-bottom:32px;border-bottom:3px solid #111;padding-bottom:12px}');
  win.document.write('.field{display:grid;grid-template-columns:120px 1fr;gap:8px;padding:6px 0;border-bottom:1px solid #ccc;font-size:14px}');
  win.document.write('.field-label{font-weight:bold}');
  win.document.write('.notes{margin-top:24px;padding:16px;border:1px solid #ccc;min-height:100px;font-size:14px;white-space:pre-wrap}');
  win.document.write('.confidential{margin-top:32px;padding:12px;border:2px solid #111;font-size:11px;text-align:center;font-weight:bold}');
  win.document.write('@media print{body{margin:20px}}');
  win.document.write('</style></head><body>');
  win.document.write('<h1>FAX COVER SHEET</h1>');
  win.document.write('<div class="field"><div class="field-label">TO:</div><div>' + escHtml(toName) + '</div></div>');
  win.document.write('<div class="field"><div class="field-label">FAX:</div><div>' + escHtml(faxNum) + '</div></div>');
  win.document.write('<div class="field"><div class="field-label">FROM:</div><div>' + escHtml(fromName + (fromCreds ? ', ' + fromCreds : '')) + '</div></div>');
  if (fromPractice) win.document.write('<div class="field"><div class="field-label">PRACTICE:</div><div>' + escHtml(fromPractice) + '</div></div>');
  win.document.write('<div class="field"><div class="field-label">PHONE:</div><div>' + escHtml(fromPhone) + '</div></div>');
  win.document.write('<div class="field"><div class="field-label">FAX:</div><div>' + escHtml(fromFax) + '</div></div>');
  win.document.write('<div class="field"><div class="field-label">DATE:</div><div>' + new Date().toLocaleDateString() + '</div></div>');
  win.document.write('<div class="field"><div class="field-label">PAGES:</div><div>' + escHtml(pages) + ' (including this cover sheet)</div></div>');
  if (notes) {
    win.document.write('<div class="notes">' + escHtml(notes) + '</div>');
  }
  win.document.write('<div class="confidential">CONFIDENTIAL: This fax and any attachments contain Protected Health Information (PHI) intended solely for the named recipient. If you have received this fax in error, please notify the sender immediately and destroy all copies. Unauthorized disclosure of PHI is prohibited under HIPAA.</div>');
  win.document.write('</body></html>');
  win.document.close();
  win.print();

  status.className = 'send-status success';
  status.textContent = 'Fax cover sheet generated. Print and fax with your document.';
}

/* ── Helpers ── */
function escHtml(s) {
  if (!s) return '';
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function escAttr(s) {
  return (s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
