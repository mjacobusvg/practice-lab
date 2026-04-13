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
      document.body.style.background = '#0b1120';
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
        if (data.verified) {
          setSessionToken(data.token || email);
          try {
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
    setTimeout(function() { emailInput.focus(); }, 100);
  }

  // Public API
  window.TBPAuth = {
    protect: function(options) {
      var toolName = options.toolName || 'Think Beyond Practice';
      var spaceId = options.spaceId || null;
      var onVerified = options.onVerified || function() {};

      if (getSessionToken()) {
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

})();
