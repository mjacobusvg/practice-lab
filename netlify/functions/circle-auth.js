const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const REDIRECT_URL = 'https://community.thinkbeyondpractice.com';
const COMMUNITY_ID = 377699;
const GATED_SPACE_SLUG = 'billing-coding-simulator';

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

    // Step 2: Check if member has access to the gated space
    // Get spaces this member belongs to
    const spaceRes = await fetch(
      `https://app.circle.so/api/v1/space_members?community_member_id=${memberId}&per_page=100`,
      { headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    console.log('Space members status:', spaceRes.status);

    if (!spaceRes.ok) {
      const t = await spaceRes.text();
      console.log('Space members error:', t.substring(0, 200));
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Unable to verify access level. Please try again.' }) };
    }

    const spaceData = await spaceRes.json();
    console.log('Space data sample:', JSON.stringify(spaceData).substring(0, 600));

    // Look for the gated space in member's spaces
    const spaces = Array.isArray(spaceData) ? spaceData : (spaceData.space_members || spaceData.records || spaceData.data || []);
    
    const hasAccess = spaces.some(sm => {
      const slug = sm.space_slug || (sm.space && sm.space.slug) || sm.slug || '';
      const name = sm.space_name || (sm.space && sm.space.name) || sm.name || '';
      console.log('Space:', slug, name);
      return slug === GATED_SPACE_SLUG || name === 'Billing & Coding Simulator';
    });

    console.log('hasAccess:', hasAccess, 'total spaces:', spaces.length);

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
