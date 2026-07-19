// netlify/functions/_lib/embed.js
//
// Fire-and-forget trigger for real-time Ask-the-Archive indexing of a native
// post. Posting must NEVER depend on (or wait for) the archive index, so this
// dispatches the background embed function and swallows all errors. The
// background function does the OpenAI call; this just kicks it off (202).

async function triggerEmbed(postId) {
  try {
    if (!postId) return;
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://thinkbeyondpractice.com';
    await fetch(base + '/.netlify/functions/embed-post-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: postId, secret: process.env.BACKFILL_SECRET })
    });
  } catch (e) { /* best-effort; the post already stands */ }
}

module.exports = { triggerEmbed };
