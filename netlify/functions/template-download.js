// netlify/functions/template-download.js
// Returns a download URL for a template only if the member's tier qualifies.
// Files in the private 'templates' bucket are served via short-lived signed URLs;
// external file_url templates return the link directly.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { verifyToken } = require('./_lib/session');

const TIER_RANK = { free: 0, forum: 1, full: 2 };
const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com', 'michael@thinkbeyondpractice.com', 'michael.vangelder@gmail.com'];

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

    const tplRes = await fetch(URL + '/rest/v1/template_library?id=eq.' + encodeURIComponent(templateId) + '&select=file_url,storage_path,min_tier,is_paid,member_price_cents', { headers: sbHeaders });
    const tpls = await tplRes.json();
    if (!tpls || !tpls.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Template not found' }) };
    const tpl = tpls[0];

    // Did the signed-in member individually purchase this template?
    const ownsTemplate = async function () {
      try {
        const meRes = await fetch(URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1', { headers: sbHeaders });
        const me = await meRes.json();
        if (!me || !me[0]) return false;
        const purRes = await fetch(URL + '/rest/v1/template_purchases?account_id=eq.' + me[0].id + '&template_id=eq.' + encodeURIComponent(templateId) + '&select=id&limit=1', { headers: sbHeaders });
        const pur = await purRes.json();
        return !!(pur && pur.length);
      } catch (e) { return false; }
    };

    // Access model:
    //  - Admins/owner: everything.
    //  - member_price_cents set (premium/flagship, e.g. the Complete Toolkit): NOBODY
    //    gets it via tier; forum/full members pay the reduced price too, so access
    //    requires an individual purchase.
    //  - Otherwise: every PAYING member (forum or full) gets all templates; free
    //    members get free/open templates, or a paid one they specifically bought.
    const paying = (tier === 'forum' || tier === 'full');
    const memberPriced = tpl.member_price_cents != null && tpl.member_price_cents > 0;
    let allowed = false;
    if (ADMIN_EMAILS.indexOf(email) !== -1) {
      allowed = true;
    } else if (memberPriced) {
      allowed = await ownsTemplate();
    } else if (paying) {
      allowed = true;
    } else if (!tpl.is_paid && (TIER_RANK[tier] || 0) >= (TIER_RANK[tpl.min_tier] || 2)) {
      allowed = true;
    } else if (tpl.is_paid) {
      allowed = await ownsTemplate();
    }
    if (!allowed) {
      return { statusCode: tpl.is_paid ? 402 : 403, headers, body: JSON.stringify({ ok: false, error: tpl.is_paid ? 'Purchase or join to download this template' : 'Join to download this template' }) };
    }

    // Private storage file: mint a short-lived signed URL. Encode each path segment so keys
    // with spaces or parentheses (e.g. a plainly-named uploaded .docx) sign correctly.
    if (tpl.storage_path) {
      const encodedPath = String(tpl.storage_path).split('/').map(encodeURIComponent).join('/');
      const signRes = await fetch(URL + '/storage/v1/object/sign/templates/' + encodedPath, {
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
