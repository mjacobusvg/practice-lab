// rx-vocabulary.js is generated from the interaction checker's MEDICATIONS dictionary. There is
// no build step in this repo, so the generated file is committed and this test is what stops it
// drifting: add a drug to the checker and forget to regenerate, and the Scribe silently cannot
// see it.
//
// It also pins the identity rule the vocabulary must NOT break.

const { execFileSync } = require('child_process');
const fs = require('fs');
const assert = require('assert');
const VOCAB = require('../rx-vocabulary.js');

let checks = 0, failures = 0;
function test(label, fn) {
  checks++;
  try { fn(); } catch (e) { failures++; console.error(`\nFAIL ${label}\n  ${e.message}`); }
}

test('the committed file matches what the generator produces', () => {
  const fresh = execFileSync('node', ['tools/gen-rx-vocabulary.js', '--stdout'], { encoding: 'utf8' });
  const onDisk = fs.readFileSync('rx-vocabulary.js', 'utf8');
  assert.strictEqual(fresh, onDisk,
    'rx-vocabulary.js is stale. Run: node tools/gen-rx-vocabulary.js');
});

test('every entry has at least one searchable term', () => {
  const dead = VOCAB.entries.filter((e) => !e.generics.length && !e.brands.length);
  assert.deepStrictEqual(dead, [], 'an entry nothing can match is invisible to detection');
});

test('IDENTITY: sibling brands are kept apart', () => {
  const mph = VOCAB.entries.find((e) => e.key === 'methylphenidate');
  assert.ok(mph.brands.indexOf('Ritalin') > -1 && mph.brands.indexOf('Concerta') > -1,
    'both products must be listed separately, not as the string "Ritalin/Concerta"');
  assert.ok(!mph.brands.some((b) => b.indexOf('/') > -1), 'no un-split brand strings');
});

test('no brand contains parenthetical noise or a placeholder', () => {
  VOCAB.entries.forEach((e) => e.brands.forEach((b) => {
    assert.ok(!/[()]/.test(b), `${e.key}: "${b}" still has parentheses`);
    assert.ok(!/^(n\/a|various|generic|otc|unknown)$/i.test(b), `${e.key}: "${b}" is not a brand`);
    assert.ok(b.length > 2, `${e.key}: "${b}" is too short to match safely`);
  }));
});

test('routes of administration are not mistaken for brand names', () => {
  const all = VOCAB.entries.reduce((a, e) => a.concat(e.brands), []);
  ['IV', 'IM', 'intranasal compounded', 'gel', 'injection', 'patch', 'dispensary products']
    .forEach((junk) => assert.ok(all.indexOf(junk) === -1, `"${junk}" leaked in as a brand`));
});

test('non-medications are flagged so they never reach a medication list', () => {
  ['tobacco_smoking', 'caffeine', 'alcohol_ethanol', 'grapefruit_juice'].forEach((k) => {
    const e = VOCAB.entries.find((x) => x.key === k);
    assert.ok(e, k + ' missing');
    assert.strictEqual(e.substance, true, k + ' must be marked as a substance');
  });
});

test('the vocabulary is a vocabulary, not a pharmacology dump', () => {
  const extra = new Set();
  VOCAB.entries.forEach((e) => Object.keys(e).forEach((k) => extra.add(k)));
  assert.deepStrictEqual([...extra].sort(), ['brands', 'cls', 'generics', 'key', 'substance'].sort(),
    'the checker owns CYP/QT/etc; shipping them into the Scribe is not this file’s job');
  assert.ok(fs.statSync('rx-vocabulary.js').size < 80 * 1024, 'stays small enough to ship to the Scribe');
});

test('it covers the whole checker dictionary', () => {
  const html = fs.readFileSync('pm-interaction-checker.html', 'utf8');
  const body = html.slice(html.indexOf('var MEDICATIONS = {'));
  const keys = new Set();
  const re = /\n"([a-z0-9_]+)":\s*\{/g;
  let m;
  while ((m = re.exec(body))) {
    const chunk = body.slice(m.index, m.index + 1500);
    if (/\bbrand:\s*"/.test(chunk)) keys.add(m[1]);
  }
  const have = new Set(VOCAB.entries.map((e) => e.key));
  const missing = [...keys].filter((k) => !have.has(k));
  assert.deepStrictEqual(missing, [], 'drugs in the checker but not the vocabulary');
  assert.strictEqual(VOCAB.count, VOCAB.entries.length);
});

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
