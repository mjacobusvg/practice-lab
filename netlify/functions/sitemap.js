// netlify/functions/sitemap.js
//
// Dynamic sitemap.xml: the fixed marketing/insights pages PLUS one URL per
// free_visible forum post (/post/<id>), so search engines discover the crawlable
// post pages served by post-page.js. Served at /sitemap.xml via a netlify.toml
// rewrite; robots.txt already points there.
//
// Member-only posts are intentionally excluded — only free posts are indexable.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const SITE = 'https://thinkbeyondpractice.com';

// Fixed marketing + insights pages (mirrors the former static sitemap.xml).
const STATIC_URLS = [
  { loc: '/', priority: '1.0' },
  { loc: '/insights.html', priority: '0.9' },
  { loc: '/insights/ai-scribe-that-reasons.html', priority: '0.9' },
  { loc: '/insights/billing-compliance.html', priority: '0.8' },
  { loc: '/insights/diagnostic-uncertainty.html', priority: '0.8' },
  { loc: '/insights/high-risk-documentation.html', priority: '0.8' },
  { loc: '/insights/medication-escalation.html', priority: '0.8' },
  { loc: '/insights/med-check-frequency.html', priority: '0.8' },
  { loc: '/insights/bayesian-reasoning-clinicians.html', priority: '0.8' },
  { loc: '/insights/scope-and-competence.html', priority: '0.8' },
  { loc: '/insights/when-suffering-becomes-disorder.html', priority: '0.8' },
  { loc: '/insights/pmhnp-private-practice-setup-mistakes.html', priority: '0.8' },
  { loc: '/insights/pmhnp-documentation-audit-review.html', priority: '0.8' },
  { loc: '/insights/two-visions.html', priority: '0.8' },
  { loc: '/insights/pmhnp-credentialing-delays-timeline.html', priority: '0.8' },
  { loc: '/insights/99213-vs-99214-psychiatry.html', priority: '0.8' },
  { loc: '/insights/mdm-vs-time-psychiatry.html', priority: '0.8' },
  { loc: '/insights/90833-documentation-psychiatry.html', priority: '0.8' },
  { loc: '/insights/mdm-documentation-psychiatry.html', priority: '0.8' },
  { loc: '/insights/interactive-complexity-90785.html', priority: '0.8' },
  { loc: '/practice-lab-demo.html', priority: '0.6' },
  { loc: '/ai-scribe-demo.html', priority: '0.9' },
  { loc: '/practice-manager-demo.html', priority: '0.8' }
];

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

exports.handler = async function () {
  const headers = { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' };

  let postUrls = [];
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const KEY = process.env.SUPABASE_SERVICE_KEY;
    if (SUPABASE_URL && KEY) {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/forum_posts?free_visible=eq.true&select=id,updated_at,created_at&order=updated_at.desc&limit=2000',
        { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } }
      );
      if (res.ok) {
        const rows = await res.json();
        postUrls = (rows || []).map(function (p) {
          const lm = (p.updated_at || p.created_at || '');
          return { loc: '/post/' + p.id, priority: '0.7', lastmod: lm ? String(lm).slice(0, 10) : '' };
        });
      }
    }
  } catch (e) { /* fall back to static-only sitemap */ }

  const all = STATIC_URLS.concat(postUrls);
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    all.map(function (u) {
      return '  <url>\n    <loc>' + xmlEsc(SITE + u.loc) + '</loc>\n' +
        (u.lastmod ? '    <lastmod>' + xmlEsc(u.lastmod) + '</lastmod>\n' : '') +
        (u.priority ? '    <priority>' + u.priority + '</priority>\n' : '') +
        '  </url>';
    }).join('\n') +
    '\n</urlset>\n';

  return { statusCode: 200, headers: headers, body: body };
};
