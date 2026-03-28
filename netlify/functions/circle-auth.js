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
    // Step 1: Look up member using the search endpoint with email filter
    // Circle v1 API uses 'search' param not 'email' for filtering
    const memberUrl = `https://app.circle.so/api/v1/community_members?search=${encodeURIComponent(email)}&community_id=${COMMUNITY_ID}&per_page=1`;
    console.log('Member URL:', memberUrl);

    const memberRes = await fetch(memberUrl, {
      headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' }
    });

    const memberText = await memberRes.text();
    console.log('Member response:', memberText.substring(0, 400));

    if (!memberRes.ok) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Unable to verify membership. Please try again.' }) };
    }

    let memberData;
    try { memberData = JSON.parse(memberText); } catch(e) { memberData = []; }

    const members = Array.isArray(memberData) ? memberData : (memberData.records || memberData.community_members || []);
    
    // Find the member whose email matches exactly
    const member = members.find(m => (m.email || '').toLowerCase() === email);
    console.log('Matched member:', member ? `id=${member.id} email=${member.email}` : 'none found');
    console.log('All returned emails:', members.map(m => m.email).join(', '));

    if (!member) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, redirect: true, message: 'No Think Beyond Practice account found for this email.' }) };
    }

    if (member.active === false) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, redirect: true, message: 'Your Think Beyond Practice membership is not active.' }) };
    }

    const memberId = member.id;
    console.log('Member found:', memberId, email);

    // Step 2: Check if this member is in the gated space
    const spaceUrl = `https://app.circle.so/api/v1/space_members?space_id=${GATED_SPACE_ID}&community_member_id=${memberId}&community_id=${COMMUNITY_ID}`;
    const spaceRes = await fetch(spaceUrl, {
      headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' }
    });

    const spaceData = await spaceRes.json();
    const records = spaceData.records || [];
    console.log('Space records:', records.length, 'count:', spaceData.count);

    const hasAccess = records.some(r =>
      Number(r.community_member_id) === Number(memberId) && r.status === 'active'
    );

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
