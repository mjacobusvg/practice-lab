// netlify/functions/marketplace-track.js
//
// Records a marketplace_attribution row when a visitor lands on a seller page.
// Answers "did the seller's own promotion drive visits -> purchases -> members?"
// Public, best-effort, fire-and-forget from the page.
//
// Body: { slug|seller_id, visitor_id, utm_source?, utm_medium?, utm_campaign?, referrer? }
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { sb } = require('./_lib/marketplace');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad JSON' }) }; }
  const visitorId = String(b.visitor_id || '').slice(0, 80);
  if (!visitorId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, skipped: 'no visitor' }) };

  try {
    let sellerId = String(b.seller_id || '').trim();
    if (!sellerId && b.slug) {
      const rows = await sb('marketplace_sellers?slug=eq.' + encodeURIComponent(String(b.slug)) + '&select=id&limit=1');
      sellerId = rows && rows[0] ? rows[0].id : '';
    }
    if (!sellerId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, skipped: 'no seller' }) };

    // Only record the FIRST touch per (seller, visitor) to keep it as a first-touch model.
    const existing = await sb('marketplace_attribution?seller_id=eq.' + sellerId +
      '&visitor_id=eq.' + encodeURIComponent(visitorId) + '&select=id&limit=1');
    if (existing && existing.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, existing: true }) };

    await sb('marketplace_attribution', 'POST', {
      seller_id: sellerId,
      visitor_id: visitorId,
      utm_source: b.utm_source ? String(b.utm_source).slice(0, 120) : null,
      utm_medium: b.utm_medium ? String(b.utm_medium).slice(0, 120) : null,
      utm_campaign: b.utm_campaign ? String(b.utm_campaign).slice(0, 120) : null,
      referrer_url: b.referrer ? String(b.referrer).slice(0, 500) : null
    }, 'return=minimal');
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
