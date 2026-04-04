// netlify/functions/circle-update-roadmap.js
// Updates the "What's Coming Up" section of the Circle roadmap post (post ID 23961715)

const POST_ID = 23961715;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let reqBody;
  try {
    reqBody = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { newBlock } = reqBody;
  if (!newBlock) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'newBlock is required' }) };
  }

  const token = process.env.CIRCLE_API_TOKEN;
  if (!token) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'CIRCLE_API_TOKEN not set' }) };
  }

  try {
    // Step 1: Fetch the current post
    const getResp = await fetch(`https://app.circle.so/api/v1/posts/${POST_ID}`, {
      method: 'GET',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!getResp.ok) {
      const errText = await getResp.text();
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to fetch post', detail: errText }) };
    }

    const postData = await getResp.json();

    // Log what fields Circle returns so we can diagnose
    const bodyKeys = Object.keys(postData);
    console.log('Post data keys:', JSON.stringify(bodyKeys));
    console.log('body type:', typeof postData.body);
    console.log('body_plain type:', typeof postData.body_plain);

    // Extract plain text body - try multiple fields
    let currentBody = '';
    if (typeof postData.body === 'string') {
      currentBody = postData.body;
    } else if (typeof postData.body_plain === 'string') {
      currentBody = postData.body_plain;
    } else if (postData.body && typeof postData.body === 'object') {
      console.log('body object sample:', JSON.stringify(postData.body).substring(0, 800));
      currentBody = extractTextFromTiptap(postData.body);
      console.log('tiptap result length:', currentBody.length);
    }

    console.log('currentBody length:', currentBody.length);
    console.log('currentBody preview:', currentBody.substring(0, 300));

    if (!currentBody) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'Could not extract post body',
          availableKeys: bodyKeys,
          bodyType: typeof postData.body,
          bodySample: JSON.stringify(postData.body).substring(0, 300)
        })
      };
    }

    // Step 2: Replace the coming up block
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

    const updateText = await updateResp.text();
    console.log('Update response status:', updateResp.status);
    console.log('Update response preview:', updateText.substring(0, 500));

    if (!updateResp.ok) {
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update post', detail: updateText }) };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: true, message: 'Roadmap post updated successfully' })
    };

  } catch(e) {
    console.log('Caught error:', e.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: e.message }) };
  }
};

function extractTextFromTiptap(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.content && Array.isArray(node.content)) {
    return node.content.map(extractTextFromTiptap).join('\n');
  }
  return '';
}

function replaceComingUpBlock(body, newBlock) {
  if (typeof body !== 'string') return newBlock;

  // Try multiple variations of the start marker
  const startMarkers = [
    '\uD83D\uDD25 Here\u2019s what\u2019s coming up:',
    '\uD83D\uDD25 Here\'s what\'s coming up:',
    'Here\u2019s what\u2019s coming up:',
    'Here\'s what\'s coming up:'
  ];

  const endMarkers = [
    '\uD83C\uDF93',  // 🎓
    '\uD83D\uDDC2',  // 🗂
    '\uD83D\uDCC2',  // 📂
    '\uD83D\uDCBC',  // 💼
    '\u2696',        // ⚖
    '\u2699',        // ⚙
    '\uD83E\uDD14',  // 🤔
    '\uD83E\uDDE0',  // 🧠
    '\uD83D\uDEE0',  // 🛠
    '\uD83D\uDCAC Your Turn'
  ];

  let startIdx = -1;
  for (const marker of startMarkers) {
    startIdx = body.indexOf(marker);
    if (startIdx !== -1) {
      console.log('Found start marker at index:', startIdx);
      break;
    }
  }

  if (startIdx === -1) {
    console.log('No start marker found, appending');
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
