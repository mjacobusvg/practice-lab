// netlify/functions/drug-evidence.js
//
// The one interface Discern's path calls for medication facts. Retrieval logic lives in
// _lib/rx-evidence.js; nothing else in the codebase talks to RxNorm or DailyMed.
//
// NO PHI CROSSES THIS BOUNDARY. Input is drug names and fact classes. The patient case stays on
// the BAA-covered AWS path. "What does the Adderall XR label say about adult dosing" is not PHI;
// "she is on Adderall XR and her PCP started fluoxetine" is, and must never arrive here.
//
//   POST { drugs: ['Adderall XR','fluoxetine'], classes: ['dosing','interaction'] }
//   Authorization: Bearer <RX_EVIDENCE_SECRET>
//
// The secret goes in a HEADER, never a query string: query strings land in browser history,
// access logs, proxies and analytics.

const { getEvidence } = require('./_lib/rx-evidence.js');
const { verifyToken } = require('./_lib/session.js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: '{"error":"POST only"}' };

  // The browser calls this, so the caller is the member's SIGNED SESSION TOKEN, the same one
  // every other member-facing function verifies. A shared secret would have to ship to the
  // client to be usable from the Scribe, which is not a secret. The server-to-server secret is
  // kept for backfill jobs only, and only ever in a header.
  const auth = String((event.headers && (event.headers.authorization || event.headers.Authorization)) || '');
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  const secret = process.env.RX_EVIDENCE_SECRET || process.env.BACKFILL_SECRET;
  let allowed = false;
  if (secret && bearer === secret) allowed = true;
  else if (bearer) {
    const session = verifyToken(bearer);
    allowed = !!(session && session.valid && session.claims && session.claims.scope === 'member');
  }
  if (!allowed) return { statusCode: 401, headers: CORS, body: '{"error":"unauthorized"}' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: '{"error":"bad JSON"}' }; }

  const drugs = Array.isArray(body.drugs) ? body.drugs.filter(d => typeof d === 'string' && d.trim()) : [];
  const classes = Array.isArray(body.classes) ? body.classes : ['dosing'];
  if (!drugs.length) return { statusCode: 400, headers: CORS, body: '{"error":"no drugs"}' };

  // A name long enough to be a sentence is a sign the caller is sending the question rather than
  // a drug name, which would put PHI on the wrong side of the boundary. Refuse it.
  const suspicious = drugs.find(d => d.length > 60 || d.split(/\s+/).length > 6);
  if (suspicious) {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'drug names only; this looks like free text', got: suspicious.slice(0, 40) }) };
  }

  try {
    // getEvidence returns { evidence, wanted_sections }; the caller needs wanted_sections to
    // tell "this label has no interactions section" from "we never asked for one".
    // Per-drug identity granularity, decided by the caller from the claim: product-level where
    // the formulation changes the answer, ingredient-level for pharmacology that does not.
    const granularity = (body.granularity && typeof body.granularity === 'object') ? body.granularity : {};
    // refresh bypasses the 30-day cache; used by the coverage harness so a resolver fix can be
    // validated instead of being masked by a label stored under the old scoring.
    const result = await getEvidence(drugs, classes,
      { granularity: granularity, refresh: !!body.refresh });
    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
