# Turn Tactics — release handoff

Status of this package: **built and tested locally; nothing is deployed.** No production SQL was run,
no hosting was changed, and `public/online-config.js` is byte-for-byte unchanged.

Read sections 1–3 before uploading anything. Companion document: `RULES_RECONCILIATION.md`.

**Update 1.0.1 — accounts without an email.** A username and a password are now enough to register and
sign in; an email is optional and only adds password reset. This needs one dashboard change: turn
**“Confirm email” off** (3.1). The site lives at `https://turntactics.vercel.app/`; moving it to Bunny is
optional and has not been done (3.6).

---

## 1. What changed

**Backend (Supabase SQL, incremental, re-runnable, no resets)**

| File | Purpose |
|---|---|
| `supabase/020_accounts_invites.sql` | Account profiles (username + display name), service-only username sign-in gate with rate limiting, six-character invitation aliases (existing rooms are back-filled), join/recovery attempt limiting, recovery into accounts |
| `supabase/021_notifications.sql` | Notification preferences, device subscriptions, seat-addressed outbox, service-only claim/report with quiet hours, coalescing, retry cap and expiry cleanup |
| `supabase/022_rules_engine.sql` | Rules-profile model (`legacy-v0.5`, `slideshow-2026-11`, new `owner-2026-11`), unified action/clock/victory code, rules desk (catalog, preview, atomic amendments, scheduling, cancel, correction), proposals linked to amendments, rules-version migration |
| `supabase/023_chat_replies_retention.sql` | Quoted replies, DM notifications, 24-hour finished-game chat retention, host deletion of a finished room |
| `supabase/024_release_jobs.sql` | pg_cron jobs: hourly chat purge, per-minute push dispatch (needs two Vault secrets — see 3.4) |
| `supabase/025_release_checks_rules.sql`, `026_release_checks_chat_push.sql` | Admin checks; every fixture rolls back |
| `supabase/functions/tt-login/` | Edge Function: username-or-email sign-in without exposing emails |
| `supabase/functions/tt-push/` | Edge Function: Web Push sender |
| `supabase/functions/_shared/logic.ts` | Pure helpers shared by both functions (unit-tested) |

**Frontend (`public/`, static files only)**

| File | Change |
|---|---|
| `online.html`, `online.js`, `tactics-ui.css` | Rewritten: left menu panel (no bottom bar), parchment / midnight-ink themes, labelled resource row, chess-coordinate board, crest tokens, accounts, rules desk, settings |
| `chat.js` | Avatars, host label, quoted replies, “Sent” only after confirmation, expiry handling |
| `account.js`, `notify.js`, `rules-desk.js`, `crest.js`, `ui.js`, `theme.js` | New modules |
| `sw.js` | New service worker (network-first shell, push, safe click routing) |
| `push-config.js` | New. Holds the **public** VAPID key; empty until you configure push |
| `index.html` | New root entry that forwards to `online.html` |
| `online.webmanifest`, `icons/*` | Manifest corrected; icons added (the repository referenced icons that did not exist) |
| `online-config.js` | **Unchanged. Do not replace.** |
| removed | `online.css`, `online-rules.css`, `online-icons.css`, `online-recovery.css` (unreferenced leftovers), `tests/browser-mock.cjs` (targeted element ids that no longer existed) |

**Most important problems found in the existing code**

1. Rule constants were scattered behind an exact-string test (`tt_is_slideshow`); any new version would have silently behaved as legacy (wrong costs, 7 pm cutoff, no forfeit).
2. Two competing victory paths: the action code ended a game at exactly one survivor and ignored the shared-victory target; the view repaired it later.
3. Only two automatic proposal effects existed; everything else was unenforced text.
4. Identity was an anonymous per-browser session only: no sign-in, no reset, loss of browser = loss of seat unless a recovery code had been saved.
5. No six-player board; 12-character codes only; no join-attempt limiting.
6. Manifest and HTML pointed at icon files that were not in the repository; no service worker; no push.
7. `015_recovery_checks.sql` has been failing since 016 (it starts a 3 × 3 board, which 016 forbids). Pre-existing; left as is.

---

## 2. Test results (actual, from this workspace)

Environment: PostgreSQL 16 (local, no Docker), Node 24, headless Chrome 157. Re-run everything with
`tests/run-all.sh` (installs nothing).

| Area | Result | Evidence |
|---|---|---|
| Migrations 020–023 apply, and apply a second time, on top of 001–018 | **PASS** | `tests/db/release.sh` |
| Board mapping incl. six players; range 4 new vs 2/3 preserved; unknown version refused; chess coordinates | **PASS** | 025 (SQL) + unit |
| Every action: cost, range (Manhattan, L-shape), occupancy, shield rejection without charge, exact transfer, no point creation, rejected requests free, duplicate request ignored | **PASS** | 025 |
| Elimination, forfeiture, withdrawal, last survivor, shared victory recorded once | **PASS** | 025 |
| Voting: strict majority, tie, privacy, settled once | **PASS** | 025 |
| Pacific clock: opening, 18:00 cutoff, DST start and end days, 3-day catch-up, exactly-once income, none after completion, midnight-before-action ordering | **PASS** | 025 (simulated clock on real SQL) |
| Rules desk: typed validation, six distinct error cases, multi-effect atomicity, no duplicate effects or payments, scheduled effect once, cancel, correction, proposal privacy and payment | **PASS** | 025 |
| Accounts in SQL: guests cannot host/join, profile rules, username uniqueness, login gate rate limit and service-only access | **PASS** | 025 |
| Invitations: format, normalisation, legacy codes, forced collision retry, generic failure, attempt limiting | **PASS** | 025 |
| Chat: public/DM isolation, host cannot read others' DMs, quoted-reply permissions, eliminated access, retry de-duplication, rate limit, 24-hour retention, purge, host deletion | **PASS** | 026 |
| Recovery: alias accepted, old identity denied on view/action/chat, history follows the seat, guests refused | **PASS** | 026 |
| Notifications in SQL: defaults, endpoint allow-list (SSRF cases), quiet hours, one summary afterwards, generic payload, preferences, retry, no double send, expired-subscription cleanup, revocation after recovery, device moves between accounts | **PASS** | 026 |
| Privilege audit: every `tt_` function has a fixed `search_path` and is not executable by `anon`/`public`; every `tt_` table has RLS and no client grants | **PASS** | 026 |
| Real concurrent sessions: competing moves, competing final attacks, 6× duplicate request, attack vs shield, spend race, concurrent amendments, clock job vs requests | **PASS** | `tests/db/concurrency.sh` |
| Edge Function helpers, crest determinism/uniqueness, coordinate round-trip | **PASS** | `node --test tests/unit/logic.test.mjs` |
| Browser, real UI on real SQL (21 scenarios): theme persistence without flash, menu focus/Escape/current page, invitation join, board labels, labelled resources, crests, move + Dispatch coordinate, UI privacy, lost response → reload → same-request retry, chat (Sent, quote, DM hidden from host, XSS as text), late chat response discarded, rules desk preview → publish, notification prompt not automatic, 15 × 15 on a phone, guest seat, registering and signing in with a username and password only, taken and reserved usernames, a server that still confirms emails, a failed email link, guest upgrade without an email | **PASS**, but **Supabase Auth, PostgREST and push delivery are stubbed** | `node tests/e2e/run.mjs` |
| The app under the recommended Content-Security-Policy | **PASS** (the e2e server sends it) | same |
| Accounts on a real Auth server: register and sign in with a username and password, with and without an email; name collisions; guest upgrade in place; a failed email link while signed in | **PASS, run once by hand** — real supabase-js 2.49.1 in Chrome against supabase/auth v2.197.0 run locally with “Confirm email” off | not part of `tests/run-all.sh` |
| Supabase Auth on your hosted project; confirmation and password-reset emails | **NOT RUN** — needs your Supabase project (and SMTP for the emails) | — |
| `tt-login` and `tt-push` Edge Functions executing in Deno | **NOT RUN** — no Deno/Supabase CLI here; only their pure helpers are tested | — |
| Real push to Android Chrome and installed iOS/iPadOS | **NOT RUN** — needs VAPID keys, the deployed function and devices | — |
| Checks 025/026 on the real Supabase database | **NOT RUN** — you run them in step 3.2 | — |
| iPhone Safari / Android Chrome on hardware, mobile keyboard, home-screen install | **NOT RUN** — emulated viewports only | — |
| `pg_cron`/`pg_net` jobs in 024 | **NOT RUN** — extensions absent locally | — |
| Pre-release `015_recovery_checks.sql` | **FAIL (pre-existing)** — see section 1, item 7 | `tests/db/baseline.sh` |

Do not treat the stubbed or NOT RUN rows as proven. Section 6 lists what to verify by hand.

---

## 3. How to release (in this order)

Apply the backend first, then upload the frontend straight after. In between, the old frontend keeps
working for existing seats, but its “Create a host room” and new joins will answer “Create an account”.

### 3.1 Supabase dashboard settings (before SQL)

Check each label against the current dashboard; names move.

* **Authentication → Sign In / Providers → Email**: enabled, with **“Confirm email” off**. An account
  made without an email signs in through a placeholder address (`<username>@players.turntactics.invalid`)
  that cannot receive mail, so it can only be created with confirmation off. With it off nobody waits for
  an email: registering signs the player in at once, and a typed email is stored unverified.
* **Authentication → Sign In / Providers**: “Allow anonymous sign-ins” can stay on (existing guest
  sessions refresh without it, but leaving it on is harmless — the new app never creates guests).
  “Allow manual linking” must be **on** for guest → account upgrades.
* **Authentication → URL Configuration**: Site URL `https://turntactics.vercel.app/online.html`, and the
  same address in Redirect URLs. Add the Bunny address only if you move there (3.6).
* **Authentication → Emails / SMTP**: optional. Only password-reset emails are sent now. The built-in
  sender allows 2 messages an hour and refuses every address that is not a member of your Supabase
  organisation, so players can reset a password by email only after custom SMTP is configured.
* **Database → Extensions**: `pg_cron` (already on), `pg_net`.

### 3.2 SQL, in exact order (SQL Editor, one file at a time)

1. `020_accounts_invites.sql`
2. `021_notifications.sql`
3. `022_rules_engine.sql`
4. `023_chat_replies_retention.sql`
5. `025_release_checks_rules.sql` → expect `Release rule checks passed (134 assertions)`
6. `026_release_checks_chat_push.sql` → expect `Release chat/push checks passed (59 assertions)`
7. `024_release_jobs.sql` — only after 3.4 (it needs the Vault secrets). Its first statement
   (chat purge) is safe to run on its own earlier.

Do **not** re-run 001–019. In particular 015/017/019 create rooms as bare users and will now stop at
“Create an account”; 025/026 replace them.

### 3.3 Edge Functions (Supabase CLI on any machine, or the dashboard editor)

**Shortcut for 3.3 and 3.4:** `SUPABASE_ACCESS_TOKEN=<token> node scripts/deploy-backend.mjs` generates the
secrets, deploys both functions, stores the Vault secrets, runs `024_release_jobs.sql`, checks the result
and only then writes the public key into `public/push-config.js` for you to commit. It needs 020–023
applied first and can be re-run. The manual steps below are what it does.

```
supabase functions deploy tt-login --no-verify-jwt
supabase functions deploy tt-push  --no-verify-jwt
```

`--no-verify-jwt` is required: `tt-login` is called before a session exists and `tt-push` is called
by the database with a shared secret. Both authenticate/limit requests themselves. `tt-login` is only
needed so that an account **with** an email can also sign in by its username; accounts without an email
sign in by username without it.

Secrets (Edge Functions → Secrets). Names only; you generate the values:

| Secret | Used by | Value |
|---|---|---|
| `TT_ALLOWED_ORIGINS` | tt-login | `https://turntactics.vercel.app` (comma-separate any further origin) |
| `TT_PUBLISHABLE_KEY` | tt-login | the same public key that is in `online-config.js` |
| `TT_CRON_SECRET` | tt-push | a long random string (24+ characters) |
| `TT_VAPID_PUBLIC_KEY`, `TT_VAPID_PRIVATE_KEY` | tt-push | a VAPID key pair, e.g. `npx web-push generate-vapid-keys` |
| `TT_VAPID_SUBJECT` | tt-push | `mailto:` an address you read |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are supplied by the platform.

### 3.4 Push wiring

1. Put the VAPID **public** key into `public/push-config.js` (it is safe to publish). Never put the
   private key in any file in this repository.
2. In the SQL Editor, once:
   `select vault.create_secret('https://<project-ref>.supabase.co', 'tt_project_url');`
   `select vault.create_secret('<same value as TT_CRON_SECRET>', 'tt_cron_secret');`
3. Run `024_release_jobs.sql`; confirm four `turn-tactics-*` jobs are active.

Until all of this is done the app shows notifications as **“Pending setup”** and sends nothing.

### 3.5 Frontend upload

Upload the **contents of `public/`** to the site root (GitHub → Vercel). Everything is static; no
build step.

* Upload `online-config.js` unchanged (or leave the deployed copy in place).
* Bump versions together when you change files later: the `?v=1.0.1` strings in `online.html` and in
  the `import` lines, `APP_VERSION` in `online.js`, and `VERSION` in `sw.js`.

### 3.6 Bunny (optional; not set up)

Nothing here is required: Vercel serves the same static files, and `turntactics.b-cdn.net` is not
configured. bunny.net is a paid service — its 14-day trial needs no card, but after it the account needs
a prepaid balance ($1 monthly minimum). If you move later (verify labels in the current Bunny dashboard):

* The pull zone must serve `index.html`/`online.html` from the root over HTTPS (force SSL on).
* MIME types that matter: `.js` → `text/javascript`, `.webmanifest` → `application/manifest+json`,
  `.svg` → `image/svg+xml`. Check with the browser's Network tab after upload.
* Caching: let HTML, `sw.js`, `online-config.js` and `push-config.js` revalidate (short or no edge
  cache). Other files are versioned by query string, so make sure the zone varies cache by query string.
* Recommended response headers (Bunny Edge Rules have a **Set Response Header** action). This exact
  policy is what the browser tests run under; replace the project host:

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://esm.sh; style-src 'self'; img-src 'self' data:; connect-src 'self' https://<project-ref>.supabase.co wss://<project-ref>.supabase.co https://esm.sh; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000
```

* `sw.js` must be served from the same folder as `online.html` (its scope is that folder).

### 3.7 If you move players from Vercel to Bunny

Browser storage is per origin: a session, saved rooms, theme and notification subscription on
`turntactics.vercel.app` do **not** appear on `turntactics.b-cdn.net`.

* Players with accounts: sign in on the new address; their seats are attached to the account.
  Notifications must be turned on again there (and the app re-installed to the home screen).
* Guests from the old version: **before leaving the Vercel address**, open it, choose
  *Create account* (this upgrades the guest in place and keeps every seat; no email is needed), then
  sign in on Bunny. Alternative: create a recovery code per room on Vercel, then on Bunny sign in and
  use *Restore a role*.
* Keep the Vercel deployment online until active games have migrated, and add the Bunny address to
  `TT_ALLOWED_ORIGINS` and the Auth redirect list before then.

---

## 4. Behaviour worth knowing

* **Existing rooms** keep their rules version and every stored value. New rooms are `owner-2026-11`.
* **Accounts**: a username and a password; an email is optional. Without an email the account signs in
  directly by its username and cannot reset a forgotten password by itself. The host can set a new one in
  the SQL Editor: `update auth.users set encrypted_password = extensions.crypt('<new password>',
  extensions.gen_salt('bf')) where email = '<username>@players.turntactics.invalid';` (a hash written
  this way was accepted by a local Auth server; `extensions` is where Supabase keeps pgcrypto). With an
  email the account can reset its password and signs in with that email; signing in by username then
  needs `tt-login`, which resolves usernames server-side so the browser never receives an email
  (failures are generic; 10 attempts per identifier and 40 per IP per 15 minutes).
* **Guest upgrade** completes at once when “Confirm email” is off, with or without an email. With it on,
  Supabase's documented order applies: email first, password after the email is verified; the app then
  asks for the password on the profile step.
* **Failed email links**: a confirmation or reset link that has expired, or that a mail scanner opened
  before the person did, comes back as `#error=…otp_expired`. The app explains it and removes it before
  the Auth library sees it, because the library would otherwise end the current session.
* **Signing in to an existing account from a guest browser** replaces the guest session. The app
  offers to carry the remembered room's role across using a freshly minted recovery code (this
  replaces that role's previous code). Other guest seats need their own recovery codes.
* **Invitations** authorise a join attempt only. Unknown, started and full rooms give the same
  answer; 12 failures in 10 minutes pause further attempts for that account.
* **Scheduled effects** apply at the next reset, before that reset's income, exactly once.
* **Notifications**: generic text only (“You have a new update.” / “You have N new updates.”).
  Quiet hours 22:00–08:00 Pacific hold every category; one summary follows. Events older than
  36 hours are dropped rather than delivered late. Events are addressed to seats, so a recovered-away
  identity stops receiving them at once.
* **Chat retention**: 24 hours after the match ends, access is refused immediately and the hourly
  job deletes the rows. Quotes are never stored as copies, so they disappear with the original.
  Already-seen text, screenshots and external copies cannot be recalled.
* **Privacy**: DMs are participant-only in the app, not end-to-end encrypted; database
  administrators can read stored messages. The app states this in the chat screen.

---

## 5. Known limitations

* The Supabase client library is loaded from `esm.sh` at a pinned version, as before. If esm.sh is
  unreachable the app cannot start. Vendoring the file into `public/` would remove that dependency
  (not done: adding third-party code was outside what you authorised).
* One recovery code per role; carrying a guest seat into an account replaces it.
* There is no screen for adding an email to an account that was made without one.
* If someone registers without an email under a username that already belongs to an account with an
  email, the refused attempt leaves a locked, profile-less row in Authentication → Users. It is harmless
  and can be deleted there.
* Room names are fixed once a game is scheduled; a changed account display name does not rename
  existing seats.
* The host's five-room limit counts finished rooms until they are deleted.
* Push cannot be delivered to iPhone/iPad Safari tabs — only to the installed home-screen app
  (iOS/iPadOS 16.4+). Delivery timing is up to the device and push service.
* Notifications are coalesced per account per minute; a burst may arrive as one summary.
* Rules desk: no board resizing, revival, piece movement, conditional triggers beyond
  “next midnight reset”, or changes to the transfer amount. Use a written (host-enforced) rule.
* A legacy or slideshow room viewed with this frontend shows chess coordinates on the board, while
  its Dispatch keeps the `(column, row)` wording it was written with.
* Dispatch and the host log show the latest 300 entries.

---

## 6. Release blockers (must be done by you)

1. Run 020–023 and confirm both check files pass on the real project (3.2).
2. Turn “Confirm email” off and set the Auth URLs (3.1); then register a test account with a username
   and password only, sign out, and sign in again. **These flows passed against a local Auth server but
   have never run on your hosted project**; password reset by email has not run anywhere.
3. Deploy both Edge Functions with their secrets; confirm that an account with an email can sign in by
   its username.
4. Generate VAPID keys, fill `push-config.js`, create the Vault secrets, run 024, and receive a real
   notification on an Android phone and an installed iPhone app, including a quiet-hours summary.
5. Deploy `public/` (Vercel) and confirm: `online.html` loads, the app installs to a home screen, a
   reload after a later deploy shows the new version.
6. Upgrade one real guest seat (*Create account* in the browser that holds it) and confirm the seat is
   still there.

Until 2–4 are verified, describe accounts and background notifications as *pending setup*.

---

## 7. Rollback and forward-fix

* **Frontend**: re-upload the previous `public/` files. Bump `VERSION` in `sw.js` (or remove
  `sw.js` and unregister) so installed copies pick up the change on next load; the worker is
  network-first, so it never pins old code while online.
* **SQL**: the migrations only add tables/columns and replace functions; they delete nothing.
  Prefer a forward fix. To return to the previous function behaviour, re-run 016 then 018
  (rooms created meanwhile as `owner-2026-11`, their amendments and reply links would then be
  ignored or refused by the old code — do this only with no such rooms in play). New tables can stay.
* **Jobs**: `select cron.unschedule('turn-tactics-push');` stops delivery and keeps the queue.
* **Edge Functions**: delete or redeploy; accounts without an email still sign in by username, the
  others by email, and notifications show “pending setup”.

Git history is the backup of the pre-release files (`main` before this change).
