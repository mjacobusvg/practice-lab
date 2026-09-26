// Medication grounding: when to retrieve, how the evidence is presented, and what the model is
// told it may not do.
//
// The defect being closed: asked for the maximum Adderall dose, Discern answered 30 mg from
// memory. That is the PEDIATRIC maximum. Adult recommended is 20 mg/day; adult trials studied
// up to 60 mg/day. The tests below are mostly about keeping those three apart, and about what
// happens when retrieval FAILS, because answering from memory anyway is the original bug.

const G = require('../rx-grounding.js');
const assert = require('assert');

let checks = 0, failures = 0;
function test(label, fn) {
  checks++;
  try { fn(); } catch (e) { failures++; console.error(`\nFAIL ${label}\n  ${e.message}`); }
}
const cls = (q) => G.classifyQuestion(q);

// ---- when to ground -----------------------------------------------------------------------
test('THE CASE: the original question asks for dosing AND contraindication', () => {
  const c = cls('What is the maximum Adderall dose I can go to, and is that combination contraindicated?');
  assert.ok(c.needsMedicationFacts);
  assert.ok(c.classes.includes('dosing'), 'dosing');
  assert.ok(c.classes.includes('contraindication'), 'contraindication');
});

test('dose questions in the words clinicians actually use', () => {
  ['Can I go higher on the Adderall?', 'How much can I give?', 'What is the usual dose?',
   'Is 40 mg too much?', 'Should I titrate up?', 'max dose?', 'What is the recommended dose'
  ].forEach((q) => assert.ok(cls(q).classes.includes('dosing'), q));
});

test('plurals and inflections do not slip through', () => {
  // A prefix pattern ending in \b silently fails on the inflected form. Both of these were
  // broken in the first draft, and a missed classification means an ungrounded answer.
  assert.ok(cls('Any interactions?').classes.includes('interaction'));
  assert.ok(cls('Is there an interaction?').classes.includes('interaction'));
  assert.ok(cls('Is this safe in pregnancy?').classes.includes('populations'));
  assert.ok(cls('Safe while breastfeeding?').classes.includes('populations'));
  assert.ok(cls('What are the side effects?').classes.includes('warnings'));
  assert.ok(cls('Any adverse reactions to watch?').classes.includes('warnings'));
  assert.ok(cls('Is it contraindicated?').classes.includes('contraindication'));
  assert.ok(cls('What are the indications?').classes.includes('indication'));
});

test('the existing Discern starters do NOT trigger retrieval', () => {
  ['What am I missing?', 'What should I clarify next?', 'What else could explain this?',
   'What argues against my current formulation?', 'Does the current diagnosis really fit?',
   'What would make you change your mind?', 'What did today establish?'
  ].forEach((q) => assert.strictEqual(cls(q).needsMedicationFacts, false, q));
});

test('"what kind of medication problem does this look like" is reasoning, not a label lookup', () => {
  // A deliberately kept false negative: this asks for clinical thinking about a presentation,
  // not for a fact from a package insert. Grounding it would retrieve labels for every
  // confirmed drug to answer a question that is not about any of them.
  assert.strictEqual(cls('What kind of medication problem does this look like?').needsMedicationFacts, false);
});

test('empty and junk', () => {
  [null, undefined, '', '   '].forEach((q) => assert.strictEqual(cls(q).needsMedicationFacts, false));
});

test('purpose maps to the confirmation gate that fits', () => {
  assert.strictEqual(G.purposeFor(['dosing']), 'dose', 'dose questions justify asking for a release form');
  assert.strictEqual(G.purposeFor(['interaction']), 'interaction');
  assert.strictEqual(G.purposeFor(['warnings']), 'grounding');
  assert.strictEqual(G.purposeFor([]), null);
});

// ---- the evidence block -----------------------------------------------------------------------
const EV = [{
  requested: 'Adderall XR', drug: 'Adderall XR', resolution_status: 'resolved', rxcui: '541878',
  sections: [{ section: 'dosage_and_administration', loinc: '34068-7',
               text: '2.1 Adults: 20 mg/day.\n2.2 Pediatric Patients 6-12: doses above 30 mg/day have not been studied.' },
             { section: 'clinical_studies', loinc: '34092-8', text: 'Adults were studied at 20, 40 and 60 mg/day.' }],
  source: { label_title: 'ADDERALL XR- dextroamphetamine saccharate capsule, extended release',
            setid: 'abc-123', spl_version: 41, effective_date: '20240712',
            of_candidates: 7, chosen_because: 'title matches full query; both extended-release (score 135 of 7 candidates)' }
}];

test('the evidence block is separate from patient material and says what it is', () => {
  const b = G.buildEvidenceBlock(EV);
  assert.ok(/RETRIEVED AUTHORITATIVE MEDICATION EVIDENCE/.test(b));
  assert.ok(/NOT\s*\n?patient material/.test(b) || /NOT[\s\S]{0,40}patient material/.test(b),
    'it must disclaim being patient material');
  assert.ok(/not your own knowledge|NOT your own knowledge/i.test(b));
});

test('provenance travels with the evidence', () => {
  const b = G.buildEvidenceBlock(EV);
  ['ADDERALL XR-', 'abc-123', '41', '20240712', '541878', 'DailyMed']
    .forEach((x) => assert.ok(b.indexOf(x) > -1, 'missing provenance: ' + x));
});

test('sections are named, so adult dosing and clinical studies stay distinguishable', () => {
  const b = G.buildEvidenceBlock(EV);
  assert.ok(/DOSAGE AND ADMINISTRATION/.test(b));
  assert.ok(/CLINICAL STUDIES/.test(b));
  assert.ok(/34068-7/.test(b), 'LOINC codes are the stable section identity');
});

test('a truncated section says so, so absence is not read as absence', () => {
  const big = [{ requested: 'X', drug: 'X', sections: [{ section: 'dosage_and_administration', text: 'y'.repeat(G.SECTION_CAP + 500) }], source: {} }];
  const b = G.buildEvidenceBlock(big);
  assert.ok(/TRUNCATED/.test(b));
  assert.ok(/do not treat an absence here as an absence in the label/.test(b));
});

test('no evidence means no block at all, not an empty heading', () => {
  assert.strictEqual(G.buildEvidenceBlock([]), '');
  assert.strictEqual(G.buildEvidenceBlock([{ requested: 'X', error: 'nope' }]), '');
  assert.strictEqual(G.buildEvidenceBlock(null), '');
});

// ---- the rules ------------------------------------------------------------------------------
test('the rules keep the five dose facts apart by name', () => {
  const r = G.groundingRules(['dosing'], []);
  [/recommended or usual ADULT dose/, /explicit labeled MAXIMUM/, /highest dose STUDIED/,
   /PEDIATRIC maximum, which is never an adult maximum/, /ONE FORMULATION/]
    .forEach((re) => assert.ok(re.test(r), 'missing distinction: ' + re));
});

test('the rules separate contraindication from interaction', () => {
  const r = G.groundingRules(['interaction'], []);
  assert.ok(/An interaction is not a contraindication/.test(r));
});

test('the rules forbid inventing a ceiling when the label states none', () => {
  const r = G.groundingRules(['dosing'], []);
  assert.ok(/states no explicit maximum/.test(r));
  assert.ok(/Do not invent a ceiling/.test(r));
});

test('THE KEY RULE: a gap may not be filled from memory, and the gap is named', () => {
  const r = G.groundingRules(['dosing'], [{ drug: 'Adderall XR', why: 'the product could not be identified' }]);
  assert.ok(/may not fill the gap from memory/i.test(r));
  assert.ok(/Adderall XR: the product could not be identified/.test(r));
  // The rules are line-wrapped for the prompt, so assert on the collapsed text.
  const flat = r.replace(/\s+/g, ' ');
  assert.ok(/could not retrieve the labeling and what you would need/.test(flat),
    'it must say what to tell the clinician');
  assert.ok(/An honest gap is useful/.test(flat));
});

// ---- gaps: every failure stays distinguishable -------------------------------------------------
// PRIMARY sections only: a missing supplementary section is absence, not a gap.
const WANT = ['dosage_and_administration', 'contraindications'];

test('identity never resolved', () => {
  const g = G.evidenceGaps([{ requested: 'Zorblax', error: 'no RxNorm concept matches "Zorblax"' }], WANT);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].kind, 'retrieval_failed');
  assert.ok(/no RxNorm concept/.test(g[0].why));
});

test('MULTIPLE PLAUSIBLE LABELS is its own gap, and no label was used', () => {
  const g = G.evidenceGaps([{ requested: 'Adderall', resolution_status: 'ambiguous',
                              candidates: [{ title: 'A' }, { title: 'B' }] }], WANT);
  assert.strictEqual(g[0].kind, 'identity_ambiguous');
  assert.ok(/2 plausible labels/.test(g[0].why));
  assert.ok(/rather than guessing one/.test(g[0].why));
});

test('a primary section no retrieved label has is a gap', () => {
  const g = G.evidenceGaps([{ requested: 'X', resolution_status: 'resolved',
    sections: [{ section: 'dosage_and_administration', text: 'a' }] }], WANT);
  assert.strictEqual(g[0].kind, 'section_missing');
  assert.ok(/no retrieved label has a contraindications section/.test(g[0].why));
});

test('a section missing from ONE drug but present in another is not a gap', () => {
  // "What is the maximum Adderall dose, and is the combination contraindicated" needs dosing
  // from one label and contraindications from the other. Demanding both from both produces a
  // gap list that is mostly noise, which teaches the reader to skip it.
  const g = G.evidenceGaps([
    { requested: 'Adderall XR', resolution_status: 'resolved', sections: [{ section: 'dosage_and_administration', text: 'a' }] },
    { requested: 'fluoxetine', resolution_status: 'resolved', sections: [{ section: 'contraindications', text: 'b' }] }
  ], WANT);
  assert.deepStrictEqual(g, []);
});

test('a label with nothing readable is not the same as a missing section', () => {
  const g = G.evidenceGaps([{ requested: 'X', resolution_status: 'resolved', sections: [] }], WANT);
  assert.strictEqual(g[0].kind, 'no_sections');
});

test('the evidence service returning nothing leaves a gap, never silence', () => {
  const g = G.evidenceGaps([{ requested: 'Adderall XR', error: 'evidence service returned 502' }], WANT);
  assert.strictEqual(g.length, 1);
  assert.ok(/502/.test(g[0].why));
  const r = G.groundingRules(['dosing'], g);
  assert.ok(/may not fill the gap from memory/i.test(r));
});

test('ONLY ONE OF TWO interacting drugs resolves: the other is named as a gap', () => {
  const g = G.evidenceGaps([
    EV[0],
    { requested: 'fluoxetine', error: 'no SPL on file for RXCUI 4493' }
  ], ['dosage_and_administration']);
  assert.strictEqual(g.length, 1, 'only the unresolved one is a gap');
  assert.strictEqual(g[0].drug, 'fluoxetine');
  // And the resolved one still contributes its evidence.
  assert.ok(G.buildEvidenceBlock([EV[0]]).indexOf('ADDERALL XR') > -1);
});

test('fully resolved means no gaps', () => {
  assert.deepStrictEqual(G.evidenceGaps(EV, ['dosage_and_administration']), []);
});

test('a missing SUPPLEMENTARY section is not a gap', () => {
  // Most labels have no boxed warning. Reporting that as a failure on every question buries
  // the failures that matter.
  assert.deepStrictEqual(G.evidenceGaps(EV, ['dosage_and_administration']), [],
    'clinical_studies and boxed_warning absences are not retrieval failures');
});

test('an ambiguous result is NOT reported as a generic retrieval failure', () => {
  // It carries an `error` string too. Testing that first collapsed the two, losing the
  // distinction between "we could not tell which product" and "the service was down".
  const g = G.evidenceGaps([{ requested: 'Adderall', resolution_status: 'ambiguous',
    error: 'the closest label is a different release form', candidates: [{ title: 'A' }, { title: 'B' }] }],
    ['dosage_and_administration']);
  assert.strictEqual(g[0].kind, 'identity_ambiguous');
  assert.ok(/No label was used rather than guessing one/.test(g[0].why));
});

test('a failure kind from the service is preserved', () => {
  const g = G.evidenceGaps([{ requested: 'X', error: 'no SPL on file', failure_kind: 'label_not_found' }],
    ['dosage_and_administration']);
  assert.strictEqual(g[0].kind, 'label_not_found');
});

// ---- the trail -------------------------------------------------------------------------------
test('the trail distinguishes the four failure modes', () => {
  const t = G.summarizeTrail([
    EV[0],
    { requested: 'Zorblax', error: 'no RxNorm concept', failure_kind: 'identity_unresolved' },
    { requested: 'Adderall', resolution_status: 'ambiguous', candidates: [{ title: 'A', score: 45 }] }
  ]);
  assert.strictEqual(t[0].status, 'resolved');
  assert.strictEqual(t[1].status, 'failed');
  assert.strictEqual(t[2].status, 'ambiguous');
  // resolved rows carry everything needed to tell "wrong label" from "wrong section"
  assert.strictEqual(t[0].setid, 'abc-123');
  assert.strictEqual(t[0].spl_version, 41);
  assert.ok(/title matches full query/.test(t[0].chosen_because));
  assert.strictEqual(t[0].of_candidates, 7);
  assert.deepStrictEqual(t[0].sections.map((s) => s.section),
    ['dosage_and_administration', 'clinical_studies']);
  assert.ok(t[0].sections[0].chars > 0, 'section size, so an empty retrieval is visible');
  assert.ok(t[2].candidates, 'an ambiguous row shows what it was torn between');
});

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
