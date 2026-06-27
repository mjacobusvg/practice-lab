// netlify/functions/user-tool-data.js  (thinkbeyondpractice repo)
// Generic persistence layer for Practice Manager tools.
// Stores per-user, per-tool JSON data in Supabase.
//
// SECURITY (hardened): identity comes from a SIGNED SESSION TOKEN, verified
// server-side via _lib/session.js. The client no longer supplies its own email
// — a caller cannot read or write another user's data by claiming their address.
// The old email + circle-auth round-trip is removed entirely.
//
// Environment variables:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   SESSION_SIGNING_SECRET   (must match every other repo/Netlify project)
//
// Endpoints (all POST):
//   action: "load" | "save" | "delete"
//
// Request body:
//   token:  string  - signed session token (from localStorage 'tbp_auth_token')
//   toolId: string  - tool identifier (e.g. "hipaa_binder", "ce_tracker", "vault_profile")
//   action: string
//   data:   object  - (save only) the data to store
//
// SCOPE:
//   'member' scope reaches every toolId.
//   'hub' scope (standalone Credentialing Hub buyer) reaches ONLY 'vault_profile'
//   (the shared provider profile the Hub depends on) — nothing else here.

const { verifyToken } = require('./_lib/session');

// Tools a non-member ('hub') scope may touch in this repo. Extend if more
// tools become standalone-eligible.
const HUB_ALLOWED_TOOLS = ['vault_profile'];

exports.handler = async function(event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'Server configuration missing.' }) };
  }

  var body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Invalid request body.' }) };
  }

  // Token may arrive in the body or the Authorization: Bearer header.
  var authHeader = event.headers.authorization || event.headers.Authorization || '';
  var token = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  var toolId = (body.toolId || '').trim();
  var action = (body.action || '').trim();

  if (!token || !toolId || !action) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Missing required fields: token, toolId, action.' }) };
  }
  if (['load', 'save', 'delete'].indexOf(action) === -1) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Invalid action. Must be load, save, or delete.' }) };
  }

  // Verify the SIGNED token. Identity (email) comes from the verified token,
  // never from client input.
  var session = verifyToken(token);
  if (!session.valid) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: 'Invalid or expired session.', reason: session.reason }) };
  }

  // ACCESS RULES:
  //   - vault_profile is the one shared store: ANY authenticated identity may use it
  //     (full member, forum-only member, or standalone hub buyer). The Vault is just
  //     data; it's useless without full-tier tools, so forum members may fill it out.
  //   - Every OTHER toolId requires a FULL member (scope 'member' AND tier 'full').
  //     Forum-only members (tier 'forum') and hub-scope buyers are blocked from them.
  var scope = session.claims.scope;
  var tier = session.claims.tier || null;
  // vault_profile is the one shared store ANY authenticated identity may use (full
  // member, forum-only member, or standalone hub buyer) — it's just a profile, useless
  // without full-tier tools. Every OTHER toolId requires a FULL member (scope 'member'
  // AND tier 'full'); forum-only and hub-scope are blocked. The clinical/practice tools
  // that write these stores (HIPAA Hub, Compliance Tracker, etc.) are full-tier tools.
  var SHARED_TOOLS = ['vault_profile'];
  var isShared = SHARED_TOOLS.indexOf(toolId) !== -1;
  var isFullMember = (scope === 'member' && tier === 'full');
  if (!isShared && !isFullMember) {
    return { statusCode: 403, headers: headers, body: JSON.stringify({ error: 'This tool requires the full Think Beyond Practice membership.' }) };
  }

  var email = (session.claims.email || '').trim().toLowerCase();
  if (!email) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: 'Session missing identity.' }) };
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
      await fetch(
        tableUrl + '?email=eq.' + encodeURIComponent(email) + '&tool_id=eq.' + encodeURIComponent(toolId),
        { method: 'DELETE', headers: supaHeaders }
      );
      return { statusCode: 200, headers: headers, body: JSON.stringify({ deleted: true }) };
    }
  } catch(e) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'Database operation failed.' }) };
  }
};
