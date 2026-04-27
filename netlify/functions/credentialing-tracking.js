// netlify/functions/credentialing-tracking.js
// Handles: POST new tracking entry, GET user's entries, POST /check-reminders (scheduled)

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;

  const supabaseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };

  const path = event.path.replace('/.netlify/functions/credentialing-tracking', '');

  try {
    // ── POST: Add or update a tracking entry ──
    if (event.httpMethod === 'POST' && (path === '' || path === '/')) {
      const body = JSON.parse(event.body);
      const { email, payer_name, submission_date, status, user_name, npi } = body;

      if (!email || !payer_name || !submission_date) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'email, payer_name, and submission_date are required' }) };
      }

      const row = {
        email: email.trim().toLowerCase(),
        payer_name: payer_name.trim(),
        submission_date: submission_date,
        status: status || 'submitted',
        user_name: user_name || '',
        npi: npi || '',
        reminder_30_sent: false,
        reminder_60_sent: false,
        reminder_90_sent: false,
        reminder_caqh_sent: false
      };

      const res = await fetch(SUPABASE_URL + '/rest/v1/credentialing_tracking', {
        method: 'POST',
        headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify(row)
      });

      const data = await res.json();
      return { statusCode: 201, headers, body: JSON.stringify({ success: true, data }) };
    }

    // ── GET: Fetch entries for a user ──
    if (event.httpMethod === 'GET') {
      const email = event.queryStringParameters?.email;
      if (!email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'email parameter required' }) };
      }

      const res = await fetch(
        SUPABASE_URL + '/rest/v1/credentialing_tracking?email=eq.' + encodeURIComponent(email.trim().toLowerCase()) + '&order=submission_date.asc',
        { headers: supabaseHeaders }
      );
      const data = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // ── PUT: Update status ──
    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body);
      const { id, status } = body;
      if (!id || !status) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'id and status required' }) };
      }

      const res = await fetch(
        SUPABASE_URL + '/rest/v1/credentialing_tracking?id=eq.' + id,
        {
          method: 'PATCH',
          headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
          body: JSON.stringify({ status, updated_at: new Date().toISOString() })
        }
      );
      const data = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, data }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('Error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
