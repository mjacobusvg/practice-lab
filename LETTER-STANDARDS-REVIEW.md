# TBP Clinical Letter Standards: Editorial Review and Working Notes

Living doc for the sentence-by-sentence review of the Clinical Letter Standards that feed
the Letter Generator. Read this before touching any template.

## What these are

The letter templates are NOT in the HTML. They live in Supabase and are fetched at runtime
by Netlify functions. "Editing a letter" is a SQL update with a version bump, never a code
change.

- Front-end: `pm-letter-generator.html` (single file, ~5,100 lines). The Library is the
  front door; the AI wizard is preserved as a fallback behind it.
- Data: table `tbp_letter_standards` in Supabase (project `ubcrrrapedaxkguxniwv`).
- Analytics: `tbp_letter_standard_usage`.
- Both tables have RLS: anon reads active system rows; service role has full access.

### `tbp_letter_standards` columns
- `standard_key`: letter type (e.g. `return_to_work`)
- `variant_key`: variant within a type (e.g. `full_duty`, `restricted_duty`)
- `version`: version string (e.g. `1.0`, `1.1`)
- `status`: `active` or `deprecated`
- `spec`: JSONB (purpose, audience, risk_level, should_include, should_avoid,
  failure_modes, and on reviewed rows an `editorial_notes` object)
- `body_template`: the letter text, with `{{PLACEHOLDER}}` and
  `{{#IF toggle=value}}...{{/IF}}` conditional syntax
- `placeholders`: JSONB array of the placeholders the body uses

## Library philosophy

This is a Letter Library, not a one-off Letter Generator. Each standard letter is reviewed
against one consistent editorial philosophy so the whole library reads like it came from a
single experienced psychiatric clinician, not a pile of unrelated templates. ESA Housing was
the first fully reviewed letter and is the model for the rest.

## Editorial style guide (canonical)

The sentence test. Every sentence must earn its place by being at least one of:
- legally or clinically necessary,
- materially helpful to the patient,
- materially protective of the clinician.

If a sentence is none of these, cut it.

Governing principles:

1. Minimum necessary disclosure. Omit diagnosis, DOB, symptom detail, adherence and
   "consistent engagement" language unless the receiving party genuinely needs it and the
   clinician elects to include it.
2. Describe, do not certify. Document the present-day clinical assessment or recommendation
   within the treating relationship. Do not certify conclusions the clinician is not
   performing (no "cleared," no "without restrictions," no fitness-for-duty determinations).
3. Verification is not endorsement. A verification letter confirms a fact of treatment; it
   does not vouch for the patient's conduct, credibility, or fitness.
4. Clinician voice, not lawyer voice. Write as a treating clinician dictating, not as counsel.
5. Adversarial reader test. Assume the least charitable reader (opposing counsel, a claims
   adjuster) and confirm no sentence can be turned against the patient or clinician.
6. Only ask clinicians to make decisions that require clinical judgment. Everything else
   (legal phrasing, standard requests, boilerplate) is drafted for them or hardcoded.
7. Eliminate toggles whenever possible. Fewer choices means fewer ways to produce a bad letter.
8. Default to documenting the present, not predicting the future. State today's assessment,
   not a prognosis or recovery date, UNLESS the receiving form genuinely requires a prognosis
   (e.g. FMLA).

Template content comes from the human review (currently a ChatGPT pass), not from the model's
own instincts. Do not "improve" a locked template on your own initiative.

## Review workflow

1. Draft the proposed next version (e.g. v1.1) of a template's `body_template` and `spec`.
2. Take the draft to ChatGPT for an adversarial editorial pass.
3. Bring the feedback back to Michael; he decides.
4. On sign-off, apply via SQL as a version bump in one transaction:
   - insert the new version row with `status = 'active'` and an `editorial_notes` block in `spec`
   - set the prior version's `status = 'deprecated'`
5. Confirm with Michael before ANY write (insert / update / deprecate). Read-only queries
   are fine to run freely.

## Current state (verified against the table 2026-08-02)

The database is the source of truth. Prior hand-notes were behind the table.

### Locked (reviewed, framework applied; prior versions deprecated)
- `esa/standard` (v1.1)
- `treatment_verification/general` (v1.1)
- `jury_duty/deferral` (v1.2)
- `return_to_work/full_duty`: the active v1.1 resolves both original decision points. It
  uses active-voice "I do not recommend psychiatric work restrictions as of
  {{RETURN_DATE}}," and keeps the job-demands carve-out fused into the scope line. Accepted
  as final on 2026-08-02.
- `return_to_work/restricted_duty` (v1.1)
- `workplace_accommodation/standard` (v1.1)
- `academic_accommodation/standard` (v1.1, "Postsecondary Academic Accommodation")
- `treatment_verification/court` (v1.1)
- `medication_travel/standard` (v1.1)
- `medication_travel/controlled` (v1.1)
- `continuation_of_care/standard` (v1.1)
- `general_clinical_support/standard` (v1.1)

### Not in the editorial review track
- `medicaid_private_pay/acknowledgment` (v1.0). A patient-facing financial acknowledgment, not a
  To-Whom clinical letter. Already verified and currently single-user (Michael only). Left as-is,
  intentionally outside this framework sweep. Do not "review" or rewrite it here.

With that, every clinical letter in the library has been through the framework. Remaining work is
net-new templates (see "To build"), not review of existing ones.

### To build
- FMLA / PFML: NOT a letter, do not build one. It is a certification FORM the provider fills
  in: federal DOL form WH-380-E (or the employer's equivalent), plus state paid-family-and-
  medical-leave forms with their own fields (e.g. WA PFML, and CA/MA/CO/OR/NY). A free-text
  letter does not map onto fixed form fields and is usually rejected in place of the form.
  Open decision: either leave FMLA out of the library entirely, or build a separate
  FMLA/PFML Certification Prep worksheet (explicitly NOT the form) that helps the clinician
  draft the defensible clinical content to transcribe onto whichever official form: diagnosis,
  onset, probable duration, frequency and duration of incapacity or flare-ups, and work impact.
  FMLA remains the one context where a prognosis is legitimately required.
- Detailed Disability Documentation (postsecondary). A diagnosis-required pathway for
  institutions whose disability office demands a detailed form: diagnosis, date/duration,
  diagnostic method, current severity, treatment history, prognosis, and an explicit
  diagnosis-to-limitation-to-adjustment nexus. Companion to the standard Postsecondary letter,
  which stays diagnosis-free. Not yet built.
- K-12 school letter. Provider information supporting a school-district evaluation or 504/IEP
  process, NOT a clinician-dictated set of finalized accommodations. Different eligibility and
  service structure from postsecondary; the Postsecondary letter explicitly excludes K-12. Not
  yet built.
- Treating-Provider Clinical Summary for Legal Use. The high-warning home for the substantive
  content stripped out of Treatment Verification-Court (diagnosis, dates or frequency,
  attendance facts, observed clinical course, current status, limits of the information, and
  the exact question being answered). It should force the clinician to paste or identify the
  recipient's written request and confirm the response stays within the treating role, rather
  than exposing that content as optional toggles inside the verification letter. Not yet built.
- Medication Travel: destination-specific additional-documentation pathway. Some countries
  require extra details (total quantity, travel dates, days supply, generic names, diagnosis,
  passport number, prescriber license). Keep these OUT of the standard travel letters; add a
  separate "destination requires additional documentation" path driven by the actual
  requirement the clinician or traveler supplies. Not yet built.

## Per-template decision log

Decisions locked in during review, kept here so the reasoning is not lost.

### ESA Housing (esa/standard, v1.1), the model letter
- Removed diagnosis disclosure entirely.
- Removed all optional toggles (zero toggles).
- Minimum necessary disclosure throughout.
- Replaced the generalized scientific claim ("such animals have been shown...") with the
  clinician's own judgment. Settled line: "In my clinical judgment, the presence of this
  animal helps alleviate symptoms associated with the patient's condition and supports their
  ongoing treatment."

### Treatment Verification, General (treatment_verification/general, v1.1)
- Removed diagnosis, DOB, adherence language, and "consistent engagement."
- Reduced to a simple verification letter with a strong scope limitation.
- Principle established: verification is not endorsement.

### Return to Work, Full Duty (return_to_work/full_duty, v1.1)
- Replaced "cleared to return without restrictions" with "Based on my clinical assessment
  within the treating relationship, I do not recommend psychiatric work restrictions as of
  {{RETURN_DATE}}." Documents an opinion rather than certifying fitness.
- Avoids unnecessary future predictions.
- Job-demands carve-out fused into the scope line rather than a separate clause.

### Jury Duty (jury_duty/deferral, v1.2)
- Evolved from a static template into a clinical-judgment tool: the clinician checks the
  clinical concern(s) and the AI drafts one defensible rationale sentence (the
  CLINICAL_RATIONALE placeholder, source clinical_judgment). The drafting prompt forces
  "In my clinical judgment," a present-day assessment, no future prediction, and no
  diagnosis, medication, or symptom naming.
- Closing request hardcoded to excusal from the current jury summons (correct, since in
  practice essentially every such letter requests excusal) rather than asking the clinician
  what they want the court to do. Optional jury date via {{#IF jury_date_known=yes}}.
- v1.2 (ChatGPT editorial pass, 2026-08-02): cut the "please contact my office directly"
  line; tightened the scope paragraph to "This letter reflects my clinical opinion within the
  treating relationship..." (removed the third restatement of purpose); reworded the
  instability concern to drop the loaded word "stable" (now "Current symptoms make jury
  service clinically inadvisable"); softened the case-material concern to be less categorical
  (now "Potential case material may worsen symptoms"); recorded an editorial_notes block. This
  also resolves the prior RTW-consistency gap (contact line and missing editorial_notes).

### Return to Work, Restricted Duty (return_to_work/restricted_duty, v1.1)
- Sibling of Full Duty. Removed clearance language for the active-voice "I recommend the
  following temporary work limitations as of {{RETURN_DATE}}," and reused the Full Duty scope
  line verbatim so the pair matches.
- Reframed "accommodations/restrictions" as "temporary work limitations" to keep this letter
  in the return-to-work lane. Renamed the list placeholder ACCOMMODATIONS_LIST to
  WORK_LIMITATIONS_LIST; its hint routes environmental, remote-work, and ongoing scheduling
  accommodations to the Workplace Accommodation letter and forbids stating treatment frequency.
- Dropped the ongoing/indefinite duration option (kept only a set date or pending clinical
  reassessment). Cut the contact boilerplate and the redundant clinical-observations sentence.
  Removed the unused PATIENT_FIRST_NAME placeholder.
- Front-end route-to-ADA banner: DONE. Added a data-driven `placeholder.notice` callout that
  renders above a field's input in the Library fill form; the WORK_LIMITATIONS_LIST field
  carries the notice routing environmental, remote-work, and ongoing scheduling accommodations
  to the Workplace Accommodation letter. Any template can now attach a field notice via its row.

### Workplace ADA Accommodation (workplace_accommodation/standard, v1.1)
- Now the designated home for accommodations the RTW-Restricted letter routes away.
- Removed diagnosis entirely (no include_diagnosis toggle, no DIAGNOSIS_LABEL), per ESA and the
  ADA minimum-necessary-disclosure principle.
- Stopped adjudicating ADA eligibility: states the substantial limitation rather than
  "constitutes a disability within the meaning of the ADA."
- Split the old FUNCTIONAL_LIMITATIONS into MAJOR_LIFE_ACTIVITIES (EEOC-recognized activities)
  and WORK_RELATED_EFFECTS (bounded workplace effects), with an explicit accommodation nexus.
  Recommends "the following accommodations, or other effective accommodations identified
  through the interactive process," and no longer claims to know essential functions (dropped
  POSITION_OR_ROLE).
- Duration is a genuine three-way field: through a date, ongoing with review as clinically
  appropriate, or cannot be determined at this time.
- Added the employer-role boundary ("The specific accommodations provided are determined
  through the employer's interactive process") and cut both the standing offer to participate
  and the contact boilerplate.
- Adversarial-language guardrails ride as field notices on WORK_RELATED_EFFECTS and
  ACCOMMODATIONS_LIST (avoid categorical inability language).
- First reader of the pronoun engine (see below).

## Library convention: name plus clinician-set pronouns
- House style for referring to the patient: keep the patient's name in subject slots (so verbs
  stay correct, no "they has") and use clinician-set pronouns only in possessive/object slots.
  Default they/them, never inferred from the name, and confirmed before generating.
- Implemented as a reusable engine in `pm-letter-generator.html`: PRONOUN_SETS plus token
  expansion for `{{PATIENT_POSSESSIVE}}`, `{{PATIENT_OBJECT}}`, `{{PATIENT_SUBJECT}}` and their
  `_CAP` variants, driven by a `pronouns` toggle. A `confirm_required` toggle starts unset,
  shows a visible confirm note, and blocks generation until the clinician confirms. Opt-in per
  template, so already-locked letters are untouched until revisited.
- Follow-up (not yet done): revisit the already-locked letters (ESA, Treatment Verification,
  the RTW pair, Jury Duty) to adopt name-plus-pronouns where they currently lean on
  "the patient" / "this patient," so the whole library speaks in one voice.

### Postsecondary Academic Accommodation (academic_accommodation/standard, v1.1)
- Education sibling of the ADA letter. Renamed from "Academic Accommodation" to
  "Postsecondary Academic Accommodation" and scoped to college/university/graduate/professional
  programs. K-12 is explicitly out of scope (it needs its own evaluation-support letter).
- Removed diagnosis entirely (no include_diagnosis toggle, no DIAGNOSIS_LABEL). Institution
  diagnostic requirements route to the planned Detailed Disability Documentation letter rather
  than a toggle, because for academic offices that need is not rare.
- Split FUNCTIONAL_LIMITATIONS into MAJOR_LIFE_ACTIVITIES and ACADEMIC_EFFECTS to force the
  condition-to-limitation-to-effect-to-accommodation bridge.
- "or other effective accommodations identified through the institution's accommodation
  process" (works across access offices, student services, committees, private programs).
- Removed the ADA/Section 504 citation from the body (the governing framework varies by
  institution type; the clinician need not sort it out). Cut the redundant functional-impact
  sentence and the contact boilerplate. Tightened the scope paragraph to "does not assess
  overall academic ability or predict academic performance."
- Omitted duration deliberately (the institution manages re-verification, term, and program
  scope); a duration field would pressure false precision.
- Name plus clinician-set pronouns (reuses the engine). Adversarial guardrails as field notices
  against essential-standards language, plus cautions that attendance flexibility must be
  confirmed clinically necessary and phrased subject to essential course requirements, and that
  lecture recording is not universally appropriate.

### Treatment Verification, Court / Legal Proceedings (treatment_verification/court, v1.1)
- High-risk. Stripped to pure verification of the treatment relationship: removed diagnosis,
  treatment modality, and every substantive clinical section (historical course, current
  status, "no acute decompensation," attendance, adherence). The rationale: any substantive
  field becomes a cross-examination handle the scope disclaimer cannot undo, so substantive
  content moves to the separate planned Treating-Provider Clinical Summary for Legal Use.
- Two deterministic openings avoid implying continuous treatment: current ("has received ...
  with treatment beginning DATE, and is currently under my care") and past ("received ...
  beginning in DATE").
- currently_in_treatment is a required explicit choice with no silent default (reuses the
  confirm_required gate), since a stale "currently under my care" is the statement most likely
  to become inaccurate. DOB is optional (default off) for identity matching only.
- Removed the AAPL citation from the body (reads as defensive lawyering, hints at forensic
  expertise) and softened "assessed all relevant parties" to "methods and information
  appropriate to the specific legal question." No honorific, no pronoun engine (the letter
  names the patient once, then refers only to "this letter" and "the treatment relationship").

### Medication Travel, Standard and Controlled (medication_travel/standard and /controlled, v1.1)
- Governing principle for this pair: a travel letter verifies the prescription; it does not
  instruct TSA or foreign customs, assert foreign legality, or certify medical necessity.
- Both: removed the condition phrase (now "for personal medical use," no diagnosis by default),
  cut "medically necessary" and the request that authorities permit carriage, reworded
  original-container and carry-on as traveler guidance (not a directive to security), dropped
  the first-name reference (no pronouns needed), relabeled DOB as "date of birth" (kept for
  identity matching), and kept the contact-for-verification line (a real operational purpose
  here, unlike the advocacy letters).
- Controlled only: removed the DEA-registration sentence, the show_dea toggle, and the
  DEA-number token (a US DEA registration says nothing about foreign legality and is needless
  disclosure). Uses "classified as a controlled substance in the United States" and the
  grammar-safe "Any controlled medication listed above ... its original labeled pharmacy
  container."
- The international country-law warning was moved OUT of the letter into the generator: a new
  toggle-choice notice feature shows the caution beneath the "Will the patient be traveling
  internationally?" toggle when Yes is selected. Quantity and days supply are omitted by
  default.

### Continuation of Care (continuation_of_care/standard, v1.1)
- The one letter type where full clinical content is correct: it is a clinician-to-clinician
  handoff, so diagnoses and current medications are necessary, not over-disclosure. Kept them,
  but time-anchored the headings ("ACTIVE DIAGNOSES AT TRANSFER," "MEDICATION REGIMEN AT
  TRANSFER") so the data is not mistaken as current long after the handoff.
- Two deterministic openings via a required treatment-status choice (ongoing vs ended), no
  silent default, replacing "from START to present."
- Added a KNOWN MEDICATION ALLERGIES OR CLINICALLY SIGNIFICANT ADVERSE REACTIONS section as a
  required explicit choice (none documented / listed / not assessed). Silently omitting allergy
  status on a medication handoff is a safety gap, so it uses the confirm gate.
- Brief history renamed to BRIEF TREATMENT SUMMARY (default off), refocused on what changes
  immediate care and explicitly discouraging unfocused narrative, trauma detail, negative
  characterizations, and adherence speculation.
- "Complete records upon signed release" became "additional relevant treatment records ...
  appropriate authorization" (minimum necessary). Authorization basis is handled in the sending
  workflow, not the letter body. Kept "Dear Receiving Provider" and the coordination contact
  line (a real clinician-to-clinician need). Name only, no pronoun engine.
- Reused engine features only (confirm gate, conditional blocks); no front-end change.

### General Clinical Letter of Support (general_clinical_support/standard, v1.1)
- The catch-all wrapper, and the easiest template to misuse (a clinician can write a forensic or
  capacity opinion in the freeform body that no later disclaimer can neutralize). The v1.1 work
  moved the real protection out of the fixed copy and into the workflow.
- Broadened the scope opener to "based solely on information obtained within the treating
  relationship" (covers patient-reported history and records, not just observations) with a
  precise forensic/ultimate-decision boundary (custody, parenting capacity, legal competence,
  credibility, fitness for any role, or any other legal or forensic question).
- Cut the contact boilerplate and "at the patient's request" (authorization lives in the
  workflow, not the letter); "Purpose:" is a scannable label. DOB optional, default off.
- Required confirmation gate (reuses the confirm gate): the clinician must affirm that no more
  specific template applies and that the letter is not a forensic/custody/capacity/credibility/
  fitness opinion before Generate works.
- Route-to-specific and stay-in-scope field notices, plus a new nonblocking keyword-alert
  feature: template-specific routing messages fire as the clinician types the purpose or body
  (jury duty, ESA, return to work, accommodation, custody/competence/credibility), matched with
  word boundaries so "incompetence" does not trip "competence."

## Hard rules (repo-wide, but they bite here)

- No em dashes, anywhere, ever. Absolute, including letter copy.
- Proven model strings only: `claude-haiku-4-5-20251001` and `claude-sonnet-4-6`. Replace
  `claude-sonnet-4-20250514` on sight.
- Netlify functions use plain `fetch()` against the Supabase REST API. Do NOT reintroduce
  `@supabase/supabase-js` (it caused a "Cannot find module" build failure). Env vars:
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- Any `.mjs` Netlify function must inline `verifyToken`, never import it from `_lib`. Auth is
  signed HMAC tokens via `_lib/session.js`.
- Vault field names the generator reads: `legalName` (already includes credentials),
  `practiceAddress`, `practicePhone`, `practiceFax`, `practiceEmail`, `npi1`, `licenseNum`,
  `licenseState`, `letterhead` (base64 PDF data URL). Not `providerName` / `address` / `phone`.

## Related build items

- vault.html letterhead upload: DONE as of 2026-08-02. Accepts `application/pdf`, cap raised
  to 600 KB (file size), and the preview branches so a PDF is not shoved into an `<img>` in
  both the upload and load paths.
- RTW-Full Duty SQL push: DONE (v1.1 active, v1.0 deprecated). No action pending.
