/**
 * Netlify Function: circle-auth
 * Verifies a Circle member's email and checks they have Practice Lab access.
 * 
 * Flow:
 * 1. Receive email from client
 * 2. Call Circle Auth API to get member's JWT token
 * 3. Call Circle Member API to get their profile and paywalls
 * 4. Check if they have the required paywall ("Think Beyond Practice: Full Forum Access")
 * 5. Return verified:true or appropriate error
 */

const CIRCLE_DOMAIN = 'think-beyond-practice.circle.so';
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const REQUIRED_PAYWALL = 'Think Beyond Practice: Full Forum Access';
const REDIRECT_URL = 'https://community.thinkbeyondpractice.com';

exports.handler = async function(event, context) {
  // CORS headers — allow requests from your tool domains
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ message: 'Method not allowed' }) };
  }

  let email;
  try {
    const body = JSON.parse(event.body || '{}');
    email = (body.email || '').trim().toLowerCase();
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Invalid request' }) };
  }

  if (!email || !email.includes('@')) {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Valid email required' }) };
  }

  if (!CIRCLE_API_TOKEN) {
    console.error('CIRCLE_API_TOKEN not set');
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'Server configuration error' }) };
  }

  try {
    // Step 1: Get member's JWT token from Circle Auth API
    const authRes = await fetch(`https://${CIRCLE_DOMAIN}/api/v1/headless/auth_token`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    });

    if (authRes.status === 404 || authRes.status === 422) {
      // Member not found in Circle
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          verified: false,
          redirect: true,
          message: 'No Think Beyond Practice account found for this email. Please join to access this tool.'
        })
      };
    }

    if (!authRes.ok) {
      const errText = await authRes.text();
      console.error('Circle auth error:', authRes.status, errText);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ verified: false, message: 'Unable to verify membership. Please try again.' })
      };
    }

    const authData = await authRes.json();
    const memberToken = authData.access_token;

    if (!memberToken) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ verified: false, message: 'Unable to verify membership. Please try again.' })
      };
    }

    // Step 2: Get member profile to check their paywalls/membership tier
    // Use the admin API to check member details including paywall access
    const memberRes = await fetch(`https://app.circle.so/api/v1/community_members?email=${encodeURIComponent(email)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!memberRes.ok) {
      console.error('Circle member lookup error:', memberRes.status);
      // Fallback: if we got a valid auth token, member exists — check via headless me endpoint
      const meRes = await fetch(`https://${CIRCLE_DOMAIN}/api/headless/v1/me`, {
        headers: {
          'Authorization': `Bearer ${memberToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (meRes.ok) {
        const meData = await meRes.json();
        // Member exists and is authenticated — check their tier
        // If we can't check tier, log and allow (fail open) or deny (fail closed)
        // Fail closed for security
        console.log('Member found via headless me, but cannot check tier:', JSON.stringify(meData).substring(0, 200));
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ verified: false, message: 'Unable to verify membership tier. Please try again.' })
      };
    }

    const members = await memberRes.json();
    
    // Handle both array and object responses
    const memberData = Array.isArray(members) ? members[0] : members;

    if (!memberData) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          verified: false,
          redirect: true,
          message: 'No Think Beyond Practice account found for this email.'
        })
      };
    }

    // Step 3: Check membership tier via paywalls
    // Check community_member's paywall/plan data
    // The $89 and $119 tiers have the "Think Beyond Practice: Full Forum Access" paywall
    const memberEmail = (memberData.email || '').toLowerCase();
    const isActive = memberData.active !== false; // default to active if field missing

    if (!isActive) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          verified: false,
          redirect: true,
          message: 'Your Think Beyond Practice membership is not active.'
        })
      };
    }

    // Check paywalls - look for the required paywall in member data
    // Circle stores this in member_tags, paywalls, or membership_level fields
    const memberStr = JSON.stringify(memberData).toLowerCase();
    const requiredPaywallLower = REQUIRED_PAYWALL.toLowerCase();
    
    // Check multiple possible field locations
    const paywalls = memberData.paywalls || memberData.member_paywalls || [];
    const memberTags = memberData.member_tags || memberData.tags || [];
    const membershipLevel = memberData.membership_level || memberData.plan_name || '';

    const hasPaywall = 
      // Check paywalls array
      (Array.isArray(paywalls) && paywalls.some(p => 
        (p.name || p.paywall_name || p.title || '').toLowerCase().includes('full forum access')
      )) ||
      // Check tags
      (Array.isArray(memberTags) && memberTags.some(t => 
        (t.name || t.label || t || '').toString().toLowerCase().includes('full forum access')
      )) ||
      // Check membership level string
      (typeof membershipLevel === 'string' && membershipLevel.toLowerCase().includes('full forum access')) ||
      // Broad string search on full member object as last resort
      memberStr.includes('full forum access');

    if (!hasPaywall) {
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

    // Verified — return success with a session token (just email hash for simplicity)
    const token = Buffer.from(email + ':' + Date.now()).toString('base64');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        verified: true,
        token: token,
        message: 'Access verified'
      })
    };

  } catch(err) {
    console.error('circle-auth error:', err);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ verified: false, message: 'Verification failed. Please try again.' })
    };
  }
};
