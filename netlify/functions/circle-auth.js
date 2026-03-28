const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_HEADLESS_TOKEN = process.env.CIRCLE_HEADLESS_TOKEN;
const CIRCLE_DOMAIN = 'think-beyond-practice.circle.so';
const REDIRECT_URL = 'https://community.thinkbeyondpractice.com';
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
  if (!CIRCLE_HEADLESS_TOKEN || !CIRCLE_API_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ message: 'Server configuration error' }) };

  try {
    // Step 1: Use Headless Auth API to get member JWT
    // This confirms the email belongs to a real member
    const authRes = await fetch(`https://${CIRCLE_DOMAIN}/api/v1/headless/auth_token`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CIRCLE_HEADLESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    });

    console.log('Headless auth status:', authRes.status);

    if (authRes.status === 404 || authRes.status === 422) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ verified: false, message: 'No Think Beyond Practice account found for this email.' })
      };
    }

    if (!authRes.ok) {
      const t = await authRes.text();
      console.log('Auth error:', t.substring(0, 200));
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Unable to verify membership. Please try again.' }) };
    }

    const authData = await authRes.json();
    console.log('Auth data keys:', Object.keys(authData));

    const memberToken = authData.access_token;
    const communityMemberId = authData.community_member_id;
    console.log('Member ID from auth:', communityMemberId);

    if (!memberToken || !communityMemberId) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Unable to verify membership. Please try again.' }) };
    }

    // Step 2: Check space membership using admin API with the real member ID
    const spaceUrl = `https://app.circle.so/api/v1/space_members?space_id=${GATED_SPACE_ID}&community_member_id=${communityMemberId}`;
    console.log('Space check URL:', spaceUrl);

    const spaceRes = await fetch(spaceUrl, {
      headers: {
        'Authorization': `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('Space check status:', spaceRes.status);
    const spaceData = await spaceRes.json();
    console.log('Space count:', spaceData.count, 'records:', (spaceData.records || []).length);

    const records = spaceData.records || [];
    const hasAccess = records.some(r =>
      Number(r.community_member_id) === Number(communityMemberId) &&
      r.status === 'active'
    );

    console.log('hasAccess:', hasAccess, 'communityMemberId:', communityMemberId);

    if (!hasAccess) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          verified: false,
          message: 'Practice Lab access requires the $89 or $119 Think Beyond Practice plan. Your current plan does not include Practice Lab access.'
        })
      };
    }

    const token = Buffer.from(email + ':' + Date.now()).toString('base64');
    return { statusCode: 200, headers, body: JSON.stringify({ 
      verified: true, 
      token, 
      memberToken,
      communityMemberId,
      message: 'Access verified' 
    }) };

  } catch(err) {
    console.error('circle-auth error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Verification failed. Please try again.' }) };
  }
};
