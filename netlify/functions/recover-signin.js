// netlify/functions/recover-signin.js
//
// "Forgot which email you used?" recovery — the safety net that replaces the
// removed Google sign-in. Given a NAME, find the matching account(s) and send a
// magic sign-in link (Supabase OTP) to the email on file for each. Privacy-safe:
// it NEVER reveals whether a name matched, how many did, or what the email is —
// the client always shows the same generic message. Only ever emails addresses
// that already exist in our accounts table (their own inbox), so it can't be used
// to fish for arbitrary addresses.
//
// Body: { name }  ->  { ok: true, message }
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

// Public anon key (same one shipped in platform.html) — used only to call the
// standard GoTrue OTP endpoint, exactly as the browser sign-in form does.
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InViY3JycmFwZWRheGtndXhuaXd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzNjA2MTUsImV4cCI6MjA5MDkzNjYxNX0.CoS_t8EvCsgXJJA1dz4WXYWGsE8OMKEDeaWfsExQ1H0';
const SITE = 'https://thinkbeyondpractice.com';

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false }) };

  // Same message every time, regardless of outcome — never leak account existence.
  const generic = { ok: true, message: "If we found an account under that name, we've emailed a sign-in link to the address on file." };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  let name = '';
  try { name = String((JSON.parse(event.body || '{}')).name || '').trim(); } catch (e) {}
  if (!URL || !KEY || name.length < 2) return { statusCode: 200, headers, body: JSON.stringify(generic) };

  try {
    const svc = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
    const r = await fetch(URL + '/rest/v1/accounts?name=ilike.' + encodeURIComponent('%' + name + '%') + '&select=email&limit=10', { headers: svc });
    const rows = r.ok ? await r.json() : [];
    // Send a magic link to each matching account (name collisions -> each real
    // owner gets a link in their own inbox; only they can open it).
    for (const row of rows) {
      if (!row.email || row.email.indexOf('@') === -1) continue;
      try {
        await fetch(URL + '/auth/v1/otp?redirect_to=' + encodeURIComponent(SITE + '/platform'), {
          method: 'POST',
          headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: String(row.email).toLowerCase(), create_user: true })
        });
      } catch (e) { /* best-effort per address */ }
    }
  } catch (e) { /* never surface internals */ }

  return { statusCode: 200, headers, body: JSON.stringify(generic) };
};
