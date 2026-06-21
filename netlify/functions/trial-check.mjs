// netlify/functions/trial-check.mjs
//
// Server-enforced 7-day trial for the Clinical Note Builder trial clone.
// Keyed to the member's Circle community member ID (falls back to verified email)
// AND to a trial version string, so a major release (HPI gen, Vault Plan, ambient)
// can grant a fresh window by bumping the version the page sends.
//
// The timer is enforced HERE, not in the browser, so clearing localStorage does not
// reset the trial. The page only displays whatever this function returns.
//
// Requires two environment variables in Netlify (these already exist in this project):
//   SUPABASE_URL          e.g. https://ubcrrrapedaxkguxniwv.supabase.co
//   SUPABASE_SERVICE_KEY  service-role key (server-side only; never ship to client)
//
// Table (already created in Supabase):
//   note_builder_trials(community_member_id text, trial_version text, email text,
//                       started_at timestamptz, primary key (community_member_id, trial_version))

const TRIAL_DAYS = 7;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function json(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Minimal Supabase REST helpers (PostgREST). No client library needed.
async function sbSelect(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`select failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`insert failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { status: 'error', message: 'Method not allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(500, { status: 'error', message: 'Trial service is not configured.' });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json(400, { status: 'error', message: 'Invalid request body.' });
  }

  const memberId = (payload.memberId || '').toString().trim();
  const email = (payload.email || '').toString().trim().toLowerCase();
  const trialVersion = (payload.trialVersion || 'v1').toString().trim();

  // Key on member ID when available (closes the multi-email loophole); fall back to email.
  const keyId = memberId || email;
  if (!keyId) {
    return json(400, { status: 'error', message: 'Missing member identity.' });
  }

  try {
    // Look for an existing trial row for this identity + version.
    const existing = await sbSelect(
      'note_builder_trials',
      `community_member_id=eq.${encodeURIComponent(keyId)}&trial_version=eq.${encodeURIComponent(trialVersion)}&select=started_at`
    );

    const now = Date.now();
    const msInDay = 24 * 60 * 60 * 1000;

    if (existing && existing.length > 0) {
      const startedAt = new Date(existing[0].started_at).getTime();
      const elapsedDays = (now - startedAt) / msInDay;
      const daysLeft = Math.max(0, Math.ceil(TRIAL_DAYS - elapsedDays));
      if (elapsedDays < TRIAL_DAYS) {
        return json(200, { status: 'active', daysLeft });
      }
      return json(200, { status: 'expired' });
    }

    // No row yet: start the trial now.
    await sbInsert('note_builder_trials', {
      community_member_id: keyId,
      trial_version: trialVersion,
      email: email || null,
      started_at: new Date(now).toISOString(),
    });
    return json(200, { status: 'active', daysLeft: TRIAL_DAYS });
  } catch (err) {
    return json(500, { status: 'error', message: 'Trial lookup failed. Please try again.' });
  }
};
