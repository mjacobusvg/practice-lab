// netlify/functions/marketplace-mentors.js
//
// PUBLIC directory feed: lists active mentors for /mentors. Each entry carries a
// bookable flag (has open future availability) so the directory can show "Book"
// vs "Availability coming soon". No auth.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { sb, callerFromEvent } = require('./_lib/marketplace');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };

  try {
    const sellers = await sb('marketplace_sellers?status=eq.active' +
      '&select=id,slug,display_name,bio,expertise,avatar_url,status&order=created_at.asc&limit=100');

    // Preview: a signed-in caller also sees their OWN hidden profile; an admin sees
    // every hidden profile. These are flagged `hidden:true` so the UI can badge them.
    const caller = await callerFromEvent(event);
    const hiddenIds = new Set();
    if (caller) {
      const previewable = caller.isAdmin
        ? await sb('marketplace_sellers?status=eq.hidden' +
            '&select=id,slug,display_name,bio,expertise,avatar_url,status&order=created_at.asc&limit=100')
        : (caller.accountId
            ? await sb('marketplace_sellers?status=eq.hidden&account_id=eq.' + encodeURIComponent(caller.accountId) +
                '&select=id,slug,display_name,bio,expertise,avatar_url,status&order=created_at.asc&limit=100')
            : []);
      for (const h of (previewable || [])) {
        if (!sellers.some(function (s) { return s.id === h.id; })) { sellers.push(h); hiddenIds.add(h.id); }
      }
    }

    const nowIso = new Date().toISOString();
    const out = [];
    for (const s of (sellers || [])) {
      // Cheapest bookable check: any open, future slot.
      const slots = await sb('marketplace_availability?seller_id=eq.' + s.id +
        '&status=eq.open&starts_at=gt.' + encodeURIComponent(nowIso) + '&select=id&limit=1');
      // Pull the headline offering price for the card.
      const off = await sb('marketplace_offerings?seller_id=eq.' + s.id +
        '&status=eq.active&type=eq.service&select=price_public_cents&order=created_at.asc&limit=1');
      out.push({
        slug: s.slug,
        display_name: s.display_name,
        bio: s.bio,
        expertise: s.expertise,
        avatar_url: s.avatar_url,
        bookable: !!(slots && slots.length),
        from_price_cents: off && off[0] ? off[0].price_public_cents : null,
        hidden: hiddenIds.has(s.id) || s.status === 'hidden'
      });
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ mentors: out }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
