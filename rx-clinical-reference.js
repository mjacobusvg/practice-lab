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
    { key: 'amphetamine_mixed_salts', product: 'Adderall XR', granularity: 'product',
      population: 'adult', adultPracticalCeiling: '60 mg/day',
      basis: 'adult trials in the current labeling included 20, 40 and 60 mg/day; 60 mg/day is '
           + 'widely used as the practical adult ceiling in clinical references',
      labelRecommended: '20 mg/day (adult, per current labeling)',
      note: 'the labeling states no explicit adult maximum; the 30 mg/day figure in it is the '
          + 'PEDIATRIC maximum for ages 6-12',
      verified: false, reviewedBy: null, reviewedAt: null },

    { key: 'amphetamine_mixed_salts', product: 'Adderall (immediate-release)', granularity: 'product',
      population: 'adult', adultPracticalCeiling: '40 mg/day, commonly divided',
      basis: 'commonly cited adult ceiling for the immediate-release product',
      note: 'immediate-release dosing is not extended-release dosing',
      verified: false, reviewedBy: null, reviewedAt: null },

    { key: 'methylphenidate', product: 'Concerta', granularity: 'product',
      population: 'adult', adultPracticalCeiling: '72 mg/day',
      basis: 'commonly cited adult ceiling for the OROS extended-release product',
      verified: false, reviewedBy: null, reviewedAt: null },

    { key: 'lisdexamfetamine', product: 'Vyvanse', granularity: 'product',
      population: 'adult', adultPracticalCeiling: '70 mg/day',
      basis: 'commonly cited adult ceiling',
      verified: false, reviewedBy: null, reviewedAt: null },

    { key: 'fluoxetine', product: 'fluoxetine', granularity: 'ingredient',
      population: 'adult', adultPracticalCeiling: '80 mg/day',
      basis: 'commonly cited adult ceiling for depression and anxiety indications',
      verified: false, reviewedBy: null, reviewedAt: null },

    { key: 'sertraline', product: 'sertraline', granularity: 'ingredient',
      population: 'adult', adultPracticalCeiling: '200 mg/day',
      basis: 'commonly cited adult ceiling',
      verified: false, reviewedBy: null, reviewedAt: null },

    { key: 'escitalopram', product: 'escitalopram', granularity: 'ingredient',
      population: 'adult', adultPracticalCeiling: '20 mg/day',
      basis: 'commonly cited adult ceiling; higher doses are used off label and carry QT considerations',
      verified: false, reviewedBy: null, reviewedAt: null },

    { key: 'bupropion', product: 'bupropion XL', granularity: 'product',
      population: 'adult', adultPracticalCeiling: '450 mg/day',
      basis: 'commonly cited adult ceiling; seizure risk is dose related',
      verified: false, reviewedBy: null, reviewedAt: null }
  ];

  // Look up by interaction key, preferring an entry whose product matches what was written.
  function lookup(med) {
    if (!med) return null;
    var key = med.interactionKey, written = String(med.rawName || '').toLowerCase();
    var hits = ENTRIES.filter(function (e) { return e.key === key; });
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
