/**
 * Think Beyond Practice — Auth Gate Module
 * Drop this script into any protected page.
 * 
 * Usage:
 *   <script src="/auth-gate.js"></script>
 *   <script>
 *     TBPAuth.protect({
 *       toolName: 'Practice Lab',         // Display name shown on gate screen
 *       spaceId: 2546298,                 // Optional — pass to restrict to a specific tier/space
 *                                         // Omit for community-wide access (any active member)
 *       onVerified: function() { ... }    // Called when member is verified — load your tool here
 *     });
 *   </script>
 */

(function() {
  'use strict';

  var SESSION_KEY = 'tbp_auth_token';
  var SESSION_EXPIRY_KEY = 'tbp_auth_expiry';
  var SESSION_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours
  var REDIRECT_URL = 'https://community.thinkbeyondpractice.com';

  // Inject styles
  var style = document.createElement('style');
  style.textContent = [
    '*{box-sizing:border-box;margin:0;padding:0}',
    ':root{--tbp-navy:#0b1120;--tbp-navy-mid:#111c30;--tbp-navy-light:#1a2d47;--tbp-teal:#2aabb8;--tbp-teal-hover:#33c8d6;--tbp-cream:#e8e2d6;--tbp-cream-dim:#b0aa9e;--tbp-white:#f5f4f2;--tbp-rule:rgba(42,171,184,0.2);--tbp-error-bg:rgba(163,45,45,0.18);--tbp-error-text:#f87171;--tbp-error-border:rgba(248,113,113,0.3);}',
    'body.tbp-gate-active{display:flex;align-items:center;justify-content:center;min-height:100vh;background:var(--tbp-navy);}',
    '#tbp-gate{width:100%;max-width:420px;padding:20px;}',
    '#tbp-gate .gate-card{background:var(--tbp-navy-mid);border:1px solid var(--tbp-rule);border-top:2px solid var(--tbp-teal);border-radius:8px;padding:40px 36px;text-align:center;font-family:-apple-system,"DM Sans",sans-serif;}',
    '#tbp-gate .gate-logo{width:52px;height:52px;margin:0 auto 22px;background:rgba(42,171,184,0.15);border:1px solid var(--tbp-rule);border-radius:10px;display:flex;align-items:center;justify-content:center;}',
    '#tbp-gate .gate-logo svg{width:26px;height:26px;fill:var(--tbp-teal);}',
    '#tbp-gate .gate-wordmark{font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:var(--tbp-teal);margin-bottom:10px;}',
    '#tbp-gate h1{font-size:20px;font-weight:700;color:var(--tbp-white);margin-bottom:6px;letter-spacing:0.01em;}',
    '#tbp-gate .gate-sub{font-size:13px;color:var(--tbp-cream-dim);margin-bottom:28px;line-height:1.6;}',
    '#tbp-gate .gate-label{font-size:10px;font-weight:700;color:var(--tbp-teal);text-transform:uppercase;letter-spacing:0.12em;text-align:left;margin-bottom:7px;}',
    '#tbp-gate .gate-input{width:100%;border:1px solid var(--tbp-rule);border-radius:6px;padding:12px 14px;font-size:14px;color:var(--tbp-cream);background:var(--tbp-navy);transition:border-color 0.15s;margin-bottom:12px;font-family:inherit;}',
    '#tbp-gate .gate-input::placeholder{color:var(--tbp-cream-dim);opacity:0.6;}',
    '#tbp-gate .gate-input:focus{outline:none;border-color:var(--tbp-teal);}',
    '#tbp-gate .gate-input.error{border-color:var(--tbp-error-text);background:rgba(163,45,45,0.1);}',
    '#tbp-gate .gate-btn{width:100%;padding:13px;background:var(--tbp-teal);color:var(--tbp-navy);border:none;border-radius:6px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;transition:background 0.15s;display:flex;align-items:center;justify-content:center;gap:8px;letter-spacing:0.01em;}',
    '#tbp-gate .gate-btn:hover{background:var(--tbp-teal-hover);}',
    '#tbp-gate .gate-btn:disabled{background:var(--tbp-navy-light);color:var(--tbp-cream-dim);cursor:not-allowed;}',
    '#tbp-gate .gate-spinner{width:16px;height:16px;border:2px solid rgba(11,17,32,0.3);border-top-color:var(--tbp-navy);border-radius:50%;animation:tbp-spin 0.7s linear infinite;display:none;}',
    '@keyframes tbp-spin{to{transform:rotate(360deg)}}',
    '#tbp-gate .gate-error{display:none;margin-top:12px;padding:10px 14px;background:var(--tbp-error-bg);border:1px solid var(--tbp-error-border);border-radius:6px;font-size:13px;color:var(--tbp-error-text);text-align:left;line-height:1.5;}',
    '#tbp-gate .gate-footer{margin-top:22px;font-size:12px;color:var(--tbp-cream-dim);}',
    '#tbp-gate .gate-footer a{color:var(--tbp-teal);text-decoration:none;}',
    '#tbp-gate .gate-footer a:hover{text-decoration:underline;}'
  ].join('');
  document.head.appendChild(style);

  function getSessionToken() {
    try {
      var expiry = localStorage.getItem(SESSION_EXPIRY_KEY);
      if (expiry && Date.now() < parseInt(expiry)) {
        return localStorage.getItem(SESSION_KEY);
      }
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_EXPIRY_KEY);
    } catch(e) {}
    return null;
  }

  function setSessionToken(token) {
    try {
      localStorage.setItem(SESSION_KEY, token);
      localStorage.setItem(SESSION_EXPIRY_KEY, (Date.now() + SESSION_DURATION_MS).toString());
    } catch(e) {}
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_EXPIRY_KEY);
    } catch(e) {}
  }

  function renderGate(toolName, spaceId, onVerified) {
    document.body.style.overflow = 'hidden';
    document.body.classList.add('tbp-gate-active');

    var gate = document.createElement('div');
    gate.id = 'tbp-gate';
    gate.innerHTML = [
      '<div class="gate-card">',
        '<div class="gate-logo">',
          '<svg viewBox="0 0 20 20"><path d="M10 2L3 7v11h5v-5h4v5h5V7z"/></svg>',
        '</div>',
        '<div class="gate-wordmark">Think Beyond Practice</div>',
        '<h1>', toolName, '</h1>',
        '<p class="gate-sub">Member access only.<br>Enter your Circle email to continue.</p>',
        '<div class="gate-label">Your email</div>',
        '<input class="gate-input" id="tbp-email" type="email" placeholder="you@example.com" autocomplete="email">',
        '<button class="gate-btn" id="tbp-submit">',
          '<div class="gate-spinner" id="tbp-spinner"></div>',
          '<span id="tbp-btn-label">Verify access</span>',
        '</button>',
        '<div class="gate-error" id="tbp-error"></div>',
        '<div class="gate-footer">',
          'Not a member? <a href="', REDIRECT_URL, '" target="_blank">Join Think Beyond Practice</a>',
        '</div>',
      '</div>'
    ].join('');

    document.body.appendChild(gate);

    var emailInput = document.getElementById('tbp-email');
    var submitBtn = document.getElementById('tbp-submit');
    var spinner = document.getElementById('tbp-spinner');
    var btnLabel = document.getElementById('tbp-btn-label');
    var errorDiv = document.getElementById('tbp-error');

    function setLoading(on) {
      submitBtn.disabled = on;
      spinner.style.display = on ? 'block' : 'none';
      btnLabel.textContent = on ? 'Verifying...' : 'Verify access';
    }

    function showError(msg) {
      emailInput.classList.add('error');
      errorDiv.textContent = msg;
      errorDiv.style.display = 'block';
    }

    function clearError() {
      emailInput.classList.remove('error');
      errorDiv.style.display = 'none';
    }

    function removeGate() {
      document.body.removeChild(gate);
      document.body.style.overflow = '';
      document.body.classList.remove('tbp-gate-active');
    }

    function verify() {
      clearError();
      var email = emailInput.value.trim().toLowerCase();
      if (!email || !email.includes('@')) {
        showError('Please enter a valid email address.');
        return;
      }

      setLoading(true);

      var requestBody = { email: email };
      if (spaceId) requestBody.spaceId = spaceId;

      fetch('/.netlify/functions/circle-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        setLoading(false);
        if (data.verified && data.token) {
          // Store ONLY the real signed token. No email fallback — an email is
          // not a valid session token and the hardened backends would reject it.
          setSessionToken(data.token);
          try {
            localStorage.setItem('tbp_verified_email', email);
            if (data.tier) localStorage.setItem('tbp_tier', data.tier);
            if (data.memberToken) localStorage.setItem('tbp_member_jwt', data.memberToken);
            if (data.communityMemberId) localStorage.setItem('tbp_member_id', String(data.communityMemberId));
          } catch(e) {}
          removeGate();
          onVerified();
        } else if (data.redirect) {
          window.location.href = REDIRECT_URL;
        } else {
          showError(data.message || 'Access could not be verified. Check your email and try again.');
        }
      })
      .catch(function() {
        setLoading(false);
        showError('Connection error. Please try again.');
      });
    }

    emailInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') verify();
    });
    submitBtn.addEventListener('click', verify);
    setTimeout(function() {
      var storedEmail = '';
      try { storedEmail = localStorage.getItem('tbp_verified_email') || ''; } catch(e) {}
      if (storedEmail) {
        emailInput.value = storedEmail;
      } else {
        emailInput.focus();
      }
    }, 100);
  }

  // Public API
  window.TBPAuth = {
    protect: function(options) {
      var toolName = options.toolName || 'Think Beyond Practice';
      var spaceId = options.spaceId || null;
      var onVerified = options.onVerified || function() {};
      var skipPHIGate = options.skipPHIGate === true;
      var termsVersion = options.termsVersion || 'interim_v1';
      var baaVersion = options.baaVersion || '3.0';

      // OPT-OUT PHI gate. The BAA + Terms gate runs by DEFAULT for every tool.
      // A page only skips it by explicitly passing skipPHIGate:true (used for
      // non-PHI reference tools, practice-data tools, the Practice Lab,
      // Credentialing Hub, Ask the Archive, and the marketing/platform pages).
      // This means a NEW tool is gated unless you deliberately exempt it: the
      // safe failure mode. The gate fails CLOSED on any ambiguity or error.
      if (!skipPHIGate) {
        var realOnVerified = onVerified;
        onVerified = function() {
          runPHIGate(toolName, termsVersion, baaVersion, realOnVerified);
        };
      }

      // If spaceId is required, always verify against the API to check tier access.
      // Only skip verification for community-wide access (no spaceId).
      if (!spaceId && getSessionToken()) {
        onVerified();
        return;
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
          renderGate(toolName, spaceId, onVerified);
        });
      } else {
        renderGate(toolName, spaceId, onVerified);
      }
    },

    clearSession: clearSession
  };

  // ── PHI gate: BAA then Terms, both required, fail closed ──
  function getVerifiedEmail() {
    try { return (localStorage.getItem('tbp_verified_email') || '').trim().toLowerCase(); } catch (e) { return ''; }
  }

  function phiOverlay(innerHTML) {
    var o = document.createElement('div');
    o.id = 'tbp-phi-gate';
    o.style.cssText = 'position:fixed;inset:0;z-index:99998;background:var(--tbp-navy,#0b1120);display:flex;align-items:center;justify-content:center;padding:20px;font-family:-apple-system,"DM Sans",sans-serif;';
    o.innerHTML = '<div style="max-width:460px;width:100%;background:var(--tbp-navy-mid,#111c30);border:1px solid var(--tbp-rule,rgba(42,171,184,0.2));border-top:2px solid var(--tbp-teal,#2aabb8);border-radius:8px;padding:36px 32px;color:var(--tbp-cream,#e8e2d6);">' + innerHTML + '</div>';
    document.body.appendChild(o);
    return o;
  }
  function removePhiOverlay() {
    var o = document.getElementById('tbp-phi-gate');
    if (o && o.parentNode) o.parentNode.removeChild(o);
  }

  function showBaaRequired(email) {
    var redirect = encodeURIComponent(window.location.pathname + window.location.search);
    phiOverlay(
      '<div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--tbp-teal,#2aabb8);margin-bottom:10px">Think Beyond Practice</div>' +
      '<h1 style="font-size:19px;color:var(--tbp-white,#f5f4f2);margin:0 0 10px">Business Associate Agreement required</h1>' +
      '<p style="font-size:14px;color:var(--tbp-cream-dim,#b0aa9e);line-height:1.6;margin:0 0 14px">This tool processes clinical content that may include protected health information. A current signed Business Associate Agreement is required before you can use it. It takes about a minute.</p>' +
      '<p style="font-size:13px;color:var(--tbp-cream-dim,#b0aa9e);line-height:1.6;margin:0 0 22px;padding:10px 14px;background:rgba(245,200,66,0.10);border-left:3px solid #f5c842;border-radius:6px">If you have signed a BAA before, you may be asked to sign again. The agreement is updated periodically as new tools are added to the platform, and using the clinical tools requires your signature on the current version.</p>' +
      '<a href="/baa-sign.html?email=' + encodeURIComponent(email) + '&redirect=' + redirect + '" style="display:inline-block;padding:13px 26px;background:var(--tbp-teal,#2aabb8);color:var(--tbp-navy,#0b1120);border-radius:6px;font-size:14px;font-weight:700;text-decoration:none">Review and sign the BAA</a>' +
      '<p style="font-size:12px;color:var(--tbp-cream-dim,#b0aa9e);margin:18px 0 0">Questions? michael@thinkbeyondpractice.com</p>'
    );
  }

  function showTermsRequired(email, termsVersion, proceed) {
    var o = phiOverlay(
      '<div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--tbp-teal,#2aabb8);margin-bottom:10px">Think Beyond Practice</div>' +
      '<h1 style="font-size:19px;color:var(--tbp-white,#f5f4f2);margin:0 0 10px">Terms of Use</h1>' +
      '<p style="font-size:14px;color:var(--tbp-cream-dim,#b0aa9e);line-height:1.6;margin:0 0 16px">Before using this tool, please review and accept the <a href="/terms-of-service.html" target="_blank" style="color:var(--tbp-teal,#2aabb8)">Terms of Use</a>. They cover appropriate use, that the tool supports rather than replaces your clinical judgment, and your responsibilities when handling patient information.</p>' +
      '<label style="display:flex;align-items:flex-start;gap:10px;font-size:13px;color:var(--tbp-cream,#e8e2d6);line-height:1.5;margin:0 0 16px;cursor:pointer"><input type="checkbox" id="tbp-terms-box" style="margin-top:3px;width:16px;height:16px;flex:none"><span>I have read and agree to the Think Beyond Practice Terms of Use.</span></label>' +
      '<div id="tbp-terms-error" style="display:none;color:#f87171;font-size:13px;margin:0 0 12px"></div>' +
      '<button id="tbp-terms-btn" style="width:100%;padding:13px;background:var(--tbp-teal,#2aabb8);color:var(--tbp-navy,#0b1120);border:none;border-radius:6px;font-size:14px;font-weight:700;cursor:pointer">Agree and continue</button>'
    );
    var box = o.querySelector('#tbp-terms-box');
    var btn = o.querySelector('#tbp-terms-btn');
    var err = o.querySelector('#tbp-terms-error');
    btn.addEventListener('click', function() {
      if (!box.checked) { err.textContent = 'Please check the box to continue.'; err.style.display = 'block'; return; }
      err.style.display = 'none';
      btn.disabled = true; btn.textContent = 'Saving...';
      fetch('/.netlify/functions/record-terms-acceptance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getSessionToken() },
        body: JSON.stringify({ action: 'record', token: getSessionToken(), terms_version: termsVersion })
      })
      .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
      .then(function(res){
        if (res.ok && res.d && res.d.ok) { removePhiOverlay(); proceed(); }
        else { err.textContent = 'Could not record your acceptance. Please try again.'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Agree and continue'; }
      })
      .catch(function(){ err.textContent = 'Could not record your acceptance. Please try again.'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Agree and continue'; });
    });
  }

  function runPHIGate(toolName, termsVersion, baaVersion, proceed) {
    var email = getVerifiedEmail();
    // Fail closed: if we cannot identify the member, require the BAA path.
    if (!email) { showBaaRequired(''); return; }

    // 1) BAA check (fail closed). Require the CURRENT version: a member who
    // signed an older version (e.g. 1.0) does not satisfy 2.0 and is sent to re-sign.
    // Identity is the SIGNED token; check-baa-status derives the email from it.
    var authToken = getSessionToken();
    fetch('/.netlify/functions/check-baa-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
      body: JSON.stringify({ token: authToken })
    })
    .then(function(r){ return r.ok ? r.json() : { hasBaa: false }; })
    .then(function(baa){
      var signedCurrent = baa && baa.hasBaa === true &&
        String(baa.baaVersion || '') === String(baaVersion);
      if (!signedCurrent) { showBaaRequired(email); return; }
      // 2) Terms check (fail closed: any error or non-accepted => show terms)
      return fetch('/.netlify/functions/record-terms-acceptance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
        body: JSON.stringify({ action: 'check', token: authToken, terms_version: termsVersion })
      })
      .then(function(r){ return r.ok ? r.json() : { accepted: false }; })
      .then(function(terms){
        if (terms && terms.accepted === true) { proceed(); }
        else { showTermsRequired(email, termsVersion, proceed); }
      });
    })
    .catch(function(){ showBaaRequired(email); });
  }

})();
