// Medication candidate detection.
//
// Two invariants, both of which have already burned us once:
//
//   IDENTITY   "Adderall XR" must not become "Adderall", and Concerta must not become Ritalin.
//              The ingredient-level interaction key rides alongside the written name, never
//              replaces it. Collapsing the formulation is what produced a hallucinated 30 mg
//              maximum from the wrong label.
//
//   MENTION    A dictionary hit means a drug was MENTIONED. "Stopped fluoxetine six months ago"
//              is a mention. Nothing here may put a drug on the current list.

const VOCAB = require('../rx-vocabulary.js');
const { detect } = require('../rx-detect.js');
const assert = require('assert');

let checks = 0, failures = 0;
function test(label, fn) {
  checks++;
  try { fn(); } catch (e) { failures++; console.error(`\nFAIL ${label}\n  ${e.message}`); }
}
const run = (text, opts) => detect(text, Object.assign({ vocab: VOCAB }, opts || {}));
const one = (text) => { const r = run(text); assert.strictEqual(r.length, 1, `expected 1 candidate, got ${r.length}: ${r.map(c => c.rawName)}`); return r[0]; };

// ---- IDENTITY: specificity must survive ---------------------------------------------------
test('Adderall XR is not collapsed to Adderall', () => {
  const c = one('Continue Adderall XR 20 mg qam.');
  assert.strictEqual(c.rawName, 'Adderall XR', 'the written product name is the identity');
  assert.strictEqual(c.formulation, 'extended-release');
  assert.strictEqual(c.formulationSource, 'text');
  assert.strictEqual(c.interactionKey, 'amphetamine_mixed_salts', 'ingredient key rides alongside');
  assert.strictEqual(c.dose, '20 mg');
});

test('Adderall IR and Adderall XR are different medications', () => {
  const r = run('Was on Adderall IR 10 mg, switched to Adderall XR 20 mg.');
  const names = r.map((c) => c.rawName).sort();
  assert.deepStrictEqual(names, ['Adderall IR', 'Adderall XR']);
  assert.strictEqual(r.filter((c) => c.formulation === 'immediate-release').length, 1);
  assert.strictEqual(r.filter((c) => c.formulation === 'extended-release').length, 1);
});

test('Concerta stays Concerta and is not renamed Ritalin', () => {
  const c = one('Restarted Concerta 36 mg daily.');
  assert.strictEqual(c.rawName, 'Concerta');
  assert.strictEqual(c.brand, 'Concerta');
  assert.strictEqual(c.interactionKey, 'methylphenidate');
  assert.ok(!/ritalin/i.test(JSON.stringify(c)), 'the sibling brand must never appear');
});

test('Concerta and Ritalin are separate candidates despite one interaction key', () => {
  const r = run('Takes Concerta 36 mg. Also has Ritalin 10 mg for afternoons.');
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r.map((c) => c.rawName).sort(), ['Concerta', 'Ritalin']);
  assert.ok(r.every((c) => c.interactionKey === 'methylphenidate'), 'both map to one key for the checker');
});

test('a generic mention is labeled generic and carries no invented brand', () => {
  const c = one('On methylphenidate 20 mg.');
  assert.strictEqual(c.matchedAs, 'generic');
  assert.strictEqual(c.brand, null, 'must not fill in a brand the clinician did not write');
});

test('formulation is never inferred from the ingredient', () => {
  const c = one('Takes Adderall 10 mg bid.');
  assert.strictEqual(c.rawName, 'Adderall');
  assert.strictEqual(c.formulation, null, 'bare Adderall has no formulation; guessing one picks the wrong label');
  assert.strictEqual(c.formulationSource, null);
});

test('release-form modifiers are recognized across products', () => {
  [['Wellbutrin XL 300 mg', 'extended-release'], ['Wellbutrin-SR 150 mg', 'sustained-release'],
   ['Effexor XR 75 mg', 'extended-release'], ['Zyprexa ODT 5 mg', 'orally disintegrating']]
    .forEach(([text, want]) => {
      const c = one('Patient takes ' + text + '.');
      assert.strictEqual(c.formulation, want, text);
      assert.ok(/(XL|SR|XR|ODT)$/.test(c.rawName), 'the modifier stays in the name: ' + c.rawName);
    });
});

test('longest term wins so a multi-word generic is not shredded', () => {
  const c = one('On mixed amphetamine salts 20 mg.');
  assert.strictEqual(c.matchedTerm, 'mixed amphetamine salts');
  assert.strictEqual(c.interactionKey, 'amphetamine_mixed_salts');
});

// ---- MENTION is not CURRENT -----------------------------------------------------------------
test('stopped is historical', () => {
  assert.strictEqual(one('Stopped fluoxetine six months ago.').proposedStatus, 'historical');
});
test('previously failed is historical', () => {
  assert.strictEqual(one('Previously failed Concerta after five days.').proposedStatus, 'historical');
});
test('d/c is historical', () => {
  assert.strictEqual(one("Sertraline was d/c'd due to GI upset.").proposedStatus, 'historical');
});
test('history of is historical', () => {
  assert.strictEqual(one('History of lithium use in her twenties.').proposedStatus, 'historical');
});
test('tried and did not tolerate is historical', () => {
  assert.strictEqual(one('Tried bupropion, did not tolerate it.').proposedStatus, 'historical');
});
test('currently taking is current', () => {
  assert.strictEqual(one('Currently taking Adderall XR 20 mg.').proposedStatus, 'current');
});
test('started N ago is CURRENT, not historical', () => {
  const c = one('PCP started fluoxetine 40 mg two weeks ago.');
  assert.strictEqual(c.proposedStatus, 'current',
    'a past-tense time marker on a start is not a stop');
});
test('continues on is current', () => {
  assert.strictEqual(one('Continues on lamotrigine 200 mg.').proposedStatus, 'current');
});
test('a bare mention with no cue is unclear, not current', () => {
  const c = one('We discussed lithium as a future option.');
  assert.strictEqual(c.proposedStatus, 'unclear');
  assert.ok(/no clear indication/.test(c.statusReason));
});

test('THE LEAK: a cue in the next sentence cannot reclassify this one', () => {
  const r = run('PCP started fluoxetine 40 mg two weeks ago. Previously stopped Concerta after five days.');
  const flx = r.find((c) => c.interactionKey === 'fluoxetine');
  const mph = r.find((c) => c.interactionKey === 'methylphenidate');
  assert.strictEqual(flx.proposedStatus, 'current', 'the next sentence must not leak in');
  assert.strictEqual(mph.proposedStatus, 'historical');
});

test('a cue in the previous sentence cannot leak forward', () => {
  const r = run('Stopped sertraline last year. Takes Adderall XR 20 mg now.');
  assert.strictEqual(r.find((c) => c.interactionKey === 'sertraline').proposedStatus, 'historical');
  assert.strictEqual(r.find((c) => c.interactionKey === 'amphetamine_mixed_salts').proposedStatus, 'current');
});

test('newline-separated list lines are independent', () => {
  const r = run('MEDICATIONS\nAdderall XR 20 mg - current\nfluoxetine 40 mg - current\nConcerta - stopped 2024');
  assert.strictEqual(r.find((c) => c.rawName === 'Concerta').proposedStatus, 'historical');
  assert.strictEqual(r.find((c) => c.rawName === 'Adderall XR').proposedStatus, 'current');
});

test('no candidate is ever emitted already marked as confirmed-current', () => {
  const r = run('Currently taking Adderall XR 20 mg and fluoxetine 40 mg.');
  r.forEach((c) => {
    assert.ok(!('status' in c), 'detection emits proposedStatus only; status is the clinician’s word');
    assert.ok(!('confirmedBy' in c));
  });
});

// ---- detail extraction ------------------------------------------------------------------------
test('dose, route and frequency come off the text', () => {
  const c = one('Takes sertraline 100 mg PO daily.');
  assert.strictEqual(c.dose, '100 mg');
  assert.strictEqual(c.route, 'oral');
  assert.strictEqual(c.frequency, 'daily');
});
test('combination-product dose is kept whole', () => {
  const c = one('On Suboxone 8 mg/2 mg sublingual.');
  assert.strictEqual(c.dose, '8 mg/2 mg');
  assert.strictEqual(c.route, 'sublingual');
});
test('mcg and unit doses', () => {
  assert.strictEqual(one('Synthroid 75 mcg daily.').dose, '75 mcg');
  assert.strictEqual(one('Lantus 20 units nightly.').dose, '20 units');
});
test('a dose belonging to the NEXT drug is not stolen', () => {
  const r = run('Takes fluoxetine, lithium 900 mg nightly.');
  assert.strictEqual(r.find((c) => c.interactionKey === 'fluoxetine').dose, null);
  assert.strictEqual(r.find((c) => c.interactionKey === 'lithium').dose, '900 mg');
});
test('the quote is the sentence, for the clinician to eyeball', () => {
  const c = one('Patient reports good response to Adderall XR 20 mg each morning.');
  assert.ok(/good response/.test(c.quote));
  assert.ok(!/\n/.test(c.quote));
});

// ---- merging ------------------------------------------------------------------------------------
test('repeat mentions of the same thing merge, keeping both quotes', () => {
  const r = run('Continue Adderall XR 20 mg. Tolerating Adderall XR 20 mg well.');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].quotes.length, 2);
});
test('merging prefers the more specific name', () => {
  const r = run('Takes amphetamine 20 mg daily. Currently that is Adderall XR 20 mg.');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].rawName, 'Adderall XR', 'the brand+formulation is what picks the right label');
});
test('a bare later reference folds into the dosed row', () => {
  const r = run('Currently taking Adderall XR 20 mg every morning. Wants to know if we can go higher on the Adderall.');
  assert.strictEqual(r.length, 1, 'one prescription, one row');
  assert.strictEqual(r[0].rawName, 'Adderall XR', 'the specific row survives');
  assert.strictEqual(r[0].dose, '20 mg');
  assert.strictEqual(r[0].quotes.length, 2, 'both sentences stay visible');
});

test('a bare reference with a CONFLICTING release form does not fold in', () => {
  const r = run('On Adderall XR 20 mg. Also has Adderall IR for afternoons.');
  assert.strictEqual(r.length, 2, 'IR and XR are different products even when one has no dose');
});

test('folding respects status', () => {
  const r = run('Takes lithium 900 mg nightly. Stopped lithium years ago is incorrect in the chart.');
  assert.strictEqual(r.length, 2, 'a past mention must not fold into a current prescription');
});

test('same drug at two doses does not merge', () => {
  const r = run('Was on lithium 600 mg, now lithium 900 mg.');
  assert.strictEqual(r.length, 2);
});
test('same drug with different status does not merge', () => {
  const r = run('Stopped Concerta. Restarted Concerta.');
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r.map((c) => c.proposedStatus).sort(), ['current', 'historical']);
});

// ---- false positives --------------------------------------------------------------------------
test('a drug name inside a longer word is not a hit', () => {
  assert.strictEqual(run('Discussed lithiumesque strategies and prelithium labs.').length, 0);
});
test('substances are excluded from the medication list by default', () => {
  assert.strictEqual(run('Drinks alcohol socially, smokes tobacco, drinks grapefruit juice.').length, 0);
  assert.ok(run('Drinks alcohol socially.', { includeSubstances: true }).length > 0,
    'still detectable for the interaction engine when asked for');
});
test('empty and junk input', () => {
  [null, undefined, '', '   ', 42, {}].forEach((v) => assert.deepStrictEqual(run(v), []));
});
test('no vocabulary means no guesses', () => {
  assert.deepStrictEqual(detect('Takes Adderall XR 20 mg.', { vocab: null }), []);
});
test('case does not matter but the written case is preserved', () => {
  const c = one('takes ADDERALL xr 20 mg');
  assert.strictEqual(c.matchedTerm, 'ADDERALL');
  assert.strictEqual(c.rawName, 'ADDERALL XR', 'form modifier is normalized to caps, the name is not touched');
});

// ---- the acceptance-test note -------------------------------------------------------------------
test('THE CASE: Adderall XR 20 mg + fluoxetine 40 mg, as the card would show it', () => {
  const r = run('34yo woman with ADHD, currently taking Adderall XR 20 mg every morning. '
    + 'PCP started fluoxetine 40 mg two weeks ago for anxiety. '
    + 'Previously stopped Concerta after five days due to headaches.');
  assert.strictEqual(r.length, 3);
  const [a, f, c] = [r.find((x) => x.rawName === 'Adderall XR'),
                     r.find((x) => x.rawName === 'fluoxetine'),
                     r.find((x) => x.rawName === 'Concerta')];
  assert.ok(a && f && c, 'all three found');
  assert.strictEqual(a.proposedStatus, 'current');
  assert.strictEqual(a.formulation, 'extended-release');
  assert.strictEqual(a.dose, '20 mg');
  assert.strictEqual(f.proposedStatus, 'current');
  assert.strictEqual(f.dose, '40 mg');
  assert.strictEqual(c.proposedStatus, 'historical');
  assert.ok(/headaches/.test(c.quote), 'the clinician sees why it was flagged historical');
});

// ---- coverage audit regressions, 26 Sept 2026 ------------------------------------------------
// Found by running 42 representative psych meds through the detector. Each of these was a real
// miss, and the LAI one is the original Adderall XR defect in a place nobody was looking.

test('LAI: a product name stays whole and is NOT its oral parent', () => {
  const c = one('Currently taking Abilify Maintena 400 mg IM monthly.');
  assert.strictEqual(c.rawName, 'Abilify Maintena', 'never collapsed to Abilify');
  assert.strictEqual(c.lai, true);
  assert.strictEqual(c.formulation, 'long-acting injectable');
  assert.strictEqual(c.formulationSource, 'product', 'the product name IS the formulation');
  assert.strictEqual(c.dose, '400 mg', 'the dose parsed: the suffix no longer sits between name and number');
  assert.strictEqual(c.interactionKey, 'aripiprazole', 'ingredient key rides alongside, as always');
});

test('LAI: every product in the LAI dataset resolves whole', () => {
  [['Invega Sustenna 156 mg IM monthly', 'paliperidone'],
   ['Invega Trinza 273 mg IM', 'paliperidone'],
   ['Aristada 882 mg IM', 'aripiprazole'],
   ['Perseris 90 mg SC monthly', 'risperidone'],
   ['Uzedy 100 mg SC', 'risperidone'],
   ['Zyprexa Relprevv 300 mg IM', 'olanzapine']].forEach(([phrase, key]) => {
    const c = one('Currently taking ' + phrase + '.');
    assert.strictEqual(c.lai, true, phrase);
    assert.strictEqual(c.interactionKey, key, phrase);
    // Some LAI brands are one word (Aristada, Perseris, Uzedy). What matters is that the
    // product identity is preserved and marked injectable, not that the name has two words.
    assert.strictEqual(c.formulation, 'long-acting injectable', phrase);
    assert.ok(phrase.toLowerCase().indexOf(c.rawName.toLowerCase()) === 0,
      phrase + ' must keep the product name as written, got ' + c.rawName);
  });
});

test('LAI and oral of the SAME ingredient do not merge', () => {
  // Someone on a monthly injection plus an oral is on two things, whatever the doses look like.
  const r = run('Takes oral Invega 6 mg daily and Invega Sustenna 156 mg monthly.');
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r.filter((c) => c.lai).length, 1);
});

test('divalproex is how clinicians write it, and now matches', () => {
  // The interaction dictionary keys this as `valproate`, so the commonest written form matched
  // nothing at all and the drug was invisible to grounding.
  const c = one('Currently taking divalproex ER 1000 mg nightly.');
  assert.strictEqual(c.interactionKey, 'valproate');
  assert.strictEqual(c.rawName, 'divalproex ER');
  assert.strictEqual(c.formulation, 'extended-release');
  assert.strictEqual(one('Takes valproic acid 500 mg bid.').interactionKey, 'valproate');
});

test('a combination product resolves, with its components alongside', () => {
  const c = one('Currently taking Symbyax 6/25 mg nightly.');
  assert.strictEqual(c.rawName, 'Symbyax');
  assert.deepStrictEqual(c.components, ['olanzapine', 'fluoxetine']);
  assert.strictEqual(c.dose, '6/25 mg', 'one unit at the end is still a dose');
});

test('combination strengths parse in both written forms', () => {
  assert.strictEqual(one('Takes Suboxone 8/2 mg sublingual.').dose, '8/2 mg');
  assert.strictEqual(one('Takes Suboxone 8 mg/2 mg sublingual.').dose, '8 mg/2 mg');
});

test('a single-ingredient drug gets no components', () => {
  assert.strictEqual(one('Takes lithium 900 mg nightly.').components, null);
  assert.strictEqual(one('Takes lithium 900 mg nightly.').lai, false);
});

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
