// netlify/functions/marketplace-offering.js
//
// PUBLIC read for a seller's offering page (e.g. /mentors/denis-grigorov).
// No auth: returns the seller, their active offering, PUBLIC prices, and open
// future availability slots. Member prices are resolved server-side at checkout
// (marketplace-book.js) or via an authed peek — never trusted from the client.
//
// Query: ?slug=<seller slug>  OR  ?seller=<seller uuid>
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { sb } = require('./_lib/marketplace');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };

  const q = event.queryStringParameters || {};
  const slug = (q.slug || '').trim();
  const sellerId = (q.seller || '').trim();
  if (!slug && !sellerId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'slug or seller required' }) };

  try {
    const filter = sellerId
      ? 'id=eq.' + encodeURIComponent(sellerId)
      : 'slug=eq.' + encodeURIComponent(slug);
    const sellers = await sb('marketplace_sellers?' + filter +
      '&status=eq.active&select=id,slug,display_name,bio,expertise,avatar_url,timezone&limit=1');
    const seller = sellers && sellers[0];
    if (!seller) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Not found' }) };

    const offerings = await sb('marketplace_offerings?seller_id=eq.' + seller.id +
      '&status=eq.active&type=eq.service&select=id,title,description,duration_minutes,' +
      'price_public_cents,price_member_cents,bundle_enabled,bundle_price_public_cents,' +
      'bundle_price_member_cents&order=created_at.asc&limit=1');
    const offering = offerings && offerings[0];

    // Open, future, un-held slots only. Also treat expired holds as open.
    const nowIso = new Date().toISOString();
    const slots = await sb('marketplace_availability?seller_id=eq.' + seller.id +
      '&starts_at=gt.' + encodeURIComponent(nowIso) +
      '&status=in.(open,held)&select=id,starts_at,ends_at,status,hold_expires_at&order=starts_at.asc&limit=200');
    const openSlots = (slots || []).filter(function (s) {
      if (s.status === 'open') return true;
      // a held slot whose hold has expired is effectively open again
      return s.status === 'held' && s.hold_expires_at && new Date(s.hold_expires_at) < new Date();
    }).map(function (s) { return { id: s.id, starts_at: s.starts_at, ends_at: s.ends_at }; });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        seller: {
          id: seller.id, slug: seller.slug, display_name: seller.display_name,
          bio: seller.bio, expertise: seller.expertise, avatar_url: seller.avatar_url,
          timezone: seller.timezone
        },
        offering: offering || null,
        slots: openSlots
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
