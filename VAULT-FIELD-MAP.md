# Field map: what every generated document should already know

**Status:** working inventory, Sept 2026. Written before extending auto-fill, so we find
out whether Vault is doing the job it was designed for rather than assuming it.

## The rule this exists to enforce

> Any TBP tool that generates practice-specific documents hydrates known practice data
> from Vault before asking the member to type it again.

Applies to Policy Builder, template personalization, the Letter Generator, and any future
consent or form generation. Vault is not a profile page. It is the reason a member should
never type their practice name twice.

**Vault saves typing. It never makes a legal or contextual decision.** That line is why
the classes below matter more than the auto-fill mechanism does.

## The six classes

Never collapse 3 to 6 into "manual". They fail in different ways, and a generator that
treats a patient-name field like a practice phone number will do something stupid and
confident.

| # | Class | Source of truth | Auto-fill? |
|---|---|---|---|
| 1 | **Stable practice data** | Vault | Yes, aggressively |
| 2 | **Policy decision** | Policy Builder | Yes, from the member's answers |
| 3 | **Patient / encounter-specific** | The encounter | Never. Stays fillable at use |
| 4 | **Counterparty-specific** | The other party | Never. Differs per agreement |
| 5 | **Signature / execution** | Wet or e-signature | Never. Must stay blank |
| 6 | **Contextual legal judgment** | The clinician, per document | Never auto-fill. May prompt |

Class 6 is the one that bites. A field can look like class 1 and not be: an entity name on
a BAA may legitimately differ from `practiceName` when a clinician runs multiple entities,
and the "state" governing a Collaborative Practice Agreement is a legal determination, not
a copy of `practiceState`. **Superficial field-name similarity is not a mapping.**

## Where the data lives

- **Vault:** `localStorage.tbp_vault`, mirrored server-side through
  `netlify/functions/user-tool-data` with `toolId: 'vault_profile'`. 84 fields keyed by the
  `data-vault` attribute in `vault.html`. Same origin as `platform.html`, so any generator
  there reads it directly (`pbVault()` / `pbVaultStr()`).
- **Builder decisions:** `POLICY_DECISIONS` in `platform.html`. 20 decisions across 5
  topics; 4 carry fill-in fields (`days`, `fee_late`, `fee_noshow`, `interval`).
- **Templates:** the 15 Foundations `.docx` in the `templates` bucket. 64 bracketed tokens
  plus 64 underscore rules across 14 of them. "Credit Card Authorization: Which Form?" has
  none; it is guidance, not a form.

## Class 1 — stable practice data (Vault)

| Bracketed token as it appears | Vault key |
|---|---|
| Insert Practice Name · Insert Your Practice Name · Your Practice Name · Practice Name · Name of Company · Insert Practice/Provider Name | `practiceName` |
| Your Name · Your Name, Credentials · Insert Provider Name | `legalName` + `credentials` |
| Insert Address · Your Address | `practiceAddress` |
| Insert Phone · Practice Phone · xxx-xxx-xxxx | `practicePhone` |
| Practice Email | `practiceEmail` |
| Insert phone / email · Insert practice / phone / email · Your Practice Contact Information | `practicePhone` + `practiceEmail` |
| Insert state and location | `practiceState` + `practiceCity` |
| Practice Website | `practiceWebsite` |
| List insurances here. Update regularly. | `acceptedInsurances` |
| List: cash, credit/debit card, check, HSA/FSA, etc. | `acceptedPaymentMethods` |
| 45-60 (appointment length) | `initialAppointmentLength` / `followupAppointmentLength` |
| Insert NPI | `npi1` |
| Insert TIN | `ein` |
| Your Practice Name / Logo · Your Practice Name or Logo | `practiceName` + `letterhead` |
| Insert Effective Date · Insert Date | generated (today), never asked |

**~24 tokens, 10 of the 14 templates.** Every one is already entered once in Vault.

## Class 2 — policy decision (Builder)

| Token | Decision |
|---|---|
| insert required notice: e.g., 24 or 48 hours · notice timeframe · 24/48 | `att_window` (`days`) |
| amount · insert fee amount, e.g., $100 | `att_fee` (`fee_late` / `fee_noshow`) |
| insert timeframe, e.g., 2-3 business days · insert timeframe | `rx_window` (`interval`) |
| Insert any practice-specific monitoring requirements. | `benzo_monitor` (partial) |

**~8 tokens.** The No-Show and Medication Refill policies are covered entirely by classes
1 + 2: a member with a filled Vault and answered decisions should see no bracket at all.

## Class 3 — patient / encounter-specific

Patient Name · First · Last · Insert date/time (appointment) · GFE Description · Insert
single expected code · Insert total · Insert or not yet determined · "List, or write
'None anticipated at this time.'"

These stay fillable at the point of use. A generator must not prefill them, and a
"personalize" path must leave them alone.

## Class 4 — counterparty-specific

BAA: Insert Business Associate Name · Insert description of permitted services/uses ·
Insert cure period · Insert shorter period if agreed. ROI: the recipient.
CPA: the collaborating clinician.

Different for every executed copy of the same document. Never Vault, even though the
practice's own side of the agreement is class 1.

## Class 5 — signature / execution

The 64 underscore rules across ROI, CPA, both card authorizations, NPP and Telepsychiatry
Consent, plus every "Insert Name and Title" on a signature block.

**Must stay blank.** Prefilling an execution field is the one auto-fill that could actually
harm someone.

## Class 6 — contextual legal judgment

- "MD/DO or other professional permitted by state law" (CPA) — a legal determination
- "Insert or strike" (BAA) — a drafting choice
- "Insert Practice Name/Legal Entity" (BAA, Telepsychiatry Consent) — *looks* like class 1,
  but the contracting entity may not be the trading name in `practiceName`

May prompt with the Vault value as a **suggestion**, clearly marked, never silently filled.

## Gaps

Stable practice configuration with nowhere to live. All class 1 by nature; all currently
forcing a member to type something the product should hold:

1. ~~No practice website field~~ — **done.** `practiceWebsite`.
2. ~~No accepted-insurances list~~ — **done.** `acceptedInsurances`.
3. ~~No accepted-payment-methods list~~ — **done.** `acceptedPaymentMethods`.
4. ~~No appointment-length value~~ — **done**, as **two** fields:
   `initialAppointmentLength` and `followupAppointmentLength`. Not one scalar. Practices
   routinely run a longer initial evaluation than a follow-up, and a single value would be
   wrong for most of them; collapsing them later is easy, splitting them after documents
   depend on the single value is not.
5. ~~Builder does not read Vault for clause text~~ — **done.** Clauses support
   `{{vault.key|fallback}}`, and the packet carries a Vault-built contact section.
6. **The 15 templates are static and cannot be hydrated.** Resolved as a product decision,
   below.

These five fields are deliberately **not** added to `TRACKED_FIELDS`. They are optional
practice configuration, not credentialing, and adding them would drop every member's
completion percentage for fields they have never been shown.

## Decision: static templates are not personalized in place

The generic master stays exactly as it is. Personalization is an **additional** path, not a
replacement:

```
Download template            -> the untouched generic master
Personalize with my Vault -> a copy with class 1 fields filled in
```

Reasons the silent-replacement version was rejected:

- someone may want an untouched master
- Vault data can be incomplete or stale
- a clinician may run multiple entities or locations
- class 6 fields look like class 1 and are not; silently filling them would have the
  product making a legal decision

Only classes 1 and 2 are ever eligible for the personalize path. Classes 3, 4 and 5 are
left blank by design, and class 6 may be offered as a marked suggestion.

## Scoreboard

Of 64 bracketed tokens across the 15 templates: roughly **20 class 1**, **8 class 2**, and
**36 spread across classes 3 to 6**. So about **44% of every bracket a member fills in by
hand is data the product already holds** — and the remaining 56% breaks into four groups
with genuinely different rules, which is the whole point of not calling them "manual".
