// netlify/functions/baa-document.js
//
// Authenticated retrieval of a signed BAA PDF. Security audit 2026-09-16, finding H3.
//
// WHAT WAS WRONG
// process-baa-signature.js stored each executed BAA in the Supabase Storage bucket
// `baa-documents`, which was marked PUBLIC, and then handed out
// `.../storage/v1/object/public/baa-documents/<path>` — a permanent, unauthenticated
// URL — in the confirmation email and on the signing page's download button.
//
// A public bucket's /object/public/ route bypasses RLS by design, so the only thing
// standing between an outsider and a countersigned agreement was guessing the path.
// The path was NOT random: `baa-signed/baa_<email with non-alphanumerics -> _>_v<ver>_<Date.now()>.pdf`.
// Everything but the millisecond stamp is derivable from a member's email address, and
// the document carries the signer's legal name, practice entity, title, email, signing
// IP address and the ESIGN attestation block. 49 of them were sitting there.
//
// (Listing was not open — storage.objects has no anon SELECT policy — so this was a
// guess-the-path exposure, not an enumerate-the-bucket one. That is a difference in
// effort, not in kind.)
//
// WHAT THIS DOES
// The bucket is now private, and a BAA is reachable two ways, both of which prove who
// is asking before Supabase mints a short-lived signed URL:
//
//   POST { token }            — a verified session. Returns THIS member's own BAAs, each
//                               with a 5-minute signed URL. Admins may pass { id } to
//                               fetch any one of them.
//   GET  ?t=<link token>      — the link mailed to the signer. An HMAC over the signature
//                               id and an expiry, keyed with SESSION_SIGNING_SECRET, so it
//                               is unguessable, expires, and is scoped to ONE document.
//                               Redirects to the signed URL.
//
// A mailed link is still a bearer credential — anyone holding the email holds it. That is
// the same trust boundary as the PDF being attached to the mail, and it now expires.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET.

const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('./_lib/session');
const { verifyLinkToken } = require('./_lib/baa-link');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com', 'michael@thinkbeyondpractice.com', 'michael.vangelder@gmail.com'];

const BUCKET = 'baa-documents';
const SIGNED_URL_TTL_SEC = 300; // the URL Supabase mints; long enough to click, short enough not to circulate

function supa() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function signedUrlFor(sb, storagePath) {
  if (!storagePath) return null;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_URL_TTL_SEC);
  if (error) { console.error('baa-document: createSignedUrl failed:', error.message); return null; }
  return (data && data.signedUrl) || null;
}

// A plain page, because this arm is reached by clicking a link in an email — an error
// here is read by a person, not by fetch().
function htmlPage(statusCode, heading, detail) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:64px auto;padding:0 20px;color:#1a1a2e">' +
      '<h1 style="font-size:20px;color:#0b1120">' + heading + '</h1>' +
      '<p style="line-height:1.6;color:#4b5563">' + detail + '</p>' +
      '<p style="line-height:1.6;color:#4b5563">Email <a href="mailto:michael@thinkbeyondpractice.com">michael@thinkbeyondpractice.com</a> and I will send you a fresh copy.</p>' +
      '</div>'
  };
}

exports.handler = async (event) => {
  const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !process.env.SESSION_SIGNING_SECRET) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Server misconfigured' }) };
  }

  // ── Email-link arm ──
  if (event.httpMethod === 'GET') {
    const t = (event.queryStringParameters && event.queryStringParameters.t) || '';
    const link = verifyLinkToken(t);
    if (!link.valid) {
      return link.reason === 'expired'
        ? htmlPage(410, 'This download link has expired', 'Signed BAA links are good for 30 days. Sign in to the platform to download your copy, or ask for a new link.')
        : htmlPage(403, 'This link is not valid', 'The link may have been altered in transit, or copied incompletely.');
    }
    const sb = supa();
    const { data: row, error } = await sb.from('baa_signatures')
      .select('id, pdf_storage_path').eq('id', link.claims.sid).maybeSingle();
    if (error || !row || !row.pdf_storage_path) {
      return htmlPage(404, 'That agreement could not be found', 'The record exists no longer, or no PDF was stored with it.');
    }
    const url = await signedUrlFor(sb, row.pdf_storage_path);
    if (!url) return htmlPage(500, 'The download could not be prepared', 'Something went wrong on our side.');
    return { statusCode: 302, headers: { Location: url, 'Cache-Control': 'no-store' }, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Signed-in arm ──
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const session = verifyToken((body.token || authHeader.replace(/^Bearer\s+/i, '')).trim());
  if (!session.valid) {
    return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
  }
  const email = String(session.claims.email || '').trim().toLowerCase();
  if (!email) {
    return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: 'Session missing identity.' }) };
  }
  const isAdmin = ADMIN_EMAILS.indexOf(email) !== -1;

  try {
    const sb = supa();
    let q = sb.from('baa_signatures')
      .select('id, member_name, baa_version, signed_at, entity_name, pdf_storage_path')
      .order('signed_at', { ascending: false });

    // Scope is the token's email. An admin asking for one specific id is the only way
    // to reach someone else's agreement, and it is still server-side — the client never
    // names whose BAA it wants.
    if (body.id && isAdmin) q = q.eq('id', body.id);
    else q = q.eq('member_email', email);

    const { data, error } = await q;
    if (error) {
      console.error('baa-document lookup failed:', error.message);
      return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Lookup failed' }) };
    }

    const documents = [];
    for (const row of (data || [])) {
      documents.push({
        id: row.id,
        member_name: row.member_name,
        baa_version: row.baa_version,
        signed_at: row.signed_at,
        entity_name: row.entity_name,
        url: await signedUrlFor(sb, row.pdf_storage_path),
        expires_in: SIGNED_URL_TTL_SEC
      });
    }
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true, documents }) };
  } catch (err) {
    console.error('baa-document error:', err);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Unexpected error' }) };
  }
};
