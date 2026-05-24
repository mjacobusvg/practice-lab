// netlify/functions/crisis-resources.js
// Read/write community crisis resources from Supabase
// GET: fetch resources by state (and optionally county)
// POST: contribute a new resource

const fetch = require('node-fetch');

exports.handler = async function(event) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    if (event.httpMethod === 'GET') {
      // Fetch resources for a state (and optionally county)
      var params = event.queryStringParameters || {};
      var state = (params.state || '').toUpperCase();
      if (!state || state.length !== 2) return { statusCode: 400, headers, body: JSON.stringify({ error: 'State required (2-letter code)' }) };

      var url = SUPABASE_URL + '/rest/v1/crisis_resources?state=eq.' + state + '&order=is_default.desc,verified.desc,contributed_at.asc';
      var resp = await fetch(url, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
      });
      var data = await resp.json();

      // If county specified, also include county-specific results
      if (params.county) {
        var countyUrl = SUPABASE_URL + '/rest/v1/crisis_resources?state=eq.' + state + '&county=ilike.' + encodeURIComponent('%' + params.county + '%') + '&order=verified.desc,contributed_at.asc';
        var countyResp = await fetch(countyUrl, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
        });
        var countyData = await countyResp.json();
        // Merge, dedup by id
        var ids = new Set(data.map(function(r) { return r.id; }));
        countyData.forEach(function(r) { if (!ids.has(r.id)) { data.push(r); ids.add(r.id); } });
      }

      return { statusCode: 200, headers, body: JSON.stringify(data) };

    } else if (event.httpMethod === 'POST') {
      // Contribute a new resource
      var body = JSON.parse(event.body);
      if (!body.state || !body.resource_name) return { statusCode: 400, headers, body: JSON.stringify({ error: 'state and resource_name required' }) };

      var record = {
        state: body.state.toUpperCase(),
        county: body.county || null,
        resource_name: body.resource_name,
        phone: body.phone || null,
        instructions: body.instructions || null,
        contributed_by: body.contributed_by || 'anonymous',
        is_default: false,
        verified: false
      };

      var resp = await fetch(SUPABASE_URL + '/rest/v1/crisis_resources', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(record)
      });
      var data = await resp.json();
      return { statusCode: 201, headers, body: JSON.stringify(data) };

    } else {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
