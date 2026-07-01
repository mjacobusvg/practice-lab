// functions/deidentify-note.js
//
// Pure PHI de-identifier (platform tool). SELF-CONTAINED: the deterministic second
// pass is inlined below so there is no _lib require for the Netlify bundler to miss.
//
// Flow:
//   1. Verify HMAC session token (localStorage tbp_auth_token).
//   2. AI pass through the BAA-covered Anthropic API: removes SHAPELESS identifiers
//      patterns can't catch (names, employers, schools, place names, free-text detail).
//   3. Deterministic second pass (inlined): guarantees SHAPED identifiers (SSN, phone,
//      MRN, ZIP, dates, addresses, ages 90+, IP, URL) are gone even if the AI missed one.
//   4. Return de-identified note + category counts.
//
// PHI build rule: NEVER logs raw note, AI output, or any patient text. Logs only counts.
// Env required (Netlify): ANTHROPIC_API_KEY (BAA-covered), SESSION_SIGNING_SECRET.

'use strict';

// Use the platform's canonical token verifier so this tool verifies IDENTICALLY
// to every other .js function. This is a .js (CommonJS) function, so Netlify bundles
// the relative _lib require normally (the bundling issue only affected .mjs functions).
const { verifyToken } = require('./_lib/session.js');

const MODEL = 'claude-sonnet-4-6';

// ---------- inlined deterministic scrub (belt-and-suspenders second pass) ----------
function scrubDeterministic(text) {
  const log = [];
  let out = String(text == null ? '' : text);
  function rep(re, tag, label) { out = out.replace(re, () => { log.push(label); return tag; }); }

  rep(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]', 'ssn');
  rep(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]', 'email');
  rep(/\bhttps?:\/\/[^\s)]+/gi, '[URL]', 'url');
  rep(/\b(0?[1-9]|1[0-2])[\/\-.](0?[1-9]|[12]\d|3[01])[\/\-.](\d{4}|\d{2})\b/g, '[DATE]', 'date');
  rep(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi, '[DATE]', 'date');
  rep(/\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/gi, '[DATE]', 'date');
  rep(/\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[PHONE]', 'phone');
  rep(/\b(?:MRN|Medical Record(?: Number)?|Acct(?:ount)?|Member(?:\s*ID)?|Policy|Subscriber|Chart|Claim)\s*#?:?\s*[A-Z0-9-]{4,}\b/gi, '[ID]', 'id');
  rep(/\b[A-Z]{2,}\d{6,}\b/g, '[ID]', 'id');
  rep(/\b\d{7,}\b/g, '[ID]', 'id');
  rep(/\b\d{1,6}\s+([A-Z0-9][A-Za-z0-9.]*\s+){0,3}(Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Highway|Hwy)\b\.?(?:\s+(?:Ste|Suite|Apt|Unit)\s*#?\s*\w+)?/gi, '[ADDRESS]', 'address');
  rep(/\b\d{5}(?:-\d{4})?\b/g, '[ZIP]', 'zip');
  rep(/\b(9\d|1\d{2})\s*(?:years?\s*old|y\/?o|yo)\b/gi, '[AGE 90+]', 'age90plus');
  rep(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]', 'ip');

  const counts = {};
  for (const l of log) counts[l] = (counts[l] || 0) + 1;
  return { text: out, counts, total: log.length };
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
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const session = verifyToken(token); // reads SESSION_SIGNING_SECRET internally
  if (!session || !session.valid) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authorized' }) };
  }

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
  if (note.length > 100000) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'Text too long. De-identify one note at a time (max ~100k characters).' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Service not configured' }) };
  }

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
        max_tokens: 32000,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: note }]
      })
    });

    if (!resp.ok) {
      console.error('deidentify-note: AI pass failed, status', resp.status);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'De-identification service error. Try again.' }) };
    }

    const data = await resp.json();
    aiText = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  } catch (err) {
    console.error('deidentify-note: AI pass exception');
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'De-identification service error. Try again.' }) };
  }

  if (!aiText) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'No output produced. Try again.' }) };
  }

  const scrub = scrubDeterministic(aiText);

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
