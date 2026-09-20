# Vault field map: what every generated document should already know

**Status:** inventory, Sept 2026. Produced before extending document generation, so we
find out whether Vault is doing the job it was designed for or whether we have built
generators that ignore it.

## The rule this exists to enforce

> Any TBP tool that generates practice-specific documents hydrates known practice data
> from Vault before asking the member to type it again.

Applies to Policy Builder, template customization, the Letter Generator, and any future
consent or form generation. Vault is not a profile page. It is the reason a member should
never type their practice name twice.

The assembly order is fixed:

```
Vault (stable practice facts)
  -> Builder decisions (things that genuinely require a choice)
    -> ask only for what neither supplies
      -> document
```

## Where the data lives

- **Vault:** `localStorage.tbp_vault`, mirrored server-side via
  `netlify/functions/user-tool-data` with `toolId: 'vault_profile'`. 84 fields, keyed by
  the `data-vault` attribute in `vault.html`. Same origin as `platform.html`, so any
  generator there can read it directly (`pbVault()` in `platform.html`).
- **Builder decisions:** `POLICY_DECISIONS` in `platform.html`. 20 decisions in 5 topics.
  Only 4 carry fill-in fields: `days`, `fee_late`, `fee_noshow`, `interval`.
- **Templates:** the 15 Foundations `.docx` files in the `templates` bucket. 64 bracketed
  tokens plus 64 underscore rules across 14 of them ("Credit Card Authorization: Which
  Form?" has none; it is guidance, not a form).

## The mapping

### A. Vault already holds this — a generator asking for it is a bug

| Bracketed token (as it appears in the templates) | Vault key |
|---|---|
| Insert Practice Name · Insert Your Practice Name · Your Practice Name · Practice Name · Insert Practice Name/Legal Entity · Name of Company · Insert Practice/Provider Name | `practiceName` |
| Your Name · Your Name, Credentials · Insert Provider Name · Insert Name and Title | `legalName` + `credentials` |
| Insert Address · Your Address | `practiceAddress` |
| Insert Phone · Practice Phone · xxx-xxx-xxxx | `practicePhone` |
| Practice Email | `practiceEmail` |
| Insert phone / email · Insert practice / phone / email · Your Practice Contact Information | composite of `practicePhone` + `practiceEmail` |
| Insert state and location | `practiceState` + `practiceCity` |
| Insert NPI | `npi1` |
| Insert TIN | `ein` |
| Your Practice Name / Logo · Your Practice Name or Logo | `practiceName` + `letterhead` |
| Insert Effective Date · Insert Date | generated (today), never asked |

That is **11 of the 64 token patterns, covering 9 of the 14 templates.** Every one of them
is a field the member has already entered once.

### B. A Builder decision already answers this

| Token | Decision |
|---|---|
| insert required notice: e.g., 24 or 48 hours · notice timeframe · 24/48 | `att_window` (`days`) |
| amount · insert fee amount, e.g., $100 | `att_fee` (`fee_late` / `fee_noshow`) |
| insert timeframe, e.g., 2-3 business days · insert timeframe | `rx_window` (`interval`) |
| Insert any practice-specific monitoring requirements. | `benzo_monitor` (partial) |

The No-Show template and the Medication Refill template are **entirely** covered by A + B.
A member who has filled Vault and answered those decisions should never see a bracket in
either document.

### C. Genuinely manual — per-patient, per-contract, or a legal judgment

Leave these alone. They are not Vault failures.

- **Per-patient:** Patient Name, First, Last, Insert date/time (appointment)
- **Per-estimate (GFE):** Description, Insert single expected code, Insert total, Insert or
  not yet determined, "List, or write 'None anticipated at this time.'"
- **Per-contract (BAA):** Insert Business Associate Name, Insert description of permitted
  services/uses, Insert cure period, Insert shorter period if agreed, Insert or strike
- **Legal judgment (CPA):** MD/DO or other professional permitted by state law
- **Signature and date rules:** the 64 underscore runs across ROI, CPA, the card
  authorizations, NPP and Telepsychiatry Consent. Correctly manual; they are signed on paper.

## Gaps this inventory found

These are the reasons a bracket survives today that should not:

1. **Vault has no practice website field.** The Welcome Letter asks for `Practice Website`
   and nothing can supply it. One field closes it.
2. **Vault has no accepted-insurances list.** Payment Policy asks for
   "List insurances here. Update regularly." Belongs in Vault, not in a document.
3. **Vault has no accepted-payment-methods list.** Billing & Discount Policy asks for
   "List: cash, credit/debit card, check, HSA/FSA, etc." Either a Vault field or a Builder
   decision; it is currently neither.
4. **No appointment-length value anywhere.** The Welcome Letter asks for "45-60".
   Vault field, most likely.
5. **The Builder does not read Vault for clause text.** As of this commit it hydrates the
   document header only (practice name, clinician, credentials). Clause-level hydration is
   the next step and is what closes group A for generated policies.
6. **The 15 templates are static `.docx` and cannot be hydrated at all.** They are
   downloaded as-is. Closing group A for them means either generating them from Vault at
   download time, or accepting brackets as the price of a static file. That is a product
   decision, not a bug.

## Scoreboard

Of the 64 bracketed tokens across the 15 templates:

- **~20 are group A** — Vault holds the answer today
- **~8 are group B** — a Builder decision holds the answer today
- **~36 are group C** — genuinely manual, correctly so

So roughly **44% of every bracket a member fills in by hand is data the product already
has.** That is the size of the prize, and the answer to "is Vault doing its job": the data
is there, the generators just do not read it yet.
