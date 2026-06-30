// netlify/functions/letter-sign-info.js
// Serves the medicaid-sign.html page the data it needs to render the form for a given signing
// token: the resolved (provider-filled) form text and the toggle state. Returns NO patient data
// (there is none stored). Validates the token is pending + unexpired.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { buildLetterPdf } = require('./_lib/build-letter-pdf'); // reuse its template render via _internals
const { _internals } = require('./_lib/build-letter-pdf');

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured' }) };

  const token = ((event.queryStringParameters || {}).t || '').trim();
  if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing token' }) };

  function sb(path) {
    return fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY, 'Accept': 'application/json' }
    });
  }

  try {
    const tok = (await (await sb('letter_sign_tokens?token=eq.' + encodeURIComponent(token) + '&select=*&limit=1')).json())[0];
    if (!tok) return { statusCode: 404, headers, body: JSON.stringify({ error: 'invalid', message: 'This signing link is not valid.' }) };
    if (tok.status === 'signed') return { statusCode: 200, headers, body: JSON.stringify({ status: 'signed', message: 'This form has already been signed. Thank you.' }) };
    if (tok.status === 'expired' || new Date(tok.expires_at) < new Date()) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'expired', message: 'This signing link has expired. Please contact your provider for a new one.' }) };
    }

    const std = (await (await sb('tbp_letter_standards?id=eq.' + tok.standard_id + '&select=body_template,placeholders,optional_toggles,category_label')).json())[0];
    if (!std) return { statusCode: 404, headers, body: JSON.stringify({ error: 'standard not found' }) };

    const vault = ((await (await sb('user_tool_data?tool_id=eq.vault_profile&email=eq.' + encodeURIComponent(tok.provider_email) + '&select=data&limit=1')).json())[0] || {}).data || {};

    const placeholders = {};
    const defs = std.placeholders || [];
    defs.forEach(function (p) {
      if (p.source === 'vault') placeholders[p.key] = vaultValue(vault, p.key);
      else if (p.source === 'auto' && p.default_value === 'today') placeholders[p.key] = formatToday(0);
      else if (p.source === 'auto' && /^today\+\d+$/.test(p.default_value || '')) placeholders[p.key] = formatToday(parseInt(p.default_value.split('+')[1], 10));
      else if (p.default_value) placeholders[p.key] = p.default_value;
    });
    const toggles = {};
    (std.optional_toggles || []).forEach(function (t) { toggles[t.key] = t.default_value; });
    Object.assign(toggles, tok.toggles || {});

    // Render the provider-filled body for on-screen review (patient fields still blank).
    const rendered = _internals.libRenderTemplate(std.body_template, placeholders, toggles, defs);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        status: 'pending',
        title: std.category_label || 'Private-Pay Acknowledgment',
        rendered_body: rendered,
        practice_name: vaultValue(vault, 'PROVIDER_PRACTICE')
      })
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function vaultValue(v, key) {
  switch (key) {
    case 'PROVIDER_NAME': return v.legalName || v.providerName || v.name || '';
    case 'PROVIDER_CREDENTIALS': return v.credentials || '';
    case 'PROVIDER_PRACTICE': return v.practiceName || '';
    case 'PROVIDER_NPI': return v.npi1 || v.npi || '';
    default: return '';
  }
}
function formatToday(o) {
  const m = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const d = new Date(); d.setDate(d.getDate() + (o || 0));
  return m[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}
