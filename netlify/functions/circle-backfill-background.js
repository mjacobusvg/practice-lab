// netlify/functions/circle-backfill-background.js
// Background function - runs up to 15 minutes
// Trigger via POST to /.netlify/functions/circle-backfill-background with { "secret": "your-backfill-secret" }
// Returns 202 immediately, runs in background, check logs for progress

const EXCLUDED_SPACE_SLUGS = [
  'billing-coding-simulat',
  'billing-coding-simulator',
  'therapeutic-technique',
  'private-practice-simulat',
  'private-practice-simulator',
  'toolkit-download',
  'toolkit-download-setup',
];

exports.handler = async function(event, context) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (body.secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const circleToken = process.env.CIRCLE_API_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!circleToken || !supabaseUrl || !supabaseKey || !openaiKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  // Background functions: do work directly, Netlify gives us up to 15 minutes
  const stats = { spaces: 0, posts: 0, comments: 0, embedded: 0, errors: [] };

  try {
    console.log('BACKFILL START');

    const spaces = await getAllSpaces(circleToken);
    console.log('Total spaces found: ' + spaces.length);

    const targetSpaces = spaces.filter(function(s) {
      var slug = (s.slug || '').toLowerCase();
      return !EXCLUDED_SPACE_SLUGS.some(function(ex) { return slug.includes(ex); });
    });

    console.log('Target spaces: ' + targetSpaces.length);
    stats.spaces = targetSpaces.length;

    for (var si = 0; si < targetSpaces.length; si++) {
      var space = targetSpaces[si];
      console.log('SPACE [' + (si+1) + '/' + targetSpaces.length + ']: ' + space.name);

      try {
        var posts = await getAllPostsInSpace(circleToken, space.id);
        console.log('  Posts: ' + posts.length);

        for (var pi = 0; pi < posts.length; pi++) {
          var post = posts[pi];
          try {
            var fullPost = await getPost(circleToken, post.id);
            if (!fullPost) continue;

            var postBody = extractBody(fullPost);
            if (!postBody || postBody.length < 20) continue;

            var postText = [fullPost.name || '', postBody].filter(Boolean).join('\n\n').trim();
            var embedding = await getEmbedding(postText, openaiKey);

            await upsertToSupabase(supabaseUrl, supabaseKey, {
              id: 'post_' + post.id,
              circle_post_id: post.id,
              title: fullPost.name || '',
              body: postBody.substring(0, 10000),
              author: fullPost.user_name || 'Member',
              space_name: space.name,
              space_slug: space.slug,
              url: fullPost.url || '',
              created_at: post.created_at,
              updated_at: post.updated_at,
              embedding: embedding,
              chunk_index: 0
            });

            stats.posts++;
            stats.embedded++;
            console.log('  POST OK: ' + (fullPost.name || post.id));

            var comments = await getPostComments(circleToken, post.id);
            for (var ci = 0; ci < comments.length; ci++) {
              var comment = comments[ci];
              try {
                var commentBody = extractCommentBody(comment);
                if (!commentBody || commentBody.length < 20) continue;

                var commentText = '[Comment on: ' + (fullPost.name || 'post') + ']\n\n' + commentBody;
                var commentEmbedding = await getEmbedding(commentText, openaiKey);

                await upsertToSupabase(supabaseUrl, supabaseKey, {
                  id: 'comment_' + comment.id,
                  circle_post_id: post.id,
                  title: 'Comment on: ' + (fullPost.name || ''),
                  body: commentBody.substring(0, 10000),
                  author: comment.user_name || 'Member',
                  space_name: space.name,
                  space_slug: space.slug,
                  url: fullPost.url || '',
                  created_at: comment.created_at,
                  updated_at: comment.updated_at,
                  embedding: commentEmbedding,
                  chunk_index: 0
                });

                stats.comments++;
                stats.embedded++;
              } catch(ce) {
                console.log('  COMMENT ERROR ' + comment.id + ': ' + ce.message);
                stats.errors.push('comment_' + comment.id + ': ' + ce.message);
              }
            }

            await sleep(300);

          } catch(pe) {
            console.log('  POST ERROR ' + post.id + ': ' + pe.message);
            stats.errors.push('post_' + post.id + ': ' + pe.message);
          }
        }
      } catch(se) {
        console.log('SPACE ERROR ' + space.name + ': ' + se.message);
        stats.errors.push('space_' + space.id + ': ' + se.message);
      }
    }

    console.log('BACKFILL COMPLETE: posts=' + stats.posts + ' comments=' + stats.comments + ' embedded=' + stats.embedded + ' errors=' + stats.errors.length);

  } catch(e) {
    console.log('BACKFILL FATAL: ' + e.message);
  }

  return {
    statusCode: 202,
    headers: CORS,
    body: JSON.stringify({ message: 'Backfill started. Check function logs for progress.' })
  };
};

// ── Circle API helpers ──────────────────────────────────────────────────────

async function getAllSpaces(token) {
  var spaces = [];
  var page = 1;
  while (true) {
    var resp = await fetch('https://app.circle.so/api/v1/spaces?page=' + page + '&per_page=50', {
      headers: { 'Authorization': 'Token ' + token, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) { console.log('Spaces fetch failed: ' + resp.status); break; }
    var data = await resp.json();
    var batch = Array.isArray(data) ? data : (data.spaces || data.records || []);
    if (!batch.length) break;
    spaces = spaces.concat(batch);
    if (batch.length < 50) break;
    page++;
  }
  return spaces;
}

async function getAllPostsInSpace(token, spaceId) {
  var posts = [];
  var page = 1;
  while (true) {
    var resp = await fetch('https://app.circle.so/api/v1/posts?space_id=' + spaceId + '&page=' + page + '&per_page=50', {
      headers: { 'Authorization': 'Token ' + token, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) break;
    var data = await resp.json();
    var batch = Array.isArray(data) ? data : (data.posts || data.records || []);
    if (!batch.length) break;
    posts = posts.concat(batch);
    if (batch.length < 50) break;
    page++;
  }
  return posts;
}

async function getPost(token, postId) {
  var resp = await fetch('https://app.circle.so/api/v1/posts/' + postId, {
    headers: { 'Authorization': 'Token ' + token, 'Content-Type': 'application/json' }
  });
  if (!resp.ok) return null;
  return await resp.json();
}

async function getPostComments(token, postId) {
  var comments = [];
  var page = 1;
  while (true) {
    var resp = await fetch('https://app.circle.so/api/v1/comments?post_id=' + postId + '&page=' + page + '&per_page=50', {
      headers: { 'Authorization': 'Token ' + token, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) break;
    var data = await resp.json();
    var batch = Array.isArray(data) ? data : (data.comments || data.records || []);
    if (!batch.length) break;
    comments = comments.concat(batch);
    if (batch.length < 50) break;
    page++;
  }
  return comments;
}

function extractBody(post) {
  if (post.body && typeof post.body === 'object' && post.body.body) {
    return stripHtml(post.body.body);
  }
  if (typeof post.body === 'string') return stripHtml(post.body);
  if (post.body_plain_text) return post.body_plain_text;
  if (post.body_plain) return post.body_plain;
  return '';
}

function extractCommentBody(comment) {
  if (comment.body && typeof comment.body === 'object' && comment.body.body) {
    return stripHtml(comment.body.body);
  }
  if (typeof comment.body === 'string') return stripHtml(comment.body);
  if (comment.body_plain_text) return comment.body_plain_text;
  return '';
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function getEmbedding(text, apiKey) {
  var truncated = text.substring(0, 8000);
  var resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: truncated,
      dimensions: 1536
    })
  });
  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('OpenAI embedding failed: ' + err.substring(0, 200));
  }
  var data = await resp.json();
  return data.data[0].embedding;
}

async function upsertToSupabase(url, key, record) {
  var resp = await fetch(url + '/rest/v1/posts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(record)
  });
  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('Supabase upsert failed: ' + err.substring(0, 200));
  }
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}
