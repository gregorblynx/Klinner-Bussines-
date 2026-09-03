# Autopilot fix round — after Codex final audit

Response to Codex's `FAIL / FIX REQUIRED` verdict on the prior overnight autopilot pass. All confirmed blockers fixed, tested, and locally committed. See `OVERNIGHT_REPORT.md` for the prior round's work (now partially superseded — its "CLOSED" claims for N5 were premature; see its updated header note).

## 1. N5 final design

`LEDGER_STATE.AMBIGUOUS` (Constants.gs) is now the durable, ledger-level barrier for any Gmail operation (`draft.send()`, `GmailThread.reply()`) that may have succeeded but whose outcome cannot be confirmed. `isLiveKeyBlocked_` (Ledger.gs, renamed from `isLiveKeyClaimedOrSent_`) treats `CLAIMED`/`SENT`/`AMBIGUOUS` as all equally blocking. The ledger write happens independently of, and is never conditioned on, any other write — this is the structural fix for round 1's core flaw (relying on a Prospects write that could itself fail).

## 2. Durable ambiguous-send state

Applied at three sites: `doStep1Send_`'s `catch (sendError)`, `doFollowUpSend_`'s `catch (replyError)` (a gap round 1 never addressed at all — only the message-count-mismatch case was handled), and `doFollowUpSend_`'s message-count-mismatch guard. All three write `State: LEDGER_STATE.AMBIGUOUS` to the already-`CLAIMED` row (never downgrading it to a non-blocking state, unlike round 1's `FAILED`).

## 3. Behavior if Prospects NEEDS_REVIEW write fails

No effect on blocking. The ledger `AMBIGUOUS` write happens first (or independently); the Prospects write is now purely a secondary, operational signal for dashboards/human review, wrapped in its own try/catch that only logs on failure. Proven directly by `test_N5_step1SendThrowsDurablyBlocksLedgerEvenIfProspectsWriteFails_` and `test_N5_followUpMessageCountMismatchDurablyBlocksEvenIfProspectsWriteFails_`, which deliberately break `writeRowById_` globally and confirm the ledger still blocks a second attempt.

## 4. Recon behavior for ambiguous CLAIMED

`reconcileStaleLiveClaims_` (Recon.gs) rewritten: exactly one Gmail search match → `SENT` (unchanged, safe). Zero matches OR more than one match → `AMBIGUOUS` (previously: zero matches → `ABANDONED`, a non-blocking state — the confirmed duplicate-send risk). A `GmailApp.search()` failure now leaves the row completely untouched (still `CLAIMED`, already blocking) instead of attempting any transition. Search window widened `newer_than:2d` → `newer_than:30d` to reduce false-ambiguous flagging from delayed reconciliation (does not change the safety property).

## 5. N3 post-create compensation model

`createPreviewDraft_` no longer reads any Gmail metadata after `GmailApp.createDraft()` succeeds (the exact gap Codex found: `.getMessage().getThread().getId()` used to run there, outside every fail-closed guard). Every post-creation read — `draft.getId()`, `getMessage()`, `message.getId()`, `getThread()`, the returned thread's `getId()`, `getTo`/`getSubject`/`getPlainBody` — now happens inside ONE protected block in `previewStep()`. On any failure there, compensation uses the DIRECT object reference (`attemptDeleteDraftDirectly_`) — no enumeration, no dependency on any of the reads that just failed.

## 6. Behavior if cleanup itself fails

If the direct-reference delete also fails, a recovery ledger row is written (blank fingerprint) so the pre-existing legacy-blank-fingerprint policy (N3 V3 round 1) durably preserves it on the next run instead of risking a duplicate. If THAT write also fails, `previewStep()` still returns a controlled `ERROR_DRAFT_METADATA_CAPTURE_FAILED` status rather than throwing uncaught — proven by `test_N3v3_bothCompensationAndRecoveryRowFailStillReturnsControlledStatus_`. Separately, every Draft_ID-based enumeration lookup (used by callers with no live object reference — `deletePreviewDraftIfOwned_`, `resolveExistingPreviewDraft_`) now goes through `findDraftInListSafely_`, which never conflates "an unrelated draft threw during enumeration" with "our draft is confirmed gone."

## 7. Isolation harness fix

`run-f1-tests.js` now checks functional (`passed === total`) and isolation (`isolationCleanCount === total`) as two independent gates — both required for exit 0. Previously only functional was enforced; a leaking test could exit 0 as long as the leak didn't happen to perturb a later test's assertions. Also fixed the actual leak this caught: a test that permanently broke a mock draft's `deleteDraft` and never restored it, causing the framework's own teardown to fail too. `verify-isolation-enforcement.js` proves the enforcement itself works (builds a temp copy with cleanup disabled, confirms functional stays green while isolation goes to 0%, confirms exit code is non-zero anyway).

## 8. DST algorithm/policy

`dateFromWallClock_` (Schedule.gs) rewritten as fixed-point iteration — re-derives the timezone offset at the CURRENT candidate instant on each pass, not just once at the neutral literal-UTC instant (which was wrong whenever the neutral instant and true target instant fell on opposite sides of a DST transition). Explicit, documented policy for the two genuinely undefined cases: a nonexistent "spring forward" wall clock resolves to the later (post-gap) equivalent; an ambiguous "fall back" wall clock resolves to the earlier occurrence. Neither policy is exercised by any current production call site.

## 9. Docs/deploy corrections

- `PRODUCTION_CHECKLIST.md` reordered: triggers now install only AFTER the first LIVE send is manually verified safe (was backwards).
- Removed the claim that Preview verifies F0 config (`previewStep`/`previewQueue` never call `assertLiveAllowed_`). Added `checkLiveReadiness()` (Config.gs) — a read-only function calling the exact same `getPendingF0Keys_()` the real gate uses — wired into the menu.
- `F1_GOOGLE_CLOSURE_PLAN.md`: corrected a step expecting `LEGACY_BASELINE_PRESERVED`/`HUMAN_EDIT_PRESERVED` in the Log sheet — those are SendLedger `Error`-column markers, not `LOG_EVENT` tokens.
- `MONITORING_SPEC.md`: corrected a row assuming `syncReplies()` logs its own run boundaries (it doesn't — verified via grep).
- `OVERNIGHT_REPORT.md`/`README.md`: "N5 CLOSED"/"no automatic retry ever" claims removed pending independent confirmation.

## 10. Files changed (this round)

`Constants.gs`, `Ledger.gs`, `Mailer.gs`, `Recon.gs`, `Schedule.gs`, `Config.gs`, `Menu.gs`, `Tests.gs`, `test-harness/gas-mocks.js`, `test-harness/run-f1-tests.js`, `test-harness/verify-static-findings.js`, `test-harness/mutation-test-N3.js`, `test-harness/mutation-test-N5.js` (rewritten), `test-harness/mutation-test-timezone.js`, `test-harness/verify-isolation-enforcement.js` (new), `N5_AUDIT.md` (rewritten), `README.md`, `PRODUCTION_CHECKLIST.md`, `F1_GOOGLE_CLOSURE_PLAN.md`, `MONITORING_SPEC.md`, `OVERNIGHT_REPORT.md`.

## 11. Commits created (local only, this round)

```
a9a33a2 test(outreach): register all new tests in the F1 suite runner
3f50576 fix(outreach): correct F0/deploy-order docs, add a safe LIVE-readiness check
31127fd test(outreach): add DST transition regression tests
d6c7784 fix(outreach): correct DST wall-clock resolution near transitions
7cd21fa fix(outreach): enforce test-harness isolation as a hard gate
50b4ee8 test(outreach): add N3 orphan-draft-gap regression tests
7556933 fix(outreach): close N3 orphan-draft compensation gap
dfd71b8 test(outreach): add real executable N5 tests
6062a61 fix(outreach): harden N5 durable ledger-level ambiguous-outcome blocking
```
(on top of the prior round's `11ee854` and earlier — see `git log`)

## 12. Functional suite exact count

**77/77 passed**, identically under `TZ=America/Chicago`, `TZ=UTC`, `TZ=Asia/Kolkata`.

## 13. Isolation exact count

**77/77 clean**, identically under all three timezones. Enforced as a hard exit-code gate (see §7) and independently verified: `verify-isolation-enforcement.js` confirms functional stays green (77/77 PASS) while isolation correctly drops to 0/77 under a deliberately broken-cleanup mutation, and that the exit code goes non-zero anyway.

## 14. Static exact count

**14/14 passed** (round-1's 3 detailed N5 checks replaced with 1 minimal structural sanity check — round 2's real tests now carry the actual proof; net check count dropped by 2 but coverage strictly increased).

## 15. Every mutation result

| Suite | Mutations | Result |
|---|---|---|
| N7 (pre-existing) | 2 | PASS |
| Ghost-row (pre-existing) | 1 | PASS |
| N3 V3 | 7 (A-G; G new this round — orphan-draft gap) | PASS, each caught by its intended test only |
| N4 (pre-existing) | 2 | PASS |
| N5 (rewritten — behavioral, not static) | 4 (A-D) | PASS, each caught by its intended test |
| Timezone | 3 (A-C; C new this round — DST algorithm) | PASS |
| Isolation enforcement | 2 scenarios (clean / cleanup-disabled) | PASS |

## 16. Results under three host timezones

Full suite, static verifier: identical (77/77, 77/77, 14/14) under `America/Chicago`, `UTC`, `Asia/Kolkata`. All mutation suites: identical PASS under all three (N5/N3/N4/ghost/N7 don't depend on host timezone at all; the DST-specific mutation test forces `Asia/Kolkata` internally for its host-timezone-dependent mutations A/B and runs mutation C, the DST-algorithm one, under whatever the actual host TZ is — confirmed PASS on this machine, America/Chicago).

## 17. Self-audit findings

Adversarial read-only pass across N5, N3, isolation, and DST, plus the six named interactions (N3+Ledger, N5+Ledger, N5+Recon, N4+Suppression, Timezone+Schedule, DRY_RUN+LIVE gates, Triggers ordering):

- Grepped for every remaining `LEDGER_STATE.FAILED`/`LEDGER_STATE.ABANDONED` write in Mailer.gs/Recon.gs/Ledger.gs — none found outside comments; every post-Gmail-call ledger transition is now `SENT` or `AMBIGUOUS`, never a non-blocking state.
- Checked whether LIVE ledger rows can ever have a "multiple active rows" ambiguity analogous to N3's preview-flow guard: no — the CLAIMED-before-attempt ordering plus `isLiveKeyBlocked_`'s pre-check together make a second `appendLedgerRow_` for the same key structurally unreachable once any blocking row exists (unlike N3's two-step append-then-supersede transition, which genuinely can race). No new guard needed; documented as a deliberate finding, not an oversight.
- Verified `withLiveModeEnabledForTest_`'s Config restoration runs in `finally` regardless of whether the wrapped test body throws.
- Verified N4's `restrictedValues` guard has no interaction surface with Suppression.gs (separate sheet, separate write path).
- No further blockers found in this pass.

## 18. Remaining blockers

None known, locally. A fresh independent audit of this round's diff is the next required gate before any push (per this repo's standing rule).

## 19. Remaining GOOGLE-REAL-only gates

Real concurrent Apps Script executions, real Gmail send/reply timing and quota behavior, real `GmailApp.search()` indexing/query semantics, and the N3-5 Gmail-draft-round-trip-stability question — none of these can be proven from this environment. See `F1_GOOGLE_CLOSURE_PLAN.md` and `PRODUCTION_CHECKLIST.md`.

## 20. Verdict

## READY FOR CODEX RE-AUDIT

No push. No Google. No LIVE. No triggers.
