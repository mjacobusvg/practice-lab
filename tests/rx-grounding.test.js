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

// ---- identity substitution must reach the prompt ------------------------------------------
// Pass B: Symbyax answered "the labeled adult maximum ... is explicitly stated in the label
// for both indications". Symbyax has no current label. The combination fallback had read the
// generic olanzapine and fluoxetine labeling and recorded that in the trail, but the evidence
// block still announced itself as labeling "for the specific products confirmed for this
// patient", so the model was told a generic label WAS the Symbyax label and wrote accordingly.
const SUBBED = [{
  requested: 'Symbyax', drug: 'Symbyax', rxcui: '405343',
  identity_note: 'no current Symbyax label; using the generic combination labeling for fluoxetine and olanzapine',
  sections: [{ section: 'dosage_and_administration', loinc: '34068-7', text: 'Maximum 12 mg/50 mg once daily.' }],
  source: { label_title: 'OLANZAPINE AND FLUOXETINE CAPSULE [PAR HEALTH USA, LLC]', setid: 'x1' }
}];
const subBlock = G.buildEvidenceBlock(SUBBED);
test('the substitution appears beside the label it applies to', () => assert.ok(/IDENTITY SUBSTITUTION: no current Symbyax label/.test(subBlock)));
test('and names the labeling that was actually read', () => assert.ok(/generic combination labeling for fluoxetine and olanzapine/.test(subBlock)));
test('the header warns that not every item is the product asked about', () => assert.ok(/NOT EVERY ITEM BELOW IS THE LABEL FOR THE PRODUCT THAT WAS ASKED ABOUT/.test(subBlock)));
test('and forbids attributing it to the product asked about', () => assert.ok(/Do not write "the <asked-about product> label states"/.test(subBlock)));

// An ordinary retrieval must not pick up the warning, or it becomes noise the model learns to
// ignore in exactly the case that matters.
const PLAIN = [{
  requested: 'Adderall XR', drug: 'Adderall XR', rxcui: '352398',
  sections: [{ section: 'dosage_and_administration', loinc: '34068-7', text: '20 mg/day.' }],
  source: { label_title: 'ADDERALL XR CAPSULE', setid: 'x2' }
}];
const plainBlock = G.buildEvidenceBlock(PLAIN);
test('a normal label carries no substitution line', () => assert.ok(!/IDENTITY SUBSTITUTION/.test(plainBlock)));
test('and no header warning', () => assert.ok(!/NOT EVERY ITEM BELOW/.test(plainBlock)));

// ---- population split ----------------------------------------------------------------------
// Three separate times the model answered an ADULT dosing question with a PEDIATRIC figure:
// Adderall 30 mg (the original defect), and Concerta 54 mg in Pass B run 1, where 72 is the
// adult number and 54 is the childrens'. Retrieval was correct in every case. The two figures
// were simply adjacent in one dosing section, and adjacency was enough.

const ADDERALL_DOSE =
  '2.1 Adults: The recommended dose is 20 mg/day. 2.2 Pediatric Patients 6 to 12 years: '
  + 'doses above 30 mg/day have not been studied.';

test('the adult and pediatric figures land in separate blocks', () => {
  const r = G.splitByPopulation(ADDERALL_DOSE);
  assert.ok(r.segments, r.why);
  assert.deepStrictEqual(r.segments.map((s) => s.population), ['adult', 'pediatric']);
  assert.ok(/20 mg\/day/.test(r.segments[0].text) && !/30 mg\/day/.test(r.segments[0].text),
    'the pediatric ceiling must not sit inside the adult block');
});

// THE INVARIANT. A parser that silently drops the paragraph holding the real maximum is worse
// than no parser at all.
[ADDERALL_DOSE,
 '2.1 Adults 72 mg/day.  2.2 Children 6 to 12 years 54 mg/day.  2.3 Geriatric Use: start low.',
 'Preamble text here. 1.1 Adults: 10 mg. 1.2 Pediatric: 5 mg.',
 '10.1 Adults A. 10.2 Pediatric B.'
].forEach((src, i) => {
  test(`nothing is lost, case ${i + 1}`, () => {
    const r = G.splitByPopulation(src);
    assert.ok(r.segments, r.why);
    assert.strictEqual(r.segments.map((s) => s.text).join(''), src,
      'the segments must reassemble into the source exactly');
  });
});

test('text before the first subsection is kept, not dropped', () => {
  const r = G.splitByPopulation('Important preamble. 1.1 Adults: 10 mg. 1.2 Pediatric: 5 mg.');
  assert.ok(r.segments);
  assert.ok(/Important preamble/.test(r.segments[0].text));
});

// FAIL CLOSED. Every case it cannot read confidently goes to the model whole.
test('one subsection is not a structure, so nothing is split', () => {
  assert.strictEqual(G.splitByPopulation('2.1 Adults: 20 mg/day.').segments, null);
});
test('prose with no numbering is not split', () => {
  assert.strictEqual(G.splitByPopulation('Give 20 mg daily to adults and 10 mg to children.').segments, null);
});
test('subsections that name no population are not split, since that separates nothing', () => {
  assert.strictEqual(G.splitByPopulation('2.1 Dosing: 20 mg. 2.2 Administration: with food.').segments, null);
});
test('empty input does not throw', () => {
  assert.strictEqual(G.splitByPopulation('').segments, null);
  assert.strictEqual(G.splitByPopulation(null).segments, null);
});

// A heading naming two populations is reported as naming two. Picking one would invent a
// precision the label does not have.
test('a combined heading is labelled as combined, not resolved to one', () => {
  assert.strictEqual(G.populationOf('2.1 Adults and Pediatric Patients 13 years and older'),
    'adult and pediatric');
});
test('geriatric is its own population', () => {
  assert.strictEqual(G.populationOf('8.5 Geriatric Use'), 'geriatric');
});
test('a heading naming nobody is unspecified, not guessed as adult', () => {
  assert.strictEqual(G.populationOf('2.3 Switching from another product'), 'unspecified');
});

// THE CONCERTA CASE, as it actually failed.
test('the Concerta adult ceiling cannot be read out of the pediatric block', () => {
  const r = G.splitByPopulation(
    '2.1 Adults: may be increased to a maximum of 72 mg/day. '
    + '2.2 Children 6 to 12 years: daily dosage above 54 mg/day is not recommended.');
  assert.ok(r.segments);
  const adult = r.segments.find((s) => s.population === 'adult');
  const kids  = r.segments.find((s) => s.population === 'pediatric');
  assert.ok(/72 mg/.test(adult.text) && !/54 mg/.test(adult.text));
  assert.ok(/54 mg/.test(kids.text) && !/72 mg/.test(kids.text));
});

// And in the block the model actually receives.
test('the prompt carries the population labels and the rule for using them', () => {
  const block = G.buildEvidenceBlock([{
    requested: 'Concerta', drug: 'Concerta',
    sections: [{ section: 'dosage_and_administration', loinc: '34068-7', text: ADDERALL_DOSE }],
    source: { label_title: 'CONCERTA TABLET', setid: 'c1' }
  }]);
  assert.ok(/\[POPULATION: adult\]/.test(block));
  assert.ok(/\[POPULATION: pediatric\]/.test(block));
  assert.ok(/never give a figure from a/.test(block));
  assert.ok(/State the/.test(block) && /population alongside every dose/.test(block));
});

test('a non-dosing section is left exactly as it was', () => {
  const block = G.buildEvidenceBlock([{
    requested: 'Concerta', drug: 'Concerta',
    sections: [{ section: 'clinical_studies', loinc: '34092-8', text: ADDERALL_DOSE }],
    source: { label_title: 'CONCERTA TABLET', setid: 'c1' }
  }]);
  assert.ok(!/\[POPULATION:/.test(block), 'splitting prose that merely mentions children adds noise');
  assert.ok(block.indexOf(ADDERALL_DOSE) !== -1, 'and the text is untouched');
});

// ---- population-tagged figure index --------------------------------------------------------
// splitByPopulation declined on the real Concerta label: "no subsection names a population".
// Its subsections are named for clinical situation, and the age bands are in a dosing TABLE. The
// split did nothing, and Concerta answered 54 mg/day to an adult question in one run of five.
const CONCERTA_TABLE =
  '2.1 Dosage in Patients New to Methylphenidate. The recommended starting dose is 18 mg/day. '
  + 'Patient Population Starting Dose Maximum Dose  Children 6 to 12 years 18 mg/day 54 mg/day  '
  + 'Adolescents 13 to 17 years 18 mg/day 72 mg/day  Adults 18 to 65 years 18 or 36 mg/day 72 mg/day';

test('the pediatric ceiling is tagged pediatric and nothing else', () => {
  const tags = G.populationTaggedFigures(CONCERTA_TABLE);
  const fifty4 = tags.filter((f) => f.figure === '54 mg/day');
  assert.strictEqual(fifty4.length, 1);
  assert.strictEqual(fifty4[0].population, 'pediatric',
    '54 mg/day presented as an adult figure is the defect this exists to stop');
});

test('a figure that belongs to two populations is listed under both', () => {
  const pops = G.populationTaggedFigures(CONCERTA_TABLE)
    .filter((f) => f.figure === '72 mg/day').map((f) => f.population).sort();
  assert.deepStrictEqual(pops, ['adult', 'pediatric'],
    '72 mg/day is the ceiling for adolescents and for adults, and saying only one would be wrong');
});

// THE BUG THIS TEST EXISTS FOR. A bare "65 years" matched the END OF AN AGE RANGE, so
// "Adults 18 to 65 years" tagged geriatric and took the adult 72 mg/day with it. Geriatric has
// to be stated, not inferred from a boundary.
test('an age range ending at 65 is not geriatric', () => {
  assert.strictEqual(G.populationOf('Adults 18 to 65 years'), 'adult');
});
test('but geriatric is still found when the label says it', () => {
  assert.strictEqual(G.populationOf('8.5 Geriatric Use'), 'geriatric');
  assert.strictEqual(G.populationOf('in patients 65 years and older'), 'geriatric');
});

test('a figure with no population near it is unclear, never guessed', () => {
  const tags = G.populationTaggedFigures('The recommended starting dose is 18 mg/day.');
  assert.strictEqual(tags.length, 1);
  assert.strictEqual(tags[0].population, 'unclear');
});

test('each tag carries the text it was derived from, so a wrong one is visible', () => {
  const t54 = G.populationTaggedFigures(CONCERTA_TABLE).find((f) => f.figure === '54 mg/day');
  assert.ok(/Children 6 to 12 years/.test(t54.context));
});

test('nothing at all does not throw', () => {
  assert.deepStrictEqual(G.populationTaggedFigures(''), []);
  assert.deepStrictEqual(G.populationTaggedFigures(null), []);
});

test('a section with no figures produces no index', () => {
  assert.deepStrictEqual(G.populationTaggedFigures('Take one tablet by mouth each morning.'), []);
});

// In the block the model receives: additive, and the section is still there whole.
const CONCERTA_BLOCK = G.buildEvidenceBlock([{
  requested: 'Concerta', drug: 'Concerta',
  sections: [{ section: 'dosage_and_administration', loinc: '34068-7', text: CONCERTA_TABLE }],
  source: { label_title: 'CONCERTA TABLET', setid: 'c1' }
}]);

test('the index reaches the prompt even though the heading split declined', () => {
  assert.strictEqual(G.splitByPopulation(CONCERTA_TABLE).segments, null, 'the split cannot see a table');
  assert.ok(/DOSE FIGURES ABOVE, EACH WITH THE POPULATION NEAREST IT/.test(CONCERTA_BLOCK));
  assert.ok(/54 mg\/day {2}-> {2}pediatric/.test(CONCERTA_BLOCK));
});

test('it is marked derived, and the label text is declared to win over it', () => {
  assert.ok(/DERIVED, not label text/.test(CONCERTA_BLOCK));
  assert.ok(/THE SECTION TEXT WINS/.test(CONCERTA_BLOCK));
});

test('the section itself is still present in full, unchanged', () => {
  assert.ok(CONCERTA_BLOCK.indexOf(CONCERTA_TABLE) !== -1,
    'the index is additive; it may not replace or edit what the label says');
});

test('a non-dosing section gets no index', () => {
  const block = G.buildEvidenceBlock([{
    requested: 'Concerta', drug: 'Concerta',
    sections: [{ section: 'clinical_studies', loinc: '34092-8', text: CONCERTA_TABLE }],
    source: { label_title: 'CONCERTA TABLET', setid: 'c1' }
  }]);
  assert.ok(!/DOSE FIGURES ABOVE/.test(block));
});

// ---- a practice number still needs a source ------------------------------------------------
// Pass B, after the population tagging stopped Concerta borrowing the pediatric 54: one run in
// five answered "some clinical practice pushes to 108 mg/day in adults off-label". 108 mg/day
// is in no label and in no Tier 2 row. Rule 2 permits supplying PRACTICE from own knowledge, and
// the model took that literally and supplied a number. Describing the practice is the synthesis
// that rule protects; naming its figure is the invention it exists to stop.
const RULES = G.groundingRules(['dosing'], []);

test('a dose figure may not come from recall, however it is labelled', () => {
  assert.ok(/A NUMBER IS NOT SYNTHESIS/.test(RULES));
  assert.ok(/appears neither in the/.test(RULES) && /retrieved label nor in the clinical reference block/.test(RULES));
});

test('and saying off-label does not license one', () => {
  assert.ok(/does not license it/.test(RULES));
});

// The carve-out this must NOT undo. "Grounding exists to prevent invention. It does not exist
// to prevent synthesis" is the standing instruction, and a rule that silenced practice entirely
// would walk the answers back to the grounded uselessness that was already rejected once.
test('describing practice in words is still explicitly allowed', () => {
  assert.ok(/It does not exist to stop you/.test(RULES) && /SYNTHESIZING an answer/.test(RULES));
  assert.ok(/You may describe practice in words from your own/.test(RULES));
  assert.ok(/Describing the practice is useful/.test(RULES));
});

test('and the model is told what to say instead of a number it cannot source', () => {
  assert.ok(/some clinicians do exceed the/.test(RULES) && /no sourced figure for how far/.test(RULES));
});

// ---- the classifier missed how clinicians actually ask -------------------------------------
// "How high can I go on this?" returned needsMedicationFacts: false. No class matched, so no
// retrieval ran, so every Concerta answer in the whole audit came from the model's memory. The
// trail reported no gap, because nothing had ever been asked for. The pattern wanted "on the",
// "on her", "on his" or "on their"; the clinician wrote "on this".
[
  'How high can I go on this?',
  'how high can i go?',
  'Can I go up on this?',
  'Is there room to increase?',
  'How far can I push this?',
  'Should I go higher?',
  'How much can I give?',
  'Can we bump it up?',
  'Any headroom to titrate?'
].forEach((q) => {
  test(`a dosing question phrased as a clinician phrases it: ${q}`, () => {
    const c = G.classifyQuestion(q);
    assert.ok(c.needsMedicationFacts, 'no class means no retrieval and no gap reported');
    assert.ok(c.classes.indexOf('dosing') > -1);
  });
});

// The other half. Widening a phrase list is how everything becomes a medication question, and
// then every answer carries labeling it did not need.
[
  'What should I document for this visit?',
  'How is the patient doing?',
  'Can I go home now?',
  'What did today establish?',
  'Who else should I loop in?'
].forEach((q) => {
  test(`still not a medication question: ${q}`, () => {
    assert.ok(!G.classifyQuestion(q).needsMedicationFacts);
  });
});

// ---- a weight-based ceiling needs a documented weight --------------------------------------
// Pass B answered "4,200 mg/day" and "4,800 mg/day" as divalproex ceilings. The label gives
// 60 mg/kg/day; those are 70 kg and 80 kg. No weight appeared in the note. At 50 kg the ceiling
// is 3,000, so the answer overstated headroom by forty percent from a parameter nobody recorded.

test('no weight in the note means no weight', () => {
  assert.strictEqual(G.documentedWeight('Currently taking divalproex ER 1000 mg nightly.'), null);
  assert.strictEqual(G.documentedWeight('Taking 20 mg daily.'), null);
  assert.strictEqual(G.documentedWeight(''), null);
  assert.strictEqual(G.documentedWeight(null), null);
});

// THE TRAP. "60 mg/kg/day" contains "kg". Reading that as a documented weight would defeat the
// check on precisely the answers it exists for.
test('a mg/kg ceiling is not a documented weight', () => {
  assert.strictEqual(G.documentedWeight('The labeled maximum is 60 mg/kg/day.'), null);
  assert.strictEqual(G.documentedWeight('up to 2 mg/kg/day, not to exceed 100 mg'), null);
});

test('a weight the clinician wrote down is found, in either unit', () => {
  assert.strictEqual(G.documentedWeight('Weight 82 kg. divalproex ER 1000 mg nightly.'), '82 kg');
  assert.strictEqual(G.documentedWeight('Wt 154 lbs, stable.'), '154 lb');
  assert.strictEqual(G.documentedWeight('Max 60 mg/kg/day; weight 70 kg today.'), '70 kg',
    'a mg/kg figure in the same note must not hide a real weight');
});

const NO_WEIGHT = G.groundingRules(['dosing'], [], {});
const WITH_WEIGHT = G.groundingRules(['dosing'], [], { weight: '82 kg' });

test('with no weight documented, the gap is named', () => {
  assert.ok(/THIS ENCOUNTER DOCUMENTS NO WEIGHT/.test(NO_WEIGHT));
  assert.ok(/say the/.test(NO_WEIGHT) && /weight is not documented/.test(NO_WEIGHT));
});

// But conditional illustration is ALLOWED, and the first version of this rule wrongly banned it.
// "At 70 kg that would be 4,200 mg/day; at 60 kg, 3,600" names the weight each figure rests on,
// claims nothing about this patient, and shows why the missing number is worth going to get.
test('working it out at an explicitly named weight is permitted', () => {
  assert.ok(/You MAY work it out at a weight you name explicitly/.test(NO_WEIGHT));
  assert.ok(/nothing in it claims to be THIS patient/.test(NO_WEIGHT));
});

// The real line: whether the weight the figure rests on is stated beside it.
test('an unconditional range for "most adults" is still forbidden', () => {
  assert.ok(/for most adults/.test(NO_WEIGHT));
  assert.ok(/is not conditional at/.test(NO_WEIGHT));
  assert.ok(/whether the weight the/.test(NO_WEIGHT) && /figure rests on is stated beside it/.test(NO_WEIGHT));
});

test('it is told to name the weight as the missing input, not to refuse the question', () => {
  assert.ok(/Give the ceiling per kilogram/.test(NO_WEIGHT));
  assert.ok(/names the one thing to go look up/.test(NO_WEIGHT),
    'refusing to give any figure is the weaker answer, not the safer one');
});

test('with a weight documented, the conversion is allowed and must be shown', () => {
  assert.ok(/documents a weight of 82 kg/.test(WITH_WEIGHT));
  assert.ok(!/DOCUMENTS NO WEIGHT/.test(WITH_WEIGHT));
  assert.ok(/state the weight you used/.test(WITH_WEIGHT));
});

// Same category, caught by the same rule: 72 mg/day called "one 18 mg increment above 36 mg".
test('any calculated figure must show its inputs', () => {
  [NO_WEIGHT, WITH_WEIGHT].forEach((r) => {
    assert.ok(/SHOW THE INPUTS FOR ANY FIGURE YOU CALCULATE/.test(r));
    assert.ok(/the evidence contains its inputs and not the result/.test(r));
  });
});

test('the rules still build with no opts at all', () => {
  assert.ok(G.groundingRules(['dosing'], []).length > 0);
  assert.ok(G.groundingRules(['interaction'], []).length > 0);
});

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
