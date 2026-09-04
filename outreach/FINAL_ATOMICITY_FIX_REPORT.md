# Final atomicity + isolation fix — after Codex re-audit

> **Superseded in part.** The production fixes below were audited and
> passed. Two test-infrastructure gaps in this round's §6 isolation work
> did not: `_configCache` was not part of the shared-sandbox comparison,
> and the content-extent fix reached `setValues()` but not `setValue()`.
> Both are closed in
> [FINAL_TEST_INFRA_REPORT.md](FINAL_TEST_INFRA_REPORT.md), which carries
> the current counts (95/95, 8 enforcement scenarios). Everything else
> below still holds.

Four blockers, all closed locally. Nothing pushed, nothing touched on Google. N4, timezone, Recon, the fingerprint algorithm and the N5 core were not reopened; no new test showed a regression in any of them.

## 1. Atomic finalization design

The reported hole was real. `finalizePreviewClaimAsDrafted_` went through `updateLedgerRow_`, which writes one `setValue()` per field with `for (var name in fields)` — insertion order, so `State` went out first — and never flushed. A failure between that write and the `Draft_ID` write left a durable row reading `State=DRAFTED, Draft_ID=""`, which the next Preview read as "the draft disappeared", superseded, and duplicated.

The fix is a new primitive, `writeLedgerMetadataThenState_(rowIndex, metadataFields, state)` in [Ledger.gs](Ledger.gs). It refuses `State` in its metadata argument, so the ordering cannot be bypassed by a caller. `finalizePreviewClaimAsDrafted_` additionally throws rather than write `DRAFTED` without a `Draft_ID` at all.

`updateLedgerRow_` is unchanged and still used everywhere its semantics are correct — writing decoration onto an already-correct State (`markPreviewClaimAmbiguous_`, `releasePreviewClaim_`). Only transitions *into* a state whose meaning depends on other columns go through the new primitive.

## 2. Exact write ordering

1. Write every metadata column. `Thread_ID`(9) through `Human_Edit_Detected_At`(16) are contiguous, so this is a **single `setValues()` range write**, not eight cell writes — the partial-write window inside step 1 is one Sheets operation.
2. `SpreadsheetApp.flush()` — metadata is durable.
3. Write `State` (column 8).
4. `SpreadsheetApp.flush()`.

Steps 1–2 touch only columns the *old* state does not depend on, so a failure anywhere in 1–3 leaves the row exactly as it was: `PREVIEW_CLAIMED`, which blocks.

On the question the audit asked to reason about rather than assume: `setValues()` does not make this airtight in the strong sense. Apps Script can die between the step-3 write and the step-4 flush. That direction is safe — the State write is simply lost and the row stays `PREVIEW_CLAIMED`. What cannot happen is the other direction, and that is the only invariant needed:

> **If State reads DRAFTED, the metadata was already durably persisted before it.**

## 3. Incomplete DRAFTED policy

Construction safety only covers rows this code wrote. History, manual edits, and failure modes not yet imagined are not covered by it, so there is a second, independent protection.

`resolveExistingPreviewDraft_` (CASO 12) now treats a `DRAFTED` row with a blank `Draft_ID` as corrupt: `BLOCKED_NEEDS_REVIEW` / `drafted_row_missing_draft_id`. It is **not** auto-superseded, **not** read as "already gone", and creates **zero** drafts. The row is left exactly as found for a human to resolve.

Both DRAFTED writers were audited. `finalizePreviewClaimAsDrafted_` is state-last as above. `preserveDraftDurably_` writes DRAFTED through `appendLedgerRow_` — one atomic `appendRow` plus flush — carrying `oldValues.Draft_ID`, which the CASO 12 guard has already proven non-blank before that path can be reached.

## 4. Partial-write regression test

`n3atomic_runPartialFinalizationCase_` proxies `getLedgerSheet_` so exactly one cell write fails while every other ledger operation keeps working — reproducing not "the ledger is broken" but "the finalization got halfway". In both cases the compensating `deleteDraft()` fails and `markPreviewClaimAmbiguous_` fails, so the ledger row is the only barrier left.

| | injected failure | asserted |
|---|---|---|
| `N3atomic_stateWriteFailsMetadataDurable` | the final State write | State still `PREVIEW_CLAIMED`, **and `Draft_ID` already durable** — the positive ordering proof |
| `N3atomic_metadataWriteFailsNoDraftedState` | the metadata range write | State still `PREVIEW_CLAIMED`, never `DRAFTED` — the negative proof |

Both then assert: the orphan draft **does** still exist in Gmail (cleanup was made to fail), the forbidden row `DRAFTED + Draft_ID=""` does not exist, the second Preview is blocked, **total `createDraft` calls across both runs = exactly 1**, no row is appended, and the row is never auto-superseded as "gone".

`N3atomic_incompleteDraftedBlocksCreateNew` seeds the corrupt row directly and asserts **zero** `createDraft` calls.

## 5. Partial-write mutations

| | mutation | caught by |
|---|---|---|
| K | State written before the metadata it describes | `N3atomic_metadataWriteFailsNoDraftedState` (and `N3atomic_stateWriteFailsMetadataDurable`) |
| L | incomplete DRAFTED treated as "gone" | `N3atomic_incompleteDraftedBlocksCreateNew` |
| M | `PREVIEW_CLAIMED` stops blocking | `N3atomic_stateWriteFailsMetadataDurable` (and two more) |

Baseline green, every mutation red at its named test, restored green.

## 6. Isolation reset/snapshot design

Per-test: snapshot the whole shared sandbox → run → teardown → diff against the snapshot. Teardown is the fixer, the diff is the detector, and §11's scenarios break the fixer to prove the detector works.

The snapshot now covers Gmail drafts (with subjects), threads **with their message lists**, labels, the sent index, call counters, the script lock, the identity of every monkey-patchable function (now including `writeLedgerMetadataThenState_` and `getLedgerSheet_`), and the **real cell content** of Prospects, SendLedger, Log and Suppression.

Turning that on immediately failed two tests, and the cause was a genuine leak rather than an over-strict check: the ghost-row fixture writes a 999-row block of blanks, and the mock modelled the content extent as `data.length`, so `getLastRow()` went from 1 to 1000 for every subsequent test — silently shifting where `appendRow()` landed. Fixed in the mock, where the bug was: real Sheets tracks a content extent and does not grow it with blanks, so trailing all-blank rows are trimmed after a write. `false` and `0` are values, not blanks, and are preserved.

## 7. Counter isolation

Counters are genuinely shared and genuinely mutated (tests reset them mid-test to assert exact counts). Teardown restores them to the baseline **that test started from** via `GmailApp._setCallCounts`, which is what makes a residual counter a detectable leak rather than business as usual. Scenario 4 removes that restore: 57/92 tests immediately report dirty.

## 8. Label isolation

`GmailApp._labelNames()` / `_removeLabelForTest()` added. Teardown removes any label not present in the test's baseline. Scenario 5 proves detection.

## 9. Thread / message isolation

The thread signature includes each thread's message ids, so a reply appended to an **already-existing** thread is caught even though the draft-id set, the thread-id set and every sheet are byte-identical. Scenario 6 is built exactly that way: it seeds a thread before the suite loop — so the thread is in every baseline — and replies into it during one test. Nothing else in the sandbox changes; the gate still catches it.

## 10. Suppression isolation

No longer inferred from the tracking arrays. `sheetContentSignature_` compares the real Suppression cell content before and after each test, so a row written straight to the sheet with no marker and no Run_ID is caught (scenario 7). The same signature covers Prospects, SendLedger and Log.

## 11. Isolation enforcement scenarios

Each mutation must keep the functional gate all-green and still force a non-zero exit.

| scenario | functional | isolation | exit |
|---|---|---|---|
| 1. unmodified | 92/92 PASS | 92/92 PASS | 0 |
| 2. sheet-row residue | 92/92 PASS | 0/92 FAIL | 1 |
| 3. leaked Gmail draft | 92/92 PASS | 91/92 FAIL | 1 |
| 4. leaked call counter | 92/92 PASS | 57/92 FAIL | 1 |
| 5. leaked Gmail label | 92/92 PASS | 90/92 FAIL | 1 |
| 6. message appended to a pre-existing thread | 92/92 PASS | 91/92 FAIL | 1 |
| 7. untracked Suppression row | 92/92 PASS | 91/92 FAIL | 1 |

## 12. N5 exact follow-up proof

`N5_followUpReplyAndProspectsBothThrow` is permanent: `thread.reply()` is invoked and throws, the `writeRowById_(Prospects → NEEDS_REVIEW)` **also** throws, the script lock is released, and the same step runs again.

Its value is that the two guards *disagree*. Before the second attempt the test asserts Prospects still reads `Status=IN_SEQUENCE` and `Sequence_Step=1` — the state machine still considers step 2 due — so a green result cannot be explained by `canSend_`. `isLiveKeyBlocked_` is asserted directly. Total `thread.reply()` invocations across both executions: **exactly 1**.

New mutation N5-E moves `doFollowUpSend_`'s claim to after `reply()` succeeds; this test catches it.

## 13. Files modified

`Ledger.gs`, `Mailer.gs`, `Tests.gs`, `test-harness/gas-mocks.js`, `test-harness/mutation-test-N3.js`, `test-harness/mutation-test-N5.js`, `test-harness/verify-isolation-enforcement.js`, new `test-harness/verify-post-suite-sandbox.js`, and this report.

## 14. Commits (local only)

```
c2c021f docs(outreach): mark Tests.gs local-only, never deploy
ed5bf5f test(outreach): close real Gmail mock isolation gaps and N5 proof
532a30e fix(outreach): make preview finalization state-last and fail-closed
```
`.gitignore`, `auditoria-seo-klinnercleaning.html` and `imagen para cambio.HEIC` were left untouched and excluded from all three.

## 15. Functional

**92/92 PASS** (was 88; +3 partial-write/corrupt-row tests, +1 N5 follow-up test).

## 16. Isolation

**92/92 clean**, against the expanded definition in §6.

## 17. Independent post-suite sandbox state

`verify-post-suite-sandbox.js` inspects from outside the suite, sharing no helper with `Tests.gs`. Every dimension byte-identical to the pre-suite baseline, in all three timezones:

```
drafts 0=0 · threads 0=0 · messages 0=0 · labels 0=0 · sentIndex 0=0
callCounts {createDraft:0, createDraftReply:0, send:0, reply:0}
Prospects / SendLedger / Log / Suppression / Config / Templates identical
script lock free · 10/10 patched functions restored
```

## 18. Static

**14/14 PASS**

## 19. Mutations

| suite | mutations | result |
|---|---|---|
| N3 | 13 (A–M; K/L/M new) | PASS |
| N5 behavioral | 5 (A–E; E new) | PASS |
| N4 | 2 | PASS |
| N7 | 2 | PASS |
| ghost rows | 1 | PASS |
| timezone | 3 | PASS |
| isolation enforcement | 7 scenarios | PASS |

## 20. Three-timezone results

`America/Chicago`, `UTC`, `Asia/Kolkata` — identical in all three: functional 92/92, isolation 92/92, static 14/14, post-suite sandbox inspection PASS.

## 21. Self-audit

1. **Can State=DRAFTED appear durably before Draft_ID?** No. Two writers, both proven — `finalizePreviewClaimAsDrafted_` is state-last and refuses a blank `Draft_ID`; `preserveDraftDurably_` uses a single atomic `appendRow` with a `Draft_ID` the CASO 12 guard already validated.
2. **Can an incomplete DRAFTED row authorize CREATE_NEW?** No — CASO 12 fails closed before any Gmail read (mutation L red).
3. **Can a draft survive with no ledger barrier?** No. All three draft-creating call sites (`GmailApp.createDraft` and `thread.createDraftReply` in `createPreviewDraft_`, `GmailApp.createDraft` in `doStep1Send_`) sit after their durable claim; `createPreviewDraft_` has exactly one caller.
4. **Can a second Preview create another draft after any partial finalization failure?** No — asserted by call count, not by state inspection, in both partial-write cases and the triple-failure case.
5. **Can isolation report clean with a residual call counter?** No (scenario 4).
6. **…with a residual Gmail label?** No (scenario 5).
7. **…with a modified thread?** No (scenario 6) — and this is the one where every id set stays identical.
8. **Is reply-throw + Prospects-write-throw permanently proven with exactly one reply call?** Yes (§12), with the ledger isolated as the cause.

No new blockers found.

## 22. Remaining LOCAL blockers

None.

## 23. Remaining GOOGLE-REAL-only gates

- Real `SpreadsheetApp.flush()` durability. §2's ordering argument assumes a flush that returns has persisted; the mock flush is a no-op because its writes are synchronous. This is the one assumption in the design that only Google can confirm.
- Gmail fingerprint round-trip stability on an untouched real draft.
- Real concurrent Apps Script executions, real Gmail send/reply timing and quota behavior, real `GmailApp.search` semantics.
- The SendLedger N:P migration (`repairSendLedgerColumns()`), and the whole `F1_GOOGLE_CLOSURE_PLAN.md` sequence.
- Operationally new, worth watching on the first real Preview runs: a killed execution now leaves a `PREVIEW_CLAIMED` row that blocks that prospect until a human clears it. Intended trade — a blocked preview beats a duplicate draft.

## 24. Verdict

**READY FOR FINAL CODEX AUDIT**

No push. No Google. No Gmail real. No LIVE. No triggers. `DRY_RUN`, `MAX_PER_DAY` and the `PENDING_F0` values untouched.
