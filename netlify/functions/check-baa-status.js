// ============================================
// check-baa-status.js
// Netlify Function
// ============================================
// Quick lookup: does this email have a signed BAA?
// Used by the PHI gate in auth-gate.js on tool pages that may process PHI.
//
// FAILS CLOSED. Until 2026-09-16 a database error here answered
// 200 {hasBaa: true, note: 'Check failed, defaulting to open'}, and the gate believes
// this endpoint — so a Supabase blip let anyone straight past the BAA wall into the
// clinical tools. That is the one check standing between an unsigned member and PHI
// processing, so availability is not the thing to optimise for.
//
// A transient blip is absorbed by one retry. A persistent failure answers 503 and
// hasBaa:false, and the gate distinguishes THAT from "no BAA on file" — it must, or it
// would send a member who has already signed to sign again, where the server answers
// 409 and they are stuck. The sibling record-terms-acceptance has always failed closed.
// ============================================

const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('./_lib/session');

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

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

        const { data, error } = await lookupLatestBaa(email);

        if (error) {
            console.error('BAA check unavailable:', (error && error.message) || error);
            return unavailable();
        }

        return {
            statusCode: 200,
            headers: NO_STORE,
            body: JSON.stringify({
                ok: true,
                hasBaa: !!data,
                baaVersion: data?.baa_version || null,
                signedAt: data?.signed_at || null
            })
        };

    } catch (err) {
        console.error('BAA check unavailable:', err);
        return unavailable();
    }
};

// One retry: a single transient blip should not put an overlay in front of a clinician
// mid-visit. Two failures in a row is a real outage, and the answer to that is a refusal.
async function lookupLatestBaa(email) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise(function (r) { setTimeout(r, 250); });
        // A dropped connection THROWS rather than returning {error}, and that is the
        // likelier transient failure of the two, so it has to be retried as well.
        try {
            const { data, error } = await supabase
                .from('baa_signatures')
                .select('id, baa_version, signed_at')
                .eq('member_email', email)
                .order('signed_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            if (!error) return { data: data };
            lastError = error;
        } catch (e) {
            lastError = e;
        }
    }
    return { error: lastError };
}

// 503 + an explicit reason. hasBaa:false keeps a caller that reads only that field on the
// safe side; `error` is what lets the gate say "could not verify" instead of "go sign one".
function unavailable() {
    return {
        statusCode: 503,
        headers: NO_STORE,
        body: JSON.stringify({ ok: false, hasBaa: false, error: 'check_unavailable' })
    };
}
