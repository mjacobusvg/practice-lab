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

    // Step 2: Get paywall subscriptions via the correct endpoint
    // Try multiple endpoints since v1 API structure varies
    let hasAccess = false;

    // Try 1: paywall_subscriptions on member
    const pwRes1 = await fetch(
      `https://app.circle.so/api/v1/paywall_subscriptions?community_member_id=${memberId}`,
      { headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log('Paywall endpoint 1 status:', pwRes1.status);

    if (pwRes1.ok) {
      const pwData = await pwRes1.json();
      console.log('Paywall data 1:', JSON.stringify(pwData).substring(0, 500));
      const subs = Array.isArray(pwData) ? pwData : (pwData.paywall_subscriptions || pwData.records || pwData.data || []);
      hasAccess = subs.some(sub => {
        const name = sub.paywall_name || sub.name || (sub.paywall && sub.paywall.name) || '';
        const active = sub.status === 'active' || sub.active === true;
        console.log('Sub:', name, active);
        return active && ACCESS_PAYWALLS.includes(name);
      });
    } else {
      const t1 = await pwRes1.text();
      console.log('Endpoint 1 failed:', t1.substring(0, 100));

      // Try 2: member_paywalls
      const pwRes2 = await fetch(
        `https://app.circle.so/api/v1/community_members/${memberId}?include_paywalls=true`,
        { headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      console.log('Paywall endpoint 2 status:', pwRes2.status);

      if (pwRes2.ok) {
        const pwData2 = await pwRes2.json();
        console.log('Member with paywalls:', JSON.stringify(pwData2).substring(0, 800));
        const subs = pwData2.paywall_subscriptions || pwData2.paywalls || pwData2.member_paywalls || [];
        hasAccess = subs.some(sub => {
          const name = sub.paywall_name || sub.name || (sub.paywall && sub.paywall.name) || '';
          const active = sub.status === 'active' || sub.active === true;
          console.log('Sub2:', name, active);
          return active && ACCESS_PAYWALLS.includes(name);
        });
      } else {
        const t2 = await pwRes2.text();
        console.log('Endpoint 2 failed:', t2.substring(0, 100));
      }
    }

    console.log('Final hasAccess:', hasAccess);

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
