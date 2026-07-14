// netlify/functions/extract-templates-background.js
// Admin-triggered batch that turns each template_library row (which today only
// points at a source post) into a real, standalone template:
//   1. reads the source post body,
//   2. asks Claude to extract the clean, reusable template from it,
//   3. stores the extracted template as rendered HTML in `preview` (shown inline
//      on the template detail page, copy-able), refreshes `description`, and
//   4. renders a downloadable PDF into the private 'templates' bucket, setting
//      `storage_path` so template-download.js can serve it.
//
// It NEVER invents clinical content: the prompt constrains Claude to only reuse
// what's in the post. Progress is written to migration_log (the 202 response
// hides the result from the browser). Re-running only touches rows not yet
// extracted unless {force:true}.
//
// Auth: Michael's signed admin token (or EXTRACT_SECRET header) - it spends model
// calls, so it must not be openly triggerable.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY[, EXTRACT_SECRET]

const https = require('https');
const { verifyToken } = require('./_lib/session');
const { toRichHtml } = require('./_lib/richtext');
const { buildTextPdf } = require('./_lib/text-pdf');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];
const MODEL = 'claude-sonnet-4-6';
const BUCKET = 'templates';
const BATCH_CAP = 80;

function anthropic(apiKey, payload) {
  return new Promise(function (resolve, reject) {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
    }, function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        try { const j = JSON.parse(body); if (res.statusCode >= 400) reject(new Error('anthropic ' + res.statusCode + ': ' + (j.error && j.error.message || body).slice(0, 200))); else resolve(j); }
        catch (e) { reject(new Error('anthropic parse: ' + body.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

// Parse the delimited reply (TITLE / DESCRIPTION / === / markdown body). This
// format is far more robust than JSON: markdown bodies contain newlines and
// quotes that routinely break JSON.parse, and a truncated body just loses its
// tail instead of failing the whole parse.
function parseDelimited(text) {
  let t = String(text || '').replace(/```/g, '').trim();
  const idx = t.indexOf('===');
  const header = idx === -1 ? t : t.slice(0, idx);
  let body = idx === -1 ? '' : t.slice(idx + 3);
  const titleM = header.match(/TITLE:\s*(.+)/i);
  const descM = header.match(/DESCRIPTION:\s*(.+)/i);
  if (idx === -1) {
    // No delimiter: strip the header lines and treat the rest as the body.
    body = t.replace(/^\s*TITLE:.*$/im, '').replace(/^\s*DESCRIPTION:.*$/im, '').trim();
  }
  return {
    title: (titleM ? titleM[1] : '').trim(),
    description: (descM ? descM[1] : '').trim(),
    body_markdown: body.trim()
  };
}

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY, AI = process.env.ANTHROPIC_API_KEY;
  if (!URL || !KEY || !AI) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env (SUPABASE_URL / SUPABASE_SERVICE_KEY / ANTHROPIC_API_KEY)' }) };
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  const sb = async (path, method, body, prefer) => {
    const h = Object.assign({ 'Content-Type': 'application/json' }, auth);
    if (prefer) h['Prefer'] = prefer;
    const res = await fetch(URL + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error('sb ' + res.status + ': ' + text.slice(0, 150));
    return text ? JSON.parse(text) : null;
  };
  const log = async (msg) => { try { await sb('migration_log', 'POST', { tag: 'extract-templates', detail: String(msg).slice(0, 500) }, 'return=minimal'); } catch (e) {} };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }

  // Authorize: Michael's admin token OR the shared BACKFILL_SECRET (same one the
  // avatar migration uses), passed in the body from the trigger page.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  const isAdmin = session.valid && ADMIN_EMAILS.indexOf(String(session.claims.email || '').toLowerCase()) !== -1;
  const secretOk = process.env.BACKFILL_SECRET && p.secret && p.secret === process.env.BACKFILL_SECRET;
  if (!isAdmin && !secretOk) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Admin only' }) };

  const force = !!p.force;
  await log('start (force=' + force + ')');

  try {
    // Rows that still point at a post but are not fully extracted yet (missing
    // the clean markdown, the inline preview, OR the downloadable PDF).
    let filter = 'template_library?source_post_id=not.is.null&visible=eq.true&select=id,title,source_post_id,storage_path,preview,body_markdown&order=sort_order.asc&limit=' + BATCH_CAP;
    if (!force) filter += '&or=(storage_path.is.null,preview.is.null,body_markdown.is.null)';
    const rows = await sb(filter, 'GET');
    if (!rows || !rows.length) { await log('nothing to do'); return { statusCode: 200, headers, body: JSON.stringify({ ok: true, processed: 0 }) }; }

    let done = 0, failed = 0;
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i];
      try {
        let title = null, description = null, bodyMd = null;

        // Deterministic rebuild path: if we already have curated markdown and
        // this is not a forced re-extract, just re-render preview + PDF from it.
        // No model call, so it never drifts from approved content.
        if (t.body_markdown && !force) {
          bodyMd = String(t.body_markdown).trim();
          title = t.title || 'Template';
        } else {
          const posts = await sb('forum_posts?id=eq.' + encodeURIComponent(t.source_post_id) + '&select=title,body_plain&limit=1', 'GET');
          const post = posts && posts[0];
          if (!post || !post.body_plain) { failed++; await log('skip (no post body) ' + t.id); continue; }

          const sys = 'You turn a community forum post (written for psychiatric prescribers) into a clean, standalone, reusable TEMPLATE or quick-reference document. The post mixes personal commentary with the actual reusable material. Output ONLY what a clinician would copy and adapt: keep every substantive detail (CPT codes, time thresholds, MDM criteria, exact phrasing, checklists, letter/note structure, examples), but strip greetings, "here is how I", storytelling, and meta-commentary. Where the post implies a fill-in document (a letter, a note, an appeal), format it as a template with clearly marked fill-in fields like [Patient Name] or [Date]. Use clean Markdown: ## / ### headings, bold, bullet/numbered lists, and GFM pipe tables for any tabular data (codes, thresholds, ranges). NEVER invent facts, codes, or clinical content; use only what appears in the post.';
          const usr = 'POST TITLE: ' + (post.title || '') + '\n\nPOST BODY:\n' + String(post.body_plain).slice(0, 12000) +
            '\n\nReturn EXACTLY this format and nothing else:\n' +
            'TITLE: <name the ARTIFACT, not the article. A short noun phrase a clinician would file it under. NO emoji, NO "How to", NO clickbait. E.g. "E/M Time vs MDM Reference Card", "Payer Rate-Increase Request Letter", "90833 Add-On Documentation Checklist">\n' +
            'DESCRIPTION: <one sentence, under 160 chars, saying what the document is and when to use it>\n' +
            '===\n<the template/reference in clean Markdown as described above>';

          const reply = await anthropic(AI, { model: MODEL, max_tokens: 6000, system: sys, messages: [{ role: 'user', content: usr }] });
          const textOut = (reply.content && reply.content[0] && reply.content[0].text) || '';
          const parsed = parseDelimited(textOut);
          // Normalize em/en dashes to hyphens everywhere (house style: no em dashes).
          var deDash = function (s) { return String(s == null ? '' : s).replace(/[—–]/g, '-'); };
          bodyMd = deDash(parsed.body_markdown || textOut || '').trim();
          if (!bodyMd) { failed++; await log('skip (empty extraction) ' + t.id); continue; }
          // Strip any leading emoji/symbols the model may still prepend.
          title = deDash(parsed.title || '').replace(/^[^\w"'(]+/, '').trim().slice(0, 160) || t.title || 'Template';
          description = deDash(parsed.description || '').replace(/\s+/g, ' ').trim().slice(0, 240) || null;
        }

        // Persist the clean markdown + rendered preview + title/description FIRST
        // so a PDF hiccup never blocks the inline, readable template.
        const prePatch = { body_markdown: bodyMd, preview: toRichHtml(bodyMd), title: title };
        if (description) prePatch.description = description;
        await sb('template_library?id=eq.' + encodeURIComponent(t.id), 'PATCH', prePatch, 'return=minimal');

        // Downloadable PDF into the private templates bucket (best-effort).
        try {
          const pdf = await buildTextPdf(title, bodyMd);
          const objectPath = 'extracted/' + t.id + '.pdf';
          const upRes = await fetch(URL + '/storage/v1/object/' + BUCKET + '/' + objectPath, {
            method: 'POST',
            headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
            body: pdf
          });
          if (upRes.ok) { await sb('template_library?id=eq.' + encodeURIComponent(t.id), 'PATCH', { storage_path: objectPath }, 'return=minimal'); }
          else { await log('pdf upload failed ' + t.id + ': ' + (await upRes.text()).slice(0, 120)); }
        } catch (pe) { await log('pdf error ' + t.id + ': ' + (pe && pe.message ? pe.message : pe)); }
        done++;
      } catch (e) {
        failed++;
        await log('error ' + t.id + ': ' + (e && e.message ? e.message : e));
      }
    }

    await log('done processed=' + done + ' failed=' + failed + ' of ' + rows.length);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, processed: done, failed: failed, total: rows.length }) };
  } catch (e) {
    await log('fatal: ' + (e && e.message ? e.message : e));
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
