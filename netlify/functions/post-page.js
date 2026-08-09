// netlify/functions/post-page.js
//
// Server-rendered, crawlable HTML for a single FREE forum post (SEO). The platform
// (platform.html) renders posts client-side via Supabase JS, which search engines
// index poorly. This function emits real HTML — <title>, meta description, Open
// Graph, canonical, JSON-LD Article, and the post body in the initial response —
// so free posts can rank. Humans who land here get a clean readable version plus
// a CTA into the platform (which now lets anonymous visitors read + create a free
// account, see the shared-post reader).
//
// SAFETY: only free_visible=true posts render their body. Member-only posts, and
// the members-only "second half" (post_members_extra), are NEVER fetched or
// emitted here — a member-only post returns a noindex teaser with a join CTA.
//
// Route: /post/:id  ->  /.netlify/functions/post-page?id=:id  (netlify.toml)
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const SITE = 'https://thinkbeyondpractice.com';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(opts) {
  // opts: { title, description, canonical, ogImage, noindex, bodyHtml, jsonld }
  var head = [
    '<!doctype html><html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + esc(opts.title) + '</title>',
    '<meta name="description" content="' + esc(opts.description) + '">',
    opts.noindex ? '<meta name="robots" content="noindex, follow">' : '<meta name="robots" content="index, follow">',
    '<link rel="canonical" href="' + esc(opts.canonical) + '">',
    '<meta property="og:type" content="article">',
    '<meta property="og:title" content="' + esc(opts.title) + '">',
    '<meta property="og:description" content="' + esc(opts.description) + '">',
    '<meta property="og:url" content="' + esc(opts.canonical) + '">',
    '<meta property="og:site_name" content="Think Beyond Practice">',
    opts.ogImage ? '<meta property="og:image" content="' + esc(opts.ogImage) + '">' : '',
    '<meta name="twitter:card" content="' + (opts.ogImage ? 'summary_large_image' : 'summary') + '">',
    opts.jsonld ? '<script type="application/ld+json">' + opts.jsonld + '</script>' : '',
    '<style>',
    'body{margin:0;background:#0b1120;color:#e8e2d6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"DM Sans",sans-serif;line-height:1.6}',
    '.wrap{max-width:720px;margin:0 auto;padding:28px 20px 80px}',
    'a{color:#33c8d6}',
    '.brand{font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#2aabb8;text-decoration:none}',
    'h1{font-family:Georgia,"Times New Roman",serif;font-size:1.7rem;line-height:1.25;color:#f5f4f2;margin:18px 0 8px}',
    '.meta{font-size:.85rem;color:#b0aa9e;margin-bottom:22px}',
    '.prose{font-size:1.02rem}',
    '.prose p{margin:0 0 16px}.prose h2,.prose h3{color:#f5f4f2;margin:26px 0 10px}',
    '.prose img{max-width:100%;height:auto;border-radius:8px}',
    '.prose ul,.prose ol{padding-left:22px;margin:0 0 16px}',
    '.cta{margin:30px 0;padding:20px 22px;background:#111c30;border:1px solid rgba(42,171,184,.28);border-top:2px solid #2aabb8;border-radius:10px}',
    '.cta a.btn{display:inline-block;margin-top:10px;background:#2aabb8;color:#0b1120;font-weight:700;padding:11px 20px;border-radius:6px;text-decoration:none}',
    '.foot{margin-top:40px;font-size:.8rem;color:#b0aa9e;border-top:1px solid rgba(255,255,255,.08);padding-top:16px}',
    '</style>',
    '</head><body><div class="wrap">'
  ].join('');
  var foot = '</div></body></html>';
  return head + opts.bodyHtml + foot;
}

exports.handler = async function (event) {
  const baseHeaders = { 'Content-Type': 'text/html; charset=utf-8' };
  const id = (event.queryStringParameters && event.queryStringParameters.id) ||
    ((event.path || '').match(/\/post\/([0-9a-fA-F-]{36})/) || [])[1] || '';

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;

  const notFound = function () {
    return {
      statusCode: 404,
      headers: Object.assign({}, baseHeaders, { 'Cache-Control': 'public, max-age=300' }),
      body: page({
        title: 'Post not found | Think Beyond Practice',
        description: 'This post could not be found.',
        canonical: SITE + '/platform',
        noindex: true,
        bodyHtml: '<a class="brand" href="/">Think Beyond Practice</a><h1>Post not found</h1>' +
          '<p>This post may have been moved or removed. <a href="/platform">Go to the platform</a>.</p>'
      })
    };
  };

  if (!id || !SUPABASE_URL || !KEY) return notFound();

  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/forum_posts?id=eq.' + encodeURIComponent(id) +
      '&select=id,title,excerpt,body_html,body_plain,free_visible,created_at,updated_at,edited_at,comment_count,image_urls,accounts(name,credentials),spaces(name,slug)&limit=1',
      { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } }
    );
    if (!res.ok) return notFound();
    const rows = await res.json();
    const post = rows && rows[0];
    if (!post) return notFound();

    const canonical = SITE + '/post/' + post.id;
    const title = (post.title || 'Discussion') + ' | Think Beyond Practice';
    const rawDesc = (post.excerpt || (post.body_plain || '').replace(/\s+/g, ' ')).trim();
    const description = rawDesc.slice(0, 155);
    const author = (post.accounts && post.accounts.name) || 'Think Beyond Practice';
    const space = post.spaces && post.spaces.name;

    // Member-only post: never emit the body. Noindex teaser + join CTA only.
    if (!post.free_visible) {
      return {
        statusCode: 200,
        headers: Object.assign({}, baseHeaders, { 'Cache-Control': 'public, max-age=600' }),
        body: page({
          title: title, description: description, canonical: canonical, noindex: true,
          bodyHtml:
            '<a class="brand" href="/">Think Beyond Practice</a>' +
            '<h1>' + esc(post.title || 'Members’ discussion') + '</h1>' +
            '<div class="meta">A members’ thread' + (space ? ' in ' + esc(space) : '') + '</div>' +
            '<p>' + esc(description) + '</p>' +
            '<div class="cta"><strong>This is a members’ thread.</strong><br>' +
            'Join Think Beyond Practice to read the full discussion and join in.' +
            '<br><a class="btn" href="/platform?post=' + esc(post.id) + '">Open in the platform</a></div>'
        })
      };
    }

    // Free post: full crawlable article.
    const ogImage = (Array.isArray(post.image_urls) && post.image_urls[0]) ? post.image_urls[0] : (SITE + '/og-share.png');
    const published = post.created_at || '';
    const modified = post.edited_at || post.updated_at || post.created_at || '';
    const jsonld = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: post.title || 'Discussion',
      description: description,
      datePublished: published,
      dateModified: modified,
      author: { '@type': 'Person', name: author },
      publisher: { '@type': 'Organization', name: 'Think Beyond Practice' },
      mainEntityOfPage: canonical
    });

    var dateStr = '';
    try { dateStr = new Date(published).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) {}

    const bodyHtml =
      '<a class="brand" href="/">Think Beyond Practice</a>' +
      '<h1>' + esc(post.title || 'Discussion') + '</h1>' +
      '<div class="meta">By ' + esc(author) +
        (post.accounts && post.accounts.credentials ? ', ' + esc(post.accounts.credentials) : '') +
        (dateStr ? ' · ' + esc(dateStr) : '') +
        (space ? ' · ' + esc(space) : '') + '</div>' +
      '<div class="prose">' + (post.body_html || ('<p>' + esc(post.body_plain || '') + '</p>')) + '</div>' +
      '<div class="cta"><strong>Join the discussion.</strong><br>' +
      'Think Beyond Practice is a community of psychiatric prescribers. Create a free account to comment, save posts, and read the archive.' +
      '<br><a class="btn" href="/platform?post=' + esc(post.id) + '">Open in the platform</a></div>' +
      '<div class="foot"><a href="/platform">Browse the community</a> · <a href="/">thinkbeyondpractice.com</a></div>';

    return {
      statusCode: 200,
      headers: Object.assign({}, baseHeaders, { 'Cache-Control': 'public, max-age=600, s-maxage=3600' }),
      body: page({
        title: title, description: description, canonical: canonical,
        ogImage: ogImage, noindex: false, bodyHtml: bodyHtml, jsonld: jsonld
      })
    };
  } catch (e) {
    return notFound();
  }
};
