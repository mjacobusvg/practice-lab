// Medication confirmation: detection -> clinician decision -> tbpEncounterState.medications.
//
// The two properties that matter, both already responsible for a real wrong answer:
//
//   Nothing reaches medications.current without a clinician click. A dictionary hit is a
//   mention. "Previously stopped Concerta" must not become part of the regimen.
//
//   Specificity survives confirmation. "Adderall XR" stays "Adderall XR" in the stored record,
//   with the ingredient key alongside rather than instead. rxcui stays null and honest until
//   the RxNorm layer fills it.
//
// Plus the gate: the card must stay out of the way unless a medication-related task asks.

const { readFileSync } = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = readFileSync('ai-scribe-practice.html', 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const deepEq = (a, b, m) => assert.deepStrictEqual(plain(a), plain(b), m);

// The whole encounter block: store, result contract, medication logic, the card, and the context
// reader. The card's wiring IIFE no-ops when #meds-rows is absent, so it is safe to evaluate
// headlessly, and including it means these tests run the shipped code rather than a subset.
const i = html.indexOf('function TBP_ENCOUNTER_BLANK(){');
const j = html.indexOf('\nfunction tbpRsnUpdateCtx(');
assert.ok(i > 0 && j > i, 'could not slice the encounter-state + medication logic');
const CORE = html.slice(i, j);
['tbpMedApplyConfirmation', 'tbpMedScan', 'tbpMedConfirmationNeeded', 'getEncounterContext',
 'tbpRecordResult'].forEach((f) =>
  assert.ok(new RegExp('function ' + f + '\\b').test(CORE), 'slice is missing ' + f));

const VOCAB = require('../rx-vocabulary.js');
const DETECT = require('../rx-detect.js');

// getEncounterContext() reads the DOM; stub only what it touches, and feed the note text in.
function env(state = {}) {
  const els = {
    raw: { value: state.note || '' },
    context: { value: state.priorNote || '' },
    'hpi-out': { value: state.hpi || '' },
    'assess-out': { value: '' },
    'therapy-out': { value: '' },
    'plan-out': { value: state.plan || '' }
  };
  const sandbox = {
    console, Date, JSON, Math, Object,
    window: { TBP_RX_VOCAB: VOCAB, TBP_RX_DETECT: DETECT },
    document: { getElementById: (id) => els[id] || null, querySelectorAll: () => [] }
  };
  sandbox.TBP_RX_VOCAB = VOCAB;
  sandbox.TBP_RX_DETECT = DETECT;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(CORE, ctx);
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);

let checks = 0, failures = 0;
function test(label, fn) {
  checks++;
  try { fn(); } catch (e) { failures++; console.error(`\nFAIL ${label}\n  ${e.message}`); }
}

const NOTE = '34yo woman with ADHD, currently taking Adderall XR 20 mg every morning. '
  + 'PCP started fluoxetine 40 mg two weeks ago for anxiety. '
  + 'Previously stopped Concerta after five days due to headaches.';

// ---- scanning ----------------------------------------------------------------------------
test('the scan finds the three, with the right proposed statuses', () => {
  const ctx = env({ note: NOTE });
  const c = run(ctx, 'tbpMedScan()');
  assert.strictEqual(c.length, 3);
  const by = {}; c.forEach((x) => { by[x.rawName] = x; });
  assert.strictEqual(by['Adderall XR'].proposedStatus, 'current');
  assert.strictEqual(by['fluoxetine'].proposedStatus, 'current');
  assert.strictEqual(by['Concerta'].proposedStatus, 'historical');
});

test('the scan records which part of the encounter each came from', () => {
  const ctx = env({ note: 'Takes Adderall XR 20 mg.', priorNote: 'Was on lithium 900 mg.' });
  const c = run(ctx, 'tbpMedScan()');
  deepEq(c.find((x) => x.rawName === 'Adderall XR').sources, ["today's note"]);
  deepEq(c.find((x) => x.rawName === 'lithium').sources, ['last visit']);
});

test('a drug that is only in the PRIOR note is not presumed current today', () => {
  const ctx = env({ priorNote: 'Patient is currently taking sertraline 100 mg daily.' });
  const c = run(ctx, 'tbpMedScan()');
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].proposedStatus, 'unclear',
    'last visit’s present tense is not today’s present tense');
  assert.ok(/not yet confirmed for today/.test(c[0].statusReason));
});

test('outside records are not scanned', () => {
  const ctx = env({ note: 'Doing well.' });
  run(ctx, "tbpSources = [{name:'Neuropsych', text:'Patient was on haloperidol and lithium.', useForPrep:true}];");
  assert.strictEqual(run(ctx, 'tbpMedScan()').length, 0,
    'a drug named in a 40-page report is the weakest possible signal for a current-med list');
});

test('scanning with no vocabulary loaded yields nothing rather than guessing', () => {
  const ctx = env({ note: NOTE });
  run(ctx, 'window.TBP_RX_VOCAB = null; TBP_RX_VOCAB = null;');
  deepEq(run(ctx, 'tbpMedScan()'), []);
});

// ---- nothing is current without a click ------------------------------------------------------
test('scanning alone writes nothing to the store', () => {
  const ctx = env({ note: NOTE });
  run(ctx, 'tbpMedScan(); tbpMedScan();');
  deepEq(run(ctx, 'tbpEncounterState.medications.current'), []);
  assert.strictEqual(run(ctx, 'tbpEncounterState.medications.confirmedAt'), null);
  deepEq(run(ctx, 'getEncounterContext().medications.current'), []);
});

test('a historical drug the clinician did not promote never reaches current', () => {
  const ctx = env({ note: NOTE });
  run(ctx, `var rows = tbpMedScan().map(function(c){
    return Object.assign({}, c, { status: c.proposedStatus === 'historical' ? 'historical' : 'current' }); });
    tbpMedApplyConfirmation(rows, 'clinician');`);
  const cur = run(ctx, 'tbpEncounterState.medications.current').map((r) => r.rawName).sort();
  const hist = run(ctx, 'tbpEncounterState.medications.historical').map((r) => r.rawName);
  deepEq(cur, ['Adderall XR', 'fluoxetine']);
  deepEq(hist, ['Concerta']);
});

test('a row marked "not a medication" is dropped entirely', () => {
  const ctx = env({ note: NOTE });
  run(ctx, `tbpMedApplyConfirmation(tbpMedScan().map(function(c){
    return Object.assign({}, c, { status: c.rawName === 'Concerta' ? 'exclude' : 'current' }); }));`);
  const all = JSON.stringify(run(ctx, 'tbpEncounterState.medications'));
  assert.ok(!/Concerta/.test(all), 'excluded rows must not persist anywhere');
});

test('a row with no status is not silently defaulted to current', () => {
  const ctx = env({ note: NOTE });
  run(ctx, "tbpMedApplyConfirmation(tbpMedScan().map(function(c){ return Object.assign({}, c, {status:''}); }));");
  deepEq(run(ctx, 'tbpEncounterState.medications.current'), []);
  deepEq(run(ctx, 'tbpEncounterState.medications.historical'), []);
});

test('a blank-name row is ignored', () => {
  const ctx = env();
  run(ctx, "tbpMedApplyConfirmation([{rawName:'   ', status:'current'}, {rawName:'lithium', dose:'900 mg', status:'current'}]);");
  const cur = run(ctx, 'tbpEncounterState.medications.current');
  assert.strictEqual(cur.length, 1);
  assert.strictEqual(cur[0].rawName, 'lithium');
});

test('confirming replaces the list rather than appending to it', () => {
  const ctx = env();
  run(ctx, "tbpMedApplyConfirmation([{rawName:'lithium', status:'current'}]);");
  run(ctx, "tbpMedApplyConfirmation([{rawName:'lamotrigine', status:'current'}]);");
  const cur = run(ctx, 'tbpEncounterState.medications.current');
  assert.strictEqual(cur.length, 1, 'the card shows the whole list; confirming it is the whole truth');
  assert.strictEqual(cur[0].rawName, 'lamotrigine');
});

// ---- specificity survives -----------------------------------------------------------------------
test('THE IDENTITY RULE: the stored record keeps Adderall XR, and both identities', () => {
  const ctx = env({ note: NOTE });
  run(ctx, `tbpMedApplyConfirmation(tbpMedScan().filter(function(c){return c.rawName==='Adderall XR';})
    .map(function(c){ return Object.assign({}, c, {status:'current'}); }));`);
  const r = run(ctx, 'tbpEncounterState.medications.current[0]');
  assert.strictEqual(r.rawName, 'Adderall XR', 'never collapsed to Adderall');
  assert.strictEqual(r.brand, 'Adderall XR');
  assert.strictEqual(r.formulation, 'extended-release');
  assert.strictEqual(r.formulationSource, 'text');
  assert.strictEqual(r.dose, '20 mg');
  assert.strictEqual(r.interactionKey, 'amphetamine_mixed_salts', 'for the deterministic checker');
  assert.strictEqual(r.ingredient, 'amphetamine mixed salts');
  assert.strictEqual(r.status, 'current');
  assert.strictEqual(r.confirmedBy, 'clinician');
  assert.ok(r.confirmedAt > 0);
});

test('rxcui is null and identityStatus says so, rather than being guessed', () => {
  const ctx = env({ note: NOTE });
  run(ctx, "tbpMedApplyConfirmation([{rawName:'Adderall XR', interactionKey:'amphetamine_mixed_salts', status:'current'}]);");
  const r = run(ctx, 'tbpEncounterState.medications.current[0]');
  assert.strictEqual(r.rxcui, null);
  assert.strictEqual(r.identityStatus, 'unresolved',
    'the RxNorm layer fills this at grounding time; a guess here picks the wrong label');
});

test('a clinician edit to the name is what gets stored', () => {
  const ctx = env({ note: 'Takes Adderall 20 mg.' });
  run(ctx, `var rows = tbpMedScan().map(function(c){
    return Object.assign({}, c, { rawName: 'Adderall XR', status: 'current' }); });
    tbpMedApplyConfirmation(rows);`);
  assert.strictEqual(run(ctx, 'tbpEncounterState.medications.current[0].rawName'), 'Adderall XR');
});

test('a hand-added medication is a first-class record', () => {
  const ctx = env();
  run(ctx, "tbpMedApplyConfirmation([{rawName:'Vyvanse 40 mg', dose:'40 mg', status:'current'}]);");
  const r = run(ctx, 'tbpEncounterState.medications.current[0]');
  assert.strictEqual(r.rawName, 'Vyvanse 40 mg');
  assert.strictEqual(r.interactionKey, null, 'unmatched by the vocabulary, and says so');
  assert.strictEqual(r.identityStatus, 'unresolved');
});

test('the confirmed list does not alias the rows the card was editing', () => {
  const ctx = env();
  run(ctx, `var rows = [{rawName:'lithium', dose:'900 mg', status:'current', sources:['x']}];
            tbpMedApplyConfirmation(rows);
            rows[0].rawName = 'TAMPERED'; rows[0].sources.push('y');`);
  assert.strictEqual(run(ctx, 'tbpEncounterState.medications.current[0].rawName'), 'lithium');
  deepEq(run(ctx, 'tbpEncounterState.medications.current[0].sources'), ['x']);
});

// ---- the gate ------------------------------------------------------------------------------------
test('no purpose means the card never opens', () => {
  const ctx = env({ note: NOTE });
  assert.strictEqual(run(ctx, 'tbpMedConfirmationNeeded(null)'), null);
  assert.strictEqual(run(ctx, 'tbpMedConfirmationNeeded("")'), null,
    'a visit that never asks a medication question must never see this form');
});

test('a medication purpose with nothing confirmed asks once', () => {
  const ctx = env({ note: NOTE });
  assert.strictEqual(run(ctx, 'tbpMedConfirmationNeeded("interaction")'), 'never-confirmed');
});

test('once confirmed and unchanged it stops asking', () => {
  const ctx = env({ note: NOTE });
  run(ctx, `tbpMedApplyConfirmation(tbpMedScan().map(function(c){
    return Object.assign({}, c, {status: c.proposedStatus === 'historical' ? 'historical':'current'}); }));`);
  assert.strictEqual(run(ctx, 'tbpMedConfirmationNeeded("interaction")'), null,
    'this is the difference between a confirmation and a reconciliation chore');
});

test('a new drug documented after confirmation reopens it', () => {
  const ctx = env({ note: NOTE });
  run(ctx, `tbpMedApplyConfirmation(tbpMedScan().map(function(c){
    return Object.assign({}, c, {status: c.proposedStatus === 'historical' ? 'historical':'current'}); }));`);
  run(ctx, "document.getElementById('raw').value += ' Starting lamotrigine 25 mg tonight.';");
  assert.strictEqual(run(ctx, 'tbpMedConfirmationNeeded("interaction")'), 'new-since-confirmed');
  const fresh = run(ctx, 'tbpMedNewSinceConfirmation()');
  assert.strictEqual(fresh.length, 1);
  assert.strictEqual(fresh[0].rawName, 'lamotrigine');
});

test('a missing dose only matters when the question turns on dose', () => {
  const ctx = env();
  run(ctx, "tbpMedApplyConfirmation([{rawName:'Adderall XR', interactionKey:'amphetamine_mixed_salts', formulation:'extended-release', status:'current'}]);");
  assert.strictEqual(run(ctx, 'tbpMedConfirmationNeeded("interaction")'), null,
    'an interaction check does not need the dose, so do not stop for it');
  assert.strictEqual(run(ctx, 'tbpMedConfirmationNeeded("dose")'), 'ambiguous');
});

test('a missing release form only matters for a drug that has distinct ones', () => {
  const ctx = env();
  run(ctx, "tbpMedApplyConfirmation([{rawName:'Adderall', dose:'20 mg', interactionKey:'amphetamine_mixed_salts', status:'current'}]);");
  assert.strictEqual(run(ctx, 'tbpMedConfirmationNeeded("dose")'), 'ambiguous',
    'IR and XR have different labels and different maximums');
  const why = run(ctx, 'tbpMedAmbiguities("dose")');
  assert.ok(/release form/.test(why[0].issue));

  const ctx2 = env();
  run(ctx2, "tbpMedApplyConfirmation([{rawName:'sertraline', dose:'100 mg', interactionKey:'sertraline', status:'current'}]);");
  assert.strictEqual(run(ctx2, 'tbpMedConfirmationNeeded("dose")'), null,
    'sertraline has no formulation ambiguity worth interrupting for');
});

// ---- it flows into the rest of the architecture -----------------------------------------------------
test('confirmed meds reach a fresh snapshot', () => {
  const ctx = env({ note: NOTE });
  run(ctx, "tbpMedApplyConfirmation([{rawName:'Adderall XR', dose:'20 mg', status:'current'}]);");
  const snap = run(ctx, 'getEncounterContext().medications.current');
  assert.strictEqual(snap[0].rawName, 'Adderall XR');
});

test('changing the confirmed list makes a prior interaction result stale', () => {
  const ctx = env({ note: NOTE });
  run(ctx, "tbpMedApplyConfirmation([{rawName:'Adderall XR', dose:'20 mg', status:'current'},{rawName:'fluoxetine', dose:'40 mg', status:'current'}]);");
  run(ctx, `tbpRecordResult('interactions', { inputs: { medications: tbpEncounterState.medications.current },
             data: [{pair:'amphetamine + fluoxetine'}] });`);
  assert.strictEqual(run(ctx, "tbpLatestResult('interactions').status"), 'current');
  run(ctx, "tbpMedApplyConfirmation([{rawName:'Adderall XR', dose:'20 mg', status:'current'}]);");
  assert.strictEqual(run(ctx, "tbpLatestResult('interactions').status"), 'stale',
    'the whole point of the result contract, driven by a real med-list change');
});

test('bookkeeping fields do not participate in staleness', () => {
  const ctx = env();
  run(ctx, "tbpMedApplyConfirmation([{rawName:'lithium', dose:'900 mg', status:'current'}]);");
  run(ctx, "tbpRecordResult('monitoring', { inputs: { medications: tbpEncounterState.medications.current }, data: {} });");
  run(ctx, `tbpEncounterState.medications.current[0].confirmedAt = 1;
            tbpEncounterState.medications.current[0].sourceQuote = 'different quote';
            tbpEncounterState.medications.current[0].sources = ['somewhere else'];`);
  assert.strictEqual(run(ctx, "tbpLatestResult('monitoring').status"), 'current',
    'a quote or a timestamp is not a regimen change');
  run(ctx, "tbpEncounterState.medications.current[0].dose = '1200 mg';");
  assert.strictEqual(run(ctx, "tbpLatestResult('monitoring').status"), 'stale',
    'but a dose is');
});

test('re-confirming an identical list does not spuriously invalidate results', () => {
  const ctx = env();
  run(ctx, "tbpMedApplyConfirmation([{rawName:'lithium', dose:'900 mg', status:'current'}]);");
  run(ctx, `tbpRecordResult('monitoring', { inputs: { medications: tbpEncounterState.medications.current }, data: {} });`);
  run(ctx, "tbpMedApplyConfirmation([{rawName:'lithium', dose:'900 mg', status:'current'}]);");
  assert.strictEqual(run(ctx, "tbpLatestResult('monitoring').status"), 'current',
    'confirmedAt moves every time, so it must not be part of the fingerprint');
});

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
