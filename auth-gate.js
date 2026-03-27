/**
 * Think Beyond Practice — Auth Gate Module
 * Drop this script into any protected page.
 * 
 * Usage:
 *   <script src="/auth-gate.js"></script>
 *   <script>
 *     TBPAuth.protect({
 *       toolName: 'Practice Lab',         // Display name shown on gate screen
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
    ':root{--text:#1A1714;--text2:#5C5650;--text3:#9C958F;--surface:#F9F7F5;--border:#E8E3DD;--blue:#1D6FA4;--blue-light:#EBF4FB;--red:#A32D2D;--red-light:#FDECEA;}',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--surface);min-height:100vh;display:flex;align-items:center;justify-content:center}',
    '#tbp-gate{width:100%;max-width:420px;padding:20px}',
    '#tbp-gate .gate-card{background:white;border:1px solid var(--border);border-radius:16px;padding:36px 32px;text-align:center}',
    '#tbp-gate .gate-logo{width:56px;height:56px;margin:0 auto 20px;background:#1D6FA4;border-radius:12px;display:flex;align-items:center;justify-content:center}',
    '#tbp-gate .gate-logo svg{width:28px;height:28px;fill:white}',
    '#tbp-gate h1{font-size:20px;font-weight:700;color:var(--text);margin-bottom:6px}',
    '#tbp-gate .gate-sub{font-size:13px;color:var(--text2);margin-bottom:28px;line-height:1.5}',
    '#tbp-gate .gate-label{font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;text-align:left;margin-bottom:6px}',
    '#tbp-gate .gate-input{width:100%;border:1.5px solid var(--border);border-radius:8px;padding:12px 14px;font-size:14px;color:var(--text);background:white;transition:border-color 0.15s;margin-bottom:12px}',
    '#tbp-gate .gate-input:focus{outline:none;border-color:var(--blue)}',
    '#tbp-gate .gate-input.error{border-color:var(--red);background:var(--red-light)}',
    '#tbp-gate .gate-btn{width:100%;padding:13px;background:var(--blue);color:white;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:background 0.15s;display:flex;align-items:center;justify-content:center;gap:8px}',
    '#tbp-gate .gate-btn:hover{background:#185d8c}',
    '#tbp-gate .gate-btn:disabled{background:#94a3b8;cursor:not-allowed}',
    '#tbp-gate .gate-spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:tbp-spin 0.7s linear infinite;display:none}',
    '@keyframes tbp-spin{to{transform:rotate(360deg)}}',
    '#tbp-gate .gate-error{display:none;margin-top:12px;padding:10px 14px;background:var(--red-light);border:1px solid #f5c6c6;border-radius:8px;font-size:13px;color:var(--red);text-align:left;line-height:1.5}',
    '#tbp-gate .gate-footer{margin-top:20px;font-size:12px;color:var(--text3)}',
    '#tbp-gate .gate-footer a{color:var(--blue);text-decoration:none}',
    '#tbp-gate .gate-footer a:hover{text-decoration:underline}'
  ].join('');
  document.head.appendChild(style);

  function getSessionToken() {
    try {
      var expiry = sessionStorage.getItem(SESSION_EXPIRY_KEY);
      if (expiry && Date.now() < parseInt(expiry)) {
        return sessionStorage.getItem(SESSION_KEY);
      }
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_EXPIRY_KEY);
    } catch(e) {}
    return null;
  }

  function setSessionToken(token) {
    try {
      sessionStorage.setItem(SESSION_KEY, token);
      sessionStorage.setItem(SESSION_EXPIRY_KEY, (Date.now() + SESSION_DURATION_MS).toString());
    } catch(e) {}
  }

  function clearSession() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_EXPIRY_KEY);
    } catch(e) {}
  }

  function renderGate(toolName, onVerified) {
    // Hide body content while gate is showing
    document.body.style.overflow = 'hidden';

    var gate = document.createElement('div');
    gate.id = 'tbp-gate';
    gate.innerHTML = [
      '<div class="gate-card">',
        '<div class="gate-logo">',
          '<svg viewBox="0 0 20 20"><path d="M10 2L3 7v11h5v-5h4v5h5V7z"/></svg>',
        '</div>',
        '<h1>', toolName, '</h1>',
        '<p class="gate-sub">Think Beyond Practice member access.<br>Enter your Circle email to continue.</p>',
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
    }

    function verify() {
      clearError();
      var email = emailInput.value.trim().toLowerCase();
      if (!email || !email.includes('@')) {
        showError('Please enter a valid email address.');
        return;
      }

      setLoading(true);

      fetch('/.netlify/functions/circle-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        setLoading(false);
        if (data.verified) {
          setSessionToken(data.token || email);
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
    setTimeout(function() { emailInput.focus(); }, 100);
  }

  // Public API
  window.TBPAuth = {
    protect: function(options) {
      var toolName = options.toolName || 'Think Beyond Practice';
      var onVerified = options.onVerified || function() {};

      // Check for valid session first
      if (getSessionToken()) {
        onVerified();
        return;
      }

      // Wait for DOM ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
          renderGate(toolName, onVerified);
        });
      } else {
        renderGate(toolName, onVerified);
      }
    },

    clearSession: clearSession
  };

})();
