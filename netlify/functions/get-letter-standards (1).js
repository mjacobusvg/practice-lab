// netlify/functions/get-letter-standards.js
// Returns active TBP Clinical Letter Standards.
// Uses Supabase REST API directly (no SDK dependency).
//
// GET /.netlify/functions/get-letter-standards
//   ?email=user@example.com   (optional - if provided, also returns user's own templates)
//   ?standard_key=esa         (optional - filter to one category)

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server misconfigured: missing Supabase credentials' })
    };
  }

  const qs = event.queryStringParameters || {};
  const email = (qs.email || '').toLowerCase().trim();
  const standardKey = (qs.standard_key || '').trim();

  // Build Supabase REST URL with PostgREST filters
  const selectCols = 'id,standard_key,variant_key,version,category_label,variant_label,short_description,spec,body_template,placeholders,conditional_blocks,optional_toggles,authored_by,author_name,is_system,is_shared_to_group,status,created_at,updated_at';

  let url = SUPABASE_URL + '/rest/v1/tbp_letter_standards'
    + '?select=' + encodeURIComponent(selectCols)
    + '&status=eq.active'
    + '&order=standard_key.asc,variant_key.asc';

  if (email) {
    url += '&or=(is_system.eq.true,authored_by.eq.' + encodeURIComponent(email) + ')';
  } else {
    url += '&is_system=eq.true';
  }

  if (standardKey) {
    url += '&standard_key=eq.' + encodeURIComponent(standardKey);
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('[get-letter-standards] Supabase error:', response.status, text);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Supabase returned ' + response.status, detail: text })
      };
    }

    const data = await response.json();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        standards: data || [],
        count: (data || []).length,
        retrieved_at: new Date().toISOString()
      })
    };
  } catch (err) {
    console.error('[get-letter-standards] fetch error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Internal error' })
    };
  }
};
