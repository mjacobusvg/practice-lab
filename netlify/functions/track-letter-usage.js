// netlify/functions/track-letter-usage.js
// Records usage analytics for TBP Letter Standards.
// Uses Supabase REST API directly (no SDK dependency).
//
// POST body: { standard_id, standard_key, variant_key, clinician_email, generation_time_seconds, toggle_state }

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const standard_id = payload.standard_id || null;
  const standard_key = payload.standard_key || null;
  const variant_key = payload.variant_key || null;
  const clinician_email = payload.clinician_email || null;
  const generation_time_seconds = payload.generation_time_seconds || null;
  const toggle_state = payload.toggle_state || null;

  if (!standard_key && !standard_id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'standard_key or standard_id required' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server misconfigured: missing Supabase credentials' })
    };
  }

  try {
    const insertBody = {
      standard_id: standard_id,
      standard_key: standard_key,
      variant_key: variant_key,
      clinician_email: clinician_email,
      generation_time_seconds: generation_time_seconds,
      toggle_state: toggle_state
    };

    const response = await fetch(SUPABASE_URL + '/rest/v1/tbp_letter_standard_usage', {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(insertBody)
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('[track-letter-usage] Supabase error:', response.status, text);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Supabase returned ' + response.status, detail: text })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ tracked: true })
    };
  } catch (err) {
    console.error('[track-letter-usage] fetch error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Internal error' })
    };
  }
};
