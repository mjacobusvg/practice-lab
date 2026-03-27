/**
 * Netlify Function: circle-auth
 * Access paywalls (Practice Lab):
 *   TBP_$89_Full_Access
 *   TBP_$89_Trial_NewMembers
 */

const CIRCLE_DOMAIN = 'think-beyond-practice.circle.so';
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

    console.log('Member API status:', memberRes.status);

    if (!memberRes.ok) {
      const t = await memberRes.text();
      console.error('Member API error:', memberRes.status, t.substring(0, 200));
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Unable to verify membership. Please try again.' }) };
    }

    const memberData = await memberRes.json();
    const member = Array.isArray(memberData) ? memberData[0] : memberData;
    console.log('Member object:', JSON.stringify(member).substring(0, 800));

    if (!member) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, redirect: true, message: 'No Think Beyond Practice account found for this email.' }) };
    }

    if (member.active === false) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, redirect: true, message: 'Your Think Beyond Practice membership is not active.' }) };
    }

    const memberId = member.id || member.community_member_id;
    console.log('Member ID:', memberId);

    // Step 2: Get paywall subscriptions
    const paywallRes = await fetch(
      `https://app.circle.so/api/v1/community_members/${memberId}/paywall_subscriptions`,
      { headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    console.log('Paywall API status:', paywallRes.status);
    const paywallText = await paywallRes.text();
    console.log('Paywall response:', paywallText.substring(0, 800));

    let hasAccess = false;

    if (paywallRes.ok) {
      let paywallData;
      try { paywallData = JSON.parse(paywallText); } catch(e) { paywallData = []; }
      const subs = Array.isArray(paywallData) ? paywallData : (paywallData.paywall_subscriptions || paywallData.data || []);
      hasAccess = subs.some(sub => {
        const name = sub.paywall_name || sub.name || sub.paywall || '';
        const active = sub.status === 'active' || sub.active === true || sub.status === 'Active';
        console.log('Sub:', name, active);
        return active && ACCESS_PAYWALLS.includes(name);
      });
    } else {
      // Fallback: check member object string for paywall names
      const memberStr = JSON.stringify(member);
      hasAccess = ACCESS_PAYWALLS.some(p => memberStr.includes(p));
      console.log('Fallback check:', hasAccess, memberStr.substring(0, 500));
    }

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
