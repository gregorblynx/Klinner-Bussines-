# Final local fix round — after Codex re-audit

All blockers from the re-audit closed locally. Nothing pushed, nothing touched on Google.

## 1. N3 preview claim design

The previous rounds tried to close the orphan-draft hole with progressively better catches AFTER `GmailApp.createDraft()`. Codex correctly showed that cannot work: the compensation itself can fail (`getId()` throws, then `deleteDraft()` throws), leaving a real draft with zero durable tracking and a duplicate on the next run.

The property is now structural and mirrors LIVE's claim-before-send: **a durable ledger barrier for the idempotency key exists before any Gmail call that could create a draft.** `appendPreviewClaim_` writes a `PREVIEW_CLAIMED` row and `appendLedgerRow_` flushes it, and only then is `createPreviewDraft_` invoked — which now has exactly one caller, verified. Both `PREVIEW_CLAIMED` and `PREVIEW_AMBIGUOUS` block any further preview for that key (`isPreviewKeyBlockedState_` / `findActivePreviewRows_`), checked first in `resolveExistingPreviewDraft_` before anything touches Gmail or the ledger.

On success the claim row **becomes** the DRAFTED row (updated in place), so the key never has two active rows and never has zero.

## 2. Behavior if Draft_ID is unknowable

Irrelevant to safety now, which is the point. The barrier is keyed on `Prospect_ID + Step`, not on `Draft_ID`, and it exists before the draft does. If `draft.getId()` throws, compensation still works (it uses the direct object reference, never a lookup), and if that fails too the claim becomes `PREVIEW_AMBIGUOUS` — blocking regardless of whether we ever learn the draft's id.

## 3. Behavior if delete also fails

`PREVIEW_AMBIGUOUS`, permanently, until a human resolves it. The claim is released to a non-blocking state **only** on a CONFIRMED delete (`attemptDeleteDraftDirectly_` returning true) or when no draft was created at all. Mutation J proves that distinction is load-bearing: releasing the claim on an unproven cleanup makes the duplicate tests fail.

## 4. Behavior if the ledger transition fails

The claim row is still `PREVIEW_CLAIMED` — already blocking. Compensation is attempted; the claim is then released or marked ambiguous by the same rules. If even that update fails (e.g. every ledger write is broken), the row simply stays `PREVIEW_CLAIMED`, which blocks. There is no failure ordering that produces "draft exists + no barrier". `test_N3v3_finalTransitionFailureLeavesClaimBlockingAndNoDuplicate_` exercises exactly that triple failure.

## 5. Next-run behavior after an ambiguous Preview

`previewStep` returns `SKIPPED_DRAFT_NEEDS_REVIEW` with reason `preview_ambiguous` or `preview_claim_unresolved`, and `GmailApp.createDraft` is never called — asserted by call count, not by inference. Recovery is manual and documented in `previewStep`'s docstring: find the row in SendLedger, check Gmail Drafts, delete if present, set the row to `SUPERSEDED`.

## 6. N5 send/reply exact call-count results

| Scenario | Assertion | Result |
|---|---|---|
| step1 send() throws + Prospects NEEDS_REVIEW write also throws, then re-run | total `draft.send()` calls | **exactly 1** |
| follow-up reply() throws + Prospects write also throws, then re-run | total `thread.reply()` calls | **exactly 1** |
| message-count mismatch (ambiguous), then re-run | total `thread.reply()` calls | **exactly 1** |
| normal confirmed step 1 | total `draft.send()` calls | **exactly 1** |
| normal confirmed follow-up | total `thread.reply()` calls | **exactly 1** |

N5's core implementation was not redesigned (Codex PASS); only the proof was strengthened from state-inspection to real invocation counting.

## 7. Recon final policy

Never infer SENT. Every stale `CLAIMED` row → `AMBIGUOUS`, whatever the search returns (0, 1, or many). The search runs only as diagnostic evidence written to the Error column. A search error changes nothing at all (row stays `CLAIMED`, already blocking). No automatic retry, ever. Counters: `examined`, `ambiguous`, `searchErrors`, `unchanged` — no `resolved`, because nothing is auto-resolved; a search error no longer inflates a success metric.

## 8. Isolation final proof

`verifyCleanTestState_` now snapshots the whole shared sandbox before each test and diffs after teardown: Prospects/SendLedger/Log/Suppression rows **plus** Gmail mock drafts, seeded threads, the script lock, and the identity of every mock/global function tests patch (`GmailApp.createDraft/getDrafts/search/getThreadById`, `appendLedgerRow_`, `updateLedgerRow_`, `writeRowById_`).

It immediately caught the exact leak Codex reported — 2 drafts (from the two tests that poisoned a message method without restoring it) plus 4 threads — all now fixed. `verify-isolation-enforcement.js` proves the gate: clean suite → exit 0; cleanup disabled → functional 88/88 PASS but isolation 0/88 and exit 1; one deliberately leaked Gmail draft → functional 88/88 PASS but isolation 87/88 and exit 1.

Residual after a full run, in all three timezones: drafts 0, threads 0, Prospects 0, Ledger 0, Log 0, Suppression 0, lock free, mock state restored.

## 9. Documentation corrections

- `README.md` "How to move to F2" rewritten as an explicit 8-step sequence with triggers **second-to-last**, and the correction that Preview proves nothing about F0 (`previewStep` never calls `assertLiveAllowed_`); `checkLiveReadiness()` is the real gate check.
- `OVERNIGHT_REPORT.md` sections 15-19 explicitly marked obsolete-on-deploy-order, pointing at `PRODUCTION_CHECKLIST.md` as authoritative. No contradictory actionable instructions remain.
- `N3_AUDIT.md` does not exist and never did (the audit referred to it from chat context). No link anywhere in `outreach/` points at it, so there was nothing to repair and no filler document was created to satisfy a dangling name.

## 10. Migration hardening

`repairSendLedgerColumns_` now validates all three headers independently (N/O/P), repairs whichever are wrong — including the half-migrated "N correct, O/P wrong" case it previously reported as "nothing to repair" — and grows the sheet grid first if it is not wide enough for column P. Still additive-only, idempotent, never touches A-M or any data row. Tested: all-missing, partial, idempotent re-run, A-M byte-identical, grid width.

## 11. Files modified

`Constants.gs`, `Ledger.gs`, `Mailer.gs`, `Recon.gs`, `SheetRepo.gs`, `Tests.gs`, `test-harness/gas-mocks.js`, `test-harness/mutation-test-N3.js`, `test-harness/mutation-test-N5.js`, `test-harness/verify-isolation-enforcement.js`, `README.md`, `OVERNIGHT_REPORT.md`, and this report.

## 12. Local commits

```
daa93da docs(outreach): correct F2 deploy order and flag obsolete instructions
4395faa test(outreach): real isolation, call-count proofs, and new mutations
84b4394 fix(outreach): harden repairSendLedgerColumns_ header validation
10ee880 fix(outreach): stop inferring SENT from a generic recipient search
57ae50b fix(outreach): durable PREVIEW claim before any Gmail draft side effect
```

## 13. Functional exact result

**88/88 PASS**

## 14. Isolation exact result

**88/88 clean** — now including Gmail drafts, threads, lock, and mock-method restoration.

## 15. Static exact result

**14/14 PASS**

## 16. Mutation exact results

| Suite | Mutations | Result |
|---|---|---|
| N3 | 10 (A-J; H/I/J new: claim-after-createDraft, PREVIEW_AMBIGUOUS-not-blocking, release-claim-on-failed-cleanup) | PASS |
| N4 | 2 | PASS |
| N5 behavioral | 4 (C replaced: false-SENT inference) | PASS |
| N7 | 2 | PASS |
| ghost rows | 1 | PASS |
| timezone | 3 | PASS |
| isolation enforcement | 3 scenarios (clean / cleanup disabled / leaked draft) | PASS |

## 17. Three-timezone results

`America/Chicago`, `UTC`, `Asia/Kolkata` — identical: functional 88/88, isolation 88/88, static 14/14.

## 18. Self-audit findings

1. **Can any Preview Gmail side effect happen before the durable claim?** No. `createPreviewDraft_` has exactly one caller, after `appendPreviewClaim_`; if the claim throws, the function returns before Gmail.
2. **Can a Preview ambiguous state become auto-retryable?** No. The only writes away from a blocking state are the three `releasePreviewClaim_` calls, each guarded by proven cleanup (mutation J red).
3. **Can any LIVE Gmail side effect happen before the durable CLAIMED row?** No — `appendLedgerRow_` precedes both `draft.send()` and `thread.reply()`.
4. **Can LIVE AMBIGUOUS auto-retry?** No. Nothing transitions away from `AMBIGUOUS`; `findStaleLiveClaims_` only selects `CLAIMED`, so Recon never reopens it.
5. **Can Recon claim SENT without exact proof?** No — `LEDGER_STATE.SENT` no longer appears anywhere in Recon.gs.
6. **Can the suite leave Gmail mock state and still exit 0?** No — proven by the leaked-draft scenario.
7. **Do any active docs install triggers before the first manual LIVE?** No — README corrected, OVERNIGHT_REPORT marked obsolete, PRODUCTION_CHECKLIST authoritative.

No new blockers found.

## 19. Remaining LOCAL blockers

None.

## 20. Remaining GOOGLE-REAL gates

- Gmail fingerprint round-trip stability on an untouched real draft.
- Real concurrent Apps Script executions, real Gmail send/reply timing and quota behavior, real `GmailApp.search` semantics.
- The SendLedger N:P migration itself (`repairSendLedgerColumns()`), and the whole `F1_GOOGLE_CLOSURE_PLAN.md` sequence.
- One consequence worth stating plainly: with the preview pre-claim, a killed Apps Script execution now leaves a `PREVIEW_CLAIMED` row that blocks that prospect's preview until a human clears it. That is the intended trade (a blocked preview beats a duplicate draft), but it is new operational behavior to watch for during the first real Preview runs.

## 21. Verdict

**READY FOR FINAL CODEX AUDIT**

No push. No Google. No Gmail real. No LIVE. No triggers.
