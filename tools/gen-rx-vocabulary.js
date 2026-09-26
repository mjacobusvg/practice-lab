#!/usr/bin/env node
// Generates rx-vocabulary.js from the MEDICATIONS dictionary in pm-interaction-checker.html.
//
// Why this exists: the Scribe needs to notice that a note mentions a drug and know which
// interaction-engine key it maps to. It does NOT need the CYP tables, QT risk or the other ~30
// pharmacology fields per entry, and shipping 210 of those into the Scribe would be absurd. The
// interaction checker keeps owning the pharmacology; this is only the vocabulary.
//
// CRITICAL, and the reason the whole medication detour happened: what this produces is a
// CANDIDATE-DETECTION vocabulary and an interaction-engine key. It is NOT medication identity.
// The dictionary deliberately works at the ingredient level, because CYP and serotonergic
// relationships do. So `methylphenidate` carries brand "Ritalin/Concerta" in one string, and
// `amphetamine_mixed_salts` carries "Adderall" with no IR/XR distinction. Those are different
// products with different labels, different formulations and different maximum doses. Resolving
// "Adderall XR 20 mg" to generic "Adderall" is exactly the collapse that produced a hallucinated
// 30 mg maximum. Detection may say "this text probably mentions amphetamine mixed salts". It may
// never decide what product the patient is on.
//
// There is no build step in this repo, so the output is committed and
// tests/rx-vocabulary.test.js re-runs this generator and fails on drift.
//
//   node tools/gen-rx-vocabulary.js

const fs = require('fs');
const path = require('path');

const SRC = 'pm-interaction-checker.html';
const OUT = 'rx-vocabulary.js';

// Brand strings that name no product. The dictionary uses these as placeholders.
const NOT_A_BRAND = /^(n\/a|various|various ocs|generic|otc supplement|food\/beverage|unknown)$/i;
// Parenthetical noise: "(OTC)", "(IV/IM/intranasal compounded)", "(gel/injection/patch)".
// Stripped BEFORE splitting on "/", or "IV/IM" becomes two brand names.
const STRIP_PARENS = /\([^)]*\)/g;

// Written the way clinicians write them, where the dictionary key is not that. Small and curated
// on purpose: a generated alias list would produce false matches like "thyroid" or "salts".
const ALIASES = {
  amphetamine_mixed_salts: ['amphetamine', 'mixed amphetamine salts', 'amphetamine salts',
                            'dextroamphetamine-amphetamine', 'dextroamphetamine/amphetamine'],
  thyroid_levothyroxine: ['levothyroxine'],
  ethinyl_estradiol_oral_contraceptive: ['ethinyl estradiol', 'oral contraceptive'],
  st_johns_wort: ["st john's wort", 'st johns wort', "st. john's wort"],
  cannabis_thc: ['cannabis', 'marijuana', 'thc'],
  tobacco_smoking: ['tobacco', 'nicotine', 'smoking'],
  alcohol_ethanol: ['alcohol', 'ethanol'],
  grapefruit_juice: ['grapefruit'],
  doxepin_low_dose: ['doxepin'],
  selegiline_transdermal: ['selegiline'],
  dextromethorphan_bupropion: ['dextromethorphan-bupropion'],
  lidocaine_topical: ['lidocaine'],
  fluticasone_nasal: ['fluticasone'],
  methylene_blue: [],
  insulin_glargine: [], insulin_lispro: [],
  fluticasone_salmeterol: [], budesonide_formoterol: [],
  amoxicillin_clavulanate: [], trimethoprim_sulfamethoxazole: []
};

// Not medications. They belong in the interaction engine (1A2 induction, CNS depression, CYP3A4
// inhibition) but must never be proposed as a line on a medication list.
const SUBSTANCE = new Set(['tobacco_smoking', 'caffeine', 'alcohol_ethanol', 'grapefruit_juice',
                           'cannabis_thc', 'st_johns_wort', 'kratom']);

function parseDictionary(html) {
  const start = html.indexOf('var MEDICATIONS = {');
  if (start < 0) throw new Error('MEDICATIONS dictionary not found in ' + SRC);
  const body = html.slice(start);
  const re = /\n"([a-z0-9_]+)":\s*\{/g;
  const entries = [];
  let m;
  while ((m = re.exec(body))) {
    const chunk = body.slice(m.index, m.index + 1500);
    const brand = chunk.match(/\bbrand:\s*"([^"]*)"/);
    const cls = chunk.match(/\bclass:\s*"([^"]*)"/);
    if (!brand) continue;                       // not a drug record
    entries.push({ key: m[1], brand: brand[1], cls: cls ? cls[1] : '' });
  }
  return entries;
}

function brandsOf(raw) {
  return raw.replace(STRIP_PARENS, ' ')
    .split(/[\/,]/)
    .map((b) => b.trim())
    .filter((b) => b && !NOT_A_BRAND.test(b) && /[a-z]/i.test(b) && b.length > 2);
}

function genericOf(key) {
  // The key is the generic name for single-word keys. Multi-word keys are handled by ALIASES,
  // because "amphetamine mixed salts" is not a phrase anyone types.
  return key.indexOf('_') === -1 ? [key] : [];
}

const html = fs.readFileSync(path.resolve(SRC), 'utf8');
const dict = parseDictionary(html);

const entries = dict.map(({ key, brand, cls }) => {
  const generics = genericOf(key).concat(ALIASES[key] || []);
  const brands = brandsOf(brand);
  const e = { key, generics, brands, cls };
  if (SUBSTANCE.has(key)) e.substance = true;
  return e;
});

const unaliased = entries.filter((e) => !e.generics.length && !e.brands.length);
if (unaliased.length) throw new Error('no searchable term for: ' + unaliased.map((e) => e.key).join(', '));

const banner = `// GENERATED FILE - do not edit by hand.
//   node tools/gen-rx-vocabulary.js
// Source: ${SRC}, var MEDICATIONS (${entries.length} entries).
//
// A CANDIDATE-DETECTION vocabulary and interaction-engine key map. NOT medication identity.
// The dictionary works at the ingredient level because CYP and serotonergic relationships do,
// so "methylphenidate" covers both Ritalin and Concerta and "amphetamine_mixed_salts" covers
// both Adderall IR and Adderall XR. Those are different products with different labels and
// different maximum doses. A hit here means "this text probably mentions this ingredient". It
// never establishes what product the patient is taking. Prescribing identity comes from the
// clinician's confirmation of the text they actually wrote, resolved through RxNorm/DailyMed.
//
// entries[].substance marks things that are not medications (tobacco, alcohol, grapefruit).
// They matter to the interaction engine and must never appear as a line on a medication list.
`;

const out = banner + '\n(function(){\n  var VOCAB = ' +
  JSON.stringify({ source: SRC, count: entries.length, entries }, null, 1).replace(/\n/g, '\n  ') +
  ';\n  if (typeof window !== "undefined") window.TBP_RX_VOCAB = VOCAB;\n' +
  '  if (typeof module !== "undefined" && module.exports) module.exports = VOCAB;\n})();\n';

if (process.argv.indexOf('--stdout') > -1) { process.stdout.write(out); }
else {
  fs.writeFileSync(OUT, out);
  console.log(`${OUT}: ${entries.length} entries, ` +
    `${entries.reduce((n, e) => n + e.generics.length + e.brands.length, 0)} search terms, ` +
    `${entries.filter((e) => e.substance).length} marked as substances`);
}
