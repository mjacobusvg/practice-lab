const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const REDIRECT_URL = 'https://community.thinkbeyondpractice.com';

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

    // Step 2: Get all spaces to find the Billing & Coding Simulator space ID
    const spacesRes = await fetch(
      `https://app.circle.so/api/v1/spaces`,
      { headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    console.log('Spaces status:', spacesRes.status);
    const spacesData = await spacesRes.json();
    console.log('Spaces sample:', JSON.stringify(spacesData).substring(0, 800));

    const spaces = Array.isArray(spacesData) ? spacesData : (spacesData.spaces || spacesData.records || spacesData.data || []);
    console.log('Total spaces:', spaces.length);

    // Find the gated space
    const gatedSpace = spaces.find(s => {
      const slug = s.slug || s.space_slug || '';
      const name = s.name || s.space_name || '';
      return slug === 'billing-coding-simulator' || name === 'Billing & Coding Simulator';
    });

    console.log('Gated space found:', JSON.stringify(gatedSpace));

    if (!gatedSpace) {
      console.error('Could not find Billing & Coding Simulator space');
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Unable to verify access. Please try again.' }) };
    }

    const spaceId = gatedSpace.id || gatedSpace.space_id;
    console.log('Space ID:', spaceId);

    // Step 3: Check if this member is in the gated space
    const spaceMemberRes = await fetch(
      `https://app.circle.so/api/v1/space_members?space_id=${spaceId}&community_member_id=${memberId}`,
      { headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    console.log('Space member check status:', spaceMemberRes.status);
    const spaceMemberData = await spaceMemberRes.json();
    console.log('Space member data:', JSON.stringify(spaceMemberData).substring(0, 400));

    const members = Array.isArray(spaceMemberData) ? spaceMemberData : (spaceMemberData.space_members || spaceMemberData.records || spaceMemberData.data || []);
    const hasAccess = members.length > 0;

    console.log('hasAccess:', hasAccess);

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
