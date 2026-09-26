// netlify/functions/_lib/rx-evidence.js
//
// TIER 1 MEDICATION EVIDENCE. The single place medication facts are retrieved. Nothing else in
// the codebase talks to RxNorm or DailyMed, and no prompt carries medication data of its own.
//
// WHY THIS EXISTS: Discern was answering "what is the maximum dose of X" out of model weights.
// It said 30 mg/day was the labeled adult maximum for Adderall XR. The real label says 20 mg/day
// is the recommended ADULT dose, 30 mg/day is the maximum for ages 6-12, and the adult trials ran
// 20/40/60 mg/day. Four adjacent numbers, collapsed into one confident wrong sentence. No wording
// of a prompt fixes that; only handing it the actual label does.
//
// WHAT IT STORES: verbatim labeled sections. NOT model-derived "claims" -- deciding which number
// is "the maximum" is the very error being prevented, and doing it at ingest just moves the error
// somewhere harder to see. The reasoning model reads the source text.
//
// NO PHI EVER REACHES THIS FILE. Its whole input is a drug name. The patient case stays on the
// BAA-covered path; only normalised drug identities cross over.
//
// Documented contracts used:
//   RxNorm  findRxcuiByString  /REST/rxcui.json?name=&search=
//   DailyMed v2  /services/v2/spls.json?rxcui=
//   DailyMed v2  /services/v2/spls/{SETID}.xml

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const DAILYMED = 'https://dailymed.nlm.nih.gov/dailymed/services/v2';

// HL7 SPL section codes. These are the stable identifiers for label sections; matching on
// section TITLE text instead would break the moment a labeler words a heading differently.
const SECTIONS = {
  '34067-9': 'indications_and_usage',
  '34068-7': 'dosage_and_administration',
  '34070-3': 'contraindications',
  '34071-1': 'warnings_and_precautions',
  '34066-1': 'boxed_warning',
  '34073-7': 'drug_interactions',
  '43684-0': 'use_in_specific_populations',
  '34092-8': 'clinical_studies',
  '43685-7': 'warnings_and_cautions'
};

// What a question needs. Dosing pulls clinical_studies alongside dosage_and_administration on
// purpose: "doses studied in adult trials" lives there, and without it the model has a
// recommended dose, a pediatric maximum, and no way to see where 60 mg/day actually comes from.
const CLASS_SECTIONS = {
  dosing:          ['dosage_and_administration', 'clinical_studies', 'use_in_specific_populations'],
  interaction:     ['drug_interactions', 'warnings_and_precautions', 'boxed_warning'],
  contraindication:['contraindications', 'boxed_warning'],
  warnings:        ['warnings_and_precautions', 'boxed_warning'],
  populations:     ['use_in_specific_populations'],
  indication:      ['indications_and_usage']
};

function sb(path, opts) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return Promise.reject(new Error('supabase not configured'));
  return fetch(url + '/rest/v1/' + path, Object.assign({}, opts, {
    headers: Object.assign({
      apikey: key, Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json'
    }, (opts && opts.headers) || {})
  }));
}

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return r.json();
}

// ── 1. name -> RXCUI ────────────────────────────────────────────────────────────────────────
// search=0 exact, 1 normalized, 2 exact-then-normalized. Approximate is a separate endpoint and
// is deliberately a LAST resort: an approximate match silently answering about a different drug
// is worse than failing, so when it is used it is recorded and reported.
async function resolveRxcui(name) {
  const exact = await getJson(RXNAV + '/rxcui.json?name=' + encodeURIComponent(name) + '&search=2');
  const ids = (exact && exact.idGroup && exact.idGroup.rxnormId) || [];
  if (ids.length) return { rxcui: ids[0], resolved_by: 'exact_or_normalized', name: name };

  const approx = await getJson(RXNAV + '/approximateTerm.json?term=' + encodeURIComponent(name) + '&maxEntries=1');
  const cand = (approx && approx.approximateGroup && approx.approximateGroup.candidate) || [];
  if (cand.length && cand[0].rxcui) {
    return { rxcui: cand[0].rxcui, resolved_by: 'approximate', name: name, approx_score: cand[0].score };
  }
  return null;
}

// ── 2. RXCUI -> the RIGHT SPL ───────────────────────────────────────────────────────────────
// An RXCUI maps to many SPLs: every manufacturer of a generic has its own label. Taking the
// first is how "Adderall XR" quietly becomes some other amphetamine product. The ranking is
// explicit and the reason is stored on the row, so a wrong pick is visible rather than silent.
function chooseSpl(list, queryName) {
  if (!list || !list.length) return null;
  const q = String(queryName || '').toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 2);
  const scored = list.map(s => {
    const title = String(s.title || '').toLowerCase();
    let score = 0, why = [];
    // Every word of what was asked for appears in the title: the strongest signal that this is
    // the same product, and what separates "Adderall XR" from immediate-release mixed salts.
    if (words.length && words.every(w => title.indexOf(w) !== -1)) { score += 100; why.push('title matches full query'); }
    else if (words.some(w => title.indexOf(w) !== -1)) { score += 20; why.push('title matches part of query'); }
    // Extended-release asked for must not resolve to an immediate-release label, or vice versa.
    const wantER = /\b(xr|er|extended[- ]release|sr|la|cd)\b/.test(q);
    const isER = /extended[- ]release|\bxr\b|\ber\b/.test(title);
    if (wantER === isER) { score += 25; why.push(wantER ? 'both extended-release' : 'neither extended-release'); }
    else { score -= 60; why.push('RELEASE FORM MISMATCH'); }
    const d = String(s.published_date || '');
    if (d) score += Math.min(10, Math.max(0, (parseInt(d.slice(0, 4), 10) || 2000) - 2015));
    return { spl: s, score: score, why: why.join('; ') };
  }).sort((a, b) => b.score - a.score);
  const top = scored[0];
  return {
    spl: top.spl,
    candidate_count: list.length,
    chosen_reason: top.why + ' (score ' + top.score + ' of ' + list.length + ' candidates)'
  };
}

// ── 3. SPL XML -> sections ──────────────────────────────────────────────────────────────────
// Deliberately a narrow tag walk rather than a full XML parse: the only thing wanted is the text
// under each LOINC-coded <section>. Nested subsections are kept with their parent, which is what
// makes "2.1 Adults" and "2.2 Pediatric Patients" arrive together and stay distinguishable.
function stripTags(xml) {
  return String(xml)
    .replace(/<\/(paragraph|item|title|td|tr|caption)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, ' ')
    // Trim each line WITHOUT touching the newlines. /^\s+|\s+$/gm looks equivalent and is not:
    // \s matches \n, so it swallows the line breaks and welds a heading onto its body --
    // "2.2 Pediatric Patients 6 to 12 YearsThe recommended starting dose is 10 mg".
    // Those headings are the only thing separating the adult dose from the pediatric one.
    .replace(/[ \t]+$/gm, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractSections(xml) {
  const out = [];
  const src = String(xml || '');
  // Find each <code code="LOINC" .../> and take the <section> element containing it.
  const codeRe = /<code[^>]*\bcode="(\d{4,5}-\d)"[^>]*>/gi;
  let m;
  while ((m = codeRe.exec(src)) !== null) {
    const name = SECTIONS[m[1]];
    if (!name) continue;
    const secStart = src.lastIndexOf('<section', m.index);
    if (secStart === -1) continue;
    // Walk to the matching </section>, counting nesting so subsections stay inside.
    let depth = 0, i = secStart, end = -1;
    const tagRe = /<(\/?)section\b/gi;
    tagRe.lastIndex = secStart;
    let t;
    while ((t = tagRe.exec(src)) !== null) {
      if (t[1] === '/') {
        depth--;
        if (depth === 0) {
          // t[0] is "</section" -- the regex stops at the word boundary, so the '>' is not in the
          // match. Ending here left a dangling "</section" that <[^>]+> could never strip, and it
          // rode into the evidence text.
          const gt = src.indexOf('>', t.index);
          end = (gt === -1) ? t.index : gt + 1;
          break;
        }
      }
      else depth++;
      if (tagRe.lastIndex > src.length) break;
    }
    if (end === -1) continue;
    const text = stripTags(src.slice(secStart, end));
    if (text && text.length > 40) {
      out.push({ loinc_code: m[1], section_name: name, text: text, ord: out.length });
    }
  }
  // One label can carry the same code more than once; keep the longest, which is the real
  // section rather than a cross-reference to it.
  const best = {};
  out.forEach(s => {
    if (!best[s.section_name] || s.text.length > best[s.section_name].text.length) best[s.section_name] = s;
  });
  return Object.keys(best).map((k, i) => Object.assign({}, best[k], { ord: i }));
}

// ── 4. fetch + cache one drug ───────────────────────────────────────────────────────────────
const CACHE_DAYS = 30;

async function ingestDrug(queryName) {
  const res = await resolveRxcui(queryName);
  if (!res) return { ok: false, query: queryName, error: 'no RxNorm concept for "' + queryName + '"' };

  const spls = await getJson(DAILYMED + '/spls.json?rxcui=' + encodeURIComponent(res.rxcui) + '&pagesize=50');
  const list = (spls && spls.data) || [];
  const pick = chooseSpl(list, queryName);
  if (!pick) return { ok: false, query: queryName, rxcui: res.rxcui, error: 'no SPL for RXCUI ' + res.rxcui };

  const setid = pick.spl.setid || pick.spl.set_id;
  const xml = await (await fetch(DAILYMED + '/spls/' + encodeURIComponent(setid) + '.xml')).text();
  const sections = extractSections(xml);

  await sb('tbp_rx_drug', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      rxcui: res.rxcui, query_name: queryName, rx_name: res.name,
      tty: pick.spl.title ? null : null, resolved_by: res.resolved_by, updated_at: new Date().toISOString()
    })
  });
  await sb('tbp_drug_label', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      setid: setid, rxcui: res.rxcui, title: pick.spl.title,
      spl_version: pick.spl.spl_version ? parseInt(pick.spl.spl_version, 10) : null,
      published_date: pick.spl.published_date || null,
      source_url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=' + setid,
      candidate_count: pick.candidate_count, chosen_reason: pick.chosen_reason,
      fetched_at: new Date().toISOString()
    })
  });
  await sb('tbp_drug_label_section?setid=eq.' + encodeURIComponent(setid), { method: 'DELETE' });
  if (sections.length) {
    await sb('tbp_drug_label_section', {
      method: 'POST',
      body: JSON.stringify(sections.map(s => Object.assign({ setid: setid }, s)))
    });
  }
  return {
    ok: true, query: queryName, rxcui: res.rxcui, setid: setid,
    resolved_by: res.resolved_by, candidate_count: pick.candidate_count,
    chosen_reason: pick.chosen_reason, sections: sections.map(s => s.section_name)
  };
}

// ── 5. THE INTERFACE. The only function Discern's path calls. ───────────────────────────────
async function getEvidence(drugNames, classes) {
  const want = {};
  (classes && classes.length ? classes : ['dosing']).forEach(c => {
    (CLASS_SECTIONS[c] || []).forEach(s => { want[s] = true; });
  });
  const wanted = Object.keys(want);
  const out = [];

  for (const name of (drugNames || []).slice(0, 6)) {
    let row = null;
    try {
      const r = await sb('tbp_drug_label?select=*,tbp_rx_drug!inner(query_name)&tbp_rx_drug.query_name=eq.'
        + encodeURIComponent(name) + '&order=fetched_at.desc&limit=1');
      const j = await r.json();
      row = (j && j[0]) || null;
    } catch (e) { /* fall through to a fetch */ }

    const stale = !row || (Date.now() - new Date(row.fetched_at).getTime()) > CACHE_DAYS * 864e5;
    if (stale) {
      const ing = await ingestDrug(name);
      if (!ing.ok) { out.push({ drug: name, error: ing.error }); continue; }
      const r2 = await sb('tbp_drug_label?setid=eq.' + encodeURIComponent(ing.setid) + '&select=*');
      row = (await r2.json())[0];
    }
    if (!row) { out.push({ drug: name, error: 'no label' }); continue; }

    const sr = await sb('tbp_drug_label_section?setid=eq.' + encodeURIComponent(row.setid)
      + '&section_name=in.(' + wanted.join(',') + ')&select=section_name,text,loinc_code&order=ord');
    const secs = await sr.json();
    out.push({
      drug: name,
      sections: (secs || []).map(s => ({ section: s.section_name, loinc: s.loinc_code, text: s.text })),
      source: {
        label_title: row.title,
        setid: row.setid,
        spl_version: row.spl_version,
        effective_date: row.published_date,
        url: row.source_url,
        of_candidates: row.candidate_count,
        chosen_because: row.chosen_reason
      }
    });
  }
  return out;
}

module.exports = { getEvidence, ingestDrug, extractSections, chooseSpl, resolveRxcui, SECTIONS, CLASS_SECTIONS };
