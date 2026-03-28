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
    // Step 1: Look up member by email — must include community_id
    const memberUrl = `https://app.circle.so/api/v1/community_members?email=${encodeURIComponent(email)}&community_id=${COMMUNITY_ID}`;
    console.log('Member URL:', memberUrl);
    
    const memberRes = await fetch(memberUrl, {
      headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' }
    });

    if (!memberRes.ok) {
      const t = await memberRes.text();
      console.log('Member lookup failed:', memberRes.status, t.substring(0, 100));
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Unable to verify membership. Please try again.' }) };
    }

    const memberData = await memberRes.json();
    console.log('Raw member response type:', Array.isArray(memberData) ? 'array len=' + memberData.length : 'object');
    console.log('Member response:', JSON.stringify(memberData).substring(0, 300));

    const member = Array.isArray(memberData) ? memberData[0] : memberData;

    if (!member || !member.id) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, redirect: true, message: 'No Think Beyond Practice account found for this email.' }) };
    }

    // Verify the returned member actually matches the email we searched for
    const returnedEmail = (member.email || '').toLowerCase();
    console.log('Searched email:', email, 'Returned email:', returnedEmail, 'Member ID:', member.id);

    if (returnedEmail && returnedEmail !== email) {
      console.log('Email mismatch — member not found');
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, redirect: true, message: 'No Think Beyond Practice account found for this email.' }) };
    }

    if (member.active === false) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, redirect: true, message: 'Your Think Beyond Practice membership is not active.' }) };
    }

    const memberId = member.id;

    // Step 2: Check if this member is in the gated space
    const spaceUrl = `https://app.circle.so/api/v1/space_members?space_id=${GATED_SPACE_ID}&community_member_id=${memberId}&community_id=${COMMUNITY_ID}`;
    console.log('Space URL:', spaceUrl);

    const spaceRes = await fetch(spaceUrl, {
      headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' }
    });

    console.log('Space check status:', spaceRes.status);
    const spaceData = await spaceRes.json();
    console.log('Space data:', JSON.stringify(spaceData).substring(0, 400));

    const records = spaceData.records || [];
    const hasAccess = records.length > 0 && records.some(r => 
      Number(r.community_member_id) === Number(memberId) && r.status === 'active'
    );

    console.log('hasAccess:', hasAccess, 'memberId:', memberId, 'records:', records.length);

    if (!hasAccess) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          verified: false,
          message: 'Practice Lab access requires the $89 or $119 Think Beyond Practice plan. Your current plan does not include Practice Lab access.',
          upgradeUrl: REDIRECT_URL
        })
      };
    }

    const token = Buffer.from(email + ':' + Date.now()).toString('base64');
    return { statusCode: 200, headers, body: JSON.stringify({ verified: true, token, message: 'Access verified' }) };

  } catch(err) {
    console.error('circle-auth error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Verification failed. Please try again.' }) };
  }
};
