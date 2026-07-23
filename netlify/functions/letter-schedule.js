// netlify/functions/letter-schedule.js
// Provider-facing management of recurring letter schedules (create / list / cancel).
// Called from the Letter Generator UI. Full-tier members only; identity from the SIGNED
// token (never client email). A provider can only see/modify their OWN schedules
// (provider_email is taken from the verified token, not from the request body).
//
// Actions (POST body { action, ... }):
//   create: { standard_id, patient_email, patient_label?, patient_message?, toggles?, sign?, cadence_days?, first_send_in_days? }
//   list:   {}                          -> this provider's active/recent schedules
//   cancel: { id }                      -> sets status 'cancelled' (provider's opt-out / patient changed coverage)
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET (via _lib/session)

const { verifyToken } = require('./_lib/session');
const crypto = require('crypto');

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }

  // Auth: full-tier member, identity from signed token.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired session' }) };
  if (!(session.claims.scope === 'member' && session.claims.tier === 'full')) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Requires full membership' }) };
  }
  const providerEmail = (session.claims.email || '').toLowerCase().trim();
  if (!providerEmail) return { statusCode: 403, headers, body: JSON.stringify({ error: 'No provider identity' }) };

  function sb(path, opts) {
    opts = opts || {};
    return fetch(SUPABASE_URL + '/rest/v1/' + path, {
      method: opts.method || 'GET',
      headers: Object.assign({
        'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json', 'Accept': 'application/json'
      }, opts.headers || {}),
      body: opts.body
    });
  }

  const action = body.action;
  try {
    if (action === 'create') {
      if (!body.standard_id || !body.patient_email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'standard_id and patient_email are required' }) };
      }
      // Confirm the standard belongs to this provider or is a system standard (no cross-owner scheduling).
      const stdRes = await sb('tbp_letter_standards?id=eq.' + encodeURIComponent(body.standard_id) +
        '&select=id,is_system,authored_by&limit=1');
      const stdArr = await stdRes.json();
      const std = stdArr && stdArr[0];
      if (!std || !(std.is_system === true || (std.authored_by || '').toLowerCase() === providerEmail)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Not permitted to schedule this standard' }) };
      }

      const cadence = clampInt(body.cadence_days, 1, 365, 80);
      const firstIn = clampInt(body.first_send_in_days, 0, 365, 0); // 0 = send on next cron run
      const next = new Date();
      next.setDate(next.getDate() + firstIn);
      const optOutToken = crypto.randomBytes(24).toString('hex');

      const row = {
        provider_email: providerEmail,
        standard_id: body.standard_id,
        patient_email: String(body.patient_email).trim(),
        patient_label: (body.patient_label || '').toString().slice(0, 120) || null,
        patient_message: (body.patient_message || '').toString().slice(0, 2000).trim() || null,
        toggles: body.toggles && typeof body.toggles === 'object' ? body.toggles : {},
        sign: body.sign !== false,
        cadence_days: cadence,
        next_run_at: next.toISOString(),
        end_date: body.end_date || null,
        status: 'active',
        opt_out_token: optOutToken,
        return_email: (body.return_email || 'jesse@corspokane.com').toString().trim()
      };
      const ins = await sb('letter_schedules', {
        method: 'POST', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify(row)
      });
      if (!ins.ok) { const t = await ins.text(); return { statusCode: 500, headers, body: JSON.stringify({ error: 'Insert failed', detail: t }) }; }
      const created = (await ins.json())[0];
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, schedule: publicView(created) }) };
    }

    if (action === 'list') {
      const res = await sb('letter_schedules?provider_email=eq.' + encodeURIComponent(providerEmail) +
        '&order=created_at.desc&limit=200&select=*');
      const arr = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, schedules: (arr || []).map(publicView) }) };
    }

    if (action === 'cancel') {
      if (!body.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id required' }) };
      // Scope the update to this provider's own row.
      const res = await sb('letter_schedules?id=eq.' + encodeURIComponent(body.id) +
        '&provider_email=eq.' + encodeURIComponent(providerEmail), {
        method: 'PATCH', headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ status: 'cancelled', updated_at: new Date().toISOString() })
      });
      const arr = await res.json();
      if (!arr || !arr.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Schedule not found' }) };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, schedule: publicView(arr[0]) }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// Never leak opt_out_token to the provider UI; expose only what the list needs.
function publicView(s) {
  if (!s) return s;
  return {
    id: s.id, patient_email: s.patient_email, patient_label: s.patient_label,
    cadence_days: s.cadence_days, next_run_at: s.next_run_at, status: s.status,
    sends_count: s.sends_count, last_run_at: s.last_run_at, last_error: s.last_error,
    created_at: s.created_at
  };
}
