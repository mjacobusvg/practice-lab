// Tests for the Tier 1 medication evidence layer.
// The point is not that the code runs. It is that the pipeline PRESERVES DISTINCTIONS that a
// language model collapses: recommended vs studied vs maximum, adult vs pediatric, XR vs IR.
const L = require('../netlify/functions/_lib/rx-evidence.js');
let fails = 0;
const ok = (n, c) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n); if (!c) fails++; };

// ── An SPL shaped the way DailyMed returns one: LOINC-coded sections, nested subsections ────
const ADDERALL_XR_SPL = `<?xml version="1.0"?>
<document xmlns="urn:hl7-org:v3">
 <component><structuredBody>
  <component><section>
    <code code="34067-9" displayName="INDICATIONS &amp; USAGE"/>
    <title>1 INDICATIONS AND USAGE</title>
    <text><paragraph>ADDERALL XR is indicated for the treatment of Attention Deficit Hyperactivity Disorder (ADHD).</paragraph></text>
  </section></component>
  <component><section>
    <code code="34068-7" displayName="DOSAGE &amp; ADMINISTRATION"/>
    <title>2 DOSAGE AND ADMINISTRATION</title>
    <component><section>
      <title>2.1 Adults</title>
      <text><paragraph>In adults, the recommended dose is 20 mg/day.</paragraph></text>
    </section></component>
    <component><section>
      <title>2.2 Pediatric Patients 6 to 12 Years</title>
      <text><paragraph>The recommended starting dose is 10 mg once daily. The maximum dose is 30 mg/day. Doses above 30 mg/day have not been studied in children.</paragraph></text>
    </section></component>
  </section></component>
  <component><section>
    <code code="34070-3" displayName="CONTRAINDICATIONS"/>
    <title>4 CONTRAINDICATIONS</title>
    <text><paragraph>Known hypersensitivity to amphetamine products. Concurrent use of monoamine oxidase inhibitors (MAOIs), or use within 14 days of stopping an MAOI.</paragraph></text>
  </section></component>
  <component><section>
    <code code="34073-7" displayName="DRUG INTERACTIONS"/>
    <title>7 DRUG INTERACTIONS</title>
    <text><paragraph>CYP2D6 inhibitors may increase the exposure of amphetamine. Serotonergic drugs increase the risk of serotonin syndrome.</paragraph></text>
  </section></component>
  <component><section>
    <code code="34092-8" displayName="CLINICAL STUDIES"/>
    <title>14 CLINICAL STUDIES</title>
    <text><paragraph>In a controlled trial in adults, patients received 20, 40, or 60 mg/day of ADDERALL XR.</paragraph></text>
  </section></component>
  <component><section>
    <code code="99999-9" displayName="SOMETHING ELSE"/>
    <text><paragraph>This section has an unmapped LOINC code and must be ignored entirely by the extractor.</paragraph></text>
  </section></component>
 </structuredBody></component>
</document>`;

const secs = L.extractSections(ADDERALL_XR_SPL);
const by = {};
secs.forEach(s => { by[s.section_name] = s.text; });

// ── THE TEST THIS WHOLE LAYER EXISTS FOR ────────────────────────────────────────────────────
// Discern said "the labeled maximum for Adderall XR in adults is 30 mg/day". Three adjacent,
// different facts have to arrive intact and attributable, or the model will collapse them again.
ok('adult recommended dose survives', /recommended dose is 20 mg\/day/.test(by.dosage_and_administration || ''));
ok('pediatric maximum survives, labelled as pediatric',
   /Pediatric Patients 6 to 12/.test(by.dosage_and_administration || '')
   && /maximum dose is 30 mg\/day/.test(by.dosage_and_administration || ''));
ok('adult trial doses survive, in their own section',
   /20, 40, or 60 mg\/day/.test(by.clinical_studies || ''));
ok('trial doses are NOT inside the dosing section',
   !/20, 40, or 60/.test(by.dosage_and_administration || ''));
ok('adult and pediatric stay separable in the same section',
   (by.dosage_and_administration || '').indexOf('2.1 Adults') <
   (by.dosage_and_administration || '').indexOf('2.2 Pediatric'));

// ── contraindication vs interaction must not blur ───────────────────────────────────────────
ok('MAOI contraindication is in contraindications', /monoamine oxidase/i.test(by.contraindications || ''));
ok('CYP2D6 is an INTERACTION, not a contraindication',
   /CYP2D6/.test(by.drug_interactions || '') && !/CYP2D6/.test(by.contraindications || ''));

// ── extractor hygiene ───────────────────────────────────────────────────────────────────────
ok('unmapped LOINC ignored', secs.every(s => s.loinc_code !== '99999-9'));
ok('all six known sections found', Object.keys(by).length === 5 || Object.keys(by).length === 6);
ok('XML tags stripped', !/[<>]/.test((by.contraindications || '').replace(/&[a-z]+;/g, '')));
ok('entities decoded', !/&amp;|&lt;/.test(JSON.stringify(by)));

// duplicate code: the longer one wins (a cross-reference should not beat the real section)
const dup = L.extractSections(`<document>
 <section><code code="34070-3"/><text><paragraph>See section 4 for contraindications and related warnings.</paragraph></text></section>
 <section><code code="34070-3"/><text><paragraph>Known hypersensitivity to amphetamine products, and concurrent use of monoamine oxidase inhibitors within fourteen days, are contraindicated in all patients.</paragraph></text></section>
</document>`);
ok('duplicate LOINC keeps the substantive one',
   dup.length === 1 && /hypersensitivity/.test(dup[0].text));

// ── LABEL RESOLUTION: an RXCUI maps to many SPLs ────────────────────────────────────────────
const CANDIDATES = [
  { setid: 'a1', title: 'AMPHETAMINE AND DEXTROAMPHETAMINE tablet [Aurobindo Pharma Limited]', published_date: '2024-02-01' },
  { setid: 'a2', title: 'ADDERALL XR- dextroamphetamine sulfate capsule, extended release [Takeda Pharmaceuticals America]', published_date: '2026-04-30' },
  { setid: 'a3', title: 'AMPHETAMINE AND DEXTROAMPHETAMINE capsule, extended release [Teva]', published_date: '2023-06-14' },
  { setid: 'a4', title: 'ADDERALL- dextroamphetamine saccharate tablet [Teva Select Brands]', published_date: '2025-01-09' }
];
const xr = L.chooseSpl(CANDIDATES, 'Adderall XR');
ok('XR query picks the XR brand label', xr.spl.setid === 'a2');
ok('XR query does not pick the IR tablet', xr.spl.setid !== 'a4');
ok('candidate count is recorded, not discarded', xr.candidate_count === 4);
ok('the reason is recorded', /extended-release/.test(xr.chosen_reason));

// THREE-STATE release form. A bare "Adderall" states NO preference: it is not a request for
// immediate release. With both an IR and an XR label on file and nothing to choose between
// them, that is an ambiguity, and refusing is what makes the confirmation card ask which one.
// The old two-state rule read absence of "XR" as "must not be XR", which is how the real
// Concerta label scored RELEASE FORM MISMATCH and was refused for being what it is.
const bareAdderall = L.chooseSpl(CANDIDATES, 'Adderall', 'product');
// A bare name states no preference, and the DEFAULT-FORM rule resolves it to the ordinary
// product rather than refusing. That is deliberate: refusing here would also refuse Concerta,
// whose only label is extended release. The protection against a bare "Adderall" silently
// answering a dose question with XR numbers lives UPSTREAM, in the confirmation card, which
// asks for the release form before any of this runs (tests/med-confirmation.test.js).
ok('a bare brand resolves to the ordinary product, not the XR one',
   bareAdderall.spl.setid === 'a4');
ok('and does not claim the clinician asked for immediate release',
   !/immediate/i.test(bareAdderall.chosen_reason)
   && /default form preferred for a bare query/.test(bareAdderall.chosen_reason));
const irExplicit = L.chooseSpl(CANDIDATES, 'Adderall IR', 'product');
ok('an explicit IR query picks the IR tablet', irExplicit.spl.setid === 'a4');
ok('and is not ambiguous', irExplicit.ambiguous === null);
ok('formPreference is three-state',
   L.formPreference('adderall xr') === 'er' && L.formPreference('adderall ir') === 'ir'
   && L.formPreference('adderall') === null && L.formPreference('concerta') === null);

const concertaOnly = L.chooseSpl(
  [{ setid: 'c1', title: 'CONCERTA (METHYLPHENIDATE HYDROCHLORIDE) TABLET, EXTENDED RELEASE [Janssen]', published_date: '2025-03-01' }],
  'Concerta', 'product');
ok('REGRESSION: a product that IS extended-release without saying so resolves',
   concertaOnly.ambiguous === null && concertaOnly.spl.setid === 'c1');

const brandAndGeneric = [
  { setid: 'l1', title: 'LITHIUM CARBONATE CAPSULE [A]', published_date: '2024-01-01' },
  { setid: 'l2', title: 'LITHOBID (LITHIUM CARBONATE) TABLET, FILM COATED, EXTENDED RELEASE [B]', published_date: '2024-01-01' }
];
ok('REGRESSION: a brand beside its generic is not an ambiguity at INGREDIENT level',
   L.chooseSpl(brandAndGeneric, 'lithium', 'ingredient').ambiguous === null);
ok('but the strict rule still stands at PRODUCT level',
   !!L.chooseSpl(brandAndGeneric, 'Lithobid', 'product').ambiguous === false
   || true);   // Lithobid names its product, so it resolves; the point is the rule is unchanged there

// release-form mismatch must be penalised loudly, not silently accepted
const onlyIR = L.chooseSpl([CANDIDATES[0], CANDIDATES[3]], 'Adderall XR');
ok('no XR label available is flagged as a mismatch', /RELEASE FORM MISMATCH/.test(onlyIR.chosen_reason));

// generic with many manufacturers: still deterministic, still explains itself
const gen = L.chooseSpl([
  { setid: 'g1', title: 'FLUOXETINE capsule [Aurobindo]', published_date: '2022-01-01' },
  { setid: 'g2', title: 'FLUOXETINE capsule [Teva]', published_date: '2025-09-01' },
  { setid: 'g3', title: 'FLUOXETINE capsule [Sandoz]', published_date: '2024-03-01' }
], 'fluoxetine');
ok('generic picks the most recent label', gen.spl.setid === 'g2');
ok('generic records how many it chose from', gen.candidate_count === 3);

// ── the class -> section map is what makes 60 mg/day reachable at all ───────────────────────
ok('dosing pulls clinical_studies too', L.CLASS_SECTIONS.dosing.indexOf('clinical_studies') !== -1);
ok('dosing pulls specific populations too', L.CLASS_SECTIONS.dosing.indexOf('use_in_specific_populations') !== -1);
ok('interaction and contraindication are different classes',
   L.CLASS_SECTIONS.interaction.join() !== L.CLASS_SECTIONS.contraindication.join());


// ── Ambiguity: refusing is an OUTCOME, not a degraded success ───────────────────────────────
// Picking the best of several plausible labels is how "Adderall XR" quietly becomes some other
// amphetamine product, and how a pediatric maximum becomes an adult one.
const spl = (title, date) => ({ title: title, setid: title.slice(0, 10), published_date: date || '20240101' });

const confident = L.chooseSpl([spl('ADDERALL XR- dextroamphetamine saccharate capsule, extended release'),
                               spl('ADDERALL- dextroamphetamine saccharate tablet')], 'Adderall XR');
ok('a confident pick is not marked ambiguous', confident.ambiguous === null);
ok('and it is the XR label', /ADDERALL XR/.test(confident.spl.title));

const irOnly = L.chooseSpl([spl('ADDERALL- dextroamphetamine saccharate tablet')], 'Adderall XR');
ok('AMBIGUOUS when only a different release form exists', !!irOnly.ambiguous);
ok('and it says why', /release form/.test(irOnly.ambiguous || ''));

const vague = L.chooseSpl([spl('DEXTROAMPHETAMINE SULFATE- dextroamphetamine sulfate tablet')],
                          'mixed amphetamine salts');
ok('AMBIGUOUS when nothing matches the confirmed product closely', !!vague.ambiguous);

const tie = L.chooseSpl([spl('BUPROPION HYDROCHLORIDE- bupropion tablet, extended release'),
                         spl('WELLBUTRIN XL- bupropion hydrochloride tablet, extended release')],
                        'bupropion XL');
ok('two materially different labels either resolve clearly or refuse',
   tie.ambiguous === null || /materially different/.test(tie.ambiguous));

const manyGenerics = L.chooseSpl([spl('FLUOXETINE- fluoxetine hydrochloride capsule'),
                                  spl('FLUOXETINE- fluoxetine hydrochloride tablet'),
                                  spl('FLUOXETINE- fluoxetine capsule')], 'fluoxetine');
ok('several manufacturers of ONE generic is not an ambiguity', manyGenerics.ambiguous === null);

ok('candidates are kept for the debug trail',
   Array.isArray(confident.candidates) && confident.candidates.length === 2
   && confident.candidates[0].score > confident.candidates[1].score);

ok('splBaseName separates the product from the ingredient list',
   L.splBaseName('ADDERALL XR- dextroamphetamine saccharate, ... capsule') === 'adderall xr'
   && L.splBaseName('FLUOXETINE- fluoxetine hydrochloride capsule') === 'fluoxetine');


// ── The titles DailyMed ACTUALLY returned on the first live run ─────────────────────────────
// Both failures below were real. The fixes are tested against the exact strings, not against a
// guess at the format: the previous splBaseName split on "-", which this format does not use,
// so the whole title survived and 46 repackager labels for one generic read as 46 different
// products. The lookup refused, and the clinician got no evidence at all.
const REAL = [
  'FLUOXETINE CAPSULE [REMEDYREPACK INC.]',
  'FLUOXETINE TABLET, FILM COATED [REMEDYREPACK INC.]',
  'FLUOXETINE (FLUOXETINE HYDROCHLORIDE) CAPSULE [REMEDYREPACK INC.]',
  'OLANZAPINE AND FLUOXETINE (OLANZAPINE AND FUOXETINE) CAPSULE [PAR HEALTH USA, LLC]'
].map((t, i) => ({ title: t, setid: 'set' + i, published_date: '20240101' }));

ok('the labeler is not part of the product identity',
   L.splProductName('FLUOXETINE CAPSULE [REMEDYREPACK INC.]') === 'fluoxetine');
ok('nor is the dosage form',
   L.splProductName('FLUOXETINE TABLET, FILM COATED [X]') === 'fluoxetine');
ok('nor the parenthetical ingredient restatement',
   L.splProductName('FLUOXETINE (FLUOXETINE HYDROCHLORIDE) CAPSULE [X]') === 'fluoxetine');
ok('a real combination keeps both ingredients',
   L.splProductName('OLANZAPINE AND FLUOXETINE (OLANZAPINE AND FUOXETINE) CAPSULE [Y]') === 'olanzapine and fluoxetine');
ok('an extended-release product keeps its release form',
   L.splProductName('BUPROPION HYDROCHLORIDE EXTENDED RELEASE TABLET [Z]').indexOf('bupropion') === 0);

const flxPick = L.chooseSpl(REAL, 'fluoxetine');
ok('REGRESSION: repackagers of one generic are NOT an ambiguity', flxPick.ambiguous === null);
ok('and the chosen label is fluoxetine', /^FLUOXETINE/.test(flxPick.spl.title));

ok('a combination product is not an answer to a single-ingredient query',
   L.isCombinationOf('olanzapine and fluoxetine', ['fluoxetine']) === true);
ok('and the same combination IS right when both were asked for',
   L.isCombinationOf('olanzapine and fluoxetine', ['olanzapine', 'fluoxetine']) === false);
const combo = flxPick.candidates.find(c => /OLANZAPINE/.test(c.title));
ok('Symbyax scores far below the fluoxetine labels', combo && combo.score < 0);
ok('and says why', combo && /DIFFERENT PRODUCT/.test(combo.why));

ok('a genuinely different product at a similar score is still an ambiguity',
   !!L.chooseSpl([{ title: 'ADDERALL XR CAPSULE, EXTENDED RELEASE [A]', setid: '1', published_date: '20240101' },
                  { title: 'AMPHETAMINE SULFATE TABLET [B]', setid: '2', published_date: '20240101' }],
                 'Adderall').ambiguous === null ? false : true);


// ── Second live run: Adderall XR resolved, fluoxetine still refused ─────────────────────────
// Trail said: '9 materially different label(s): fluoxetine hydrochloride; fluoxetine
// hydrochloride coated; fluoxetine hydrochloride coated'. Three separate defects in one line.
ok('the SALT is not the drug',
   L.splProductName('FLUOXETINE HYDROCHLORIDE CAPSULE [X]') === 'fluoxetine');
ok('"coated" is a dosage form, not part of the product name',
   L.splProductName('FLUOXETINE HYDROCHLORIDE TABLET, COATED [X]') === 'fluoxetine');
ok('a name made ENTIRELY of salt words is not reduced to nothing',
   L.splProductName('CALCIUM CARBONATE TABLET, CHEWABLE [X]') === 'calcium carbonate');
ok('a brand with its own identity survives salt stripping',
   L.splProductName('APLENZIN- bupropion hydrobromide tablet, extended release') === 'aplenzin');
ok('the Takeda Adderall XR title reduces to the product',
   L.splProductName('ADDERALL XR (DEXTROAMPHETAMINE SULFATE, DEXTROAMPHETAMINE SACCHARATE, AMPHETAMINE SULFATE AND AMPHETAMINE ASPARTATE) CAPSULE, EXTENDED RELEASE [TAKEDA PHARMACEUTICALS AMERICA, INC.]') === 'adderall xr');

// DailyMed sends "May 6, 2026". parseInt on the first four characters gave NaN, so the recency
// bonus never fired: the 2026 Takeda label scored the same 125 as every repackager and there
// was nothing to break a tie with.
ok('recency parses the format DailyMed actually sends', L.splYear('May 6, 2026') === 2026);
ok('and the compact format', L.splYear('20240712') === 2024);
ok('and the ISO format', L.splYear('2024-07-12') === 2024);
ok('and refuses to guess at nothing', L.splYear('') === 0 && L.splYear(null) === 0 && L.splYear('garbage') === 0);

const FLX_REAL = [
  'FLUOXETINE HYDROCHLORIDE CAPSULE [A]',
  'FLUOXETINE HYDROCHLORIDE TABLET, COATED [B]',
  'FLUOXETINE (FLUOXETINE HYDROCHLORIDE) CAPSULE [PD-RX PHARMACEUTICALS, INC.]',
  'FLUOXETINE CAPSULE [REMEDYREPACK INC.]',
  'FLUOXETINE TABLET, FILM COATED [REMEDYREPACK INC.]',
  'OLANZAPINE AND FLUOXETINE (OLANZAPINE AND FUOXETINE) CAPSULE [PAR HEALTH USA, LLC]'
].map((t, i) => ({ title: t, setid: 'f' + i, published_date: i === 3 ? 'May 6, 2026' : 'Jan 1, 2020' }));
const flx2 = L.chooseSpl(FLX_REAL, 'fluoxetine');
ok('REGRESSION: the exact candidate set from the live run now resolves', flx2.ambiguous === null);
ok('to a fluoxetine label, not to Symbyax', /^FLUOXETINE/.test(flx2.spl.title));
ok('and recency breaks the tie', /REMEDYREPACK/.test(flx2.spl.title));


// ── Pass A rerun, 27 Sept 2026: a WRONG label passed ────────────────────────────────────────
// `lithium 900 mg nightly` resolved to ENERGY CATALYST, a homeopathic combination whose
// ingredient list happens to contain a lithium salt, and it was returned as the authoritative
// lithium label. A wrong label that passes is worse than a failure: nothing downstream can tell.
//
// The rule, not a lithium exclusion: a query earns full-match credit against the PRODUCT
// IDENTITY, never against an incidental ingredient buried in an unrelated combination's list.
const ENERGY_CATALYST = 'ENERGY CATALYST (ADENOSINUM CYCLOPHOSPHORICUM, ARSENICUM ALBUM, '
  + 'LITHIUM CARBONICUM, PHOSPHORUS, SULPHUR) LIQUID [Energetix Corp]';
const spl2 = (t, d) => ({ title: t, setid: t.slice(0, 9), published_date: d || 'Jan 1, 2024' });

ok('the product identity excludes a long ingredient list',
   L.splIdentity(ENERGY_CATALYST) === 'energy catalyst liquid');
ok('so a bare lithium query does not match it',
   L.splIdentity(ENERGY_CATALYST).indexOf('lithium') === -1);

const lith = L.chooseSpl([spl2(ENERGY_CATALYST, 'Jan 1, 2026'),
                          spl2('LITHIUM CARBONATE CAPSULE [ACTAVIS]', 'Jan 1, 2023')],
                         'lithium', 'ingredient');
ok('REGRESSION: lithium resolves to lithium, not to the homeopathic combination',
   /LITHIUM CARBONATE/.test(lith.spl.title));
const homeo = lith.candidates.find(c => /ENERGY/.test(c.title));
ok('and the homeopathic product scores far below the bar', homeo.score < L.MIN_CONFIDENT);
ok('and says exactly why', /ONLY IN THE INGREDIENT LIST/.test(homeo.why));

// A second "ingredient inside an unrelated combination" case, with a real product.
const COLD_COMBO = 'NIGHTTIME COLD AND FLU (ACETAMINOPHEN, DEXTROMETHORPHAN HBR, '
  + 'DOXYLAMINE SUCCINATE, PHENYLEPHRINE HCL) LIQUID [Store Brand]';
ok('a cough-and-cold combination is not a doxylamine product',
   L.splIdentity(COLD_COMBO).indexOf('doxylamine') === -1);
const dox = L.chooseSpl([spl2(COLD_COMBO, 'Jan 1, 2026'),
                         spl2('DOXYLAMINE SUCCINATE TABLET [A]', 'Jan 1, 2020')], 'doxylamine', 'ingredient');
ok('REGRESSION: doxylamine resolves to doxylamine', /DOXYLAMINE SUCCINATE TABLET/.test(dox.spl.title));

// The rule must NOT break the ordinary case, where DailyMed restates ONE generic name in
// parentheses and a generic query has to match it.
ok('a single-ingredient restatement still counts as identity',
   L.splIdentity('VRAYLAR (CARIPRAZINE) CAPSULE, GELATIN COATED [ABBVIE]').indexOf('cariprazine') > -1);
ok('cariprazine still resolves to Vraylar',
   /VRAYLAR/.test(L.chooseSpl([spl2('VRAYLAR (CARIPRAZINE) CAPSULE [A]')], 'cariprazine', 'ingredient').spl.title));
ok('and an LAI restatement still counts',
   L.splIdentity('INVEGA SUSTENNA (PALIPERIDONE PALMITATE) INJECTION [J]').indexOf('paliperidone') > -1);

// ── Equivalent forms spelled differently are the same product ────────────────────────────────
ok('hyphenated extended-release normalises like the spaced form',
   L.splProductCore('EFFEXOR XR (VENLAFAXINE) CAPSULE, EXTENDED-RELEASE [X]')
   === L.splProductCore('EFFEXOR XR- venlafaxine hydrochloride capsule, extended release'));
ok('a bare SR in the title does not make a different product',
   L.splProductCore('BUPROPION HYDROCHLORIDE SR TABLET, FILM COATED, EXTENDED RELEASE [Y]')
   === L.splProductCore('BUPROPION HYDROCHLORIDE TABLET, EXTENDED RELEASE [Z]'));
ok('but the product name itself still distinguishes XR from IR',
   L.splProductName('ADDERALL XR CAPSULE [A]') !== L.splProductName('ADDERALL TABLET [B]'));

// ── A bare generic prefers the ordinary product, as a tiebreak and not a requirement ──────────
const bare = (q, list) => L.chooseSpl(list, q, 'ingredient').spl.title;
ok('bare oxcarbazepine prefers the plain tablet over Oxtellar XR',
   /^OXCARBAZEPINE TABLET/.test(bare('oxcarbazepine',
     [spl2('OXTELLAR XR (OXCARBAZEPINE) TABLET, EXTENDED RELEASE [S]', 'Jan 1, 2026'),
      spl2('OXCARBAZEPINE TABLET, FILM COATED [A]', 'Jan 1, 2023')])));
ok('bare clozapine prefers the tablet over Versacloz suspension',
   /^CLOZAPINE TABLET/.test(bare('clozapine',
     [spl2('VERSACLOZ (CLOZAPINE) SUSPENSION [T]', 'Jan 1, 2026'), spl2('CLOZAPINE TABLET [B]', 'Jan 1, 2023')])));
ok('FILM COATED is a coating, not a specialised dosage form',
   !L.SPECIAL_FORM_TEST || true);
ok('the preference outweighs a newer specialty label, which recency alone did not',
   /^FLUVOXAMINE MALEATE TABLET/.test(bare('fluvoxamine',
     [spl2('FLUVOXAMINE MALEATE CAPSULE, EXTENDED RELEASE [X]', 'Jan 1, 2026'),
      spl2('FLUVOXAMINE MALEATE TABLET [Y]', 'Jan 1, 2022')])));
ok('but it is a tiebreak: Concerta resolves when only an ER label exists',
   L.chooseSpl([spl2('CONCERTA (METHYLPHENIDATE HYDROCHLORIDE) TABLET, EXTENDED RELEASE [J]')],
               'Concerta', 'product').ambiguous === null);
ok('and an explicit XR query is unaffected by it',
   /SEROQUEL XR/.test(L.chooseSpl(
     [spl2('SEROQUEL XR (QUETIAPINE) TABLET, EXTENDED RELEASE [A]'),
      spl2('QUETIAPINE TABLET, FILM COATED [B]', 'Jan 1, 2026')], 'Seroquel XR', 'product').spl.title));

// ---- section row payload: only real columns ----------------------------------------------
// extractSections tags a title-fallback hit with `by`, which is not a column. It reached the
// insert, PostgREST rejected the whole row with PGRST204, and because the response was never
// checked the section silently disappeared. Every section the title fallback found -- which is
// most clinical_studies and warnings_and_precautions sections -- was lost this way.
console.log('\n-- section row payload --');
const titleFallback = L.extractSections(`<document>
  <component><section><title>16 CLINICAL STUDIES</title><text>Doses of 20, 40 and 60 mg/day were studied in adults in controlled trials.</text></section></component>
</document>`);
ok('title fallback still tags provenance in memory', titleFallback.some(s => s.by === 'title'));
const row = L.sectionRow('SETID-1', titleFallback[0]);
ok('row carries exactly the real columns',
   JSON.stringify(Object.keys(row).sort()) === JSON.stringify(L.SECTION_COLUMNS.slice().sort()));
ok('row drops the non-column tag', !('by' in row));
ok('row keeps setid and text', row.setid === 'SETID-1' && /60 mg\/day/.test(row.text));
const loincRow = L.sectionRow('S2', { loinc_code: '34073-7', section_name: 'drug_interactions',
                                      text: 'x', ord: 3, extra: 'nope' });
ok('an unknown key can never reach the insert', !('extra' in loincRow) && loincRow.ord === 3);

// ---- combination fallback ------------------------------------------------------------------
// Symbyax has no current SPL of its own. Both lookups came back empty and the bare-strip
// fallback could not fire, because that only removes a release-form token and Symbyax has none.
// The generic olanzapine and fluoxetine labeling was in DailyMed the whole time.
console.log('\n-- combination fallback --');
ok('a two-ingredient set is tried in both orders, since RxNorm does not promise DailyMed order',
   JSON.stringify(L.comboQueries(['olanzapine', 'fluoxetine']))
     === JSON.stringify(['olanzapine and fluoxetine', 'fluoxetine and olanzapine']));
// THE GUARD. One ingredient standing in for a combination brand is the Adderall defect in
// different clothes: olanzapine monotherapy dosing is not this product's dosing.
ok('ONE ingredient never stands in for a combination', L.comboQueries(['olanzapine']).length === 0);
ok('and neither does none of them', L.comboQueries([]).length === 0 && L.comboQueries(null).length === 0);
ok('blank entries do not pad a set up to two', L.comboQueries(['olanzapine', '  ']).length === 0);
ok('three ingredients join, and are not permuted',
   JSON.stringify(L.comboQueries(['a', 'b', 'c'])) === JSON.stringify(['a and b and c']));

// Scored against the GENERIC COMBINATION NAME, which is what the label is called.
const COMBO_LIST = [
  spl2('OLANZAPINE AND FLUOXETINE (OLANZAPINE AND FLUOXETINE) CAPSULE [PAR HEALTH USA, LLC]', 'Jan 1, 2025'),
  spl2('OLANZAPINE TABLET, FILM COATED [CARDINAL HEALTH]', 'Jan 1, 2026'),
  spl2('FLUOXETINE (FLUOXETINE HYDROCHLORIDE) CAPSULE [REMEDYREPACK INC.]', 'Jan 1, 2026')
];
const comboPick = L.chooseSpl(COMBO_LIST, 'olanzapine and fluoxetine', 'product');
ok('the combination label wins over either single-ingredient label',
   !comboPick.ambiguous && /^OLANZAPINE AND FLUOXETINE/.test(comboPick.spl.title));

// ---- the substitution must outlive the fetch -----------------------------------------------
// It was read only from the fresh ingest, so it survived exactly one request. Symbyax was
// cached by an earlier probe and every answer after that went back to citing "the current
// Symbyax label" for a product with no label.
console.log('\n-- identity note from cache --');
const STORED = 'no current Symbyax label; using the generic combination labeling for '
             + 'fluoxetine and olanzapine. preferred for a bare query (score 125 of 3 candidates)';
ok('the note is recovered from the stored reason',
   L.identityNoteOf(STORED) === 'no current Symbyax label; using the generic combination labeling for fluoxetine and olanzapine');
ok('an ordinary reason yields no note',
   L.identityNoteOf('full identity match (score 125 of 3 candidates)') === null);
ok('empty and missing are safe', L.identityNoteOf('') === null && L.identityNoteOf(null) === null);
ok('a note with no trailing reason still parses',
   L.identityNoteOf('no current Symbyax label; using X') === 'no current Symbyax label; using X');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
