// netlify/functions/marketplace-slots.js
//
// SELLER availability management (Denis's dashboard). Auth = signed session token;
// the caller may only manage the seller row whose account matches their email.
//
//   GET                          -> { seller, slots:[...], bookings:[...] }
//   POST {action:'add', starts_at, duration_minutes?}  -> create an open slot
//   POST {action:'remove', slot_id}                    -> delete an OPEN slot
//
// Times are stored in UTC (ISO). The client sends an absolute ISO instant.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET

const { verifyToken } = require('./_lib/session');
const { sb } = require('./_lib/marketplace');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};
const j = (status, obj) => ({ statusCode: status, headers: CORS, body: JSON.stringify(obj) });

async function sellerForRequest(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  let bodyTok = '';
  try { bodyTok = (JSON.parse(event.body || '{}').token) || ''; } catch (e) {}
  const token = (bodyTok || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid) return { error: j(401, { error: 'Sign in first.' }) };
  const email = String(session.claims.email || '').toLowerCase().trim();
  if (!email) return { error: j(401, { error: 'Sign in first.' }) };

  const accts = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1');
  const acct = accts && accts[0];
  if (!acct) return { error: j(403, { error: 'No account.' }) };
  const sellers = await sb('marketplace_sellers?account_id=eq.' + acct.id +
    '&select=id,display_name,slug,status,timezone,meeting_instructions,bio,expertise,avatar_url&limit=1');
  const seller = sellers && sellers[0];
  if (!seller) return { error: j(403, { error: 'You are not a seller.' }) };
  return { seller: seller };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return j(200, {});
  try {
    const r = await sellerForRequest(event);
    if (r.error) return r.error;
    const seller = r.seller;

    if (event.httpMethod === 'GET') {
      const slots = await sb('marketplace_availability?seller_id=eq.' + seller.id +
        '&select=id,starts_at,ends_at,status,hold_expires_at&order=starts_at.asc&limit=500');
      const bookings = await sb('marketplace_bookings?seller_id=eq.' + seller.id +
        '&select=id,starts_at,ends_at,buyer_email,topic,kind,toolkit_included,status,meeting_url' +
        '&order=starts_at.asc&limit=500');
      return j(200, { seller: seller, slots: slots || [], bookings: bookings || [] });
    }

    if (event.httpMethod !== 'POST') return j(405, { error: 'Method not allowed' });
    let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return j(400, { error: 'Bad JSON' }); }
    const action = body.action;

    if (action === 'add') {
      const startsAt = new Date(body.starts_at);
      if (isNaN(startsAt.getTime())) return j(400, { error: 'Invalid start time' });
      if (startsAt.getTime() < Date.now()) return j(400, { error: 'Slot is in the past' });
      const mins = parseInt(body.duration_minutes, 10) || 60;
      const endsAt = new Date(startsAt.getTime() + mins * 60 * 1000);
      const rows = await sb('marketplace_availability', 'POST', {
        seller_id: seller.id,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        status: 'open'
      }, 'return=representation');
      return j(200, { ok: true, slot: rows && rows[0] });
    }

    if (action === 'update_profile') {
      // The mentor edits their own public page fields.
      const patch = {};
      if (body.display_name != null) patch.display_name = String(body.display_name).slice(0, 120);
      if (body.expertise != null) patch.expertise = String(body.expertise).slice(0, 400);
      if (body.bio != null) patch.bio = String(body.bio).slice(0, 4000);
      if (body.meeting_instructions != null) patch.meeting_instructions = String(body.meeting_instructions).slice(0, 500);
      if (body.timezone != null) patch.timezone = String(body.timezone).slice(0, 64);
      if (!Object.keys(patch).length) return j(400, { error: 'Nothing to update' });
      patch.updated_at = new Date().toISOString();
      const rows = await sb('marketplace_sellers?id=eq.' + seller.id, 'PATCH', patch, 'return=representation');
      return j(200, { ok: true, seller: rows && rows[0] });
    }

    if (action === 'remove') {
      const slotId = String(body.slot_id || '').trim();
      if (!slotId) return j(400, { error: 'slot_id required' });
      // Only delete a slot that is still open (never yank a booked slot).
      const del = await sb('marketplace_availability?id=eq.' + encodeURIComponent(slotId) +
        '&status=eq.open', 'DELETE', null, 'return=representation');
      if (!del || !del.length) return j(409, { error: 'Slot is booked or already gone' });
      return j(200, { ok: true, removed: slotId });
    }

    return j(400, { error: 'Unknown action' });
  } catch (e) {
    return j(500, { error: e.message });
  }
};
