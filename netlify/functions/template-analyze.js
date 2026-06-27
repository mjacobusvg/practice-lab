// netlify/functions/template-analyze.js
// Takes an intake row's extracted text, asks Claude to propose title/description/
// category/tier, and fuzzy-matches against the 38-post manifest.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY

const { verifyToken } = require('./_lib/session');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];
const VALID_CATS = ['documentation', 'billing', 'letters', 'policies', 'clinical', 'operations', 'general'];

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY, AK = process.env.ANTHROPIC_API_KEY;
  var missing = [];
  if (!URL) missing.push('SUPABASE_URL');
  if (!KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (!AK) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env: ' + missing.join(', ') }) };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }

  // Admin-only (was unauthenticated; this also calls Anthropic, so it's an AI-cost surface).
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Invalid or expired session.' }) };
  if (ADMIN_EMAILS.indexOf(String(session.claims.email || '').toLowerCase().trim()) === -1) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }

  const intakeId = String(p.intake_id || '').trim();
  const filename = String(p.filename || '').trim();
  const text = String(p.text || '').slice(0, 8000); // cap input
  if (!intakeId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'intake_id required' }) };

  const sbHeaders = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  try {
    // Pull the manifest titles so Claude can match against them
    const manRes = await fetch(URL + '/rest/v1/template_manifest?select=post_title,category', { headers: sbHeaders });
    const manifest = await manRes.json();
    const manifestList = (manifest || []).map(m => m.post_title).join('\n');

    const prompt = [
      'You are cataloging a clinical practice template file for a psychiatric prescriber\'s resource library.',
      'Filename: ' + filename,
      'File content (may be truncated):',
      '"""', text || '(no text could be extracted)', '"""',
      '',
      'Categories (pick exactly one): documentation, billing, letters, policies, clinical, operations, general.',
      '',
      'Here is a list of known template post titles this file might correspond to:',
      manifestList,
      '',
      'Return ONLY a JSON object, no prose, no markdown fences, with keys:',
      '{"title": "...", "description": "one sentence on what it is and when to use it", "category": "one of the categories", "tier": "full|forum|free", "matched_post": "exact title from the list above or empty string", "confidence": "high|medium|low|none"}'
    ].join('\n');

    // Fallback proposal from the filename, used if the AI call fails for any reason.
    var fallback = { title: filename.replace(/\.[^.]+$/, '').replace(/\.docx$/i,'').replace(/_/g,' '), description: '', category: 'general', tier: 'full', matched_post: '', confidence: 'none' };
    let prop = fallback;
    let aiError = null;
    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': AK, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
      });
      const aiData = await aiRes.json();
      if (!aiRes.ok) {
        aiError = 'Anthropic ' + aiRes.status + ': ' + JSON.stringify(aiData).slice(0, 300);
      } else {
        let raw = (aiData.content && aiData.content[0] && aiData.content[0].text) ? aiData.content[0].text : '';
        raw = raw.replace(/```json|```/g, '').trim();
        try { prop = JSON.parse(raw); } catch (e) { aiError = 'Parse failed: ' + raw.slice(0,200); prop = fallback; }
      }
    } catch (e) { aiError = 'Fetch failed: ' + e.message; }

    const cat = VALID_CATS.indexOf(prop.category) !== -1 ? prop.category : 'general';
    const tier = ['full', 'forum', 'free'].indexOf(prop.tier) !== -1 ? prop.tier : 'full';

    // Write proposal back to the intake row
    const upd = await fetch(URL + '/rest/v1/template_intake?id=eq.' + encodeURIComponent(intakeId), {
      method: 'PATCH', headers: sbHeaders,
      body: JSON.stringify({
        extracted_text: text || null,
        ai_title: prop.title || filename,
        ai_description: prop.description || null,
        ai_category: cat,
        ai_tier: tier,
        matched_post_title: prop.matched_post || null,
        match_confidence: prop.confidence || 'none',
        status: 'analyzed'
      })
    });
    if (!upd.ok) throw new Error('Supabase update ' + upd.status);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ai_error: aiError, proposal: { title: prop.title, description: prop.description, category: cat, tier: tier, matched_post: prop.matched_post, confidence: prop.confidence } }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
