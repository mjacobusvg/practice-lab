// Tier 2: the curated practical dosing table, and the rules around it.
//
// This exists because the most useful sentence in a real answer -- "40-60 mg/day is a practical
// adult ceiling" -- was coming from model memory while the evidence trail showed only DailyMed.
// The fix is not to delete the useful sentence. It is to give it a home that can be inspected
// and corrected. Being written down is the ONLY thing that separates this from recall, so these
// tests are mostly about provenance and about not overstating what the table is.

const R = require('../rx-clinical-reference.js');
const G = require('../rx-grounding.js');
const assert = require('assert');

let checks = 0, failures = 0;
function test(label, fn) {
  checks++;
  try { fn(); } catch (e) { failures++; console.error(`\nFAIL ${label}\n  ${e.message}`); }
}

test('nothing is marked verified until a clinician says so', () => {
  R.ENTRIES.forEach((e) => {
    assert.strictEqual(e.verified, false, e.product + ' must not self-certify');
    assert.strictEqual(e.reviewedBy, null);
  });
});

test('every entry states its basis, or it is indistinguishable from a guess', () => {
  R.ENTRIES.forEach((e) => {
    assert.ok(e.basis && e.basis.length > 20, e.product + ' needs a basis');
    assert.ok(e.key && e.product && e.granularity, e.product + ' needs identity fields');
  });
});

test('THE IDENTITY RULE holds inside the table too', () => {
  const xr = R.lookup({ rawName: 'Adderall XR', formulation: 'extended-release', interactionKey: 'amphetamine_mixed_salts' });
  const ir = R.lookup({ rawName: 'Adderall', interactionKey: 'amphetamine_mixed_salts' });
  assert.strictEqual(xr.product, 'Adderall XR');
  assert.ok(/immediate/.test(ir.product), 'bare Adderall must not pick the XR row');
  assert.notStrictEqual(xr.adultPracticalCeiling, ir.adultPracticalCeiling,
    'if these were the same number the distinction would be pointless');
});

test('word boundaries: "er" inside Adderall must not read as extended-release', () => {
  // /er/ unanchored matches inside "Adderall", which made the immediate-release row test as
  // extended-release, left both rows in play, and returned nothing at all.
  const ir = R.lookup({ rawName: 'Adderall', interactionKey: 'amphetamine_mixed_salts' });
  assert.ok(ir, 'a bare Adderall must resolve to something');
});

test('a drug with no entry returns nothing rather than a nearby number', () => {
  assert.strictEqual(R.lookup({ rawName: 'lithium', interactionKey: 'lithium' }), null);
  assert.strictEqual(R.lookup(null), null);
  assert.strictEqual(R.lookup({ rawName: 'x', interactionKey: 'nope' }), null);
});

test('the XR row carries the distinctions that caused the original defect', () => {
  const xr = R.lookup({ rawName: 'Adderall XR', formulation: 'extended-release', interactionKey: 'amphetamine_mixed_salts' });
  assert.ok(/60 mg/.test(xr.adultPracticalCeiling), 'the practical ceiling');
  assert.ok(/20 mg/.test(xr.labelRecommended), 'separate from the labeled recommended dose');
  assert.ok(/PEDIATRIC/.test(xr.note) && /30 mg/.test(xr.note), 'and the 30 mg figure named as pediatric');
});

// ---- the block that reaches the model ----------------------------------------------------------
const refs = R.forMeds([{ rawName: 'Adderall XR', formulation: 'extended-release', interactionKey: 'amphetamine_mixed_salts' }]);

test('the Tier 2 block never claims to be labeling', () => {
  const b = G.buildReferenceBlock(refs);
  assert.ok(/TIER 2/.test(b));
  assert.ok(/NOT product labeling/.test(b));
  assert.ok(/Never cite it as the label/.test(b.replace(/\s+/g, ' ')));
  assert.ok(/never let it override a labeled figure/.test(b.replace(/\s+/g, ' ')));
});

test('an unverified figure is given, and flagged, rather than withheld', () => {
  const b = G.buildReferenceBlock(refs);
  assert.ok(/60 mg\/day/.test(b), 'the clinician asked for this number');
  assert.ok(/NOT clinician-verified/.test(b));
  assert.ok(/commonly cited practical ceiling rather than a/.test(b.replace(/\s+/g, ' ')));
  assert.ok(/Do not present an unverified entry as authoritative/.test(b));
});

test('the basis travels with the figure', () => {
  const b = G.buildReferenceBlock(refs);
  assert.ok(/basis:/.test(b));
  assert.ok(/20, 40 and 60 mg\/day/.test(b), 'where the number comes from, not just the number');
});

test('no meds with entries means no block', () => {
  assert.strictEqual(G.buildReferenceBlock([]), '');
  assert.strictEqual(G.buildReferenceBlock(null), '');
  assert.strictEqual(G.forMeds === undefined, true);
  assert.deepStrictEqual(R.forMeds([{ rawName: 'lithium', interactionKey: 'lithium' }]), []);
});

// ---- identity granularity by claim -------------------------------------------------------------
test('granularity follows the identity the clinician wrote', () => {
  assert.strictEqual(G.granularityFor({ rawName: 'Adderall XR', formulation: 'extended-release', brand: 'Adderall XR' }), 'product');
  assert.strictEqual(G.granularityFor({ rawName: 'fluoxetine' }), 'ingredient',
    'whether fluoxetine inhibits CYP2D6 is the same in every manufacturer’s label');
  assert.strictEqual(G.granularityFor({ rawName: 'Concerta', brand: 'Concerta' }), 'product');
});

// ---- the hedging rule ----------------------------------------------------------------------------
test('the source’s hedging may not be upgraded into a patient-specific claim', () => {
  const r = G.groundingRules(['interaction'], []).replace(/\s+/g, ' ');
  assert.ok(/DO NOT UPGRADE THE SOURCE'S HEDGING/.test(r));
  assert.ok(/say may or can/.test(r));
  assert.ok(/has likely increased/.test(r), 'the exact phrasing that prompted this is named');
  assert.ok(/do not soften a stated contraindication into a caution/.test(r), 'and it cuts both ways');
});

test('the first sentence has to answer the question', () => {
  const r = G.groundingRules(['dosing'], []).replace(/\s+/g, ' ');
  assert.ok(/THE FIRST SENTENCE ANSWERS THE QUESTION/.test(r));
  assert.ok(/contains a number and what kind of number it is/.test(r));
  assert.ok(/Not the labeled dose they are already on/.test(r));
});

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
