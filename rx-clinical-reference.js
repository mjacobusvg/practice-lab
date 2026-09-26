// TIER 2: practical clinical dosing reference.
//
// ══════════════════════════════════════════════════════════════════════════════════════════
// NOT YET CLINICIAN-VERIFIED. Every entry below is `verified: false` until Michael reviews it.
// Until then it is shown to the model, and in the evidence trail, as "commonly cited, not
// clinician-verified" -- never as authority.
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// Why this file exists. A clinician asking "what is the maximum I can go to" usually means the
// practical ceiling in common use, and the FDA label often does not contain that concept at all:
// the Adderall XR label recommends 20 mg/day for adults and states no adult maximum. Answering
// "the label does not specify" is a non-answer. Answering "40-60 mg/day is commonly used" from
// model memory is the original defect wearing a better suit: it was the most useful sentence in
// the answer and the evidence trail could not support it.
//
// So the useful claim gets a home that is INSPECTABLE, VERSIONED AND CORRECTABLE, with the
// figure and its basis written down where a clinician can check and fix them. That is what
// separates this from recall, and it is the only thing that does.
//
// The precedent is `pm-lai.html`, which already carries curated dosing with a per-fact provenance
// marker distinguishing label-derived from TBP synthesis. Same discipline here, made explicit.
//
// TIERS
//   1  FDA / DailyMed SPL       labeled dose, explicit labeled maximum where one exists,
//                               contraindications, interactions, warnings, populations
//   2  THIS FILE                practical adult ranges and commonly cited ceilings
//   3  guidelines / literature  not built
//
// TO VERIFY AN ENTRY: check the figure against a clinical reference you trust, set
// `verified: true`, and put your initials and the date in `reviewedBy` / `reviewedAt`. An
// unverified entry is still better than model recall, because you can see it and change it.
// A WRONG entry is worse than none: delete rather than guess.

(function (root) {
  'use strict';

  var ENTRIES = [
    // ONE ROW. Reviewed 26 Sept 2026. Seven others were deleted after review because the figure
    // they carried is already in the labeling, which Tier 1 retrieves authoritatively: Concerta
    // 72, Vyvanse 70, fluoxetine 80, sertraline 200, escitalopram 20, bupropion XL 450, and
    // Adderall IR (whose own label says only in rare cases is it necessary to exceed 40 mg/day).
    // A Tier 2 row that restates a labeled figure is an unverified copy sitting next to a
    // retrievable fact, free to disagree with it. Tier 2 exists for a REAL GAP in Tier 1.
    //
    // This row is the real gap: the current Adderall XR labeling gives an adult recommended dose
    // of 20 mg/day, states NO explicit adult maximum, and its adult trial tested 20, 40 and
    // 60 mg/day. "How high can I actually go" has no answer in that document.
    {
      key: 'amphetamine_mixed_salts', product: 'Adderall XR', granularity: 'product',
      population: 'adult', adultPracticalCeiling: '60 mg/day',
      // The basis says why THIS TABLE holds the figure. It does not report what any label
      // contains: Tier 1 supplies that, and a basis that talks about labeling gets repeated as
      // a label fact, which already happened once.
      basis: '60 mg/day is widely cited as the adult upper limit for mixed amphetamine salts XR '
           + 'in clinical references',

      // NOT VERIFIED, deliberately. Michael reviewed the row on 26 Sept 2026 and kept it as the
      // one candidate Tier 2 concept, while declining to certify the figure on the strength of
      // model memory. His standing instruction: ground it in an actual current clinical or
      // licensed reference and bring the source-backed wording for approval.
      verified: false, reviewedBy: null, reviewedAt: null,
      reviewStatus: 'kept as the only Tier 2 candidate, 26 Sept 2026; figure not yet certified',
      leads: [
        'an adult ADHD review drawing on CADDRA guidance lists mixed amphetamine salts XR at '
        + '60 mg/day (lead supplied by Michael, not yet read or verified as the basis)'
      ]
    }
  ];

  // Look up by interaction key, preferring an entry whose product matches what was written.
  function lookup(med) {
    if (!med) return null;
    var key = med.interactionKey, written = String(med.rawName || '').toLowerCase();
    if (!key) return null;
    var hits = ENTRIES.filter(function (e) { return e.key === key; });
    if (!hits.length) return null;
    // A PRODUCT-level row only answers for that product. With the IR row deleted there is one
    // amphetamine entry left, and a bare "Adderall" would otherwise fall through the single-hit
    // shortcut and collect the XR ceiling. That is the original defect exactly: a formulation
    // the clinician did not write, inheriting a number that does not apply to it.
    hits = hits.filter(function (e) {
      if (e.granularity !== 'product') return true;
      var prod = String(e.product).toLowerCase();
      var head = prod.split(/[\s(]/)[0];
      if (written.indexOf(head) === -1) return false;
      var ER = /extended[- ]?release|\b(xr|er|xl|sr|cd|la)\b/i;
      var wantER = ER.test((med.formulation || '') + ' ' + written);
      var isER = ER.test(prod) && !/immediate/i.test(prod);
      return wantER === isER;
    });
    if (!hits.length) return null;
    if (hits.length === 1) return hits[0];
    // More than one product under one ingredient: match on what the clinician actually wrote,
    // and on the release form, because that is the distinction the entries exist to keep.
    var byName = hits.filter(function (e) {
      return written.indexOf(String(e.product).toLowerCase().split(' ')[0]) > -1;
    });
    // WORD BOUNDARIES MATTER HERE. /er/ without them matches inside "Adderall", so the
    // immediate-release entry tested as extended-release and both products were filtered in,
    // leaving the lookup ambiguous and returning nothing. Same class of bug as the classifier
    // prefixes that failed on "interactions": a two-letter abbreviation needs anchoring.
    var ER = /extended[- ]?release|\b(xr|er|xl|sr|cd|la)\b/i;
    var byForm = (byName.length ? byName : hits).filter(function (e) {
      var wantER = ER.test((med.formulation || '') + ' ' + written);
      var isER = ER.test(e.product) && !/immediate/i.test(e.product);
      return wantER === isER;
    });
    // Ambiguous between two real products is a reason to return nothing, not to pick one.
    var pool = byForm.length ? byForm : byName;
    return pool.length === 1 ? pool[0] : null;
  }

  function forMeds(meds) {
    var out = [];
    (meds || []).forEach(function (m) {
      var e = lookup(m);
      if (e) out.push({ requested: m.rawName, entry: e });
    });
    return out;
  }

  var API = { ENTRIES: ENTRIES, lookup: lookup, forMeds: forMeds,
              verifiedCount: function () { return ENTRIES.filter(function (e) { return e.verified; }).length; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.TBP_RX_REFERENCE = API;
})(typeof window !== 'undefined' ? window : globalThis);
