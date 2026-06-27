// ============================================
// check-baa-status.js
// Netlify Function
// ============================================
// Quick lookup: does this email have a signed BAA?
// Used by baa-gate.js on Practice Manager tool pages.
// ============================================

const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('./_lib/session');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const body = JSON.parse(event.body || '{}');

        // Identity from the SIGNED session token (body.token or Authorization: Bearer),
        // never from a client-supplied email. The PHI gate already holds the token.
        const authHeader = event.headers.authorization || event.headers.Authorization || '';
        const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
        const session = verifyToken(sessionToken);
        if (!session.valid) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
        }
        const email = String(session.claims.email || '').trim().toLowerCase();
        if (!email) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Session missing identity.' }) };
        }

        const { data, error } = await supabase
            .from('baa_signatures')
            .select('id, baa_version, signed_at')
            .eq('member_email', email)
            .order('signed_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error('BAA check error:', error);
            // Fail open: don't block access on DB errors
            return {
                statusCode: 200,
                body: JSON.stringify({ hasBaa: true, note: 'Check failed, defaulting to open' })
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                hasBaa: !!data,
                baaVersion: data?.baa_version || null,
                signedAt: data?.signed_at || null
            })
        };

    } catch (err) {
        console.error('BAA check error:', err);
        return {
            statusCode: 200,
            body: JSON.stringify({ hasBaa: true, note: 'Check failed, defaulting to open' })
        };
    }
};
