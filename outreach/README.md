# Klinner Outreach — Operator Runbook

Automated email prospecting for **Klinner Cleaning & Maintenance**, built on
Google Sheets + Apps Script + Gmail/Workspace. Runs entirely on Google's
servers — no dependency on any local machine.

Spec: `ESPECIFICACION FINAL V1.1 — KLINNER OUTREACH` + `PATCH FINAL V1.1`.
This delivery implements **F1 — Datos + Preview puro** only. F2 (LIVE
sending) and F3 (automatic reply-sync triggers) are scaffolded per the
approved architecture but are not active — see "Current phase" below.

## Current phase: F1 — Preview only

- `DRY_RUN = TRUE` in `Config`. This must stay `TRUE` until you have
  completed F0 and F2's acceptance checklist.
- **Zero real emails can be sent.** The preview pipeline only creates Gmail
  drafts, and every LIVE send function refuses to run while `DRY_RUN=TRUE`
  or while any F0 value is still `PENDING_F0`.
- No triggers are installed automatically. Nothing runs on a schedule yet.

## One-time setup (do this first)

1. Create a new Google Sheet (or use a dedicated Klinner Outreach sheet).
2. Extensions → Apps Script. Copy in the 16 productive `.gs` files from
   this folder plus `appsscript.json` (17 deployable files total) — or use
   `clasp push` if you set up clasp against this project — see "clasp"
   below. `Tests.gs` and everything under `test-harness/` are **not**
   part of this list — see "Running the F1 test suite".
3. In the Apps Script editor, run `initializeSheets` once (or use the
   spreadsheet menu **Klinner Outreach → Initialize Klinner Outreach
   sheets** after the first save, which calls the same function). This
   creates all 7 sheets, the Prospects column layout, data validations,
   the protected `S:AG` range, the 32-row Config sheet, and 4 seed
   templates.
4. Reload the spreadsheet. You should see a **Klinner Outreach** menu.
5. Paste your prospect data into `Prospects`, starting at row 2, filling in
   at minimum: `Business_Name`, `Email`, `City`, `State`, `Problem_Found`.
   Leave every column from `Prospect_ID` through `Last_Run_ID` blank — the
   system fills those in.
6. Run **Klinner Outreach → Validate all rows**. This classifies every new
   row as `READY`, `NEEDS_DATA`, `INVALID_EMAIL`, or `DUPLICATE`, and works
   fine while `DRY_RUN=TRUE`.
7. Run **Klinner Outreach → Preview today's queue** (or **Preview full
   sequence for selected row** for one prospect at a time). Open Gmail →
   Drafts and read them. Every preview draft's first line is:
   `--- KLINNER OUTREACH PREVIEW — DO NOT SEND ---`

## Manual configuration still pending (F0)

Five `Config` values are intentionally left as the literal string
`PENDING_F0`. **Do not invent values for these** — they are business
decisions, not engineering ones:

| Key | What it needs |
|---|---|
| `SENDER_EMAIL` | The dedicated Workspace mailbox for outreach, separate from Klinner's main business email |
| `REPLY_TO` | Usually the same address |
| `ADMIN_EMAIL` | Where the daily digest and failure alerts go |
| `PHYSICAL_ADDRESS` | Required in every commercial email footer (CAN-SPAM) |
| `UNSUBSCRIBE_LINE` | The opt-out sentence rendered in every template |

While any of these five is `PENDING_F0`, `assertLiveAllowed_()` (I21)
refuses to let any LIVE send happen — this is enforced in code, not just by
convention. Separately, `dailyDigest` specifically checks `ADMIN_EMAIL`: if
it's still `PENDING_F0`, the digest is computed and logged every day but
never emailed (I22) — that's expected, not a bug, until you fill it in.

Also outside this delivery's scope, per your explicit instructions: buying
a domain, DNS/SPF/DKIM/DMARC configuration, and Workspace mailbox setup.
Those are F0 steps for you (or whoever handles Klinner's domain) to do
outside of this code.

## Menu reference

| Menu item | What it does | Origin | Blocked by DRY_RUN? |
|---|---|---|---|
| Initialize Klinner Outreach sheets | Creates/repairs the 7 sheets | — | No |
| Validate all rows | Classifies NEW/blank/NEEDS_DATA rows | ADMIN | No |
| Preview today's queue | Drafts up to `MAX_PREVIEW_PER_RUN` eligible emails | PIPELINE (draft only) | N/A — never writes Prospects |
| Preview full sequence for selected row | Drafts all 4 steps for one prospect | PIPELINE (draft only) | N/A |
| Delete Klinner preview drafts | Bulk-deletes all live preview drafts | — | No |
| Send now (LIVE) | Runs `sendBatch()` — real sending | PIPELINE | **Yes — refuses while DRY_RUN=TRUE** |
| Sync replies now | Runs `syncReplies()` manually | SYSTEM | No (but nothing to sync in F1) |
| Stop prospect | Sets Stop_Contact + a reason | ADMIN | No |
| Process unsubscribe for selected row | Full unsubscribe procedure (§9) | ADMIN | No |
| Reset prospect | Clears send history, back to READY | ADMIN | No — but **refused** if the prospect is currently blocked (Stop_Contact or any DNC reason) |
| Install / repair triggers | Installs the 4 managed triggers only | — | No — **but do not run this yet in F1**, see below |

## Do NOT do yet (explicitly out of scope for this delivery)

- Do not click **Install / repair triggers** yet. Nothing should run on a
  schedule until you've reviewed F1's output and are ready for F2.
- Do not change `DRY_RUN` to `FALSE`.
- Do not fill in the 5 `PENDING_F0` values with placeholders "just to test"
  — `assertLiveAllowed_()` exists specifically so that can't happen by
  accident, but don't work around it either.

## How to move to F2 (LIVE sending) — later, not now

1. Complete F0: dedicated domain/mailbox, DKIM/SPF/DMARC, and fill in the
   5 `PENDING_F0` Config values with real ones.
2. Re-run **Validate all rows** and review the `Dashboard` sheet.
3. Manually run **Send now (LIVE)** a few times and watch the `Log` sheet
   and your Gmail Sent folder closely, at the `MAX_PER_DAY` cap — **5/day**
   by default, since this is a brand-new dedicated mailbox. Raise it
   manually in `Config` later, once deliverability/bounces/replies look
   healthy.
4. Only once you're confident, run **Install / repair triggers** to
   automate `sendBatch`, `syncReplies`, `nightlyRecon`, and `dailyDigest`.
5. Flipping `DRY_RUN` to `FALSE` requires no state cleanup — the LIVE
   pipeline reads real, untouched `Prospects` state, because the preview
   pipeline was architecturally incapable of writing to it (I14).

### Two items that used to block further progress — both now closed

**N5 (was: BLOCKER BEFORE FIRST LIVE EMAIL) — CLOSED.** `Mailer.gs`'s
`doStep1Send_`/`doFollowUpSend_` (inside the LIVE closure, unreachable in
F1) had ambiguous-outcome races that could leave a prospect automatically
retryable after a send whose real outcome couldn't be proven. Both now
stop the prospect into `NEEDS_REVIEW` on any ambiguous outcome instead of
leaving it retryable — see `N5_AUDIT.md` for the full race model,
verification method (static checks + `mutation-test-N5.js`, since this
project's policy is to never flip `DRY_RUN=FALSE` even locally — same
method already used for findings #7/#8), and one documented-but-not-fixed
secondary finding (a reconciliation gap that is a stuck-state bug, not a
duplicate-send risk).

**N4 (was: BLOCKER BEFORE F3) — CLOSED.** `Constants.gs`'s
`SYSTEM_REPLY_SYNC` and `SYSTEM_NIGHTLY_RECON` operations now carry the
same `restrictedValues` guard on `Do_Not_Contact_Reason` the ADMIN
operations already had — structurally forbidden from ever setting
`"unsubscribe"`. No current F1/F2 code path did that anyway (this closed a
latent gap, not an active bug) — see `test_N4_systemOperationsCannotSetUnsubscribeReason_`
in `Tests.gs` and `test-harness/mutation-test-N4.js`.

## Reading the Log sheet

Every row has `Mode` (whether the system was in `DRY_RUN` or `LIVE` when
the event happened) and `Event`. Key events to know:

- `WRITE_REFUSED_DRY_RUN` — the origin-gated write guard rejected a
  PIPELINE write while DRY_RUN=TRUE. This should never appear in normal F1
  operation (the preview pipeline never attempts such a write) — if you see
  it, something unexpected called a LIVE code path; check `Detail`.
- `SKIP:needs_data` — a preview or send attempt hit a blank required merge
  field. Fix the row's data and re-run Validate.
- `LIVE_BLOCKED_PENDING_F0` — someone tried to run LIVE sending before F0
  was finished.
- `DIGEST_NOT_SENT_PENDING_F0` — expected daily noise until `ADMIN_EMAIL`
  is filled in. The full digest text is in the `Detail` column.
- `RESET_REFUSED` — someone tried to reset a blocked prospect. Check
  `Detail` for which block (Stop_Contact or which DNC reason).

## Running the F1 test suite

`Tests.gs` is **local-only, by design** — `.claspignore` deliberately
excludes it (and all of `test-harness/`) from `clasp push`, so it never
reaches the real Apps Script project and can never run against the real
Sheet. Some of its fixtures (the 1000-row ghost-row scenario in
particular) write and restore large ranges of Prospects, which is exactly
the kind of thing that must never be exercised against real data — keeping
test code out of the deployed project is the structural guarantee for
that, not fixture-level care alone.

Run the suite locally instead, against the mocked Sheets/Gmail services in
`test-harness/`:

```
cd outreach
node test-harness/run-f1-tests.js
node test-harness/verify-static-findings.js
node test-harness/mutation-test-N7.js
node test-harness/mutation-test-ghost-rows.js
node test-harness/mutation-test-N3.js
```

`Tests.gs` is never added to `.claspignore`'s allow-list, under any
circumstance, temporary or otherwise — there is no supported procedure for
deploying it. `runAllF1Tests()` is never run against the real Google
Sheet. `test-harness/` never reaches Google either. Test fixtures
(including the 1000-row ghost-row scenario, which writes and restores
large ranges of Prospects) never execute against real data — the
guarantee is structural (the code is simply not present in the deployed
project), not a matter of the fixtures being careful.

`T26_T27` (the two tests that need a real prior LIVE thread — see their
docstring in `Tests.gs`) are consequently **not run against Google at
all** in this workflow. Google-real verification for F1 happens
exclusively through the controlled, documented F1 plan — the menu actions
and production functions listed above (`Validate all rows`, `Preview
today's queue`, etc.) — never by deploying test fixtures.

## SendLedger schema migration (N3 durable human-edit protection)

`SendLedger` gained 3 columns appended at the end of the layout — `N:
Draft_Fingerprint`, `O: Human_Edit_Preserved`, `P: Human_Edit_Detected_At`
(see `SEND_LEDGER_COLUMNS` in `Constants.gs`). They exist so previewStep()
can durably recognize a Gmail draft a human has edited (recipient,
subject, or body) and never silently delete/regenerate it — see
`resolveExistingPreviewDraft_` and `verifyPreviewDraftOwnership_` in
`Mailer.gs` for the full design.

Because the columns were **appended, not inserted**, every pre-existing
column (A:M) keeps its exact index — nothing about `Run_ID` through
`Error` changed. A brand-new SendLedger sheet gets the correct 16-column
header automatically from `initializeSendLedgerSheet_()`. The real
"Klinner Outreach — F1 Test" Sheet's SendLedger was already initialized
with the old 13-column header before this fix existed, and
`initializeSendLedgerSheet_()` deliberately never rewrites an
already-initialized sheet's header (it must never risk clearing real
ledger history) — so that Sheet needs a one-time, additive-only repair
before this fix's ledger writes will include the new columns:

```
repairSendLedgerColumns()
```

Run it once from the Apps Script editor's "Select function to run"
dropdown, the same way `repairConfigValueColumnFormat()` was run earlier.
It only ever writes header cells `N1:P1`; it never touches columns A-M,
never touches any data row, and is idempotent (a no-op if the headers are
already present). **Not run against Google as part of this delivery** —
do this before repeating `Preview today's queue` or any other preview
action against the real Sheet.

## OAuth scopes — what each service actually needs (Codex finding #16)

`appsscript.json` declares **7 scopes**. This is what each one is for,
mapped to the actual API calls in this codebase — **not yet verified
against a real Google account**; the authoritative check happens the
first time you authorize the project in Apps Script (it will prompt for
exactly the scopes it needs, or fail clearly if one is missing).

| # | Scope | Used for | Evidence in code |
|---|---|---|---|
| 1 | `.../auth/spreadsheets` | All `SpreadsheetApp` reads/writes: sheets, ranges, data validation, protected ranges. | `SpreadsheetApp.getActiveSpreadsheet`, `.getRange`, `.newDataValidation`, `.protect` (`SheetRepo.gs`) |
| 2 | `.../auth/gmail.compose` | Creating/deleting DRAFTS: `GmailApp.createDraft`, `GmailThread.createDraftReply`, `GmailDraft.deleteDraft`. This is F1's entire Gmail footprint. | `Mailer.gs` (`previewStep`, `deletePreviewDraftIfOwned_`) |
| 3 | `.../auth/gmail.modify` | Reading threads/messages and applying labels: `GmailApp.getThreadById`, `GmailApp.search`, `GmailThread.getMessages`, `GmailMessage.getFrom/getTo/getSubject/getPlainBody/getRawContent`, `GmailThread.addLabel`, `GmailApp.createLabel`/`getUserLabelByName`. F2/F3 only (`ReplySync.gs`, and the LIVE half of `Mailer.gs`) — inactive in F1. | `ReplySync.gs`, `Mailer.gs` (LIVE closure) |
| 4 | `.../auth/gmail.send` | Actually sending mail: `GmailDraft.send()`, `GmailThread.reply()`. F2 only — inactive in F1 (`performLiveSend_` blocks it). | `Mailer.gs` (LIVE closure only) |
| 5 | `.../auth/script.send_mail` | `MailApp.sendEmail()` — the daily digest. Runs in F1, but see `Digest.gs`'s `PENDING_F0` guard: it does not actually call this until `ADMIN_EMAIL` is filled in. | `Digest.gs` |
| 6 | `.../auth/script.scriptapp` | `ScriptApp.newTrigger/getProjectTriggers/deleteTrigger` — the trigger installer. Defined, not invoked automatically in F1 (`Triggers.gs`). | `Triggers.gs` |
| 7 | `.../auth/script.container.ui` | `SpreadsheetApp.getUi()` — the entire `Klinner Outreach` menu, and every `alert()`/`prompt()` dialog it drives. Without this scope the menu cannot be built. | `Menu.gs` |

**Not currently declared, used only for graceful-degradation logic that
tolerates its own absence:** `Session.getEffectiveUser()` (`SheetRepo.gs`'s
protection setup, finding #12) — this is normally covered implicitly by
any of the above scopes in practice, but if Google prompts for an
additional identity scope (e.g. `.../auth/userinfo.email`) the first time
you authorize, that is expected and should be granted; the code already
tolerates `Session.getEffectiveUser()` throwing or returning something
without `.getEmail()`.

**Two scopes (`gmail.modify`, `gmail.send`) are exercised by code that is
provably unreachable in this F1 delivery.** They are declared now so F2
doesn't require a re-authorization prompt later, but their real behavior —
label creation, real search queries, real sends — is entirely unverified
until Google-real testing (F2).

## clasp (optional)

This folder is a plain Apps Script project layout (`.gs` files +
`appsscript.json`). If you use [clasp](https://github.com/google/clasp):

```
cd outreach
clasp login
clasp create --type sheets --title "Klinner Outreach"
clasp push
```

`clasp create` will generate a `.clasp.json` — it is intentionally not
included in this delivery since it's tied to a specific Google account/
spreadsheet you create.

### Verifying a push actually removed a file remotely

If you ever change `.claspignore`'s allow-list (for example, narrowing it
further) and push, `clasp push` reporting **"Pushed 17 files"** confirms
what was *sent* — it does not by itself confirm anything was *removed* on
the Google side. If clasp instead reports **"Script is already up to
date"**, that specifically proves nothing changed remotely — it is not
evidence that a file you intended to remove is actually gone; it may
simply mean the push never happened.

After any push meant to remove a file from the deployed project (e.g.
confirming `Tests.gs` is genuinely absent), verify remotely using one of
these two methods:

**A. Apps Script editor** — open the project, **hard-refresh the page**
(a stale tab can still show a file that was already removed server-side),
and confirm the file no longer appears in the file list.

**B. A clean, isolated `clasp pull`** — in a **temporary directory outside
this repo**, never inside it:
```
mkdir -p /tmp/klinner-outreach-verify && cd /tmp/klinner-outreach-verify
clasp clone <scriptId>
ls
```
Confirm the file is absent from the pulled listing, then delete the temp
directory. **Never run `clasp pull` inside `/Users/apple/Projects/klinner-deploy/outreach`**
for this check — pulling into the canonical local source directory risks
overwriting local files with remote state, which is a separate, unrelated
risk this check must not introduce.

If verification shows the file is still present remotely, stop — do not
proceed with any Google-real testing until it is confirmed removed.

## File map

See the spec's §14 file list. Every file's header comment states its
responsibility and, where relevant, exactly which invariant(s) it enforces.
