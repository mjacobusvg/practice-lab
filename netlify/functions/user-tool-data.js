// netlify/functions/user-tool-data.js
// Generic persistence layer for Practice Manager tools.
// Stores per-user, per-tool JSON data in Supabase.
//
// Environment variables:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   CIRCLE_API_V2_TOKEN (for verifying user identity)
//
// Endpoints (all POST):
//   action: "load"   - Load saved data for a tool
//   action: "save"   - Save/update data for a tool
//   action: "delete" - Delete saved data for a tool
//
// Request body:
//   email: string     - User's verified email (from tbp_verified_email)
//   toolId: string    - Tool identifier (e.g., "hipaa_binder", "ce_tracker")
//   action: string    - "load" | "save" | "delete"
//   data: object      - (save only) The data to store
//
// Security: Verifies email is an active Circle community member before any operation.

exports.handler = async function(event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  var supabaseUrl = process.env.SUPABASE_URL;
  var supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  var circleToken = process.env.CIRCLE_API_V2_TOKEN;

  if (!supabaseUrl || !supabaseKey || !circleToken) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: 'Server configuration missing.' })
    };
  }

  var body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Invalid request body.' }) };
  }

  var email = (body.email || '').trim().toLowerCase();
  var toolId = (body.toolId || '').trim();
  var action = (body.action || '').trim();

  if (!email || !toolId || !action) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Missing required fields: email, toolId, action.' }) };
  }

  if (['load', 'save', 'delete'].indexOf(action) === -1) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Invalid action. Must be load, save, or delete.' }) };
  }

  // Verify the email belongs to an active Circle member
  try {
    var verifyRes = await fetch('https://app.circle.so/api/v1/community_members/search?email=' + encodeURIComponent(email), {
      headers: { 'Authorization': 'Token ' + circleToken }
    });

    if (!verifyRes.ok) {
      return { statusCode: 403, headers: headers, body: JSON.stringify({ error: 'Could not verify membership.' }) };
    }

    var memberData = await verifyRes.json();
    // Circle v1 search returns an array or object; check for active member
    var member = Array.isArray(memberData) ? memberData[0] : memberData;
    if (!member || !member.id) {
      return { statusCode: 403, headers: headers, body: JSON.stringify({ error: 'No active membership found for this email.' }) };
    }
  } catch(e) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'Membership verification failed.' }) };
  }

  // Supabase REST API base
  var tableUrl = supabaseUrl + '/rest/v1/user_tool_data';
  var supaHeaders = {
    'apikey': supabaseKey,
    'Authorization': 'Bearer ' + supabaseKey,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  try {
    if (action === 'load') {
      var loadRes = await fetch(
        tableUrl + '?email=eq.' + encodeURIComponent(email) + '&tool_id=eq.' + encodeURIComponent(toolId) + '&select=data,updated_at',
        { headers: supaHeaders }
      );
      var loadData = await loadRes.json();
      if (loadData && loadData.length > 0) {
        return {
          statusCode: 200,
          headers: headers,
          body: JSON.stringify({ found: true, data: loadData[0].data, updatedAt: loadData[0].updated_at })
        };
      }
      return { statusCode: 200, headers: headers, body: JSON.stringify({ found: false }) };
    }

    if (action === 'save') {
      if (!body.data || typeof body.data !== 'object') {
        return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Missing or invalid data field.' }) };
      }

      // Upsert: try to update existing row, insert if not found
      var upsertRes = await fetch(
        tableUrl + '?on_conflict=email,tool_id',
        {
          method: 'POST',
          headers: Object.assign({}, supaHeaders, { 'Prefer': 'resolution=merge-duplicates,return=representation' }),
          body: JSON.stringify({
            email: email,
            tool_id: toolId,
            data: body.data,
            updated_at: new Date().toISOString()
          })
        }
      );

      if (!upsertRes.ok) {
        var errText = await upsertRes.text();
        return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'Save failed.', detail: errText }) };
      }

      return { statusCode: 200, headers: headers, body: JSON.stringify({ saved: true }) };
    }

    if (action === 'delete') {
      var delRes = await fetch(
        tableUrl + '?email=eq.' + encodeURIComponent(email) + '&tool_id=eq.' + encodeURIComponent(toolId),
        { method: 'DELETE', headers: supaHeaders }
      );

      return { statusCode: 200, headers: headers, body: JSON.stringify({ deleted: true }) };
    }
  } catch(e) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'Database operation failed.' }) };
  }
};
