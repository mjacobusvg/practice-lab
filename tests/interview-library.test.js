// The interview library's storage model.
//
// The risk this guards is DATA LOSS, not behaviour. The Vault save is a FULL REPLACE of the
// profile object, so a migration that drops a field destroys a clinician's interview, their note
// templates or their MSE macro permanently. Every test here is some version of "the thing that
// was there before is still there afterwards".

const L = require('../interview-library.js');
const assert = require('assert');

let checks = 0, failures = 0;
function test(label, fn) {
  checks++;
  try { fn(); } catch (e) { failures++; console.error(`\nFAIL ${label}\n  ${e.message}`); }
}

const LEGACY = '• Tell me about school.\n• When did it start?';
const PROFILE = { hpiTemplateEval: 'EVAL TPL', hpiTemplateFollowup: 'FU TPL',
                  hpiMseMacro: 'Affect is full range.', interview_adhd: LEGACY };

// ---- migration: the legacy interview always survives -----------------------------------------
test('a clinician with only the legacy interview gets it as their first library entry', () => {
  const list = L.migrate(PROFILE);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].key, 'interview_adhd');
  assert.strictEqual(list[0].text, LEGACY);
  assert.ok(list[0].name, 'it must be named, or it cannot be picked');
});

test('the legacy interview goes FIRST, not appended after later ones', () => {
  const list = L.migrate({ interview_adhd: LEGACY,
    interviews: [{ key: 'interview_ocd', name: 'OCD', text: '• x' }] });
  assert.strictEqual(list[0].key, 'interview_adhd');
  assert.strictEqual(list.length, 2);
});

// The shape that would silently destroy an interview: the list exists and names the key, but the
// body was lost somewhere. The legacy field is the surviving copy and must win.
test('a list entry that lost its text recovers it from the legacy field', () => {
  const list = L.migrate({ interview_adhd: LEGACY,
    interviews: [{ key: 'interview_adhd', name: 'Mine', text: '' }] });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].text, LEGACY);
  assert.strictEqual(list[0].name, 'Mine', 'but the name they chose is not overwritten');
});

test('a list entry that HAS text is not clobbered by the legacy field', () => {
  const list = L.migrate({ interview_adhd: 'old', 
    interviews: [{ key: 'interview_adhd', name: 'Mine', text: 'new' }] });
  assert.strictEqual(list[0].text, 'new');
});

test('an empty legacy field creates no entry', () => {
  assert.strictEqual(L.migrate({ interview_adhd: '   ' }).length, 0);
  assert.strictEqual(L.migrate({}).length, 0);
});

test('garbage does not throw', () => {
  [null, undefined, 'string', 42, { interviews: 'nope' }, { interviews: [null, 3, {}] }]
    .forEach((v) => assert.ok(Array.isArray(L.migrate(v))));
});

test('duplicate keys collapse to the first', () => {
  const list = L.migrate({ interviews: [
    { key: 'a', name: 'first', text: '1' }, { key: 'a', name: 'second', text: '2' }] });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].text, '1');
});

// ---- serialize: merge, never replace ---------------------------------------------------------
test('every other Vault field survives a save', () => {
  const v = L.serialize(PROFILE, L.migrate(PROFILE));
  assert.strictEqual(v.hpiTemplateEval, 'EVAL TPL');
  assert.strictEqual(v.hpiTemplateFollowup, 'FU TPL');
  assert.strictEqual(v.hpiMseMacro, 'Affect is full range.',
    'the save is a full replace; dropping this destroys the MSE macro');
});

// Rollback insurance: if this release is reverted, the old code looks for interview_adhd.
test('the legacy field keeps mirroring the ADHD entry, for rollback', () => {
  const list = L.upsert(L.migrate(PROFILE), 'interview_adhd', 'My ADHD interview', 'EDITED');
  assert.strictEqual(L.serialize(PROFILE, list).interview_adhd, 'EDITED');
});

test('deleting the ADHD interview empties the legacy field rather than leaving a ghost', () => {
  const v = L.serialize(PROFILE, L.remove(L.migrate(PROFILE), 'interview_adhd'));
  assert.strictEqual(v.interview_adhd, '');
  assert.strictEqual(v.interviews.length, 0);
});

test('a library with no ADHD entry does not invent a legacy field', () => {
  const v = L.serialize({}, [{ key: 'interview_ocd', name: 'OCD', text: '• x' }]);
  assert.ok(!('interview_adhd' in v));
});

test('migrate -> serialize -> migrate is stable', () => {
  const once = L.migrate(PROFILE);
  const twice = L.migrate(L.serialize(PROFILE, once));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(twice)), JSON.parse(JSON.stringify(once)));
});

// ---- keys ------------------------------------------------------------------------------------
test('keys are derived from the name and made unique', () => {
  assert.strictEqual(L.keyFor('Adult ADHD evaluation', []), 'interview_adult_adhd_evaluation');
  assert.strictEqual(L.keyFor('Adult ADHD evaluation', ['interview_adult_adhd_evaluation']),
    'interview_adult_adhd_evaluation_2');
  assert.ok(L.keyFor('', []).length > 0, 'an unnamed interview still gets a key');
  assert.ok(L.keyFor('!!! ???', []).length > 0, 'and so does a name with no usable characters');
});

// THE ONE THAT MATTERS MOST. A visit refers to an interview by key. If a rename moved the key,
// a saved visit would load a different interview, or none, with no error anywhere.
test('renaming does NOT change the key', () => {
  const list = L.upsert([], null, 'Adult ADHD', '• x');
  const key = list[0].key;
  const renamed = L.rename(list, key, 'Completely Different Name');
  assert.strictEqual(renamed[0].key, key);
  assert.strictEqual(renamed[0].name, 'Completely Different Name');
});

test('renaming to blank is ignored rather than erasing the name', () => {
  const list = L.upsert([], null, 'Adult ADHD', '• x');
  assert.strictEqual(L.rename(list, list[0].key, '   ')[0].name, 'Adult ADHD');
});

// ---- selection -------------------------------------------------------------------------------
test('a selection pointing at a deleted interview falls back instead of loading nothing', () => {
  const list = L.upsert([], 'interview_ocd', 'OCD', '• x');
  assert.strictEqual(L.resolveSelection(list, 'interview_gone'), 'interview_ocd');
});
test('an empty library resolves to nothing, so the house interview is used as today', () => {
  assert.strictEqual(L.resolveSelection([], 'anything'), null);
  assert.strictEqual(L.resolveSelection(null, null), null);
});
test('a valid selection is respected', () => {
  const list = L.upsert(L.upsert([], 'a', 'A', '1'), 'b', 'B', '2');
  assert.strictEqual(L.resolveSelection(list, 'b'), 'b');
});

// The original code deliberately refused to ask a clinician to choose before they had made
// anything. One interview is still not a choice.
test('no picker until there is something to choose between', () => {
  assert.strictEqual(L.needsPicker([]), false);
  assert.strictEqual(L.needsPicker(L.migrate(PROFILE)), false);
  assert.strictEqual(L.needsPicker(L.upsert(L.migrate(PROFILE), null, 'Second', '• y')), true);
});

// ---- upsert ----------------------------------------------------------------------------------
test('upsert on an existing key edits in place and keeps position', () => {
  let list = L.upsert([], 'a', 'A', '1');
  list = L.upsert(list, 'b', 'B', '2');
  list = L.upsert(list, 'a', 'A renamed', 'EDITED');
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].key, 'a');
  assert.strictEqual(list[0].text, 'EDITED');
});
test('upsert does not mutate the list it was given', () => {
  const before = L.migrate(PROFILE);
  const n = before.length;
  L.upsert(before, null, 'New one', '• z');
  assert.strictEqual(before.length, n);
});

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
