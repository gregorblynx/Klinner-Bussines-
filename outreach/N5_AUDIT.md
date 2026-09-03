# N5 — LIVE send concurrency audit (blocker before first LIVE email)

Status: **core duplicate-send races closed**. One secondary (non-duplicate-send) reconciliation gap found and documented but not yet fixed — see §5.

## 1. Race model

Traced the full LIVE path: `sendBatch()` → `sendStep1()`/`sendFollowUp()` → `executeLiveSendForStep_` (the single guarded entry point, Mailer.gs) → `performLiveSend_` (DRY_RUN/PENDING_F0 gate) → lock → `canSend_` (StateMachine.gs) → `isLiveKeyClaimedOrSent_` (Ledger.gs, I13) → `computeLiveSendBudget_` → `doStep1Send_`/`doFollowUpSend_` → Gmail → `updateLedgerRow_`/`writeRowById_`.

Scenarios modeled:

| # | Scenario | Outcome before tonight | Outcome now |
|---|---|---|---|
| 1-3 | Two concurrent trigger executions, same prospect/step | `LockService.getScriptLock()` serializes the whole decision+send critical section (lock acquired before `canSend_`, released only in the `finally`); the second execution re-reads the ledger under the SAME lock and sees `isLiveKeyClaimedOrSent_()===true` → `SKIPPED_ALREADY_CLAIMED`. | Unchanged — already safe. Analogous mechanism (LockService around Preview's supersede→create→append) is exercised by `finding5_previewLocking` locally; the LIVE lock itself cannot be exercised locally without flipping DRY_RUN (see §2). |
| 4 | `draft.send()` throws (step 1) — genuinely ambiguous: may or may not have actually sent server-side | Marked `LEDGER_STATE.FAILED` (retryable — I13 only excludes CLAIMED/SENT) → a later `sendBatch` run calls `doStep1Send_` again → **real duplicate-send risk**. | **Fixed.** Also writes `Status: NEEDS_REVIEW` to Prospects (`writeRowById_`, origin=PIPELINE), which structurally excludes the prospect from `getNextStepNumber_`/`canSend_`/`isEligibleForNextStep_` — no automatic retry possible regardless of the ledger row's retryable state. |
| 5 | Ledger claim written, then the actual Gmail call never runs (Apps Script execution killed — 6-minute limit, quota, crash) | Ledger row stuck at `CLAIMED` forever. `isLiveKeyClaimedOrSent_` treats `CLAIMED` as claimed → blocks retry (safe, no duplicate) but the prospect is frozen until reconciled. | Unchanged behavior (safe by construction — no duplicate risk); the existing `reconcileStaleLiveClaims_`/`nightlyRecon` backstop (F2, not yet exercised) is meant to resolve this. See §5 for a gap found in that backstop. |
| 6 | `GmailThread.reply()` succeeds but the process dies before `updateLedgerRow_(...SENT...)` | Same as #5 — CLAIMED row, safe (blocks retry), needs reconciliation. | Unchanged. |
| 7 | Retry after an ambiguous timeout | Previously: retried blindly (the actual bug this whole phase closes for #4/#8). | **Fixed** for the two identified ambiguous-outcome call sites (step 1 send, follow-up reply/message-count race) — see #4 and #8. |
| 8 | Concurrent follow-up in the same thread (an inbound reply lands in the window between `thread.reply()` returning and `getMessages()`) | This is the ORIGINAL documented N5 finding: `messagesAfter.length !== messagesBefore + 1` → marked `FAILED` (retryable) and thrown, but Prospects row never touched → next `sendBatch` run calls `doFollowUpSend_` again → **real duplicate follow-up send**. | **Fixed** — see §3. |
| 9 | Duplicate sends generally | N/A | Both concrete code paths that could double-send now stop the prospect into `NEEDS_REVIEW` on any ambiguous outcome, never retry blindly. |

## 2. Why no runtime test exercises the LIVE path

`executeLiveSendForStep_` is wrapped by `performLiveSend_`, which throws immediately when `DRY_RUN=TRUE` — the ONLY way to run `doStep1Send_`/`doFollowUpSend_` at all, even locally, is to flip the mock Config's `DRY_RUN` cell to `FALSE` for the duration of a test. This project has an existing, deliberate policy against that (see `Tests.gs`'s own comment above the finding #3B/#4/#5/#6/#9/#10/#11/#12/#13/#14 test block: *"Findings #7 and #8's LIVE-only branches cannot be exercised here without flipping DRY_RUN=FALSE, which this delivery must not do — they are covered instead by a static source check in test-harness/verify-static-findings.js."*). Tonight's hard-stop list ("NO cambiar DRY_RUN a FALSE") is consistent with, and reinforces, that existing convention.

N5's fixes are therefore verified the same way findings #7/#8 already were: **static source-pattern checks** in `test-harness/verify-static-findings.js`, plus a dedicated `test-harness/mutation-test-N5.js` that mutates an in-memory copy of `Mailer.gs`'s source back to the old buggy pattern and proves each check catches it. This is not a substitute for real LIVE testing once F2 is authorized — it only proves the fix pattern is present and the bug pattern is absent.

## 3. Design implemented

**Direction (a)** from the original code comment (the only one of the two evaluated directions that doesn't require F2/real-Gmail-behavior verification to implement safely): on any ambiguous send outcome, in addition to marking the `SendLedger` row `FAILED`, ALSO write `Status: STATUS.NEEDS_REVIEW` to the Prospects row (`origin: PIPELINE, operation: PIPELINE_SEND` — already an explicitly permitted status/column for that operation in `OPERATION_PERMISSIONS`, Constants.gs). `getNextStepNumber_` only returns non-null for `Status IN (READY, IN_SEQUENCE)`, so `NEEDS_REVIEW` structurally removes the prospect from `canSend_`/`isEligibleForNextStep_` eligibility — no code path can automatically retry it, regardless of the ledger row's own retryable `FAILED` state. This is the exact same pattern `doFollowUpSend_` already used for its `getThreadById()`-returns-null case; both fixes just extend it to the two other ambiguous-outcome sites.

Applied to:
- `doStep1Send_`'s `catch (sendError)` block (Mailer.gs) — `draft.send()` throwing.
- `doFollowUpSend_`'s `messagesAfter.length !== messagesBefore + 1` guard (Mailer.gs) — the originally documented race.

Direction (b) (identify the sent message by a property of the reply itself, removing the array-length-diff race entirely) was evaluated and rejected for tonight: it requires knowing exactly what GmailThread.reply()'s real return value exposes beyond what's already documented/tested, which is Google-real-verification territory, explicitly out of scope tonight.

## 4. What AT-MOST-ONCE actually means here

Not a database transaction — Apps Script/Gmail offer no such thing. The guarantee is: **every code path that cannot prove a send did or did not happen stops retrying automatically**, converting an ambiguous outcome into a human-reviewable one (`NEEDS_REVIEW`) rather than a blindly-retried one. Combined with the pre-existing, unchanged idempotency-key/lock/claim machinery (which already fully closes the "two concurrent executions" class of race), this is the practical, honest AT-MOST-ONCE bar for this architecture.

## 5. Found but NOT fixed tonight (documented, not a duplicate-send risk)

`reconcileStaleLiveClaims_` (Recon.gs, F2 scope, not yet exercised) has two real gaps:

1. When it finds exactly one matching sent thread for a stale `CLAIMED` row (`threads.length === 1`), it updates the `SendLedger` row to `SENT` but **never calls `writeRowById_`** to update the Prospects row (Status/Sequence_Step/Thread_ID/Last_Message_ID/Next_Action_Date/StepN_Sent_At) the way `doStep1Send_`/`doFollowUpSend_` do on a normal success. The prospect would remain stuck showing its pre-send state (e.g. `READY`) forever.
2. Its Gmail search (`'in:sent to:' + email + ' newer_than:2d'`) is not scoped by `Thread_ID` for a follow-up claim, even though the ledger row already records the correct `Thread_ID` at claim time — a more precise, thread-scoped reconciliation is possible and would reduce false "ambiguous" classifications.

**Why not fixed tonight:** neither gap is a duplicate-send risk — `isLiveKeyClaimedOrSent_` (I13) already independently blocks a resend once the ledger row reaches `SENT`, regardless of whether the Prospects row was updated. It is a data-integrity/stuck-state bug (the prospect never advances), not a safety bug. Fixing and testing it properly needs new local mock capability (a `draft.send()`/`GmailApp.search()` simulation) that didn't exist before tonight and would consume budget better spent (per the stated priority order) on N4 and the remaining phases. Left as a clearly documented follow-up, consistent with this project's own convention of flagging unverified/unfinished items explicitly rather than silently leaving them.

## 6. Files changed

`Mailer.gs` (the two fixes), `test-harness/verify-static-findings.js` (3 new N5 checks), `test-harness/mutation-test-N5.js` (new).

## 7. Validation

`node test-harness/verify-static-findings.js` → 16/16 (13 pre-existing + 3 new N5 checks).
`node test-harness/mutation-test-N5.js` → PASS (2/2 mutations caught).
Full local suite (`run-f1-tests.js`) unaffected — 55/55 (LIVE code is untouched by any of it, structurally unreachable under DRY_RUN=TRUE).

## 8. Google-real verification still required before first LIVE email

None of this can be proven against real Gmail concurrency without F2 scope (real trigger installation, real LIVE sends, a real second concurrent execution). That remains a Google-real gate, not something this session can close — see PRODUCTION_CHECKLIST.md.
