# Login & auth — how members get in, and the traps we already hit

**Purpose:** the runbook for how sign-in works on the TBP platform, why it's built the
way it is, and the settings/history that will otherwise get rediscovered painfully.
Read this before touching the login gate, the magic-link flow, password auth, or the
Supabase Auth settings.

Last updated: 2026-09-09.

---

## 1. One-line summary

Auth is **Supabase Auth (GoTrue)**. Members can get in three ways, in order of preference:
1. **Password** — set once, then instant sign-in, **sends no email** (immune to any email limit).
2. **Magic link / email OTP** — the original method; emails a one-time link. Still the default
   and the fallback.
3. **Admin one-click link** — we generate a link and paste it into an email to rescue anyone
   who can't get in (no dependency on their inbox for the *login itself*).

Passwords live in Supabase `auth.users`, bcrypt-hashed. **Passwords and login emails are NOT
PHI** — see §6.

---

## 2. The history that explains the design (read this before "just use magic links")

The magic-link-only setup nearly sank us: Supabase's **default built-in email sender is
hard-capped at ~2–4 emails/hour**, project-wide, and you cannot raise it. On any busy signup
day, the 3rd person requesting a link got **nothing**, silently. That is the "2 logins an hour"
problem.

Two things fixed it, and both must stay healthy:
- **Custom SMTP** was configured so auth email no longer uses the crippled default sender.
  (Confirm in Supabase → Authentication → Emails / SMTP settings. Good deliverability — custom
  domains have the *best* sign-in rate — indicates this is in place.)
- **Password login** (added 2026-09-08) removes email from the everyday login path entirely.
  A member with a password can sign in any number of times and never touch the email system,
  so the rate limit **can never again be the thing that loses a member at the door.** This is
  the durable fix; SMTP health is the belt, passwords are the suspenders.

Diagnostic reality (checked 2026-09-08): ~72% of recent signups completed sign-in; the
"never got in" bucket was mostly **typo'd/undeliverable addresses** (now caught at signup, §5)
plus ordinary spam-foldering — NOT a broken pipe. Custom-domain signups had the *best* rate,
which is proof the email path works. Do not "re-fix SMTP" reflexively; it is not the problem.

---

## 3. How each method works (files + functions, all in `platform.html` unless noted)

### Password (the no-email path)
- **Sign-in gate:** the login screen defaults to the email-link flow everyone knows. Password is
  **strictly opt-in**: the field + button stay hidden until the member clicks *"Have a password?
  Sign in with it"* (`togglePasswordLogin()`). This keeps members who never set a password from
  being confronted with a password box they'll fumble. `signInWithPassword()` calls
  `SB.auth.signInWithPassword`; a blank password falls back to the email link.
- **Setting a password:** account menu → **"Set a password"** → `openSetPassword()` /
  `saveNewPassword()` → `SB.auth.updateUser({ password })`. Requires only the session the member
  already has (no email round-trip). This is how existing passwordless members adopt a password.
- **At signup:** the free-signup form has an **optional** password field. Filled →
  `signUpWithPassword()` (`SB.auth.signUp` with name/role metadata). Blank → the magic-link flow.
  Handles both project configs: logs them straight in if email-confirmation is off, else tells
  them to confirm via email (password works after).

### Magic link / email OTP
- `sendMagicLink(mode)` → `SB.auth.signInWithOtp`. Carries deep-link intent (returnTo / pending
  post / plan / buy) through the round trip. Still the default button and the universal fallback.

### Admin one-click link (rescue)
- `netlify/functions/admin-signin-link.js` (admin-only) mints a copy-paste link →
  `one-click-signin.js` verifies our signed token, mints a FRESH Supabase magic link at click
  time, and 302s the person straight in. Use it to unblock anyone who "never got the link." The
  admin tools (this + broadcast stats) are gated to `michael@thinkbeyondpsych.com`.

### Session → account resolution
- After any sign-in, `loadIdentity()` reads the Supabase session and resolves the account via the
  `my_account` RPC (keyed on `auth.uid()`), then `writeToolSession()` mints the signed tool token
  used by `auth-gate.js` on tool pages.

---

## 4. Supabase Auth settings that actually matter

Project: **`ubcrrrapedaxkguxniwv`** (confusingly named **"Ask the Archive"** — it *is* the live
platform DB). Settings live in the dashboard, NOT the database, so they can't be read via SQL.

**Authentication → Providers → Email:**
- **Enable email provider: ON** — password AND magic link both ride this one provider. If magic
  link works, password sign-in works; there is no separate "enable passwords" switch.
- **Require current password when updating: OFF** — *critical.* This is what lets a member with
  no password set their FIRST one. If it were ON, "Set a password" would break for everyone
  passwordless. Leave it OFF.
- **Minimum password length: 6** — the client form requires 8, which clears it. Only a problem if
  raised above 8.
- **Confirm email** (instant-login vs one confirmation email for new *password* signups): optional.
  ON = new password-signup confirms via email once, then password forever. OFF = instant login,
  zero email, but you stop verifying the signer owns the address. Only affects new signups; leave
  it unless you deliberately want the smoother/looser new-signup flow. Code handles both.

**Authentication → Rate Limits → "Emails per hour":** a *separate* configurable cap from the
old default-sender limit. Even with custom SMTP, keep this well above the old default so
magic-link/confirmation email can't wall up on a busy day. (Password logins are unaffected.)

**Plan:** Free, no BAA — this is expected and fine (§6). "Prevent use of leaked passwords" is
Pro-only; not required.

---

## 5. Guardrails already built in

- **Email typo guard** (`suggestEmailFix()`): both the sign-in and signup paths intercept obvious
  address typos (`gnail.com`, `gmail.co`, `gmail.comm`, `.con`, freemail `.co`, etc.), suggest the
  fix, and take one confirm. This stops the "never got the link because the address was mistyped"
  failure at the source.
- **Account-switch refresh** (`onAuthStateChange`): re-runs `checkAuth()` when the signed-in
  identity actually changes — not only when the gate is open. Fixes the "it keeps signing me into
  my other account" redirect (a stale session for account A shadowing a fresh login as B), and
  clears the prior account's tool-session keys on a switch.

### 5a. Session lifetime and revocation (audit H7, fixed 2026-09-19)

The signed session token (`_lib/session.js`) used to last **30 days**, and its `tier` and `scope`
were frozen into it at mint time. Nothing re-read them. That meant a cancellation, a downgrade, an
expired comp or a stolen token all kept full access for up to a month, and there was **no way to
stop one**: signing out clears `localStorage` on ONE device, which does nothing to a token string
that has already been copied somewhere else.

Three pieces now:

| | |
|---|---|
| `SESSION_TTL_MS` | **24 hours** (was 30 days). 8h is the eventual target — cut it once refresh has a production track record, not before. |
| `session-refresh.js` | Renews a live token in place, re-reading `tier` from `accounts` each time. Fires at **half-life** (~12h of runway). |
| `accounts.sessions_valid_from` | The revocation epoch. |

**To kill every live session for one member, on every device:**

```sql
update public.accounts set sessions_valid_from = now() where email = 'them@example.com';
```

They are locked out within one TTL at the outside: the next refresh is refused, so their token
simply expires and cannot be renewed. It does **not** block them logging in again — a fresh login
mints a session starting after the epoch, which is the correct behaviour for "sign out everywhere"
and for a compromised device. To lock someone out for good, change their tier or remove the
account; the epoch is for sessions, not for people.

Three things about the refresh path are deliberate and should not be "simplified":

- **An expired token is never refreshable, at any grace period.** A grace window would make the
  TTL a suggestion. Expired means the normal `platform.html` re-mint, which requires a live
  Supabase session.
- **The chain is capped** (`REFRESH_MAX_AGE_MS`, 30 days) from the original login, carried in the
  `sid` claim. `session-refresh` mints from nothing but a previous token of ours, so without a
  ceiling one stolen token could renew itself forever and the 24-hour TTL would mean nothing.
  `sid` is also what revocation compares against, so **a refresh must never reset it**.
- **A Supabase read failure answers 503, not 401**, and the client keeps its existing valid token.
  Signing every member out during a Supabase blip would turn someone else's outage into ours.

Tool pages renew via `auth-gate.js` (on load, on tab focus, and every 30 minutes — all no-ops until
past half-life). It has to be a `fetch`, not a redirect: bouncing a clinician through
`platform.html` mid-encounter in the Scribe would discard what is on screen. `platform.html` itself
does not use that endpoint — it holds the Supabase client, so it re-mints the strong way.

Tokens minted before this change carry no `sid` and are handled: readers fall back to `iat`, and
existing 30-day tokens stay valid until their original expiry, then converge to 24h on their next
refresh. Nobody is signed out by the deploy.

### 5b. Admin endpoints (audit H9, fixed 2026-09-19)

One static string, `BACKFILL_SECRET`, gated roughly twenty capabilities: the full member roster
with Stripe customer IDs, broadcasting to the entire list, subscription migration, embedding
backfills, the marketplace funnel. One secret for all of it, no way to grant one without granting
every one. It was compared with `!==` in **23 separate handlers**, each with its own idea of what a
refusal looks like. No rate limit, no lockout, and no record of a failed attempt anywhere — while
every one of those endpoints answers `Access-Control-Allow-Origin: *`, so it could be ground down
from any browser tab and nobody would ever know it had been tried.

All 23 now go through **`_lib/admin-auth.js`**, which accepts two things, strongest first:

1. **An admin session** — a signed session token plus a **live `accounts.is_admin` read** with the
   service key. `is_admin` is not in the token and must never be put there; it would go stale
   exactly like `tier` did in H8.
2. **A shared secret**, compared in constant time, for machine-to-machine calls and the
   hand-triggered maintenance pages.

Behaviour worth knowing:

- A **valid session that is not an admin** is refused `403` and does **not** fall through to try the
  secret. Someone signed in as an ordinary member poking an admin endpoint gets recorded.
- Failures are written to **`admin_auth_failures`** (never the attempted secret — only the endpoint,
  the IP and the reason). Past **8 failures from one IP in 15 minutes**, the secret path returns
  `429` *even for the correct secret*. An admin session is unaffected, so grinding cannot lock the
  owner out of his own tooling.
- A caller with **no usable IP is not exempt** from that limit; unknown callers share one bucket.
  Exempting them would hand anyone an opt-out by stripping a header.
- `timingSafeCompare` hashes both sides to 32 bytes before comparing, because
  `crypto.timingSafeEqual` **throws** on a length mismatch — which would be both an oracle and a
  500 on every wrong secret.

**This does not solve "one key opens everything."** Every caller that gets through is still fully
privileged. Splitting those capabilities into separate grants is a decision about who should hold
what, not something to invent inside an auth helper. What H9 bought is: the secret is no longer the
only key, it is compared safely, it is rate limited, and failures are visible.

It also killed a quieter problem. **Five files carried their own hardcoded `ADMIN_EMAILS` list and
they disagreed** — `template-download.js` had three addresses, the rest had one — while
`accounts.is_admin` was the real source of truth all along (exactly one row: `michael@thinkbeyondpsych.com`).
`broadcast-send.js` and `extract-templates-background.js` now read the database instead, and their
dead copies of the list are gone. **The three that remain** (`template-download.js`,
`schedule-post.js`, `template-admin.js`, `post-members-extra.js`) were left alone deliberately:
moving them to `is_admin` would silently *remove* access that `template-download.js` currently
grants to `michael.vangelder@gmail.com`, and changing who is an admin is not a refactor.

The `trigger-*.html` maintenance pages are unchanged and still work — they post `{ secret }`, which
is still accepted. They could now use an admin session instead, which would let the shared secret be
retired for human use entirely; that is the natural next step and is not done yet.

### 5c. One-click sign-in links (audit H10, fixed 2026-09-19)

The CTA in a broadcast used to carry a token that was, in effect, an account-takeover credential
sitting in marketing email. It was `email + purpose + exp` HMAC'd — **deterministic for a 30-day
window** (no nonce, so every link minted for one address in that month was the same string),
**reusable** on every one of those days, and **revocable by nothing**. Presenting it minted a fresh
Supabase magic link and logged the bearer straight in.

A URL in email does not stay in the email. It ends up in forwarded mail, corporate mail-scanning
appliances, browser history, and anything that logs query strings.

The old comment in `_lib/signin-token.js` called this "acceptable for free-tier sign-in". That was
wrong on its own terms: the token is minted per **email**, not per tier, and `_lib/paid-welcome.js`
sends one to every new **paid** member — whose account holds the Vault (NPI, license numbers) and
the PHI tools. Minters: `paid-welcome.js`, `onboarding-drip.js`, `scribe-activation-nudge.js`,
`broadcast-send.js`.

Three changes, which only work together:

| | |
|---|---|
| **TTL** | 30 days → **7** |
| **`jti`** | a random 16 bytes per token, so redemption can be recorded at all |
| **Confirmation** | a GET renders a page; the sign-in happens on the **POST** from it |

**Why the confirmation step is load-bearing, and not just UX.** Links in email are fetched by
things that are not the member — Outlook Safe Links, mail scanners, prefetchers. If the GET spent
the token, every one of those would burn it before the human clicked, and single-use would be
unshippable. Scanners fetch; they do not submit forms. It also means a forwarded email can no
longer silently authenticate the wrong person: the page names the account
(`mic•••@thinkbeyondpsych.com` — enough to recognise your own, not a fresh disclosure).

**Redemption fails closed.** The `jti` goes into `signin_token_uses`; the primary key makes a second
redemption a 409, which lands on the login gate. If that insert fails for any other reason, the
sign-in is also refused — a failed write must never quietly become an unlimited-use token.

**Do not prune `signin_token_uses` faster than the token TTL.** Those rows *are* the record of a
spend; deleting one makes a spent token live again.

**In-flight links still work.** Tokens minted before this have no `jti` and a 30-day `exp`; they are
still honoured, but `effectiveExp()` recomputes their expiry as 7 days from mint, so a link sent
yesterday works and one sent three weeks ago does not. They cannot be single-use enforced — there is
no `jti` to record — which is exactly why they should not get another month.

Not changed, noted deliberately: **`_lib/prefs-token.js` mints an unexpiring token.** It toggles
`notify_email_*` flags and nothing else, so that is defensible — but it is the same class of thing
and belongs in the risk register rather than in a comment nobody re-reads.

Still available if you want it stricter: refuse one-click sign-in for `forum`/`full` accounts
entirely and make them log in normally. That was in the audit's remediation. It is not done, because
it would break `paid-welcome.js`, whose whole job is landing a new paid member in the Scribe — and
single-use plus confirmation already removes most of what made this dangerous.

---

## 6. Compliance: auth is not a PHI path

Per `BAA-AND-PHI-ROUTING.md`, **Supabase is deliberately kept OFF the PHI path** (no BAA; hosting
and non-PHI data only). That is why the free plan / no-BAA is not a problem:
- **Passwords** are credentials, not PHI (and are hashed).
- **Login emails / email addresses** are not PHI.
- **Member (clinician) data** in Supabase — names, emails, tiers, NPI — is your *customers'* PII,
  not patient PHI. No BAA required.
- Patient PHI goes to **AWS Bedrock / Azure** (which hold BAAs) and is processed transiently,
  never stored in Supabase. If you ever persist patient content (e.g. assessment answers with
  patient identity) into a Supabase table, THAT would be a real gap — audit before doing so.

Auth email (magic link / confirmation) rides Supabase Auth's SMTP; **broadcasts are a separate
system** — `netlify/functions/broadcast-send.js` via **Amazon SES** to `public.contacts`. Don't
conflate the two when debugging deliverability.

---

## 7. Rescue playbook — "a member can't get in"

1. Is the address a **typo**? Check `accounts` / `auth.users` for near-duplicates
   (`gnail`, `.comm`, `.co`). Correct in place if it's the only account; delete the typo dupe if a
   good one exists. The signup typo guard now prevents most new cases.
2. **Duplicate accounts** (same person, two emails)? The one with the BAA / paid tier is the keeper.
   Delete the throwaway (`accounts` row + its `auth.users` row + `contacts` row), then confirm the
   keeper is intact. Deleting the dupe also removes the account-switch redirect.
3. Get them in NOW: generate an **admin one-click link** for their email and paste it into a reply.
4. Get them off the treadmill: tell them to **Set a password** (account menu) so they never wait on
   an email again.
