/**
 * Think Beyond Practice — Auth Gate Module
 * Drop this script into any protected page.
 * 
 * Usage:
 *   <script src="/auth-gate.js"></script>
 *   <script>
 *     TBPAuth.protect({
 *       toolName: 'Practice Lab',         // Display name shown on gate screen
 *       requireFull: true,                // Optional — require Full-tier ($119) membership
 *                                         // Omit for community-wide access (any active member)
 *       onVerified: function() { ... }    // Called when member is verified — load your tool here
 *     });
 *   </script>
 */

(function() {
  'use strict';

  var SESSION_KEY = 'tbp_auth_token';
  var SESSION_EXPIRY_KEY = 'tbp_auth_expiry';
  // The single sign-in path. An unauthenticated visitor is bounced to the
  // platform's Supabase login (magic link / Google); platform.html mints the
  // signed TBP token and redirects back to the tool they wanted (?returnTo).
  // This replaced the old per-tool email box that verified against Circle.
  var PLATFORM_URL = 'https://thinkbeyondpractice.com/platform';

  // Current Terms of Use version. BUMP THIS when the ToS document is materially
  // updated (e.g. when the attorney-finalized ToS replaces the interim version).
  // The acceptance check matches on (email, version), so changing the string
  // re-prompts every member to read and accept the new Terms at the clinical-tool
  // gate, and records a fresh timestamped/IP-stamped acceptance against the new
  // version. Keep in sync with CURRENT_TERMS_VERSION in
  // netlify/functions/record-terms-acceptance.js.
  var TBP_TERMS_VERSION = 'interim_v1';

  // ── MAINTENANCE MODE ──────────────────────────────────────────────────────
  // When true, every PHI/clinical tool (anything that runs the PHI gate, i.e. not
  // skipPHIGate) shows a full-screen "down for maintenance" notice and DOES NOT load
  // the tool, so no clinical content can be submitted to any backend. Non-PHI pages
  // (skipPHIGate: Practice Lab, Ask the Archive, marketing/platform) are unaffected.
  // Flip to false and push to main to bring the clinical tools back.
  var TBP_MAINTENANCE = true;
  var TBP_MAINTENANCE_MSG = 'Our clinical tools are briefly offline for a scheduled infrastructure upgrade. They will be back shortly. No patient data is affected. Thank you for your patience.';

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

  // Read the signed token's payload ({ email, scope, tier, cmid, exp }). The
  // signature isn't checked here (the server does that on every API call) — this
  // is only to read the tier/exp for gating UX.
  function parseToken(tok) {
    try {
      var b64 = tok.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      return JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch (e) { return null; }
  }

  function getSessionToken() {
    try {
      var tok = localStorage.getItem(SESSION_KEY);
      if (!tok) return null;
      var claims = parseToken(tok);
      // Honor the token's OWN expiry (~30 days), not the legacy 4-hour key — that
      // short window was forcing a re-login every few hours for no reason.
      if (claims && claims.exp && Date.now() < claims.exp) return tok;
      // Fallback for an unparseable token: the legacy 4-hour window.
      var expiry = localStorage.getItem(SESSION_EXPIRY_KEY);
      if (!claims && expiry && Date.now() < parseInt(expiry)) return tok;
      clearSession();
    } catch (e) {}
    return null;
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_EXPIRY_KEY);
    } catch(e) {}
  }

  // No local session → single Supabase login path via the platform. We preserve
  // a returnTo so platform.html can send the member back to THIS tool once it has
  // minted the signed token (see handleReturnTo in platform.html).
  function redirectToLogin() {
    var returnTo = '/';
    // Preserve the full intended location — path, query AND hash — so a deep link
    // like /pm-chart-coder.html?mode=foo#section survives the round trip.
    try { returnTo = window.location.pathname + window.location.search + window.location.hash; } catch (e) {}
    var url = PLATFORM_URL + '?returnTo=' + encodeURIComponent(returnTo);
    try { window.location.replace(url); } catch (e) { window.location.href = url; }
  }

  // Authenticated, but this tool needs Full tier and the member is forum-only.
  // Show an upgrade screen instead of redirecting — a redirect would loop, since
  // the platform would just re-mint the same forum token and send them back.
  function renderUpgrade(toolName) {
    function paint() {
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
          '<p class="gate-sub">This tool is part of the $119/month Full plan.<br>Your current plan doesn\'t include it.</p>',
          '<a class="gate-btn" style="text-decoration:none" href="', PLATFORM_URL, '?plan=full_monthly_119">Upgrade to Full</a>',
          '<div class="gate-footer">',
            'Questions? <a href="mailto:michael@thinkbeyondpractice.com">michael@thinkbeyondpractice.com</a>',
          '</div>',
        '</div>'
      ].join('');
      document.body.appendChild(gate);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
    else paint();
  }

  // Full-screen "scheduled maintenance" notice. Painted for PHI tools when
  // TBP_MAINTENANCE is on; the tool itself never loads behind it.
  function renderMaintenance(toolName) {
    function paint() {
      try { document.body.style.overflow = 'hidden'; } catch (e) {}
      var o = document.createElement('div');
      o.id = 'tbp-maintenance';
      o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--tbp-navy,#0b1120);display:flex;align-items:center;justify-content:center;padding:20px;font-family:-apple-system,"DM Sans",sans-serif;';
      o.innerHTML = [
        '<div style="max-width:460px;width:100%;background:var(--tbp-navy-mid,#111c30);border:1px solid var(--tbp-rule,rgba(42,171,184,0.2));border-top:2px solid var(--tbp-teal,#2aabb8);border-radius:8px;padding:40px 34px;text-align:center;color:var(--tbp-cream,#e8e2d6);">',
          '<div style="font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--tbp-teal,#2aabb8);margin-bottom:14px">Think Beyond Practice</div>',
          '<h1 style="font-size:20px;color:var(--tbp-white,#f5f4f2);margin:0 0 12px">Scheduled maintenance</h1>',
          '<p style="font-size:14px;color:var(--tbp-cream-dim,#b0aa9e);line-height:1.65;margin:0 0 22px">', TBP_MAINTENANCE_MSG, '</p>',
          '<p style="font-size:12px;color:var(--tbp-cream-dim,#b0aa9e);margin:0">Questions? <a href="mailto:michael@thinkbeyondpractice.com" style="color:var(--tbp-teal,#2aabb8);text-decoration:none">michael@thinkbeyondpractice.com</a></p>',
        '</div>'
      ].join('');
      document.body.appendChild(o);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
    else paint();
  }

  // Public API
  window.TBPAuth = {
    protect: function(options) {
      // Scheduled-maintenance gate: block every PHI/clinical tool up front (before
      // demo or auth), so nothing loads and no clinical content can be submitted.
      // Non-PHI pages pass skipPHIGate:true and are unaffected.
      // BYPASS for testing: the owner's own logged-in account passes through (so he can
      // verify a fix on the live site while everyone else still sees maintenance), and a
      // localStorage escape hatch (set tbp_maint_bypass='1', or visit any tool once with
      // ?maintbypass=1) lets a chosen browser through. The clinical backends still verify
      // the signed token on every call, so a bypass cannot grant anyone real access.
      if (TBP_MAINTENANCE && options && options.skipPHIGate !== true) {
        var maintBypass = false;
        try {
          if (/[?&]maintbypass=1(?:&|$)/.test(location.search)) localStorage.setItem('tbp_maint_bypass', '1');
          if (localStorage.getItem('tbp_maint_bypass') === '1') maintBypass = true;
        } catch (e) {}
        try {
          var _mtok = localStorage.getItem(SESSION_KEY);
          var _mcl = _mtok ? parseToken(_mtok) : null;
          var _mem = (_mcl && _mcl.email) ? String(_mcl.email).toLowerCase().trim() : '';
          if (_mem === 'michael.vangelder@gmail.com' || _mem === 'michael@thinkbeyondpractice.com') maintBypass = true;
        } catch (e) {}
        if (!maintBypass) {
          renderMaintenance(options.toolName || 'Think Beyond Practice');
          return;
        }
      }
      // ── Public demo mode (?demo=1) ──
      // Opens the tool with NO login, on baked-in demo content only. Two things make this safe:
      // (1) the clinical backends re-verify a signed full-tier token on every call and fail closed,
      // so a demo visitor (no token) can never actually generate; (2) the tool's own demo guard
      // intercepts every live button with a Join CTA before anything is sent. Nothing a visitor
      // types ever leaves their browser, so there is no PHI and no BAA to collect. This is the
      // top-of-funnel entry for prospects and free-tier members.
      var isDemo = false;
      try { isDemo = /(?:[?&])demo=1(?:&|$)/.test(location.search); } catch (e) {}
      if (isDemo) {
        window.TBP_DEMO = true;
        var demoVerified = options.onVerified || function () {};
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demoVerified);
        else demoVerified();
        return;
      }
      var toolName = options.toolName || 'Think Beyond Practice';
      // Canonical full-tier flag is requireFull:true. Legacy pages pass
      // spaceId:2546298 (the old Circle full-space id) to mean the same thing;
      // both are honored so nothing has to change in lockstep. This is purely a
      // "require full tier" marker now — tier comes from the signed token claim,
      // not a live Circle lookup, so it survives the platform migration unchanged.
      var FULL_SPACE_ID = 2546298;
      var requireFull = (options.requireFull === true) || (Number(options.spaceId) === FULL_SPACE_ID);
      var onVerified = options.onVerified || function() {};
      var skipPHIGate = options.skipPHIGate === true;
      var termsVersion = options.termsVersion || TBP_TERMS_VERSION;
      var baaVersion = options.baaVersion || '3.1';

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

      // A valid signed session token already present? Let them straight in:
      //  - community tools: any member token passes
      //  - full-tier tools: the token must carry tier 'full'
      // The clinical backends re-verify the signed token on every call, so
      // trusting the tier claim here is a UX shortcut, not the security boundary.
      var existing = getSessionToken();
      if (existing) {
        var claims = parseToken(existing) || {};
        var tier = String(claims.tier || '').toLowerCase();
        if (!requireFull || tier === 'full') { onVerified(); return; }
        // Authenticated, forum-only on a Full-tier tool. Before the upgrade wall,
        // honor a per-feature entitlement (a hand-granted trial pass) if this tool
        // declares one via options.feature. UX only: the clinical backend re-checks
        // the same entitlement and fails closed, so a bug here cannot grant real
        // access or burn credits — worst case a valid trialer sees the wall.
        if (options.feature) {
          checkFeatureEntitlement(existing, options.feature, function (active) {
            if (active) { onVerified(); return; }
            renderUpgrade(toolName);
          });
          return;
        }
        // Authenticated, but forum-only on a Full-tier tool → upgrade screen.
        renderUpgrade(toolName);
        return;
      }

      // No local session → bounce to the platform's Supabase login. It mints the
      // signed token and returns the member to this tool. No token is ever minted
      // here anymore (the old email/Circle gate is gone).
      redirectToLogin();
    },

    clearSession: clearSession
  };

  // Ask the server whether this member holds an active per-feature entitlement (a
  // hand-granted trial pass, e.g. a week of the Letter Generator). UX only; fails
  // closed to the upgrade wall on any error. cb(true|false).
  function checkFeatureEntitlement(token, feature, cb) {
    try {
      fetch('/.netlify/functions/check-entitlement?feature=' + encodeURIComponent(feature), {
        headers: { 'Authorization': 'Bearer ' + token }
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { cb(!!(d && d.active)); })
        .catch(function () { cb(false); });
    } catch (e) { cb(false); }
  }

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
