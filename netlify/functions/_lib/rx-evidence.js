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

// The section that ANSWERS a class, as opposed to the ones that enrich the answer. Absence of a
// supplementary section is information, not a retrieval failure: most labels have no boxed
// warning, and reporting "this label has no boxed_warning section" as a gap on every question
// trains the reader to ignore the gap list, which is where the real failures are reported.
const CLASS_PRIMARY = {
  dosing:           'dosage_and_administration',
  interaction:      'drug_interactions',
  contraindication: 'contraindications',
  warnings:         'warnings_and_precautions',
  populations:      'use_in_specific_populations',
  indication:       'indications_and_usage'
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
// A full-query title match is the bar. Anything less is reported as ambiguous rather than
// resolved, because the pipeline continuing is not evidence that it continued correctly.
const MIN_CONFIDENT = 100;

// DailyMed v2 titles come back as "<PRODUCT NAME> <DOSAGE FORM> [<LABELER>]", for example
// "FLUOXETINE CAPSULE [REMEDYREPACK INC.]" or
// "OLANZAPINE AND FLUOXETINE (OLANZAPINE AND FUOXETINE) CAPSULE [PAR HEALTH USA, LLC]".
// An earlier version split on "-" and treated everything before it as the product, which is the
// format DailyMed uses elsewhere but NOT here: the whole title survived, so forty-six repackager
// labels for one generic all looked like materially different products and the lookup refused.
const DOSE_FORMS = /\b(capsules?|tablets?|film coated|sugar coated|enteric coated|coated|delayed release|extended release|immediate release|release|oral solution|solution|suspension|syrup|elixir|injections?|injectable|powder|granules?|kit|patch|films?|spray|aerosol|inhalation|cream|ointment|gel|lotion|suppository|chewable|disintegrating|for oral use|for suspension|concentrate|pellets?|sprinkle|orally|oral|metered|usp)\b/gi;

// The salt is not the drug. DailyMed titles one generic six ways -- "FLUOXETINE",
// "FLUOXETINE HYDROCHLORIDE", "FLUOXETINE HYDROCHLORIDE ... COATED" -- and without this every
// spelling reads as a different product, which is what made nine repackager labels for one
// generic look like nine materially different drugs and refuse the lookup.
// A brand with its own identity is unaffected: those titles use the "APLENZIN- bupropion
// hydrobromide ..." shape, where the name before the dash is taken whole.
const SALTS = /\b(hydrochlorides?|hcl|hydrobromides?|hbr|sulfates?|sulphates?|succinates?|tartrates?|bitartrates?|maleates?|besylates?|mesylates?|fumarates?|citrates?|acetates?|phosphates?|bromides?|carbonates?|oxalates?|lactates?|decanoates?|palmitates?|pamoates?|valerates?|propionates?|furoates?|xinafoates?|dipropionates?|aspartates?|saccharates?|sodium|potassium|calcium|magnesium|dihydrate|monohydrate|anhydrous)\b/gi;

function splYear(published) {
  if (!published) return 0;
  const str = String(published).trim();
  const compact = str.match(/^((?:19|20)\d{2})(\d{2})(\d{2})$/);   // 20240712
  if (compact) return parseInt(compact[1], 10);
  const iso = str.match(/\b(19|20)\d{2}\b/);                      // 2024-07-12, May 6, 2026
  if (iso) return parseInt(iso[0], 10);
  const t = Date.parse(str);
  return isNaN(t) ? 0 : new Date(t).getUTCFullYear();
}

function splProductName(title) {
  const raw = String(title || '');
  // DailyMed returns BOTH shapes. The older one puts the marketed name before a dash and the
  // ingredient list after it ("ADDERALL XR- dextroamphetamine saccharate, ... capsule"); the
  // newer one appends the dosage form and a bracketed labeler instead. Handling only one of
  // them is how this broke: fixing the bracket format silently un-fixed the dash format.
  const dashed = raw.match(/^([^-\[]{2,}?)-\s/);
  if (dashed) return dashed[1].replace(/\s+/g, ' ').trim().toLowerCase();
  const stripped = raw
    .replace(/\[[^\]]*\]/g, ' ')     // the labeler, which is not part of the product's identity
    .replace(/\([^)]*\)/g, ' ')      // the ingredient restatement DailyMed puts in parentheses
    .replace(DOSE_FORMS, ' ')        // dosage form: a capsule and a tablet of one drug share a label's content
    .replace(/[,\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  // Never reduce a name to nothing: "calcium carbonate" is a drug whose every word is a salt.
  const desalted = stripped.replace(SALTS, ' ').replace(/\s+/g, ' ').trim();
  return desalted || stripped;
}
// Kept under the old name so nothing that imported it breaks.
function splBaseName(title) { return splProductName(title); }

// "OLANZAPINE AND FLUOXETINE" matched a query for "fluoxetine" with a full-title score, because
// every word asked for really does appear in it. It is a different drug (Symbyax), and putting
// its label in front of a model asked about fluoxetine is precisely the identity collapse this
// whole layer exists to prevent.
function isCombinationOf(productName, queryWords) {
  const parts = String(productName).split(/\s+and\s+|\s*\+\s*|\s*\/\s*/).map(x => x.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  // A combination is "extra" only when a component is nothing the caller asked about.
  return parts.some(part => !queryWords.some(w => part.indexOf(w) !== -1));
}

function chooseSpl(list, queryName, granularity) {
  if (!list || !list.length) return null;
  const q = String(queryName || '').toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 2);
  const wantER = /\b(xr|er|extended[- ]release|sr|la|cd|xl)\b/.test(q);
  const scored = list.map(s => {
    const title = String(s.title || '').toLowerCase();
    let score = 0, why = [], full = false, mismatch = false;
    // Every word of what was asked for appears in the title: the strongest signal that this is
    // the same product, and what separates "Adderall XR" from immediate-release mixed salts.
    if (words.length && words.every(w => title.indexOf(w) !== -1)) { score += 100; full = true; why.push('title matches full query'); }
    else if (words.some(w => title.indexOf(w) !== -1)) { score += 20; why.push('title matches part of query'); }
    // Extended-release asked for must not resolve to an immediate-release label, or vice versa.
    const isER = /extended[- ]release|\bxr\b|\ber\b|\bxl\b/.test(title);
    if (wantER === isER) { score += 25; why.push(wantER ? 'both extended-release' : 'neither extended-release'); }
    else { score -= 60; mismatch = true; why.push('RELEASE FORM MISMATCH'); }
    // An extra active ingredient makes this a different product, whatever the title match says.
    const product = splProductName(s.title);
    const extra = isCombinationOf(product, words);
    if (extra) { score -= 150; why.push('DIFFERENT PRODUCT (contains an ingredient not asked for)'); }
    // DailyMed sends "May 6, 2026", not "20260506". parseInt on the first four characters gave
    // NaN, so the recency bonus never fired once: the 2026 Takeda label scored the same 125 as
    // every repackager, leaving nothing to break a tie with.
    const year = splYear(s.published_date);
    if (year) score += Math.min(10, Math.max(0, year - 2015));
    return { spl: s, score: score, why: why.join('; '), full: full, isER: isER,
             mismatch: mismatch, product: product, extra: extra };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];

  // AMBIGUITY IS AN OUTCOME, NOT A DEGRADED SUCCESS. Picking the best of several plausible
  // labels is how "Adderall XR" quietly becomes some other amphetamine product and a pediatric
  // maximum becomes an adult one. Where the identity is not clear, say so and retrieve nothing.
  let ambiguous = null;
  if (top.mismatch) {
    ambiguous = 'the closest label is a different release form from the confirmed product';
  } else if (top.score < MIN_CONFIDENT) {
    ambiguous = 'no label title matched the confirmed product closely enough'
      + ' (best was "' + (top.spl.title || '').slice(0, 70) + '")';
  } else {
    // A near-tie only matters when the candidates are materially different products. Six
    // manufacturers of the same generic are not an ambiguity worth refusing over; an
    // immediate-release and an extended-release label at the same score are.
    const near = scored.slice(1).filter(s => (top.score - s.score) <= 10);
    let different = near.filter(s => s.isER !== top.isER || s.product !== top.product);
    // AT INGREDIENT GRANULARITY, a release-form difference between equivalent generics is not a
    // reason to refuse: whether fluoxetine inhibits CYP2D6 is the same fact in every label. Only
    // a genuinely different PRODUCT (a combination, another drug) still counts.
    if (granularity === 'ingredient') different = different.filter(s => s.product !== top.product);
    if (different.length) {
      ambiguous = different.length + ' materially different label(s) scored as well as the best match: '
        + different.slice(0, 3).map(s => s.product).join('; ');
    }
  }

  return {
    spl: top.spl,
    // The whole ranked list, so a candidate that turns out to be an empty shell can be skipped
    // for the next one instead of the lookup reporting success with no content.
    ranked: scored,
    candidate_count: list.length,
    ambiguous: ambiguous,
    // Kept for the debug trail: "wrong label chosen" and "right label, wrong section" are
    // different failures and a clinician reviewing a bad answer needs to tell them apart.
    candidates: scored.slice(0, 5).map(s => ({ title: s.spl.title, setid: s.spl.setid || s.spl.set_id,
                                               score: s.score, why: s.why })),
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
  // TITLE FALLBACK. A section whose LOINC we never saw is invisible, and on the first real run
  // the Adderall XR label came back without clinical_studies -- the section that holds "20, 40
  // and 60 mg/day studied in adults", which is the single most useful number for a dose
  // question. Matching on a heading is fragile, which is why it is a FALLBACK: it runs only for
  // a section no coded match produced. Better a section found by its title than a clinician
  // told the label is silent.
  const found = {};
  out.forEach(s => { found[s.section_name] = true; });
  const TITLE_FALLBACK = [
    [/^\s*\d*\s*CLINICAL STUDIES/im, 'clinical_studies', '34092-8'],
    [/^\s*\d*\s*DOSAGE AND ADMINISTRATION/im, 'dosage_and_administration', '34068-7'],
    [/^\s*\d*\s*DRUG INTERACTIONS/im, 'drug_interactions', '34073-7'],
    [/^\s*\d*\s*CONTRAINDICATIONS/im, 'contraindications', '34070-3'],
    [/^\s*\d*\s*WARNINGS AND PRECAUTIONS/im, 'warnings_and_precautions', '34071-1'],
    [/^\s*\d*\s*USE IN SPECIFIC POPULATIONS/im, 'use_in_specific_populations', '43684-0']
  ];
  const titleRe = /<title[^>]*>([\s\S]{0,200}?)<\/title>/gi;
  let tm;
  while ((tm = titleRe.exec(src)) !== null) {
    const heading = stripTags(tm[1]);
    TITLE_FALLBACK.forEach(([re, name, loinc]) => {
      if (found[name] || !re.test(heading)) return;
      const secStart = src.lastIndexOf('<section', tm.index);
      if (secStart === -1) return;
      let depth = 0, end = -1, t2;
      const tr = /<(\/?)section\b/gi;
      tr.lastIndex = secStart;
      while ((t2 = tr.exec(src)) !== null) {
        if (t2[1] === '/') { depth--; if (depth === 0) { const gt = src.indexOf('>', t2.index); end = (gt === -1) ? t2.index : gt + 1; break; } }
        else depth++;
      }
      if (end === -1) return;
      const text = stripTags(src.slice(secStart, end));
      if (text && text.length > 40) {
        found[name] = true;
        out.push({ loinc_code: loinc, section_name: name, text: text, ord: out.length, by: 'title' });
      }
    });
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

async function ingestDrug(queryName, wantedSections, granularity) {
  const res = await resolveRxcui(queryName);
  if (!res) return { ok: false, kind: 'identity_unresolved', query: queryName,
                     error: 'no RxNorm concept matches "' + queryName + '"' };

  // TWO WAYS IN, because the RXCUI route alone silently fails for brand concepts. RxNorm
  // resolves "Adderall XR" to a brand-name concept; DailyMed indexes SPLs by the product-level
  // RXCUIs in the label's data elements, so a BN rxcui can legitimately match nothing and the
  // whole lookup reports "no SPL on file" for a drug whose label plainly exists. Observed on
  // the first real run: RXCUI 352398 for Adderall XR returned nothing.
  const tried = [];
  let list = [];
  const byName = await getJson(DAILYMED + '/spls.json?drug_name=' + encodeURIComponent(queryName) + '&pagesize=50');
  const nameHits = (byName && byName.data) || [];
  tried.push({ by: 'drug_name', found: nameHits.length });
  list = list.concat(nameHits);

  const byRx = await getJson(DAILYMED + '/spls.json?rxcui=' + encodeURIComponent(res.rxcui) + '&pagesize=50');
  const rxHits = (byRx && byRx.data) || [];
  tried.push({ by: 'rxcui', found: rxHits.length });
  const seen = {};
  list.forEach(x => { seen[x.setid || x.set_id] = true; });
  rxHits.forEach(x => { const k = x.setid || x.set_id; if (!seen[k]) { seen[k] = true; list.push(x); } });

  const pick = list.length ? chooseSpl(list, queryName, granularity) : null;
  if (!pick) return { ok: false, kind: 'label_not_found', query: queryName, rxcui: res.rxcui,
                      lookups: tried,
                      error: 'no SPL found by drug name or by RXCUI ' + res.rxcui };
  // Nothing is written and nothing is retrieved when the product is not clear. A stored guess
  // would be cached for 30 days and would look exactly like a confident resolution.
  if (pick.ambiguous) {
    return { ok: false, kind: 'identity_ambiguous', query: queryName, rxcui: res.rxcui,
             resolved_by: res.resolved_by, candidates: pick.candidates, lookups: tried,
             candidate_count: pick.candidate_count, error: pick.ambiguous };
  }

  // A LABEL THAT YIELDS NOTHING IS NOT A RESOLVED LABEL. The first run picked a repackager SPL
  // for fluoxetine, extracted zero sections, and still reported success: the trail said
  // "resolved ... sections: none" and the clinician got no fluoxetine evidence at all. Ranking
  // by title and date says which label is most likely right; it says nothing about whether that
  // document actually carries readable content. So try the ranked candidates in order and keep
  // the first that produces what was asked for.
  const attempts = [];
  let setid = null, sections = [], xml = '', unmapped = {}, chosen = null;
  const ranked = pick.ranked || [{ spl: pick.spl }];
  for (let i = 0; i < Math.min(5, ranked.length); i++) {
    const cand = ranked[i].spl;
    const id = cand.setid || cand.set_id;
    if (!id) continue;
    let secs = [];
    try {
      xml = await (await fetch(DAILYMED + '/spls/' + encodeURIComponent(id) + '.xml')).text();
      secs = extractSections(xml);
    } catch (e) {
      attempts.push({ setid: id, title: cand.title, sections: 0, error: String(e && e.message || e) });
      continue;
    }
    const names = secs.map(x => x.section_name);
    const hasWanted = !wantedSections || !wantedSections.length
      || names.some(n => wantedSections.indexOf(n) !== -1);
    attempts.push({ setid: id, title: cand.title, sections: names.length, hasWanted: hasWanted });
    if (secs.length && hasWanted) {
      setid = id; sections = secs; chosen = cand;
      let cm2; const allCodes = /<code[^>]*\bcode="(\d{4,5}-\d)"[^>]*>/gi;
      while ((cm2 = allCodes.exec(xml)) !== null) if (!SECTIONS[cm2[1]]) unmapped[cm2[1]] = true;
      break;
    }
  }
  if (!setid) {
    return { ok: false, kind: 'no_readable_sections', query: queryName, rxcui: res.rxcui,
             lookups: tried, attempts: attempts, candidate_count: pick.candidate_count,
             error: 'found ' + pick.candidate_count + ' label(s) but none carried a readable '
                  + ((wantedSections && wantedSections.length) ? 'requested ' : '') + 'section' };
  }

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
      spl_version: chosen.spl_version ? parseInt(chosen.spl_version, 10) : null,
      published_date: chosen.published_date || null,
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
    chosen_reason: pick.chosen_reason + (attempts.length > 1
      ? ' [skipped ' + (attempts.length - 1) + ' candidate(s) with no readable section]' : ''),
    lookups: tried, attempts: attempts,
    unmapped_codes: Object.keys(unmapped).slice(0, 12),
    sections: sections.map(s => s.section_name)
  };
}

// ── 5. THE INTERFACE. The only function Discern's path calls. ───────────────────────────────
async function getEvidence(drugNames, classes, opts) {
  const want = {};
  (classes && classes.length ? classes : ['dosing']).forEach(c => {
    (CLASS_SECTIONS[c] || []).forEach(s => { want[s] = true; });
  });
  const wanted = Object.keys(want);
  // What a missing section actually means depends on whether it was the section being asked for.
  const primary = (classes && classes.length ? classes : ['dosing'])
    .map(c => CLASS_PRIMARY[c]).filter(Boolean);
  // Per-drug identity granularity, decided by the caller from the claim being made.
  const granByDrug = (opts && opts.granularity) || {};
  const out = [];

  for (const name of (drugNames || []).slice(0, 6)) {
    let row = null, ingested = null;   // `ingested` also marks that we already went to DailyMed
    try {
      const r = await sb('tbp_drug_label?select=*,tbp_rx_drug!inner(query_name)&tbp_rx_drug.query_name=eq.'
        + encodeURIComponent(name) + '&order=fetched_at.desc&limit=1');
      const j = await r.json();
      row = (j && j[0]) || null;
    } catch (e) { /* fall through to a fetch */ }

    const stale = !row || (Date.now() - new Date(row.fetched_at).getTime()) > CACHE_DAYS * 864e5;
    if (stale) {
      let ing;
      try { ing = await ingestDrug(name, wanted, granByDrug[name] || 'product'); }
      catch (e) { out.push({ requested: name, drug: name, resolution_status: 'failed',
                             failure_kind: 'service_error', error: String(e && e.message || e) }); continue; }
      if (!ing.ok) {
        // Every failure mode stays distinguishable. An answer that is wrong because the drug
        // never resolved needs a different fix from one that is wrong because two labels were
        // equally plausible, and both differ from correct evidence reasoned over badly.
        out.push({ requested: name, drug: name,
                   resolution_status: ing.kind === 'identity_ambiguous' ? 'ambiguous' : 'failed',
                   failure_kind: ing.kind || 'unknown', rxcui: ing.rxcui || null,
                   resolved_by: ing.resolved_by || null, candidates: ing.candidates || null,
                   lookups: ing.lookups || null, attempts: ing.attempts || null,
                   error: ing.error });
        continue;
      }
      ingested = ing;
      const r2 = await sb('tbp_drug_label?setid=eq.' + encodeURIComponent(ing.setid) + '&select=*');
      row = (await r2.json())[0];
    }
    if (!row) { out.push({ requested: name, drug: name, resolution_status: 'failed',
                           failure_kind: 'label_not_found', error: 'no label on file' }); continue; }

    async function readSections(setid) {
      const r = await sb('tbp_drug_label_section?setid=eq.' + encodeURIComponent(setid)
        + '&section_name=in.(' + wanted.join(',') + ')&select=section_name,text,loinc_code&order=ord');
      return (await r.json()) || [];
    }
    let secs = await readSections(row.setid);

    // A CACHE THAT CANNOT ANSWER IS NOT A CACHE HIT. An earlier run stored a repackager label
    // that extracted no sections. The row was fresh, so `stale` was false, so the candidate
    // retry added later never ran and the same empty shell was served on every subsequent
    // question. Freshness is not usefulness: if the stored label has nothing that was asked
    // for, go back to DailyMed once and take the next candidate that does.
    if (!secs.length && !ingested) {
      let ing2;
      try { ing2 = await ingestDrug(name, wanted, granByDrug[name] || 'product'); }
      catch (e) { ing2 = { ok: false, kind: 'service_error', error: String(e && e.message || e) }; }
      if (ing2 && ing2.ok) {
        ingested = ing2;
        const r3 = await sb('tbp_drug_label?setid=eq.' + encodeURIComponent(ing2.setid) + '&select=*');
        const fresh = (await r3.json())[0];
        if (fresh) { row = fresh; secs = await readSections(fresh.setid); }
      } else {
        out.push({ requested: name, drug: name,
                   resolution_status: ing2 && ing2.kind === 'identity_ambiguous' ? 'ambiguous' : 'failed',
                   failure_kind: (ing2 && ing2.kind) || 'no_readable_sections',
                   lookups: (ing2 && ing2.lookups) || null, attempts: (ing2 && ing2.attempts) || null,
                   error: (ing2 && ing2.error) || 'the stored label carries no requested section' });
        continue;
      }
    }
    out.push({
      requested: name,
      drug: name,
      resolution_status: 'resolved',
      granularity: granByDrug[name] || 'product',
      rxcui: row.rxcui || null,
      sections: (secs || []).map(s => ({ section: s.section_name, loinc: s.loinc_code, text: s.text })),
      unmapped_codes: (ingested && ingested.unmapped_codes) || null,
      attempts: (ingested && ingested.attempts) || null,
      lookups: (ingested && ingested.lookups) || null,
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
  return { evidence: out, wanted_sections: wanted, primary_sections: primary };
}

module.exports = { getEvidence, ingestDrug, extractSections, chooseSpl, splBaseName,
                   splProductName, isCombinationOf, splYear,
                   resolveRxcui, SECTIONS, CLASS_SECTIONS, CLASS_PRIMARY, MIN_CONFIDENT };
