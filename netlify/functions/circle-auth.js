// netlify/functions/circle-auth.js
//
// LAYER 1 — identity + entitlement. Confirms the email is a real Circle
// community member, determines TIER (full vs forum) from space membership, and
// mints a SIGNED session token via _lib/session.js (Layer 2). The old base64
// token (email:timestamp, no signature) is gone — it was forgeable.
//
// TIER (confirmed via Circle API, June 27 2026):
//   FULL_SPACE_ID 2546298  -> tier 'full' ($119: Practice Lab + clinical Practice Manager)
//   community member, not in full space -> tier 'forum' ($50: forum + archive)
// scope is always 'member' for a community member; tier is the gate for full-only tools.
//
// Env: CIRCLE_HEADLESS_TOKEN, CIRCLE_API_TOKEN, SESSION_SIGNING_SECRET

const { mintToken } = require('./_lib/session');

const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_HEADLESS_TOKEN = process.env.CIRCLE_HEADLESS_TOKEN;
const CIRCLE_DOMAIN = 'think-beyond-practice.circle.so';
const FULL_SPACE_ID = 2546298; // full-tier ($119) space

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ message: 'Method not allowed' }) };

  let email, requireFull;
  try {
    const body = JSON.parse(event.body || '{}');
    email = (body.email || '').trim().toLowerCase();
    // Optional: a caller can require full-tier access (Practice Lab path). If true
    // and the member is forum-only, verification fails with an upgrade message.
    // (Back-compat: a legacy spaceId === FULL_SPACE_ID is treated as requireFull.)
    requireFull = body.requireFull === true || Number(body.spaceId) === FULL_SPACE_ID;
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Invalid request' }) };
  }

  if (!email || !email.includes('@')) return { statusCode: 400, headers, body: JSON.stringify({ message: 'Valid email required' }) };
  if (!CIRCLE_HEADLESS_TOKEN || !CIRCLE_API_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ message: 'Server configuration error' }) };

  try {
    // Step 1: Headless auth confirms the email is a real community member.
    const authRes = await fetch(`https://${CIRCLE_DOMAIN}/api/v1/headless/auth_token`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CIRCLE_HEADLESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    if (authRes.status === 404 || authRes.status === 422) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'No Think Beyond Practice account found for this email.' }) };
    }
    if (!authRes.ok) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Unable to verify membership. Please try again.' }) };
    }

    const authData = await authRes.json();
    const memberToken = authData.access_token;
    const communityMemberId = authData.community_member_id;
    if (!memberToken || !communityMemberId) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Unable to verify membership. Please try again.' }) };
    }

    // Step 2: Determine TIER by checking full-space membership (always, so the
    // token always carries the correct tier).
    let tier = 'forum';
    try {
      const spaceUrl = `https://app.circle.so/api/v1/space_members?space_id=${FULL_SPACE_ID}&community_member_id=${communityMemberId}`;
      const spaceRes = await fetch(spaceUrl, {
        headers: { 'Authorization': `Bearer ${CIRCLE_API_TOKEN}`, 'Content-Type': 'application/json' }
      });
      if (spaceRes.ok) {
        const spaceData = await spaceRes.json();
        const records = spaceData.records || [];
        const isFull = records.some(r =>
          Number(r.community_member_id) === Number(communityMemberId) && r.status === 'active');
        if (isFull) tier = 'full';
      }
    } catch (e) {
      console.error('circle-auth tier check failed (defaulting to forum):', e.message);
      // Fail closed on tier: if we can't confirm full, treat as forum (least privilege).
    }

    // Step 3: If the caller requires full tier and this member is forum-only, reject.
    if (requireFull && tier !== 'full') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          verified: false,
          tier: tier,
          message: 'This tool requires the $119/month Think Beyond Practice plan. Your current plan does not include access.'
        })
      };
    }

    // Step 4: Mint the SIGNED token. scope 'member'; tier distinguishes full vs forum.
    const token = mintToken({ email, scope: 'member', tier, communityMemberId });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        verified: true,
        token,
        tier,
        memberToken,          // Circle JWT, still used by circle-comment for attribution
        communityMemberId,
        message: 'Access verified'
      })
    };

  } catch(err) {
    console.error('circle-auth error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ verified: false, message: 'Verification failed. Please try again.' }) };
  }
};
