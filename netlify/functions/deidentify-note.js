// functions/deidentify-note.js
//
// Pure PHI de-identifier (platform tool).
//
// Flow:
//   1. Verify HMAC session token (localStorage tbp_auth_token).
//   2. Send the note to the AI through the BAA-covered path (Anthropic API under our BAA)
//      with a strict de-identification instruction. The AI removes the SHAPELESS
//      identifiers patterns can't catch: names, employers, schools, place names, and
//      any free-text identifying detail.
//   3. Run the deterministic scrub on the AI output as a guaranteeing second pass, so
//      SHAPED identifiers (SSN, phone, MRN, ZIP, dates, addresses, ages 90+, IP, URL)
//      are removed even if the model overlooked one.
//   4. Return the de-identified note plus category counts.
//
// PHI build rule: this function NEVER logs the raw note, the AI output, or any patient
// text. It logs only category counts and a template-opened marker.
//
// Env required (Netlify): ANTHROPIC_API_KEY (BAA-covered account), SESSION_SIGNING_SECRET.

'use strict';

const crypto = require('crypto');
const { scrubDeterministic } = require('./_lib/deid-deterministic');

// Proven model string only.
const MODEL = 'claude-sonnet-4-6';

// --- inline session verification (built-in crypto only; matches platform pattern) ---
function verifyToken(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

const SYSTEM_PROMPT = `You are a HIPAA de-identification pass. Your only job is to return the user's clinical text with every piece of Protected Health Information removed, replaced by neutral bracketed placeholders, while preserving all clinical meaning.

Remove and replace ALL of the following, wherever they appear, including in free-text prose:
- Patient, family, and any person names -> [NAME]
- Providers named by name -> [PROVIDER]
- Employers, workplaces, schools, universities -> [ORG]
- Cities, counties, neighborhoods, states, specific facilities/clinics/hospitals by name -> [PLACE]
- All dates (appointments, DOB, procedures, life events) except a bare year -> [DATE]
- Ages 90 and over -> [AGE 90+]
- Phone/fax, email, URLs, IP addresses -> [PHONE]/[EMAIL]/[URL]/[IP]
- SSN, MRN, account/member/policy numbers, any ID number -> [ID]
- Street addresses and ZIP codes -> [ADDRESS]/[ZIP]
- Any other detail that could reasonably identify the individual, including a rare combination of specific life events plus timeframe -> replace with a neutral bracketed placeholder such as [DETAIL]

PRESERVE completely: diagnoses, symptoms, medications and doses, clinical course, mental status, labs, and the clinical reasoning. De-identification must not remove clinical substance.

Rules:
- Return ONLY the de-identified text. No preamble, no explanation, no notes.
- Keep the placeholders consistent: the same removed person is [NAME] each time.
- When in doubt about whether something identifies the individual, replace it. Over-removal of identifiers is acceptable; leaving PHI in is not.`;

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // --- auth ---
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const session = verifyToken(token, process.env.SESSION_SIGNING_SECRET);
  if (!session) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authorized' }) };
  }

  // --- parse input ---
  let note = '';
  try {
    const body = JSON.parse(event.body || '{}');
    note = String(body.note || '');
  } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad request' }) };
  }
  if (!note.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No text provided' }) };
  }
  // guardrail: cap size to keep it a single-note tool
  if (note.length > 20000) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'Text too long. De-identify one note at a time (max ~20k characters).' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Service not configured' }) };
  }

  // --- AI pass (BAA-covered) ---
  let aiText = '';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: note }]
      })
    });

    if (!resp.ok) {
      // do not include response body (could echo input); log status only
      console.error('deidentify-note: AI pass failed, status', resp.status);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'De-identification service error. Try again.' }) };
    }

    const data = await resp.json();
    aiText = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch (err) {
    console.error('deidentify-note: AI pass exception');
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'De-identification service error. Try again.' }) };
  }

  if (!aiText) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'No output produced. Try again.' }) };
  }

  // --- deterministic guaranteeing second pass ---
  const scrub = scrubDeterministic(aiText);

  // PHI build rule: log ONLY category counts + template-opened. Never the text.
  console.log('deidentify-note ok', JSON.stringify({
    template: 'deidentify-note',
    second_pass_hits: scrub.counts,
    second_pass_total: scrub.total
  }));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      deidentified: scrub.text,
      secondPassCounts: scrub.counts,
      secondPassTotal: scrub.total
    })
  };
};
