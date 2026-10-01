// The clinician's interview library: several named, reusable question sets instead of one.
//
// Only the STORAGE MODEL lives here. The parser (`tbpInterviewSplit`), the editor and the
// workspace stay where they are, because an imported interview must be the same object in the
// same slot as the house one. That is what makes it inherit the safety contract for free: the
// Draft strips it, unanswered questions establish nothing, the Framework reports nothing from
// them. A separate import pipeline would have to re-earn all of that.
//
// This file exists apart from the page because the risk here is DATA LOSS, not behaviour. The
// Vault save is a full replace of the profile object, so a migration that drops a field destroys
// a clinician's interview permanently. That belongs under test.
//
// Pure and dependency-free so it can be unit tested outside a browser.
(function (root) {
  'use strict';

  // The legacy field. One interview, no name, one key. Every clinician who has saved an
  // interview to date has it here and nowhere else.
  var LEGACY_KEY = 'interview_adhd';
  var LEGACY_NAME = 'My ADHD interview';
  var MAX_NAME = 80;

  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  // A key is derived from the name once, at creation, and never again. Renaming must not change
  // it: a saved visit refers to an interview by key, and a rename that moved the key would
  // silently load a different interview, or none.
  function keyFor(name, taken) {
    var base = clean(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (!base) base = 'interview';
    base = 'interview_' + base;
    if (!taken || taken.indexOf(base) === -1) return base;
    for (var i = 2; i < 500; i++) if (taken.indexOf(base + '_' + i) === -1) return base + '_' + i;
    return base + '_' + Date.now().toString(36);
  }

  function entry(key, name, text, extra) {
    var e = { key: String(key || ''), name: clean(name).slice(0, MAX_NAME),
              text: String(text == null ? '' : text) };
    if (extra && extra.createdAt) e.createdAt = extra.createdAt;
    if (extra && extra.updatedAt) e.updatedAt = extra.updatedAt;
    return e;
  }

  // ── migrate ───────────────────────────────────────────────────────────────────────────────
  // Vault data in, normalised list out. THE INVARIANT: a non-empty legacy interview always
  // survives, whether or not a list exists, and whether or not the list already mentions its key.
  function migrate(vault) {
    var v = (vault && typeof vault === 'object') ? vault : {};
    var out = [], seen = {};
    var raw = Array.isArray(v.interviews) ? v.interviews : [];
    raw.forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      var k = String(r.key || '').trim();
      if (!k || seen[k]) return;
      seen[k] = true;
      out.push(entry(k, r.name || k, r.text, r));
    });
    var legacy = String(v[LEGACY_KEY] == null ? '' : v[LEGACY_KEY]);
    if (legacy.trim()) {
      var existing = null;
      for (var i = 0; i < out.length; i++) if (out[i].key === LEGACY_KEY) { existing = out[i]; break; }
      if (!existing) {
        // Never appended silently at the end: a clinician with one interview should find it
        // first, and a clinician who has made others should still not lose this one.
        out.unshift(entry(LEGACY_KEY, LEGACY_NAME, legacy));
      } else if (!existing.text.trim()) {
        // The list carries the key but lost its body. The legacy field is the surviving copy.
        existing.text = legacy;
      }
    }
    return out;
  }

  // ── serialize ─────────────────────────────────────────────────────────────────────────────
  // List back into the vault object, MERGED not replaced, because the save is a full replace of
  // the profile and everything else in it (templates, scaffolds, macros) has to survive.
  //
  // The legacy field keeps being written whenever an entry holds that key. If this release is
  // ever rolled back, the old code finds the clinician's interview exactly where it expects it.
  function serialize(vault, list) {
    var v = {};
    if (vault && typeof vault === 'object') for (var k in vault) if (Object.prototype.hasOwnProperty.call(vault, k)) v[k] = vault[k];
    var arr = (list || []).filter(function (e) { return e && e.key; }).map(function (e) {
      return entry(e.key, e.name, e.text, e);
    });
    v.interviews = arr;
    var legacy = null;
    for (var i = 0; i < arr.length; i++) if (arr[i].key === LEGACY_KEY) { legacy = arr[i].text; break; }
    if (legacy !== null) v[LEGACY_KEY] = legacy;
    // If the clinician DELETED the legacy interview, the field is emptied rather than left
    // holding a copy they thought they removed.
    else if (Object.prototype.hasOwnProperty.call(v, LEGACY_KEY)) v[LEGACY_KEY] = '';
    return v;
  }

  function get(list, key) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].key === key) return list[i];
    return null;
  }

  function upsert(list, key, name, text) {
    var out = (list || []).slice(), now = Date.now();
    var e = get(out, key);
    if (e) { e.name = clean(name).slice(0, MAX_NAME) || e.name; e.text = String(text == null ? '' : text); e.updatedAt = now; return out; }
    var k = key || keyFor(name, out.map(function (x) { return x.key; }));
    out.push(entry(k, name || k, text, { createdAt: now, updatedAt: now }));
    return out;
  }

  function rename(list, key, name) {
    var out = (list || []).slice(), e = get(out, key);
    // The key is NOT recomputed. See keyFor.
    if (e && clean(name)) { e.name = clean(name).slice(0, MAX_NAME); e.updatedAt = Date.now(); }
    return out;
  }

  function remove(list, key) {
    return (list || []).filter(function (e) { return e.key !== key; });
  }

  // Which interview a visit should load. Falls back rather than failing: a selection pointing at
  // a deleted interview resolves to the first one that exists, and an empty library resolves to
  // nothing so the house interview is used, exactly as today.
  function resolveSelection(list, selectedKey) {
    var l = list || [];
    if (!l.length) return null;
    if (selectedKey && get(l, selectedKey)) return selectedKey;
    return l[0].key;
  }

  // Shown only when there is something to choose between.
  //
  // Minimise unnecessary clutter, not natural clinical decisions. Asking "which interview?" when
  // there is one is clutter: no decision exists. Asking it when there are three is a real choice
  // that changes the visit, and hiding it does not remove the decision, it just moves it to the
  // product and makes it a guess.
  function needsPicker(list) { return (list || []).length > 1; }

  var API = { LEGACY_KEY: LEGACY_KEY, LEGACY_NAME: LEGACY_NAME,
              migrate: migrate, serialize: serialize, keyFor: keyFor,
              get: get, upsert: upsert, rename: rename, remove: remove,
              resolveSelection: resolveSelection, needsPicker: needsPicker };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.TBP_INTERVIEW_LIB = API;
})(typeof window !== 'undefined' ? window : globalThis);
