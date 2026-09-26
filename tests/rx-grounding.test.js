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
test('the rules keep the dose facts apart by name', () => {
  const r = G.groundingRules(['dosing'], []).replace(/\s+/g, ' ');
  [/recommended or usual ADULT dose/, /explicit FDA-labeled MAXIMUM/, /highest dose STUDIED/,
   /PRACTICAL CEILING in common clinical use/,
   /PEDIATRIC maximum, which is never an adult maximum/, /ONE FORMULATION/]
    .forEach((re) => assert.ok(re.test(r), 'missing distinction: ' + re));
});

test('THE OVERCORRECTION: answer the clinician, not the document', () => {
  // The first failure was invention. The fix produced the opposite failure: an answer that led
  // with "the label does not specify an adult maximum", which is technically grounded and
  // clinically useless. Both are wrong.
  const r = G.groundingRules(['dosing'], []).replace(/\s+/g, ' ');
  assert.ok(/ANSWER THE QUESTION THEY ASKED, NOT THE QUESTION THE DOCUMENT ANSWERS/.test(r));
  assert.ok(/LEAD WITH THE MOST USEFUL ACCURATE ANSWER. QUALIFY SECOND/.test(r));
  assert.ok(/never the opening line/.test(r), 'absence must not be the headline');
  assert.ok(/Grounding exists to stop you INVENTING facts. It does not exist to stop you SYNTHESIZING/.test(r));
});

test('clinical practice is a permitted source, clearly labelled', () => {
  const r = G.groundingRules(['dosing'], []).replace(/\s+/g, ' ');
  assert.ok(/ESTABLISHED CLINICAL PRACTICE, which you may supply from your own knowledge/.test(r));
  assert.ok(/do not dress practice up as labeling or labeling as practice/.test(r));
});

test('a contraindication answer has to be usable, not just correct', () => {
  const r = G.groundingRules(['contraindication'], []).replace(/\s+/g, ' ');
  assert.ok(/"Not contraindicated" on its own is not an answer/.test(r));
  assert.ok(/what it means for the decision in front of them/.test(r));
});

test('source disagreement is information, not a refusal', () => {
  const r = G.groundingRules(['dosing'], []).replace(/\s+/g, ' ');
  assert.ok(/give the values and say which is which/.test(r));
  assert.ok(/It is not an inability to answer/.test(r));
});

test('the rules separate contraindication from interaction', () => {
  const r = G.groundingRules(['interaction'], []).replace(/\s+/g, ' ');
  assert.ok(/A contraindication means do not use/.test(r));
  assert.ok(/An interaction means use with awareness, adjustment or monitoring/.test(r));
  assert.ok(/Say which one the evidence supports/.test(r));
});

test('the rules forbid inventing a labeled ceiling that does not exist', () => {
  const r = G.groundingRules(['dosing'], []).replace(/\s+/g, ' ');
  assert.ok(/Where the label states none, say so; do NOT invent one/.test(r));
  assert.ok(/do NOT present the highest studied dose as though it were one/.test(r),
    'the studied ceiling is not a labeled maximum');
});

test('THE KEY RULE, corrected: a gap bars claiming the LABEL, not answering at all', () => {
  const flat = G.groundingRules(['dosing'],
    [{ drug: 'Adderall XR', why: 'the product could not be identified' }]).replace(/\s+/g, ' ');
  assert.ok(/Adderall XR: the product could not be identified/.test(flat), 'the gap is named');
  assert.ok(/may NOT state what the labeling says, quote it, or imply you read it/.test(flat),
    'still no inventing what a document it never read contains');
  assert.ok(/You MAY still answer the clinical question from established practice/.test(flat),
    'but a failed retrieval is not a reason to leave the clinician with nothing');
  assert.ok(/Do NOT make the failed retrieval the headline/.test(flat));
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
  assert.ok(/may NOT state what the labeling says/.test(r.replace(/\s+/g, ' ')));
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

// ---- query scope: what the CLAIM needs, not what the state model wants -----------------------
// The error this replaces: "needs medication facts" was treated as "needs a confirmed medication
// list", so a note that plainly said "Adderall XR 20 mg every morning" still produced a
// two-row confirmation form before anything could be answered.
const xr   = { rawName: 'Adderall XR', formulation: 'extended-release', interactionKey: 'amphetamine_mixed_salts', proposedStatus: 'current' };
const bare = { rawName: 'Adderall', interactionKey: 'amphetamine_mixed_salts', proposedStatus: 'current' };
const flx  = { rawName: 'fluoxetine', interactionKey: 'fluoxetine', proposedStatus: 'current' };
const oldFlx = { rawName: 'fluoxetine', interactionKey: 'fluoxetine', proposedStatus: 'historical' };
const scope = (classes, candidates, confirmed) =>
  G.resolveQueryScope({ classes, candidates, confirmed: confirmed || [] });

test('THE REGRESSION: an explicit note needs no confirmation', () => {
  const s = scope(['dosing', 'contraindication'], [xr, flx]);
  assert.strictEqual(s.asks.length, 0, 'nothing to ask: the note already says it');
  assert.strictEqual(s.sufficient, true);
  assert.deepStrictEqual(s.inputs.map((m) => m.rawName), ['Adderall XR', 'fluoxetine']);
  assert.strictEqual(s.source, 'note');
});

test('a confirmed list is used when one exists', () => {
  const s = scope(['dosing'], [xr], [{ rawName: 'Adderall XR', formulation: 'extended-release', status: 'current' }]);
  assert.strictEqual(s.source, 'confirmed');
});

test('the ONE ask: a release form that changes which label applies', () => {
  const s = scope(['dosing'], [bare]);
  assert.strictEqual(s.asks.length, 1);
  assert.strictEqual(s.asks[0].need, 'formulation');
  assert.strictEqual(s.sufficient, false);
});

test('the same gap does NOT block a question the release form cannot change', () => {
  assert.strictEqual(scope(['contraindication'], [bare, flx]).asks.length, 0);
  assert.strictEqual(scope(['interaction'], [bare, flx]).asks.length, 0);
  assert.strictEqual(scope(['warnings'], [bare]).asks.length, 0);
});

test('a drug with no release-form ambiguity is never asked about', () => {
  assert.strictEqual(scope(['dosing'], [flx]).asks.length, 0,
    'fluoxetine has no IR/XR distinction worth interrupting for');
});

test('current and stopped in the same note is a real conflict', () => {
  const s = scope(['interaction'], [flx, oldFlx]);
  assert.ok(s.asks.some((a) => a.need === 'status'));
});

test('a drug mentioned only as stopped is excluded, not queried about', () => {
  const s = scope(['interaction'], [xr, oldFlx]);
  assert.deepStrictEqual(s.inputs.map((m) => m.rawName), ['Adderall XR']);
  assert.strictEqual(s.asks.length, 0, 'nothing ambiguous about a stopped drug');
});

test('an unclear mention is not treated as current', () => {
  const s = scope(['interaction'], [{ rawName: 'lithium', interactionKey: 'lithium', proposedStatus: 'unclear' }]);
  assert.strictEqual(s.inputs.length, 0);
  assert.strictEqual(s.sufficient, false, 'nothing to ground on');
});

test('no medications at all is not sufficient, and not an ask either', () => {
  const s = scope(['dosing'], []);
  assert.strictEqual(s.sufficient, false);
  assert.strictEqual(s.asks.length, 0, 'there is nothing to ask ABOUT');
});

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
