const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const REDIRECT_URL = 'https://community.thinkbeyondpractice.com';
const COMMUNITY_ID = 377699;
const GATED_SPACE_ID = 2546298;

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ message: 'Method not allowed' }) };

  let email;
  try {
    const body = JSON.parse(event.body || '{}');
    email = (body.email || '').trim().toLowerCase();
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Invalid request' }) };
  }

  if (!email || !email.includes('@')) return { statusCode: 400, headers, body: JSON.stringify({ message: 'Valid email required' }) };
  if (!CIRCLE_API_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ message: 'Server configuration error' }) };

  try {
    // Use Circle Admin API v2 which supports proper email filtering
    const memberUrl = `https://app.circle.so/api/headless/admin/v2/community_members?email=${encodeURIComponent(email)}&community_id=${COMMUNITY_ID}`;
    console.log('Trying v2 URL:', memberUrl);

    const memberRes = await fetch(memberUrl, {
      headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' }
    });

    console.log('v2 status:', memberRes.status);
    const memberText = await memberRes.text();
    console.log('v2 response:', memberText.substring(0, 400));

    // Also try v1 with different param to see what works
    const v1Url = `https://app.circle.so/api/v1/community_members?email_cont=${encodeURIComponent(email)}&community_id=${COMMUNITY_ID}`;
    const v1Res = await fetch(v1Url, {
      headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' }
    });
    console.log('v1 email_cont status:', v1Res.status);
    const v1Text = await v1Res.text();
    console.log('v1 email_cont response:', v1Text.substring(0, 300));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ verified: false, message: 'DEBUG — check logs' })
    };

  } catch(err) {
    console.error('circle-auth error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Verification failed. Please try again.' }) };
  }
};
