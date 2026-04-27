// netlify/functions/npi-lookup.js
// Proxies NPI lookups to the NPPES API to avoid CORS restrictions

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const npi = event.queryStringParameters?.number;
  if (!npi || npi.length !== 10) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid 10-digit NPI required' }) };
  }

  try {
    const res = await fetch('https://npiregistry.cms.hhs.gov/api/?number=' + npi + '&version=2.1');
    const data = await res.json();
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'NPPES API request failed: ' + err.message }) };
  }
};
