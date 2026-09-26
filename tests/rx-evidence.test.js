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

const ir = L.chooseSpl(CANDIDATES, 'Adderall');
ok('IR query picks the IR tablet, not the XR capsule', ir.spl.setid === 'a4');

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

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
