// tbpEncounterState: the durable home for structured clinical information with no other
// authoritative home.
//
// The bug this exists to prevent: getEncounterContext() is a reader that builds a fresh object
// every call. A capability that writes its result into the returned snapshot loses it on the next
// call, silently. And structured state that vanishes on refresh while the prose note survives is
// the G.1 persistence bug in a new place.
//
// So these tests do not check that the store has the right keys. They check the two properties
// that actually matter: a write SURVIVES (the function returning, a fresh snapshot, and a reload),
// and a snapshot CANNOT write back.
//
// The save/reload test runs the real crash-recovery IIFE out of the page, not a reimplementation
// of it, because a reimplementation would pass while the shipped path stayed broken.

const { readFileSync } = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = readFileSync('ai-scribe-practice.html', 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const deepEq = (a, b, m) => assert.deepStrictEqual(plain(a), plain(b), m);

function slice(startNeedle, endNeedle, from = 0) {
  const i = html.indexOf(startNeedle, from);
  assert.ok(i >= 0, 'missing: ' + startNeedle);
  const j = html.indexOf(endNeedle, i);
  assert.ok(j >= 0, 'missing: ' + endNeedle);
  return html.slice(i, j + endNeedle.length);
}

// The store + the context reader.
const CORE = slice('function TBP_ENCOUNTER_BLANK(){', '\nfunction tbpRsnUpdateCtx(')
  .replace(/\nfunction tbpRsnUpdateCtx\($/, '');
// The actual autosave / restore IIFE, verbatim.
const DRAFT = slice('// ── Local crash-recovery', '\n})();');

assert.ok(/window\.tbpSaveDraft\s*=\s*save/.test(DRAFT), 'extracted the wrong block');
assert.ok(/enc:\s*\(function\(\)/.test(DRAFT), 'the draft collect() must persist encounter state');
assert.ok(/tbpEncounterRestore\(d\.enc\)/.test(DRAFT), 'the draft restore must rebuild encounter state');

// ---- sandbox --------------------------------------------------------------------------------
function makeEnv(opts = {}) {
  const store = Object.assign({}, opts.localStorage || {});
  const els = {};
  const el = (id) => (els[id] = els[id] || { value: '', innerHTML: '', style: {}, textContent: '',
                                             addEventListener() {}, scrollIntoView() {},
                                             classList: { contains: () => false } });
  ['raw', 'context', 'focus-note', 'recovery-banner', 'err-box', 'focus-ref', 'tbp-del-recovered'].forEach(el);

  const sandbox = {
    console,
    Date,
    JSON,
    location: { search: '?slot=' + (opts.slot || 'solo') },
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      _dump: () => store
    },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    setTimeout: (fn) => fn,      // autosave debounce: never fires on its own in the test
    clearTimeout: () => {},
    window: { addEventListener() {} }
  };
  sandbox.window.localStorage = sandbox.localStorage;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(CORE + '\n' + DRAFT, ctx);
  ctx._store = store;
  return ctx;
}

let checks = 0, failures = 0;
function test(label, fn) {
  checks++;
  try { fn(); } catch (e) { failures++; console.error(`\nFAIL ${label}\n  ${e.message}`); }
}
const run = (ctx, code) => vm.runInContext(code, ctx);

// Shape mirroring what renderPreflightCards actually builds and what pf-generate actually reads.
const QUESTIONS = JSON.stringify([
  { id: 'time', text: 'Which add-on code?', options: [] },
  { id: 'modality', text: 'Which modality?', options: [] },
  { id: 'clin_dx', text: 'Confirm today’s diagnoses', select: 'multi', options: [] },
  { id: 'clin_char', text: 'How would you characterize the presentation?', select: 'multi', options: [] }
]);
const ANSWERS = JSON.stringify({
  0: '90833 — 16-37 minutes',
  1: ['CBT — cognitive behavioral', 'MI — motivational interviewing'],
  2: ['F90.2 ADHD, combined type', 'F41.1 Generalized anxiety disorder', '(custom)'],
  3: []
});
const RECORD = `tbpRecordPreflight(${QUESTIONS}, ${ANSWERS}, ` +
  `{ modality: 'CBT + MI', code: '90833', timeChoice: '90833 — 16-37 minutes', noTherapy: false });`;

// ---- 1. a write survives the function that made it -------------------------------------------
test('confirmed preflight survives after the capture function returns', () => {
  const ctx = makeEnv();
  run(ctx, RECORD);
  const p = run(ctx, 'tbpEncounterState.preflight');
  deepEq(p.diagnoses, ['F90.2 ADHD, combined type', 'F41.1 Generalized anxiety disorder'],
    '(custom) placeholder must be dropped, real picks kept');
  deepEq(p.clinicalDecisions,
    [{ id: 'clin_char', question: 'How would you characterize the presentation?', selections: [] }],
    'non-dx clin_ questions are kept with their selections, including an empty one');
  deepEq(p.psychotherapy, { modality: 'CBT + MI', code: '90833', timeChoice: '90833 — 16-37 minutes', none: false });
  assert.ok(typeof p.confirmedAt === 'number' && p.confirmedAt > 0, 'confirmedAt must be stamped');
});

test('only clin_* questions become clinical decisions', () => {
  const ctx = makeEnv();
  run(ctx, RECORD);
  const ids = run(ctx, 'tbpEncounterState.preflight.clinicalDecisions.map(function(c){return c.id;})');
  deepEq(ids, ['clin_char'], 'time/modality are captured as psychotherapy, not as decisions');
});

test('a second confirmation replaces the first, it does not append', () => {
  const ctx = makeEnv();
  run(ctx, RECORD);
  run(ctx, `tbpRecordPreflight(${QUESTIONS}, ${JSON.stringify({ 2: ['F33.1 MDD, recurrent'] })}, { modality: '' });`);
  deepEq(run(ctx, 'tbpEncounterState.preflight.diagnoses'), ['F33.1 MDD, recurrent'],
    'changing an answer and regenerating must not stack two diagnosis lists');
});

test('capture tolerates junk without throwing', () => {
  const ctx = makeEnv();
  run(ctx, 'tbpRecordPreflight(null, null, null);');
  run(ctx, 'tbpRecordPreflight([{id:"clin_x"}], {0: undefined}, undefined);');
  deepEq(run(ctx, 'tbpEncounterState.preflight.diagnoses'), []);
});

// ---- 2. a fresh snapshot still contains it -----------------------------------------------------
test('a FRESH getEncounterContext() carries the confirmed state', () => {
  const ctx = makeEnv();
  run(ctx, RECORD);
  run(ctx, 'var a = getEncounterContext(); var b = getEncounterContext();');
  deepEq(run(ctx, 'a.preflight.diagnoses'), run(ctx, 'b.preflight.diagnoses'));
  deepEq(run(ctx, 'b.preflight.diagnoses'),
    ['F90.2 ADHD, combined type', 'F41.1 Generalized anxiety disorder'],
    'this is the whole point: the second snapshot must not come back empty');
});

test('results is reachable through a fresh snapshot after a capability writes it', () => {
  const ctx = makeEnv();
  run(ctx, "tbpEncounterState.results.interactions.push({pair:'fluoxetine+tramadol', severity:'major'});");
  deepEq(run(ctx, 'getEncounterContext().results.interactions'),
    [{ pair: 'fluoxetine+tramadol', severity: 'major' }]);
});

// ---- 3. a snapshot cannot write back ------------------------------------------------------------
test('mutating a snapshot cannot corrupt confirmed clinical state', () => {
  const ctx = makeEnv();
  run(ctx, RECORD);
  run(ctx, `
    var snap = getEncounterContext();
    snap.preflight.diagnoses.push('F20.0 Schizophrenia');
    snap.preflight.diagnoses[0] = 'WRONG';
    snap.preflight.psychotherapy.modality = 'WRONG';
    snap.preflight.clinicalDecisions[0].selections.push('WRONG');
    snap.results.interactions.push('WRONG');
    snap.medications.current.push('WRONG');
    snap.screeners.push('WRONG');
  `);
  deepEq(run(ctx, 'tbpEncounterState.preflight.diagnoses'),
    ['F90.2 ADHD, combined type', 'F41.1 Generalized anxiety disorder'],
    'a snapshot handed to a capability must be a copy all the way down');
  assert.strictEqual(run(ctx, 'tbpEncounterState.preflight.psychotherapy.modality'), 'CBT + MI');
  deepEq(run(ctx, 'tbpEncounterState.preflight.clinicalDecisions[0].selections'), []);
  deepEq(run(ctx, 'tbpEncounterState.results.interactions'), []);
  deepEq(run(ctx, 'tbpEncounterState.medications.current'), []);
  deepEq(run(ctx, 'tbpEncounterState.screeners'), []);
});

test('two snapshots do not share objects with each other', () => {
  const ctx = makeEnv();
  run(ctx, RECORD);
  run(ctx, "var x = getEncounterContext(); x.preflight.diagnoses.push('LEAK'); var y = getEncounterContext();");
  assert.strictEqual(run(ctx, 'y.preflight.diagnoses.indexOf("LEAK")'), -1);
});

// ---- 4. save / reload --------------------------------------------------------------------------
// Uses the real IIFE: window.tbpSaveDraft() writes localStorage, a NEW environment seeded with that
// localStorage runs window.tbpRestoreDraft(), exactly as a browser refresh does.
function saveThenReload(ctx) {
  run(ctx, 'window.tbpSaveDraft();');
  const dump = ctx._store;
  const key = Object.keys(dump).find((k) => k.indexOf('tbp_draft_') === 0);
  assert.ok(key, 'nothing was written to localStorage');
  const fresh = makeEnv({ localStorage: dump });
  run(fresh, 'window.tbpRestoreDraft();');
  return fresh;
}

test('confirmed preflight survives a reload', () => {
  const ctx = makeEnv();
  run(ctx, "document.getElementById('raw').value = 'patient reports better focus on 20mg';");
  run(ctx, RECORD);
  const fresh = saveThenReload(ctx);
  deepEq(run(fresh, 'tbpEncounterState.preflight.diagnoses'),
    ['F90.2 ADHD, combined type', 'F41.1 Generalized anxiety disorder'],
    'the prose note came back; the confirmed diagnoses must come back with it');
  deepEq(run(fresh, 'tbpEncounterState.preflight.psychotherapy'),
    { modality: 'CBT + MI', code: '90833', timeChoice: '90833 — 16-37 minutes', none: false });
  deepEq(run(fresh, 'getEncounterContext().preflight.diagnoses'),
    ['F90.2 ADHD, combined type', 'F41.1 Generalized anxiety disorder'],
    'and must be visible through a snapshot, not just in the store');
});

test('capability results survive a reload', () => {
  const ctx = makeEnv();
  run(ctx, "document.getElementById('raw').value = 'note';");
  run(ctx, "tbpEncounterState.results.interactions.push({pair:'A+B'}); tbpEncounterState.results.discern.push({q:'x',a:'y'});");
  const fresh = saveThenReload(ctx);
  deepEq(run(fresh, 'tbpEncounterState.results.interactions'), [{ pair: 'A+B' }]);
  deepEq(run(fresh, 'tbpEncounterState.results.discern'), [{ q: 'x', a: 'y' }]);
});

test('a result key added by a future capability is not dropped on reload', () => {
  const ctx = makeEnv();
  run(ctx, "document.getElementById('raw').value = 'note';");
  run(ctx, "tbpEncounterState.results.somethingNew = [{ok:1}];");
  const fresh = saveThenReload(ctx);
  deepEq(run(fresh, 'tbpEncounterState.results.somethingNew'), [{ ok: 1 }],
    'restore must not whitelist result keys, or a new capability silently loses its output');
});

test('confirmed state alone is enough to keep a draft (empty note)', () => {
  const ctx = makeEnv();
  run(ctx, RECORD);
  const fresh = saveThenReload(ctx);
  deepEq(run(fresh, 'tbpEncounterState.preflight.diagnoses'),
    ['F90.2 ADHD, combined type', 'F41.1 Generalized anxiety disorder'],
    'confirming preflight before typing must not be discarded as an empty draft');
});

test('an empty encounter does not write an enc blob', () => {
  const ctx = makeEnv();
  run(ctx, "document.getElementById('raw').value = 'just a note';");
  run(ctx, 'window.tbpSaveDraft();');
  const key = Object.keys(ctx._store).find((k) => k.indexOf('tbp_draft_') === 0);
  assert.strictEqual(JSON.parse(ctx._store[key]).enc, null);
});

test('restore from a draft saved before this feature existed', () => {
  const legacy = { 'tbp_draft_solo': JSON.stringify({ raw: 'old note', ts: Date.now() }) };
  const fresh = makeEnv({ localStorage: legacy });
  run(fresh, 'window.tbpRestoreDraft();');
  deepEq(run(fresh, 'tbpEncounterState'), run(fresh, 'TBP_ENCOUNTER_BLANK()'),
    'a draft with no enc key must restore to a clean blank, not throw or leave junk');
  assert.strictEqual(run(fresh, "document.getElementById('raw').value"), 'old note');
});

test('a corrupt enc blob cannot poison clinical state', () => {
  [ '"a string"', '[1,2,3]', 'null',
    '{"preflight":"nope","medications":42,"screeners":{"not":"an array"},"results":"no"}',
    '{"preflight":{"diagnoses":"F90.2","clinicalDecisions":null,"psychotherapy":[1,2]}}'
  ].forEach((bad) => {
    const store = { 'tbp_draft_solo': `{"raw":"n","ts":${Date.now()},"enc":${bad}}` };
    const fresh = makeEnv({ localStorage: store });
    run(fresh, 'window.tbpRestoreDraft();');
    const s = run(fresh, 'tbpEncounterState');
    assert.ok(Array.isArray(s.preflight.diagnoses), 'diagnoses must be an array for ' + bad);
    assert.ok(Array.isArray(s.preflight.clinicalDecisions), 'decisions must be an array for ' + bad);
    assert.ok(Array.isArray(s.screeners), 'screeners must be an array for ' + bad);
    assert.ok(Array.isArray(s.results.interactions), 'results.interactions must be an array for ' + bad);
    run(fresh, 'getEncounterContext();');   // must not throw
  });
});

test('reset clears everything', () => {
  const ctx = makeEnv();
  run(ctx, RECORD);
  run(ctx, "tbpEncounterState.results.discern.push('x'); tbpEncounterReset();");
  deepEq(run(ctx, 'tbpEncounterState'), run(ctx, 'TBP_ENCOUNTER_BLANK()'));
  assert.strictEqual(run(ctx, 'tbpEncounterHasContent()'), false);
});

// ---- 5. the wiring is actually in the page, not just in this test -----------------------------
test('the preflight Generate handler calls the capture', () => {
  assert.ok(/tbpRecordPreflight\(questions, pfState, \{ modality: modality, code: code, timeChoice: timeChoice, noTherapy: noTherapy \}\)/.test(html),
    'pf-generate must record the confirmation');
  const rec = html.indexOf('try { tbpRecordPreflight(questions, pfState');
  const gen = html.indexOf('generateNote(inp, scope, Object.assign({ clinBlock:');
  assert.ok(rec > 0 && gen > rec, 'the capture must run before generateNote, so a failed generation does not lose the confirmation');
});

test('clearVisit resets encounter state', () => {
  const body = html.slice(html.indexOf('function clearVisit(){'), html.indexOf('function clearVisit(){') + 1600);
  assert.ok(/tbpEncounterReset\(\)/.test(body), 'starting a new patient must not inherit the last one’s diagnoses');
});

test('deleting a recovered draft resets encounter state', () => {
  const i = html.indexOf('tbp-del-recovered');
  const body = html.slice(i, html.indexOf('</script>', i));
  assert.ok(/tbpEncounterReset\(\)/.test(body));
});

test('getEncounterContext is a reader, not the store', () => {
  const body = CORE.slice(CORE.indexOf('function getEncounterContext(){'));
  const fnEnd = body.indexOf('function renderCaseContext');
  const reader = body.slice(0, fnEnd);
  assert.ok(!/tbpEncounterState\s*(\.\w+)*\s*=[^=]/.test(reader),
    'getEncounterContext() must never assign into the store');
  assert.ok(/tbpEncClone\(tbpEncounterState\.results\)/.test(reader),
    'results must be handed out as a copy');
});

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
