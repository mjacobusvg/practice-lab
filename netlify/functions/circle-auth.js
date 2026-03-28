const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const REDIRECT_URL = 'https://community.thinkbeyondpractice.com';

const ACCESS_PAYWALLS = [
  'TBP_$89_Full_Access',
  'TBP_$89_Trial_NewMembers'
];

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
    // Step 1: Look up member
    const memberRes = await fetch(
      `https://app.circle.so/api/v1/community_members?email=${encodeURIComponent(email)}`,
      { headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    if (!memberRes.ok) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Unable to verify membership. Please try again.' }) };
    }

    const memberData = await memberRes.json();
    const member = Array.isArray(memberData) ? memberData[0] : memberData;

    if (!member || !member.id) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, redirect: true, message: 'No Think Beyond Practice account found for this email.' }) };
    }

    if (member.active === false) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, redirect: true, message: 'Your Think Beyond Practice membership is not active.' }) };
    }

    const memberId = member.id;

    // Log the FULL member object to see all fields
    const fullMemberText = JSON.stringify(memberData);
    console.log('FULL member length:', fullMemberText.length);
    console.log('FULL member part 1:', fullMemberText.substring(0, 1000));
    console.log('FULL member part 2:', fullMemberText.substring(1000, 2000));
    console.log('FULL member part 3:', fullMemberText.substring(2000, 3000));

    // Try Circle's paywall_subscriptions endpoint with member_id param
    const endpoints = [
      `https://app.circle.so/api/v1/paywall_subscriptions?member_id=${memberId}`,
      `https://app.circle.so/api/v1/members/${memberId}/paywall_subscriptions`,
      `https://app.circle.so/api/v1/community_members/${memberId}/paywalls`,
    ];

    for (const url of endpoints) {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' }
      });
      console.log(`${url} → ${res.status}`);
      if (res.ok) {
        const data = await res.json();
        console.log('Success data:', JSON.stringify(data).substring(0, 500));
      }
    }

    // For now return the member data so we can see what's available
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        verified: false,
        message: 'DEBUG MODE: Check function logs for paywall endpoint data.',
        debug: true
      })
    };

  } catch(err) {
    console.error('circle-auth error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Verification failed. Please try again.' }) };
  }
};
