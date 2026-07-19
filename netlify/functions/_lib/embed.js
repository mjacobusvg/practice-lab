// netlify/functions/_lib/embed.js
//
// Fire-and-forget triggers for real-time Ask-the-Archive indexing of native
// content. Posting/commenting must NEVER depend on (or wait for) the archive
// index, so these dispatch the background embed function and swallow all errors.

function fire(payload) {
  try {
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://thinkbeyondpractice.com';
    return fetch(base + '/.netlify/functions/embed-post-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ secret: process.env.BACKFILL_SECRET }, payload))
    }).catch(function () {});
  } catch (e) { /* best-effort */ }
}

async function triggerEmbed(postId) { if (postId) await fire({ post_id: postId }); }
async function triggerEmbedComment(commentId) { if (commentId) await fire({ comment_id: commentId }); }

module.exports = { triggerEmbed, triggerEmbedComment };
