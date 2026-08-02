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

## The editorial framework (canonical)

Applied to every template under review:

1. Every sentence must be legally or clinically necessary, materially patient-helpful, or
   materially clinician-protective. Otherwise it is cut.
2. Adversarial reader test: assume the least charitable reader (opposing counsel, a claims
   adjuster) and confirm no sentence can be turned against the patient or clinician.
3. Description, not certification. State what the clinician observed or recommends within
   the treating relationship. Do not certify conclusions the clinician is not performing
   (no "cleared," no "without restrictions," no fitness-for-duty determinations).

Template content comes from the human review (currently via a ChatGPT pass), not from the
model's own instincts. Do not "improve" a locked template on your own initiative.

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

### Locked at v1.1 (reviewed, framework applied; v1.0 deprecated)
- `esa/standard`
- `treatment_verification/general`
- `jury_duty/deferral`
- `return_to_work/full_duty`: the active v1.1 resolves both original decision points. It
  uses active-voice "I do not recommend psychiatric work restrictions as of
  {{RETURN_DATE}}," and keeps the job-demands carve-out fused into the scope line. Accepted
  as final on 2026-08-02.

### Still v1.0 active (not yet through editorial review)
- `return_to_work/restricted_duty`
- `workplace_accommodation/standard`
- `academic_accommodation/standard`
- `continuation_of_care/standard`
- `general_clinical_support/standard`
- `medication_travel/standard`
- `medication_travel/controlled`
- `treatment_verification/court`
- `medicaid_private_pay/acknowledgment` (6.5 KB, much larger than the others; review separately)

### To build
- FMLA (no row exists yet)

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
