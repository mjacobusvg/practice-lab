// netlify/functions/med-suggestion.js
// Receives medication suggestions from the Interaction Interpreter
// and logs them to the Supabase tool_usage table for review.

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    var body = JSON.parse(event.body);
    var medications = body.medications || '';
    var timestamp = body.timestamp || new Date().toISOString();

    // Log to Supabase
    var supabaseUrl = process.env.SUPABASE_URL;
    var supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (supabaseUrl && supabaseKey) {
      await fetch(supabaseUrl + '/rest/v1/tool_usage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          tool: 'Interaction Interpreter',
          mode: 'medication_suggestion',
          event: medications,
          created_at: timestamp
        })
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
