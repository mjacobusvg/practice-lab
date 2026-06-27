// netlify/functions/template-download.js
// Returns a download URL for a template only if the member's tier qualifies.
// Files in the private 'templates' bucket are served via short-lived signed URLs;
// external file_url templates return the link directly.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { verifyToken } = require('./_lib/session');

const TIER_RANK = { free: 0, forum: 1, full: 2 };

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }
  const templateId = String(p.template_id || '').trim();

  // Identity + tier from the SIGNED token (not a client email). The token's tier claim is
  // authoritative and fresher than an accounts lookup, and cannot be spoofed to grab paid/
  // full templates at another member's tier.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in to download' }) };
  const email = String(session.claims.email || '').toLowerCase().trim();
  if (!templateId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'template_id required' }) };

  const sbHeaders = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY };
  try {
    // Prefer the token's tier claim; fall back to accounts lookup if absent (e.g. hub scope).
    let tier = session.claims.tier || null;
    if (!tier) {
      const acctRes = await fetch(URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) + '&select=tier', { headers: sbHeaders });
      const accts = await acctRes.json();
      tier = (accts && accts[0]) ? accts[0].tier : 'free';
    }

    const tplRes = await fetch(URL + '/rest/v1/template_library?id=eq.' + encodeURIComponent(templateId) + '&select=file_url,storage_path,min_tier,is_paid', { headers: sbHeaders });
    const tpls = await tplRes.json();
    if (!tpls || !tpls.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Template not found' }) };
    const tpl = tpls[0];

    if (tpl.is_paid) {
      if (tier !== 'full') return { statusCode: 402, headers, body: JSON.stringify({ ok: false, error: 'This is a paid template' }) };
    } else if ((TIER_RANK[tier] || 0) < (TIER_RANK[tpl.min_tier] || 2)) {
      return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Upgrade required to download this template' }) };
    }

    // Private storage file: mint a short-lived signed URL
    if (tpl.storage_path) {
      const signRes = await fetch(URL + '/storage/v1/object/sign/templates/' + tpl.storage_path, {
        method: 'POST',
        headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 120 })
      });
      const signData = await signRes.json();
      if (!signRes.ok || !signData.signedURL) throw new Error('Could not sign file URL');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, url: URL + '/storage/v1' + signData.signedURL }) };
    }

    if (tpl.file_url) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, url: tpl.file_url }) };
    return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No file attached yet' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
