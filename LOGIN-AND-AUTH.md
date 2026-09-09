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
