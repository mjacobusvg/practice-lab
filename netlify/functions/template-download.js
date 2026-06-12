// netlify/functions/template-download.js
// Returns a template's file_url only if the member's tier qualifies.
// The file_url is never exposed via the public template_library SELECT policy;
// it is handed out here after a server-side tier check.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }
  const email = String(p.email || '').toLowerCase().trim();
  const templateId = String(p.template_id || '').trim();
  if (!email || !templateId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Sign in to download' }) };

  const sbHeaders = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY };
  try {
    const acctRes = await fetch(URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) + '&select=tier', { headers: sbHeaders });
    const accts = await acctRes.json();
    const tier = (accts && accts[0]) ? accts[0].tier : 'free';

    const tplRes = await fetch(URL + '/rest/v1/template_library?id=eq.' + encodeURIComponent(templateId) + '&select=file_url,min_tier,is_paid', { headers: sbHeaders });
    const tpls = await tplRes.json();
    if (!tpls || !tpls.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Template not found' }) };
    const tpl = tpls[0];

    // Paid templates require the (future) purchase check; for now only full-tier passes.
    if (tpl.is_paid) {
      // Placeholder until Stripe individual sales ship: full members get it, others must buy.
      if (tier !== 'full') return { statusCode: 402, headers, body: JSON.stringify({ ok: false, error: 'This is a paid template' }) };
    } else if ((TIER_RANK[tier] || 0) < (TIER_RANK[tpl.min_tier] || 2)) {
      return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Upgrade required to download this template' }) };
    }

    if (!tpl.file_url) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No file attached yet' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, url: tpl.file_url }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
