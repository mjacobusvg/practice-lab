// The structural claims CLINICAL-ONTOLOGY.md tags as ENFORCED.
//
// A document asserting "this is enforced in code" decays into fiction the moment someone adds a
// second writer or a shortcut. These tests make the ENFORCED tags executable, so the ontology
// either stays true or the build goes red.
//
// Only the claims that can be checked STRUCTURALLY live here. The behavioural ones are already
// covered where they belong: result staleness in result-contract, mention-vs-current in
// rx-detect, confirmation authority in med-confirmation. This file is the anti-drift layer.

const { readFileSync, existsSync } = require('fs');
const assert = require('assert');

const html = readFileSync('ai-scribe-practice.html', 'utf8');
const doc = readFileSync('CLINICAL-ONTOLOGY.md', 'utf8');

let checks = 0, failures = 0;
function test(label, fn) {
  checks++;
  try { fn(); } catch (e) { failures++; console.error(`\nFAIL ${label}\n  ${e.message}`); }
}

// Which function contains a given source offset.
function enclosingFunction(offset) {
  const before = html.slice(0, offset);
  const m = before.match(/\nfunction ([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{(?![\s\S]*\nfunction )/);
  return m ? m[1] : null;
}
function writersOf(pattern) {
  const re = new RegExp(pattern, 'g');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ fn: enclosingFunction(m.index), at: m.index, text: m[0] });
  return out;
}

// ---- I-1: only a confirmation act establishes clinical state -------------------------------
test('ENFORCED: medications.current has exactly one writer, the confirmation', () => {
  const w = writersOf('tbpEncounterState\\.medications\\.(current|historical)\\s*(=[^=]|\\.push)');
  assert.ok(w.length, 'no writer found at all, which means the pattern is wrong');
  const fns = [...new Set(w.map((x) => x.fn))];
  assert.deepStrictEqual(fns, ['tbpMedApplyConfirmation'],
    'a second path into the confirmed medication list breaks I-1: ' + fns.join(', '));
});

test('ENFORCED: preflight state has exactly one writer, the confirmation capture', () => {
  const w = writersOf('tbpEncounterState\\.preflight\\s*(=[^=]|\\.\\w+\\s*(=[^=]|\\.push))');
  assert.ok(w.length);
  const fns = [...new Set(w.map((x) => x.fn))].filter((f) => f !== 'tbpEncounterRestore');
  assert.deepStrictEqual(fns, ['tbpRecordPreflight'],
    'preflight state must only be established by the Generate-click capture: ' + fns.join(', '));
});

test('ENFORCED: the confirmation capture runs BEFORE the work that consumes it', () => {
  const rec = html.indexOf('tbpRecordPreflight(questions, pfState');
  const gen = html.indexOf('generateNote(inp, scope, Object.assign({ clinBlock:');
  assert.ok(rec > 0 && gen > rec,
    'a failed generation must not discard a confirmation that really happened');
});

// ---- I-2: state flows one way ----------------------------------------------------------------
test('ENFORCED: getEncounterContext is a reader and never assigns into the store', () => {
  const i = html.indexOf('function getEncounterContext(){');
  const j = html.indexOf('function renderCaseContext', i);
  assert.ok(i > 0 && j > i);
  const body = html.slice(i, j);
  const writes = body.match(/tbpEncounterState[\w.]*\s*=[^=]/g);
  assert.strictEqual(writes, null, 'the reader must not become the store: ' + writes);
});

test('ENFORCED: the renderer is the only thing that turns context into prose', () => {
  const i = html.indexOf('function renderCaseContext(ctx){');
  const j = html.indexOf('function tbpCaseContext()', i);
  const body = html.slice(i, j);
  assert.ok(!/document\.getElementById|tbpEncounterState/.test(body),
    'renderCaseContext must render the ctx it is handed, not re-read state behind it');
});

// ---- I-3: unresolved stays unresolved ------------------------------------------------------------
test('ENFORCED: fields with no writer are declared, not silently absent', () => {
  const i = html.indexOf('unresolved: {');
  const body = html.slice(i, html.indexOf('}', i));
  ['medicationChanges', 'adverseEffects', 'vitals', 'labs', 'screenersCompleted']
    .forEach((k) => assert.ok(body.indexOf(k) > -1, 'unresolved must still declare ' + k));
  // Anything that gains a writer must LEAVE unresolved, or the declaration is a lie.
  ['diagnoses:', 'medications:'].forEach((k) =>
    assert.ok(body.indexOf(k) === -1, k + ' has a writer and must not be listed as a gap'));
});

test('ENFORCED: rxcui is never populated by detection', () => {
  const i = html.indexOf('function tbpMedRecord(');
  const body = html.slice(i, html.indexOf('\nfunction ', i + 10));
  assert.ok(/rxcui:\s*c\.rxcui \|\| null/.test(body), 'rxcui may only come from a resolver');
  assert.ok(/identityStatus:\s*c\.rxcui \?/.test(body), 'identityStatus must reflect it honestly');
  const det = readFileSync('rx-detect.js', 'utf8');
  assert.ok(!/rxcui/.test(det), 'the detector must never invent an RxCUI');
});

// ---- I-4 / I-5: fail closed, keep specificity -----------------------------------------------------
test('ENFORCED: an unverifiable result reads unknown, never current', () => {
  const i = html.indexOf('function tbpResultStatus(');
  const body = html.slice(i, html.indexOf('\nfunction ', i + 10));
  assert.ok(!/return 'current'/.test(body.split("return 'unknown'").slice(0, -1).join('')) ||
            /=== rec\.inputCanon\) \? 'current' : 'stale'/.test(body),
    "'current' may only be returned from an actual canon comparison");
  assert.ok((body.match(/return 'unknown'/g) || []).length >= 3, 'every unverifiable path fails closed');
});

test('ENFORCED: the detector never writes a status, only a proposed one', () => {
  const det = readFileSync('rx-detect.js', 'utf8');
  assert.ok(/proposedStatus:/.test(det));
  assert.ok(!/^\s*status:/m.test(det), 'detection may not emit a settled status');
  assert.ok(!/confirmedBy/.test(det), 'detection may not claim confirmation');
});

test('ENFORCED: the vocabulary carries no pharmacology, and keeps sibling brands apart', () => {
  const vocab = require('../rx-vocabulary.js');
  const mph = vocab.entries.find((e) => e.key === 'methylphenidate');
  assert.ok(mph.brands.includes('Ritalin') && mph.brands.includes('Concerta'));
  assert.ok(!mph.brands.some((b) => b.includes('/')), 'no collapsed brand strings');
});

// ---- the document itself ------------------------------------------------------------------------
test('every ontology claim carries a provenance tag', () => {
  // Headed claims are the ones that bind. Each numbered invariant must say how it is known.
  const invariants = doc.match(/^### I-\d+\..*$/gm) || [];
  assert.ok(invariants.length >= 6, 'expected the universal invariants to be present');
  invariants.forEach((line) =>
    assert.ok(/\*\*(ENFORCED|DECIDED|INFERRED|OPEN)\*\*/.test(line), 'untagged invariant: ' + line));
});

test('decisions and open items are both findable in one place', () => {
  assert.ok(/# 8\. Decisions log, and what is still open/.test(doc), 'the log must exist');
  // Every fork raised must show a resolution in the log, so none can quietly go missing.
  ['working artifact', 'medication history', 'patient-reported', 'medications.changes',
   'summary substituting', 'confirmation lifetime', 'combination products']
    .forEach((f) => assert.ok(doc.indexOf(f) > -1, 'fork dropped from the log: ' + f));
  assert.ok(/## Still open/.test(doc), 'remaining open items must stay visible');
});

test('the load-bearing prohibition is explicit', () => {
  // The single most dangerous thing a future session could add "helpfully": a canonical
  // `failed` medication state, which launders the conclusion being evaluated into state.
  assert.ok(/Do not solve medication-history granularity by adding a canonical/.test(doc),
    'the failed-state prohibition must be stated as a prohibition');
  assert.ok(/dimensions, not buckets/i.test(doc), 'and the replacement must be named');
});

test('the three layers are stated as a hierarchy', () => {
  ['SOURCE MATERIAL', 'DERIVED ARTIFACT', 'CANONICAL ENCOUNTER ASSERTION']
    .forEach((l) => assert.ok(doc.indexOf(l) > -1, 'missing layer: ' + l));
});

test('ENFORCED: the context states each field layer as data, not prose', () => {
  const i = html.indexOf('provenance: {');
  assert.ok(i > 0, 'ctx.provenance must exist');
  const body = html.slice(i, html.indexOf('\n    },', i));
  ['note:', 'drafted:', 'framework:', 'results:', 'preflight:', 'medications:']
    .forEach((k) => assert.ok(body.indexOf(k) > -1, 'provenance missing ' + k));
  assert.ok(/framework:[\s\S]*?authority: 'noncanonical'/.test(body),
    'the framework is a derived artifact however its sections are named');
  assert.ok(/medications:[\s\S]*?authority: 'canonical'/.test(body));
});

test('ENFORCED: a review is marked as a derived summary, not as the document', () => {
  assert.ok(/reviewLayer: d\.review \? 'derived' : null/.test(html),
    'a consumer must be able to tell it is reasoning over a summary');
});

test('the ontology is referenced from CLAUDE.md, or nobody will read it', () => {
  assert.ok(existsSync('CLAUDE.md'));
  assert.ok(/CLINICAL-ONTOLOGY\.md/.test(readFileSync('CLAUDE.md', 'utf8')),
    'an unreferenced doc is a doc that does not exist');
});

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
