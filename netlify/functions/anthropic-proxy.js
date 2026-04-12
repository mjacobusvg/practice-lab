const https = require('https');

exports.handler = async function(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'API key not configured.' })
    };
  }

  try {
    const body = JSON.parse(event.body);
    const systemPrompt = body.system || '';
    const messages = body.messages || [];

    // Detect Practice Lab mode from system prompt
    function detectMode(prompt) {
      const p = prompt.toLowerCase();
      if (p.includes('billing simulator') || p.includes('era') || p.includes('remittance')) return 'Billing Simulator';
      if (p.includes('denial drill') || p.includes('denial scenario')) return 'Denial Drills';
      if (p.includes('chart coder') || p.includes('coding judgment')) return 'Chart Coder';
      if (p.includes('mdm foundation') || p.includes('medical decision')) return 'MDM Foundations';
      if (p.includes('psychotherapy') || p.includes('therapeutic')) return 'Psychotherapy Documentation';
      if (p.includes('paper remittance')) return 'Paper Remittance';
      if (p.includes('angela') || p.includes('insurance representative')) return 'Insurance Rep Chat';
      return 'Practice Lab';
    }

    const mode = detectMode(systemPrompt);

    // Log usage to Supabase asynchronously — don't block the response
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    if (supabaseUrl && supabaseKey) {
      fetch(supabaseUrl + '/rest/v1/tool_usage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          tool: 'Practice Lab',
          mode: mode,
          event: 'interaction',
          created_at: new Date().toISOString()
        })
      }).catch(function(e) { console.log('Usage log error:', e.message); });
    }

    const requestBody = JSON.stringify({
      model: body.model || 'claude-haiku-4-5-20251001',
      max_tokens: body.max_tokens || 1000,
      system: systemPrompt,
      messages: messages
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(requestBody)
        }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error('Anthropic API error ' + res.statusCode + ': ' + data));
            } else {
              resolve(parsed);
            }
          } catch(e) {
            reject(new Error('Invalid JSON from Anthropic (status ' + res.statusCode + '): ' + data));
          }
        });
      });
      req.on('error', (e) => { reject(e); });
      req.write(requestBody);
      req.end();
    });

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
