// The result contract: a capability result records what was established AT A POINT against
// PARTICULAR INPUTS. It is never a standing fact about the patient.
//
// The bug being prevented is silent and clinical:
//   meds are A + B -> interaction check runs -> B is stopped -> the old findings are still there
//   -> Assessment/Plan reads them as describing the current regimen. Nothing errors.
//
// The whole defense is that staleness is evaluated on READ, in getEncounterContext(), so a
// consumer cannot forget to check. These tests exist to prove a consumer CANNOT be handed a
// result that looks current when it is not.

const { readFileSync } = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = readFileSync('ai-scribe-practice.html', 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const deepEq = (a, b, m) => assert.deepStrictEqual(plain(a), plain(b), m);

const i = html.indexOf('function TBP_ENCOUNTER_BLANK(){');
const j = html.indexOf('\nfunction tbpRsnUpdateCtx(');
assert.ok(i > 0 && j > i);
const CORE = html.slice(i, j);

function env() {
  const ctx = vm.createContext({
    console, Date, JSON, Math,
    window: {},
    document: { getElementById: () => null, querySelectorAll: () => [] }
  });
  vm.runInContext(CORE, ctx);
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);

let checks = 0, failures = 0;
function test(label, fn) {
  checks++;
  try { fn(); } catch (e) { failures++; console.error(`\nFAIL ${label}\n  ${e.message}`); }
}

const MEDS = "['Adderall XR 20 mg', 'fluoxetine 40 mg']";
function withCheck(ctx, meds = MEDS) {
  run(ctx, `tbpEncounterState.medications.current = ${meds};`);
  return run(ctx, `tbpRecordResult('interactions', {
    inputs: { medications: tbpEncounterState.medications.current },
    data: [{ pair: 'amphetamine + fluoxetine', severity: 'moderate' }],
    meta: { evidenceVersion: 'spl-2026-03' } });`);
}

// ---- the exact scenario ------------------------------------------------------------------------
test('THE SCENARIO: stopping a drug marks the prior interaction result stale', () => {
  const ctx = env();
  withCheck(ctx);
  assert.strictEqual(run(ctx, 'getEncounterContext().results.interactions[0].status'), 'current');

  run(ctx, "tbpEncounterState.medications.current = ['Adderall XR 20 mg'];");   // fluoxetine stopped
  assert.strictEqual(run(ctx, 'getEncounterContext().results.interactions[0].status'), 'stale',
    'a result computed against a regimen the patient is no longer on must not read as current');
  assert.strictEqual(run(ctx, "tbpLatestResult('interactions').status"), 'stale');
});

test('adding a drug also invalidates', () => {
  const ctx = env();
  withCheck(ctx);
  run(ctx, "tbpEncounterState.medications.current.push('tramadol 50 mg');");
  assert.strictEqual(run(ctx, 'getEncounterContext().results.interactions[0].status'), 'stale');
});

test('changing a dose invalidates', () => {
  const ctx = env();
  withCheck(ctx);
  run(ctx, "tbpEncounterState.medications.current[0] = 'Adderall XR 30 mg';");
  assert.strictEqual(run(ctx, 'getEncounterContext().results.interactions[0].status'), 'stale');
});

test('rerunning against the new regimen produces a current result', () => {
  const ctx = env();
  withCheck(ctx);
  run(ctx, "tbpEncounterState.medications.current = ['Adderall XR 20 mg'];");
  withCheck(ctx, "['Adderall XR 20 mg']");
  const list = run(ctx, 'getEncounterContext().results.interactions');
  assert.strictEqual(list.length, 2, 'the superseded result is kept, not overwritten');
  assert.strictEqual(list[0].status, 'stale', 'the old one stays visibly stale');
  assert.strictEqual(list[1].status, 'current');
  assert.strictEqual(run(ctx, "tbpLatestResult('interactions').status"), 'current');
});

// ---- what must NOT count as a change -------------------------------------------------------------
test('reordering the same medications is not a regimen change', () => {
  const ctx = env();
  withCheck(ctx);
  run(ctx, "tbpEncounterState.medications.current = ['fluoxetine 40 mg', 'Adderall XR 20 mg'];");
  assert.strictEqual(run(ctx, 'getEncounterContext().results.interactions[0].status'), 'current',
    'a medication set is a set; reordering must not force a spurious rerun');
});

test('case and spacing are not regimen changes', () => {
  const ctx = env();
  withCheck(ctx);
  run(ctx, "tbpEncounterState.medications.current = ['ADDERALL  XR 20 mg ', 'Fluoxetine 40 mg'];");
  assert.strictEqual(run(ctx, 'getEncounterContext().results.interactions[0].status'), 'current');
});

test('but a real formatting difference errs toward stale', () => {
  const ctx = env();
  withCheck(ctx);
  run(ctx, "tbpEncounterState.medications.current = ['Adderall XR 20mg', 'fluoxetine 40 mg'];");
  assert.strictEqual(run(ctx, 'getEncounterContext().results.interactions[0].status'), 'stale',
    'when unsure, rerunning is cheap and a wrong "current" is not');
});

test('an unrelated part of encounter state does not invalidate', () => {
  const ctx = env();
  withCheck(ctx);
  run(ctx, "tbpEncounterState.preflight.diagnoses = ['F90.2']; tbpEncounterState.screeners.push({x:1});");
  assert.strictEqual(run(ctx, 'getEncounterContext().results.interactions[0].status'), 'current',
    'only the inputs the capability declared may invalidate it');
});

test('meta does not participate in staleness', () => {
  const ctx = env();
  withCheck(ctx);
  const a = run(ctx, 'getEncounterContext().results.interactions[0].inputCanon');
  run(ctx, `tbpRecordResult('interactions', { inputs: { medications: tbpEncounterState.medications.current },
    data: [], meta: { evidenceVersion: 'spl-2026-09', note: 'different' } });`);
  const b = run(ctx, 'getEncounterContext().results.interactions[1].inputCanon');
  assert.strictEqual(a, b, 'provenance metadata is recorded, not fingerprinted');
});

test('a multi-input result invalidates on ANY of its inputs', () => {
  const ctx = env();
  run(ctx, "tbpEncounterState.medications.current = ['lithium 900 mg']; tbpEncounterState.preflight.diagnoses = ['F31.1'];");
  run(ctx, `tbpRecordResult('monitoring', { inputs: {
    medications: tbpEncounterState.medications.current,
    diagnoses: tbpEncounterState.preflight.diagnoses }, data: { labs: ['TSH','Cr'] } });`);
  assert.strictEqual(run(ctx, "tbpLatestResult('monitoring').status"), 'current');
  run(ctx, "tbpEncounterState.preflight.diagnoses = ['F31.1', 'F41.1'];");
  assert.strictEqual(run(ctx, "tbpLatestResult('monitoring').status"), 'stale',
    'monitoring depends on the diagnosis list too, and said so');
});

// ---- fail closed ----------------------------------------------------------------------------------
test('a result with no declared inputs is unknown, never current', () => {
  const ctx = env();
  run(ctx, "tbpRecordResult('discern', { data: { a: 'some answer' } });");
  assert.strictEqual(run(ctx, 'getEncounterContext().results.discern[0].status'), 'unknown');
});

test('a result naming an input this build cannot resolve is unknown', () => {
  const ctx = env();
  run(ctx, "tbpRecordResult('discern', { inputs: { somethingWeDoNotTrack: ['x'] }, data: {} });");
  assert.strictEqual(run(ctx, 'getEncounterContext().results.discern[0].status'), 'unknown',
    'an unverifiable record must not claim to be current');
});

test('an empty inputs object is unknown, not vacuously current', () => {
  const ctx = env();
  run(ctx, "tbpRecordResult('discern', { inputs: {}, data: {} });");
  assert.strictEqual(run(ctx, 'getEncounterContext().results.discern[0].status'), 'unknown');
});

test('a record with a tampered or missing canon cannot read as current', () => {
  const ctx = env();
  withCheck(ctx);
  run(ctx, 'delete tbpEncounterState.results.interactions[0].inputCanon;');
  assert.strictEqual(run(ctx, 'getEncounterContext().results.interactions[0].status'), 'unknown');
});

test('the stored canon is authoritative, not recomputed from inputs', () => {
  const ctx = env();
  withCheck(ctx);
  // Simulate a record whose stored canon does not match its own recorded inputs, which is what a
  // canonicalizer change across a deploy would look like. It must read stale, not current.
  run(ctx, "tbpEncounterState.results.interactions[0].inputCanon = 'something-from-an-older-build';");
  assert.strictEqual(run(ctx, 'getEncounterContext().results.interactions[0].status'), 'stale');
});

test('empty medication list is a real state, distinct from unknown', () => {
  const ctx = env();
  run(ctx, "tbpRecordResult('interactions', { inputs: { medications: [] }, data: [] });");
  assert.strictEqual(run(ctx, 'getEncounterContext().results.interactions[0].status'), 'current');
  run(ctx, "tbpEncounterState.medications.current = ['sertraline 50 mg'];");
  assert.strictEqual(run(ctx, 'getEncounterContext().results.interactions[0].status'), 'stale',
    'no meds -> some meds is a change');
});

// ---- provenance / review --------------------------------------------------------------------------
test('a record carries provenance a clinician can inspect', () => {
  const ctx = env();
  const rec = withCheck(ctx);
  assert.ok(rec.id, 'needs an id');
  assert.strictEqual(rec.capability, 'interactions');
  deepEq(rec.inputs.medications, ['Adderall XR 20 mg', 'fluoxetine 40 mg'],
    'the exact inputs, as used, not normalized for display');
  assert.ok(/^[0-9a-f]{8}$/.test(rec.fingerprint), 'a short tag for debug display');
  assert.strictEqual(rec.meta.evidenceVersion, 'spl-2026-03');
  assert.ok(rec.createdAt > 0);
  assert.strictEqual(rec.reviewed, false);
});

test('review is recorded and survives', () => {
  const ctx = env();
  const rec = withCheck(ctx);
  run(ctx, `tbpMarkResultReviewed('interactions', ${JSON.stringify(rec.id)});`);
  const v = run(ctx, 'getEncounterContext().results.interactions[0]');
  assert.strictEqual(v.reviewed, true);
  assert.ok(v.reviewedAt > 0);
});

test('reviewing does not make a stale result current', () => {
  const ctx = env();
  const rec = withCheck(ctx);
  run(ctx, `tbpMarkResultReviewed('interactions', ${JSON.stringify(rec.id)});`);
  run(ctx, "tbpEncounterState.medications.current = ['Adderall XR 20 mg'];");
  const v = run(ctx, 'getEncounterContext().results.interactions[0]');
  assert.strictEqual(v.reviewed, true);
  assert.strictEqual(v.status, 'stale',
    'a clinician signing off on a finding does not make it true of a regimen that changed afterwards');
});

// ---- isolation --------------------------------------------------------------------------------------
test('mutating a result snapshot cannot corrupt the store', () => {
  const ctx = env();
  withCheck(ctx);
  run(ctx, `var v = getEncounterContext();
            v.results.interactions[0].status = 'current';
            v.results.interactions[0].data.push('INJECTED');
            v.results.interactions[0].inputs.medications.push('INJECTED');`);
  run(ctx, "tbpEncounterState.medications.current = ['Adderall XR 20 mg'];");
  assert.strictEqual(run(ctx, 'getEncounterContext().results.interactions[0].status'), 'stale',
    'a consumer must not be able to overwrite its own staleness verdict');
  assert.strictEqual(run(ctx, 'tbpEncounterState.results.interactions[0].data.length'), 1);
  assert.strictEqual(run(ctx, 'tbpEncounterState.results.interactions[0].inputs.medications.length'), 2);
});

test('recording a result does not alias the caller’s arrays', () => {
  const ctx = env();
  run(ctx, `var live = ['a']; var d = ['finding'];
            tbpRecordResult('interactions', { inputs: { medications: live }, data: d });
            live.push('b'); d.push('another');`);
  deepEq(run(ctx, 'tbpEncounterState.results.interactions[0].inputs.medications'), ['a'],
    'the record must capture the inputs as they were at the time');
  deepEq(run(ctx, 'tbpEncounterState.results.interactions[0].data'), ['finding']);
});

// ---- canonicalization unit checks --------------------------------------------------------------------
test('canonicalization is order- and case-insensitive but value-sensitive', () => {
  const ctx = env();
  const c = (v) => run(ctx, `tbpCanonical(${JSON.stringify(v)})`);
  assert.strictEqual(c(['b', 'a']), c(['a', 'b']));
  assert.strictEqual(c({ x: 1, y: 2 }), c({ y: 2, x: 1 }));
  assert.strictEqual(c(['A  B']), c(['a b']));
  assert.notStrictEqual(c(['a']), c(['a', 'a']), 'a duplicated drug is a different list');
  assert.notStrictEqual(c(['20 mg']), c(['20mg']));
  assert.notStrictEqual(c([]), c(['a']));
  assert.notStrictEqual(c(null), c([]));
  assert.notStrictEqual(c('1'), c(1), 'a string must not canonicalize to the same thing as a number');
});

test('fingerprint is stable, short, and not used for the staleness decision', () => {
  const ctx = env();
  assert.strictEqual(run(ctx, "tbpFingerprint(['a','b'])"), run(ctx, "tbpFingerprint(['b','a'])"));
  assert.notStrictEqual(run(ctx, "tbpFingerprint(['a'])"), run(ctx, "tbpFingerprint(['b'])"));
  const src = CORE.slice(CORE.indexOf('function tbpResultStatus('));
  const fn = src.slice(0, src.indexOf('\nfunction '));
  assert.ok(!/fingerprint/i.test(fn), 'tbpResultStatus must compare canon strings, never the hash');
});

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
