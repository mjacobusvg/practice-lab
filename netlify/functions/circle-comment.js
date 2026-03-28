/**
 * Netlify Function: circle-comment
 * Posts a comment to a Circle post using the member's own JWT.
 * Comment appears under the member's name and profile picture.
 */

const CIRCLE_DOMAIN = 'think-beyond-practice.circle.so';

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };

  let postId, body, memberJwt;
  try {
    const data = JSON.parse(event.body || '{}');
    postId = data.postId;
    body = (data.body || '').trim();
    memberJwt = data.memberJwt;
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'Invalid request' }) };
  }

  if (!postId || !body || !memberJwt) {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'Missing required fields' }) };
  }

  try {
    // Post comment using member's JWT — appears under their name
    const res = await fetch(`https://${CIRCLE_DOMAIN}/api/headless/v1/posts/${postId}/comments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${memberJwt}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ body })
    });

    console.log('Comment post status:', res.status);
    const resText = await res.text();
    console.log('Comment response:', resText.substring(0, 300));

    if (!res.ok) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Failed to post comment. Please try again.' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Comment posted' }) };

  } catch(err) {
    console.error('circle-comment error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Connection error. Please try again.' }) };
  }
};
