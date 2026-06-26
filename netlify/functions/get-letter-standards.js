// netlify/functions/get-letter-standards.js
// Returns active TBP Clinical Letter Standards (and optionally a single user's templates).
//
// GET /.netlify/functions/get-letter-standards
//   ?email=user@example.com   (optional - if provided, also returns user's own templates)
//   ?standard_key=esa         (optional - filter to one category)
//
// Returns: { standards: [...] }
// Each standard contains: id, standard_key, variant_key, version, category_label, variant_label,
//                         short_description, spec, body_template, placeholders, conditional_blocks,
//                         optional_toggles, authored_by, author_name, is_system, is_shared_to_group

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300'  // Cache 5 min; standards are slow-changing
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server misconfigured: missing Supabase credentials' })
    };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const qs = event.queryStringParameters || {};
  const email = (qs.email || '').toLowerCase().trim();
  const standardKey = (qs.standard_key || '').trim();

  try {
    // Always fetch active system-authored standards
    let query = supabase
      .from('tbp_letter_standards')
      .select('id, standard_key, variant_key, version, category_label, variant_label, short_description, spec, body_template, placeholders, conditional_blocks, optional_toggles, authored_by, author_name, is_system, is_shared_to_group, status, created_at, updated_at')
      .eq('status', 'active')
      .or('is_system.eq.true' + (email ? `,authored_by.eq.${email}` : ''))
      .order('standard_key', { ascending: true })
      .order('variant_key', { ascending: true });

    if (standardKey) {
      query = query.eq('standard_key', standardKey);
    }

    const { data, error } = await query;
    if (error) throw error;

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
    console.error('[get-letter-standards] error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Internal error' })
    };
  }
};
