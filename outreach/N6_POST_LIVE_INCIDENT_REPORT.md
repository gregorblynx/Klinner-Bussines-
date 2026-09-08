# N6 — post-LIVE incident: Acme Plumbing LLC, 2026-09-08

Prospect_ID `2f4d0c6c-ccd7-420b-8dd3-22c915a792f4`. Gmail send confirmed, SendLedger reached SENT, Prospects never advanced. Diagnosed, fixed, and regression-tested locally. **Nothing pushed, nothing touched on Google.**

## 1. Exact root cause

Not a single crashed line — a **structural gap**: nothing protected the Prospects write that happens *after* the ledger is already durably `SENT`. In `doStep1Send_` (Mailer.gs), the original code was:

```js
updateLedgerRow_(ledgerRowNum, { State: LEDGER_STATE.SENT, Thread_ID: ..., Message_ID: ..., Confirmed_At: new Date() });

writeRowById_(prospectId, {
  Status: STATUS.IN_SEQUENCE, Sequence_Step: 1, Last_Contacted: new Date(),
  Step1_Sent_At: new Date(), Thread_ID: thread.getId(), Last_Message_ID: message.getId(),
  Next_Action_Date: computeNextActionDate_(1, new Date(), config) || ''
}, { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
```

Any exception raised while evaluating this second statement — inside `computeNextActionDate_` (cadence math), inside `authorizeWrite_`'s guards, inside `findRowById_`'s I7 identity check, or a transient Sheets API error inside `applyFieldsToRow_` — was completely unhandled at every layer above it:

- `doStep1Send_`: no try/catch around this block.
- `executeLiveSendForStep_`: only a `finally { lock.releaseLock(); }` — no catch.
- `performLiveSend_`: no catch.
- `sendStep1`: a bare pass-through.
- `sendBatch()`: **the first and only catch**, and it treats the exception exactly like an ordinary skip:
  ```js
  try {
    if (step === 1) sendStep1(r.values.Prospect_ID); else sendFollowUp(r.values.Prospect_ID, step);
  } catch (e) {
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, r.values.Prospect_ID, r.values.Email_Normalized, step, String(e));
  }
  ```

The exception is logged and swallowed. `sendBatch()` completes normally — matching the reported "sendBatch executions: exactly 1, no retry occurred" with no visible top-level error.

## 2. Exact failing function/path

`Mailer.gs` → `doStep1Send_` (inside the LIVE closure) → the `writeRowById_(...)` call at (pre-fix) line 1100, specifically the evaluation of its `fields` argument object, which calls `computeNextActionDate_(1, new Date(), config)` inline — so the exception can originate before `writeRowById_` even begins executing.

Trace of the full call path, confirmed by reading the code (not assumed):
```
menu_sendNowLive_() → sendBatch() → sendStep1() → executeLiveSendForStep_()
  → performLiveSend_() [guard: DRY_RUN/PENDING_F0 — already cleared for this run]
  → executeLiveSendForStep_'s inner fn: lock → PAUSE_ALL → window → canSend_ → isLiveKeyBlocked_ → budget
  → doStep1Send_()
      1. appendLedgerRow_({State: CLAIMED})           ← LIVE claim written FIRST (line ~1029)
      2. GmailApp.createDraft(...)                     ← draft created
      3. draft.send()                                  ← Gmail send — CONFIRMED here
      4. thread = message.getThread(); applyOutreachLabel_(thread, config)
      5. updateLedgerRow_(ledgerRowNum, {State: SENT, Thread_ID, Message_ID, Confirmed_At})
                                                         ← ledger reaches SENT (line ~1096, pre-fix)
      6. writeRowById_(prospectId, {...7 fields incl. computeNextActionDate_(...)...})
                                                         ← UNPROTECTED (line ~1100, pre-fix) — THIS is
                                                           where the incident's exception was thrown
```

## 3. Why the ledger reached SENT while Prospects stayed READY

Because step 5 (ledger write) and step 6 (Prospects write) are **two separate, sequential Sheets operations with no shared transaction**, and only step 5 was ever protected by anything. Step 5 succeeded and was durably committed (Apps Script's Sheets bindings commit on normal script completion, and this run completed normally — it never threw past `sendBatch`'s catch). Step 6 then threw, and because `writeRowById_`'s `applyFieldsToRow_` writes fields one `setValue()` at a time in a loop but the exception happened *before that loop ever started* (in argument evaluation / `authorizeWrite_`'s guards / `findRowById_`), **zero** `setValue()` calls landed on Prospects — which is exactly why the sheet reload showed every field still at its pre-send value (`Status=READY`, everything else blank), not a partial write.

## 4. Whether the exception was propagated or swallowed

**Propagated all the way up, then swallowed** — at exactly one place: `sendBatch()`'s per-row `try/catch`. Every layer between `doStep1Send_` and `sendBatch()` re-threw or had no catch at all. `sendBatch()`'s catch has no way to distinguish "this prospect was skipped, nothing happened" from "Gmail already sent this and the ledger already confirmed it" — both produce an identical `logEvent_(LOG_LEVEL.ERROR, ...)` line with no special marker.

## 5. Safety assessment of the current ordering

**Gmail send → ledger SENT → Prospects update** is the *correct* ordering and must NOT change. Ledger-first, Gmail-second-to-last, Prospects-last is what makes the durable-blocking (N5) guarantees possible in the first place — reversing it (writing Prospects before the ledger is confirmed, or before Gmail is confirmed) would reopen exactly the duplicate-send races N5 closed. The bug was never the *ordering* — it was that step 6 had **no failure handling at all**, while step 3 (the actually risky Gmail call) already had extensive, audited failure handling. The fix adds the missing protection around step 6 without touching the ordering, the ledger schema, or any idempotency state machine.

Confirmed independently: `isLiveKeyBlocked_` already treats `SENT` as a blocking state (Ledger.gs), so **the incident never risked a duplicate email** — reproduced and proven in the regression tests below. The actual damage was purely "Prospects never advances, forever, with no visible signal," which is what this fix targets.

## 6. Code fix

**File: `Mailer.gs`, `doStep1Send_` and `doFollowUpSend_` — identical fix, mirrored (same defect shape in both).**

- One captured `confirmedAt` timestamp, reused for `Confirmed_At`/`Last_Contacted`/`Step{N}_Sent_At`/the cadence calculation (previously four separate `new Date()` calls milliseconds apart — not the incident's cause, but tightened while touching this exact code, per I15's "the real send time" invariant).
- `computeNextActionDate_` wrapped in its own try/catch. A legitimate `null` return (last step, sequence done) is tracked separately from a thrown exception (`cadenceThrew`) — conflating the two would have silently changed the pre-existing SEQUENCE_DONE/MAX_STEPS=1 behavior, which this fix does not touch.
- The Prospects `writeRowById_` call wrapped in try/catch. On failure:
  1. Log a `POST_SEND_PERSISTENCE_FAILURE` line naming the SendLedger row, Thread_ID, and Message_ID — greppable, distinct from every other error in this file.
  2. Attempt one minimal fallback write: `{ Status: STATUS.NEEDS_REVIEW }` only — the smallest possible write, chosen because it's a single already-allow-listed field, unrelated to whatever caused the full write to fail, and it's what makes a stuck prospect visible to a human (Prospects view/filter) instead of indistinguishable from a fresh, untouched `READY` row.
  3. If the fallback ALSO fails, log that as its own, louder line naming the same reconciliation data — SendLedger stays the source of truth regardless.
  4. Return a distinct status, `'SENT_PERSISTENCE_FAILED'`, with `ledgerRowNum`/`threadId`/`messageId` — rather than throwing, since Gmail's outcome here is 100% certain (`message.getId()`/`sentMessage.getId()` prove it), unlike the AMBIGUOUS paths elsewhere in this file, which genuinely don't know Gmail's outcome and therefore still throw.
- `cadenceThrew` also forces `Status: NEEDS_REVIEW` on the *first* (non-exceptional) write path — a thrown cadence calculation must never result in a silent `IN_SEQUENCE` row with a blank `Next_Action_Date` (a different, quieter version of the same "stuck forever" failure mode).

**No changes to**: SendLedger schema, `LEDGER_STATE`, `isLiveKeyBlocked_`, `isPreviewKeyBlockedState_`, N5's AMBIGUOUS handling, Recon, N4, timezone math itself (only how its exceptions are handled at one call site), fingerprinting, DRY_RUN/PENDING_F0 gating, or any Config value.

## 7. Regression tests added (`Tests.gs`)

Three new tests, registered in `F1_TEST_FUNCTIONS`, all invoking the real production path (`sendStep1` → `executeLiveSendForStep_` → `doStep1Send_`) with a real mocked Gmail send:

- **`N6_postSendPersistenceFallbackSucceeds`** — the full Prospects write throws, the minimal fallback succeeds. Asserts: `outcome.status === 'SENT_PERSISTENCE_FAILED'`; ledger row is `SENT` with `Thread_ID`/`Message_ID` populated; Prospects flips to `NEEDS_REVIEW` but does **not** fabricate `Sequence_Step`/`Step1_Sent_At`/`Thread_ID`; `isLiveKeyBlocked_` still true; exactly one `draft.send()` call, including after a retry.
- **`N6_postSendPersistenceExactIncidentReproduction`** — **both** the full write and the fallback throw (total persistence outage — the literal incident). Asserts Prospects shows **zero** change from its pre-send snapshot (`Status`, `Sequence_Step`, `Step1_Sent_At`, `Last_Contacted`, `Thread_ID`, `Next_Action_Date` all byte-identical to before), while the ledger row is still `SENT`; both failure log lines present; `isLiveKeyBlocked_` true; retry returns `SKIPPED_ALREADY_CLAIMED`; **exactly one** real Gmail send total, across the original attempt and the retry.
- **`N6_cadenceThrowAfterConfirmedSendForcesNeedsReview_`** — `computeNextActionDate_` itself throws (the write would otherwise succeed). Asserts `outcome.status === 'SENT'` (not a persistence failure — the write succeeded), but `Status` is forced to `NEEDS_REVIEW` with a blank `Next_Action_Date`, and `Sequence_Step` still correctly advances to 1 (the send is real).

Also updated: `test-harness/mutation-test-N5.js` mutation D's text anchor (D3), which targeted the exact block this fix rewrote — updated to match the new `confirmedAt`-based shape and to capture `ledgerRowNum` from the mutated append path so the mutation still exercises its intended target (claim written only *after* `send()` succeeds) without an unrelated crash.

## 8. Duplicate-send safety result

**Proven, not assumed**, in both new incident-reproduction tests: total real `draft.send()` calls across the original attempt *and* a subsequent retry is **exactly 1** in every scenario, including the worst case (total Prospects persistence outage, Prospects showing zero change). `isLiveKeyBlocked_`'s `SENT`-blocks-retry guarantee (N5) was never touched and is independently re-verified by this incident's own tests.

## 9. All test results

| Gate | Result |
|---|---|
| Functional | **100/100 PASS** (was 97; +3 new N6 tests) |
| Isolation | **100/100 PASS** |
| Static | **14/14 PASS** |
| N5 behavioral mutations | **6/6 PASS** (mutation D's anchor updated for the new code shape) |
| N3 V3 mutations | PASS (10/10, untouched) |
| N4 mutations | PASS (untouched) |
| N7 mutation | PASS (untouched) |
| Ghost-row mutation | PASS (untouched) |
| Timezone mutations | PASS (untouched) |
| Isolation enforcement (8 scenarios) | PASS |
| Mock sheet extent verification | PASS |
| Post-suite sandbox inspection | PASS — byte-identical to baseline |

All of the above run identically under `TZ=America/Chicago`, `TZ=UTC`, and `TZ=Asia/Kolkata`.

(A pre-existing, unrelated `logEvent_ failed: Error: Sheet not found: Config` console warning appears in the mutation harnesses' startup — confirmed present before this change too, on both `mutation-test-N3.js` and the pre-fix `mutation-test-N5.js`, via `git stash`. Cosmetic harness-init noise, not a functional failure; out of this round's scope.)

## 10. Exact Acme reconciliation plan

**Not executed. No Google write of any kind was made.** These are the proposed values, derived from the authoritative LIVE/SENT ledger row — computed by actually running this project's real `computeNextActionDate_`/`dateFromWallClock_` (Schedule.gs) in the local harness against `Confirmed_At = 2026-09-08 12:11:26 CDT`, not hand-calculated:

| Field | Proposed value | Source |
|---|---|---|
| `Status` | `IN_SEQUENCE` | Ledger row is `SENT`, unambiguous — matches `STATUS.IN_SEQUENCE`, the exact value `doStep1Send_` would have written |
| `Sequence_Step` | `1` | Ledger `Step` column |
| `Step1_Sent_At` | `2026-09-08 12:11:26 CDT` | Ledger `Confirmed_At` (authoritative send instant — I15) |
| `Last_Contacted` | `2026-09-08 12:11:26 CDT` | Same instant |
| `Thread_ID` | `1a08200c7ad4ac0d` | Ledger row |
| `Last_Message_ID` | `1a08200c8ea97e84` | Ledger row |
| `Next_Action_Date` | **`2026-09-11 12:11:26 CDT`** | `computeNextActionDate_(1, <Confirmed_At>, config)` — ran locally: Sept 8, 2026 is a Tuesday; +3 business days (`CADENCE_OFFSETS_BD[1]`, default `'0,3,7,7'`) skipping only Sat/Sun → Wed 9, Thu 10, Fri 11, none of them in `DEFAULT_HOLIDAYS` (`2026-09-07` is the only nearby holiday, and it precedes the send) |

**One explicit assumption, flagged as required**: this calculation used the **default** `CADENCE_OFFSETS_BD`/`SEND_DAYS`/`HOLIDAYS`/`MAX_STEPS` from `getConfigDefaults_()`, because this round has no Google access to read the real Config sheet. If the real Config tab has been customized away from these defaults, `Next_Action_Date` must be recomputed with the real values before writing anything. **Recommended pre-reconciliation step**: read-only, open the Config sheet and confirm `CADENCE_OFFSETS_BD`, `SEND_DAYS`, `HOLIDAYS`, `MAX_STEPS` match the defaults above; if not, re-run this same calculation with the real values (trivial — it's one function call in the local harness, already scripted for this report).

**How reconciliation should occur, without creating any new LIVE row or invoking Gmail**: a single `writeRowById_(prospectId, {...the 7 fields above...}, { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_RESET })`-shaped write (or an equivalent one-off ADMIN-origin operation) directly to the Prospects row — **never** through `sendStep1`/`sendBatch`/`doStep1Send_`, which would re-invoke Gmail. The existing `SendLedger` row is not touched, not superseded, not duplicated — it already correctly reads `SENT` and stays exactly as is; reconciliation only makes Prospects match what the ledger has always said. This requires either: (a) a new, narrowly-scoped ADMIN reconciliation function added to StateMachine.gs (out of scope for this round — flagged, not built, since the user said diagnose-and-fix, not build new admin tooling), or (b) a manual one-time edit directly in the Sheet UI by Gregor. Either way: **read from the ledger, write to Prospects, touch nothing else, invoke no Gmail API.**

## 11. Files changed

`Mailer.gs`, `Tests.gs`, `test-harness/mutation-test-N5.js`, and this report.

## 12. Diff summary

```
outreach/Mailer.gs                        | 142 ++++++++++++++++++--
outreach/Tests.gs                         | 209 ++++++++++++++++++++++++++++++
outreach/test-harness/mutation-test-N5.js |  10 +-
3 files changed, 344 insertions(+), 17 deletions(-)
```
Diff shown to the user in full before this report; not yet committed.

## 13. Is production deployment required?

**Yes, eventually** — this is a real production defect (confirmed by a real LIVE incident) and the fix is local-only so far. But **not this round**: per explicit instruction, no `clasp push`, no `git push`. The fix is ready for review and, once approved, a future round should push it — and it should ship *before* any further LIVE sends are attempted, since the same gap exists for every future step-1/follow-up send until this lands.

## 14. Remaining uncertainty

- The exact proximate exception (which specific guard/line inside `computeNextActionDate_`/`authorizeWrite_`/`findRowById_`/`applyFieldsToRow_` threw in the real incident) is **not proven** — only the structural gap that let it cause permanent damage is proven, from the code itself. The Log sheet row `sendBatch()`'s catch wrote for this `Prospect_ID`/`Run_ID` almost certainly contains the exact `String(e))` — that has not been read this round (no Google access). See §15.
- Whether the real Config sheet's `CADENCE_OFFSETS_BD`/`SEND_DAYS`/`HOLIDAYS` match the defaults used for the `Next_Action_Date` calculation in §10 is unconfirmed.
- Whether this exact throw could recur under the *new* code (e.g., if the underlying cause is a genuinely broken Config value rather than a transient error) — the fix makes the failure safe and visible, but does not itself diagnose or repair whatever originally threw. That's a second, separate investigation gated on reading the real Log sheet row.

## 15. Recommended Google-real verification procedure

1. **Read-only**: open the Log sheet, filter for `Prospect_ID = 2f4d0c6c-ccd7-420b-8dd3-22c915a792f4` around `2026-09-08 12:11`. The `ERROR` row `sendBatch()`'s catch wrote contains the exact exception text — this is the single most important missing piece of evidence and should be read before anything else.
2. **Read-only**: confirm the real Config sheet's `CADENCE_OFFSETS_BD`, `SEND_DAYS`, `HOLIDAYS`, `MAX_STEPS` values against the defaults used in §10; recompute `Next_Action_Date` if they differ.
3. Once this fix is reviewed/approved and pushed (a future, separate round): re-run `repairSendLedgerColumns()`-style idempotent verification is not needed here (unrelated schema), but a **dry run of the reconciliation write** should be reviewed before it's applied to the real Acme row.
4. Only after both of the above: apply the Acme reconciliation write (§10), then confirm `isLiveKeyBlocked_`-equivalent behavior by attempting **nothing** — do not re-run `sendStep1` for Acme; the ledger `SENT` row must remain the only record of that send, permanently.

---

# Addendum — independent adversarial review of 4a0f8fd

The review found the fix above **incomplete**. It correctly hardened `doStep1Send_`/`doFollowUpSend_` in isolation, but said nothing about what `sendBatch` does *next* — and `sendBatch` discarded every send's return value inside a `forEach`, so `SENT_PERSISTENCE_FAILED` was invisible to it.

**Proven, not argued**: a two-prospect batch test written against 4a0f8fd failed with `expected 1, got 2` — prospect B received a real Gmail send after prospect A's persistence failed. That is the compounding case: a broken *recording* mechanism plus a batch that keeps going produces one unrecorded real email per remaining candidate.

## Corrections applied

1. **Batch hard stop** (`sendBatch`) — `forEach` → `for` loop; the send's return value is now captured, and `SENT_PERSISTENCE_FAILED` logs a `BATCH ABORTED` line (naming the ledger row and how many candidates were skipped) and `break`s. Deliberately *not* a hard stop for ordinary skips, quota aborts, or thrown AMBIGUOUS outcomes — those all still record correctly in the ledger, and stopping on them would silently throttle normal operation to one prospect per run.
2. **Durable ledger marker** — the persistence failure previously left the authoritative row's `Error` column blank, so the *only* record was the Log sheet, which `trimLog_` prunes to `LOG_MAX_ROWS`. An unreconciled incident would eventually become invisible. Both functions now stamp `POST_SEND_PERSISTENCE_FAILURE: ...` into the ledger row's `Error` column. `State` stays `SENT` — this annotates the row, it never reopens it. Best-effort and wrapped, since the Sheets write path is precisely what just failed.

Reconciliation is now deterministic: find every row where `State=SENT` and `Error` contains `POST_SEND_PERSISTENCE_FAILURE`.

## Verified properties

- Prospect B: **zero** Gmail invocations — proven structurally, not just by counter. B has no LIVE ledger row at all, and the claim is written *before* any Gmail call, so no ledger row ⟹ no Gmail call.
- Prospect A: exactly one Gmail send; ledger `SENT`; key still blocked.
- The hard stop does **not** depend on the `NEEDS_REVIEW` fallback: the test makes the fallback fail too.
- Mutation G (hard stop disabled) is caught by **exactly one** test — the new batch test — confirming no pre-existing test covered this.

## Fallback safety assessment

The `Status=NEEDS_REVIEW` fallback *can* fail through the same path as the original write: both call `findRowById_` and its identity guard, and both pass through `authorizeWrite_` (including its `getConfig()` read). It is strictly *more likely* to succeed (one allow-listed column instead of seven, and it never calls `computeNextActionDate_`), but it is genuinely best-effort. That is acceptable, because safety rests on three things that are all independent of it: the durable ledger `SENT` state, the ledger `Error` marker, and the batch hard stop.

## Future-run behavior (ledger SENT + Prospects READY)

Confirmed safe by inspection and test: `canSend_` passes (the row still looks eligible), then `isLiveKeyBlocked_` returns true on the `SENT` row → `SKIPPED_ALREADY_CLAIMED`, no resend. No code path reopens it: `findStaleLiveClaims_` selects only `State === CLAIMED`, and Recon's only ledger write is `AMBIGUOUS`.

**One observability gap remains, and it is not fixed here**: `SKIPPED_ALREADY_CLAIMED` returns with **no log call at all**. So on every subsequent run the stuck prospect is skipped in complete silence. The durable ledger `Error` marker now compensates (it never expires), but the run-time signal is absent by design of that early return.

## Durable PAUSE — recommendation, not implemented

The hard stop protects *one* batch. With triggers installed, the next scheduled run starts fresh and would hit the same broken persistence path, compounding at trigger cadence. Options considered: auto-setting `PAUSE_ALL=TRUE` (correct response to "we cannot record sends", but it is a Config write on the very path that is failing, and one transient error would halt the whole system until manually cleared), or a start-of-batch scan for unresolved `POST_SEND_PERSISTENCE_FAILURE` markers (now possible thanks to the durable marker, but it adds a full ledger scan to every run).

**Recommendation**: do not add either yet. Keep `PAUSE_ALL=TRUE` and `triggers=0` until Acme is reconciled, and treat "unattended operation requires an automatic durable pause" as a **prerequisite for installing triggers**, decided once the real proximate exception is known. This is flagged as a gating decision, not silently deferred.

## Final verdict

## FIX READY FOR REVIEW — NO DEPLOYMENT PERFORMED
