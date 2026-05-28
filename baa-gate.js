// ============================================
// baa-gate.js
// ============================================
// Drop this into any Practice Manager tool page.
// Checks if the current user has a signed BAA.
// If not, redirects to the BAA signing page.
//
// Usage: Add this script to any clinical tool HTML page:
//   <script src="/js/baa-gate.js"></script>
//
// It reads the member's email from their Circle auth
// (or however you identify logged-in members) and checks
// Supabase for a signed BAA record.
//
// If no BAA is found, it shows a prompt and redirects.
// ============================================

(function() {
    'use strict';

    const BAA_SIGN_URL = '/baa-sign.html';
    const BAA_CHECK_URL = '/.netlify/functions/check-baa-status';

    // Get member email from Circle auth or session
    // Adjust this to match your auth implementation
    function getMemberEmail() {
        // Option 1: From Circle SDK if available
        if (window.CircleAuth && window.CircleAuth.user) {
            return window.CircleAuth.user.email;
        }

        // Option 2: From a data attribute on the page
        const authEl = document.querySelector('[data-member-email]');
        if (authEl) {
            return authEl.getAttribute('data-member-email');
        }

        // Option 3: From localStorage/sessionStorage (set during auth flow)
        const stored = sessionStorage.getItem('tbp_member_email');
        if (stored) {
            return stored;
        }

        return null;
    }

    async function checkBaaStatus() {
        const email = getMemberEmail();

        if (!email) {
            // Can't determine member identity; skip gate check
            // This handles non-authenticated pages gracefully
            console.warn('BAA Gate: No member email found. Skipping BAA check.');
            return;
        }

        try {
            const response = await fetch(BAA_CHECK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email })
            });

            const data = await response.json();

            if (!data.hasBaa) {
                showBaaRequired(email);
            }
        } catch (err) {
            console.error('BAA Gate: Check failed', err);
            // On error, don't block access (fail open)
            // Log for debugging but don't prevent tool usage
        }
    }

    function showBaaRequired(email) {
        // Create overlay
        const overlay = document.createElement('div');
        overlay.id = 'baa-gate-overlay';
        overlay.innerHTML = `
            <div style="
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(11, 17, 32, 0.85);
                z-index: 99999;
                display: flex;
                align-items: center;
                justify-content: center;
                font-family: 'DM Sans', -apple-system, sans-serif;
            ">
                <div style="
                    background: white;
                    border-radius: 12px;
                    padding: 40px;
                    max-width: 480px;
                    width: 90%;
                    text-align: center;
                ">
                    <div style="
                        width: 56px; height: 56px;
                        background: #fff3e0;
                        border-radius: 50%;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        margin: 0 auto 20px;
                        font-size: 24px;
                    ">&#128221;</div>
                    <h2 style="
                        font-family: 'DM Serif Display', Georgia, serif;
                        color: #0b1120;
                        font-size: 1.3rem;
                        margin-bottom: 12px;
                    ">BAA Required</h2>
                    <p style="
                        color: #6b7280;
                        font-size: 0.95rem;
                        line-height: 1.6;
                        margin-bottom: 24px;
                    ">This tool processes clinical content that may include protected health information. A signed Business Associate Agreement is required before use.</p>
                    <a href="${BAA_SIGN_URL}?email=${encodeURIComponent(email)}&redirect=${encodeURIComponent(window.location.pathname)}" style="
                        display: inline-block;
                        padding: 14px 32px;
                        background: #2aabb8;
                        color: white;
                        text-decoration: none;
                        border-radius: 6px;
                        font-weight: 600;
                        font-size: 0.95rem;
                    ">Sign BAA Now</a>
                    <p style="
                        margin-top: 16px;
                        font-size: 0.8rem;
                        color: #9ca3af;
                    ">Questions? Contact michael@thinkbeyondpractice.com</p>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    // Run check on page load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkBaaStatus);
    } else {
        checkBaaStatus();
    }
})();
