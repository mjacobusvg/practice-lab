// netlify/functions/track-letter-usage.js
// Lightweight analytics endpoint for tracking which TBP Letter Standards are used,
// by whom, with what toggle settings. Helps refine defaults and identify which standards
// need polish or which deserve new variants.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { standard_id, standard_key, variant_key, clinician_email, generation_time_seconds, toggle_state } = payload;

  if (!standard_key && !standard_id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'standard_key or standard_id required' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { error } = await supabase
      .from('tbp_letter_standard_usage')
      .insert({
        standard_id: standard_id || null,
        standard_key: standard_key || null,
        variant_key: variant_key || null,
        clinician_email: clinician_email || null,
        generation_time_seconds: generation_time_seconds || null,
        toggle_state: toggle_state || null
      });
    if (error) throw error;
    return { statusCode: 200, headers, body: JSON.stringify({ tracked: true }) };
  } catch (err) {
    console.error('[track-letter-usage] error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
