// netlify/functions/circle-update-roadmap.js
// Updates the "What's Coming Up" section of the Circle roadmap post (post ID 23961715)

const POST_ID = 23961715;
const COMMUNITY_ID = 'thinkbeyondpractice'; // used in API calls

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { newBlock } = body;
  if (!newBlock) {
    return { statusCode: 400, body: JSON.stringify({ error: 'newBlock is required' }) };
  }

  const token = process.env.CIRCLE_API_TOKEN;
  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ error: 'CIRCLE_API_TOKEN not set' }) };
  }

  try {
    // Step 1: Fetch the current post body
    const getResp = await fetch(`https://app.circle.so/api/v1/posts/${POST_ID}`, {
      method: 'GET',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!getResp.ok) {
      const errText = await getResp.text();
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch post', detail: errText }) };
    }

    const postData = await getResp.json();
    const currentBody = postData.body || postData.body_plain || '';

    // Step 2: Replace the "Here's what's coming up" block
    // The block starts at "🔥 Here's what's coming up:" and ends before "🎓" or the next emoji section
    const updatedBody = replaceComingUpBlock(currentBody, newBlock);

    // Step 3: Update the post
    const updateResp = await fetch(`https://app.circle.so/api/v1/posts/${POST_ID}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ body: updatedBody })
    });

    if (!updateResp.ok) {
      const errText = await updateResp.text();
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update post', detail: errText }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Roadmap post updated successfully' })
    };

  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

function replaceComingUpBlock(body, newBlock) {
  // Find the section starting with the fire emoji header
  // and replace through the next major emoji section header
  const startMarkers = ['🔥 Here\'s what\'s coming up:', '🔥 Here\'s what\'s coming up:'];
  const endMarkers = ['🎓', '🗂️', '📂', '💼', '⚙️', '🤔', '🧠', '🛠', '💬 Your Turn'];

  let startIdx = -1;
  for (const marker of startMarkers) {
    startIdx = body.indexOf(marker);
    if (startIdx !== -1) break;
  }

  if (startIdx === -1) {
    // Can't find the section, append the new block after "Think Beyond Practice includes..."
    return body + '\n\n' + newBlock;
  }

  let endIdx = body.length;
  for (const marker of endMarkers) {
    const idx = body.indexOf(marker, startIdx + 10);
    if (idx !== -1 && idx < endIdx) {
      endIdx = idx;
    }
  }

  return body.substring(0, startIdx) + newBlock + '\n\n' + body.substring(endIdx);
}
