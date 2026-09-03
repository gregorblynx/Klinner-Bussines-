# Overnight autopilot report — Klinner Outreach v1.0

## 1. Blocks worked

One continuous session. Phases 1-4 (N3 V3, N5, N4, timezone) fully implemented, tested, and locally committed. Phases 5-9 (cloud readiness, monitoring, F0, F1 closure plan, production checklist) delivered as audits/specs, per priority order and the "don't touch code unnecessarily" instruction for the lower-priority phases.

## 2. N3 — status: **CLOSED (V3, ready for Codex re-audit)**

## 3. N3 root causes fixed

- **Blocker N3-1 (legacy blank fingerprint)**: a blank stored fingerprint was previously readable as "unedited" (via `Draft_Fingerprint && ...` short-circuit) — would have let the real Rosa's Bakery/Acme rows be auto-deleted once N:P columns were added. Now: blank fingerprint is its own `legacy: true` outcome, always paired with `edited: true`, always durably preserved.
- **Blocker N3-3 (creation metadata capture)**: draft creation's metadata reads (`draft.getId()`, `message.getId()`, `getTo/getSubject/getPlainBody`) were unguarded/best-effort — a failure could write a "healthy" DRAFTED row with a blank fingerprint, or crash `previewStep()` with an untracked orphan draft. Now: one fail-closed block; on failure, best-effort compensating delete, else a recovery row (protected by the N3-1 fix above) — never a silent healthy-looking row.
- **Blocker N3-4 (non-atomic durable transition)**: `preserveDraftDurably_` reordered to append-the-new-row-first, supersede-the-old-row-second, so a partial failure never leaves zero active rows; a `findActiveDryRunDraftRows_` ambiguity guard (new) in `resolveExistingPreviewDraft_` fails closed if it ever finds more than one active row for a key, rather than silently picking one.
- **Blocker N3-5 (Gmail canonicalization)**: recipient fingerprint canonicalization now absorbs Gmail's `"Name <email>"` display-name wrapper as a structural non-edit; the Google-real stability test procedure is documented in `F1_GOOGLE_CLOSURE_PLAN.md` step 11 (cannot be proven locally).

## 4. N3 tests: **20** (Tests.gs, `N3_*`/`N3v3_*` entries in `F1_TEST_FUNCTIONS`)

## 5. N3 mutations: **6**, all PASS (`mutation-test-N3.js`) — durable-preserve guard removal, fingerprint-comparison neutering, permissive read-error fallback, blank-fingerprint-as-unedited, partial-transition-ordering reversion, and (carried from V2) the getId() permissive-fallback case.

## 6. N3 local commit: `b31cacf` — "fix(outreach): harden durable Gmail preview ownership"

## 7. N5 — status: **CLOSED (both identified duplicate-send races)**

## 8. N5 design

Both `doStep1Send_`'s ambiguous `draft.send()` failure and `doFollowUpSend_`'s documented message-count-mismatch race now ALSO write `Status: NEEDS_REVIEW` to the Prospects row (not just mark the ledger row `FAILED`), which structurally removes the prospect from `getNextStepNumber_`/`canSend_`/`isEligibleForNextStep_` eligibility — no automatic retry possible on an ambiguous outcome, ever. Verified via static source checks (this project's own established method for LIVE-only code, per the existing findings #7/#8 policy of never flipping `DRY_RUN=FALSE` locally). One secondary, non-duplicate-send reconciliation gap found in `reconcileStaleLiveClaims_` (Recon.gs) and documented, not fixed — see `N5_AUDIT.md` §5.

## 9. N5 tests: 3 new static checks (16/16 total in `verify-static-findings.js`) + 2 mutations in `mutation-test-N5.js`, both PASS

## 10. N5 local commit: `fef2a35` — "fix(outreach): harden live send concurrency"

## 11. N4 — status: **CLOSED**

## 12. N4 tests: 1 test (`test_N4_systemOperationsCannotSetUnsubscribeReason_`, negative + positive cases) + 2 mutations in `mutation-test-N4.js`, both PASS

## 13. N4 local commit: `6805573` — "fix(outreach): close N4 production blocker"

## 14. Timezone findings/fixes

Real bug found: `addCalendarDays_` used raw environment-relative `Date` getters; the local mock's `Utilities.formatDate` ignored its `tz` argument entirely. Both silently correct only because this dev machine happens to already be set to `America/Chicago` — confirmed exploitable by forcing `TZ=Asia/Kolkata`, which shifted a business-day computation by one day. Fixed: environment-independent date math (`Utilities.formatDate` + explicit offset arithmetic) and a real `Intl.DateTimeFormat`-based mock. Verified identical (green) results under `America/Chicago`, `UTC`, and `Asia/Kolkata`. One Google-config-only item documented, not touched: the real Sheet's own file-level timezone display setting (cosmetic only — see `TIMEZONE_AUDIT.md` §5). Commit `d534771`.

## 15. Cloud/triggers readiness

Audited, no code changes needed. `installTriggers()` confirmed genuinely idempotent and scoped (I19). Per-run execution time comfortably bounded by shipped defaults. One bad prospect cannot abort a `sendBatch` run. Lock/flush discipline confirmed correct. See `CLOUD_READINESS_AUDIT.md`.

## 16. Monitoring status

Spec only, deliberately not implemented tonight (small/isolated enough to implement, but competing for review attention with the higher-priority work above, and better validated against real LIVE data later — see `PRODUCTION_CHECKLIST.md` Stage 8). Full field-to-data-source mapping in `MONITORING_SPEC.md`, including why spreadsheet-native formulas would reintroduce the exact timezone risk fixed in §14.

## 17. F0 plan

`F0_PRODUCTION_CONFIG.md` — recommends a new dedicated `outreach@klinnercleaning.com` mailbox (not the existing `info@` inbox, not new domains), maps all 5 `PENDING_F0` keys, flags `ADMIN_EMAIL`/`PHYSICAL_ADDRESS` as needing Gregor's real input (not invented). Config not touched on the real Sheet.

## 18. F1 Google manual gates

`F1_GOOGLE_CLOSURE_PLAN.md` — the requested 20-step checklist (Gregor's action / my verification / PASS / STOP for each).

## 19. Full production checklist

`PRODUCTION_CHECKLIST.md` — 10 stages (0-9) from tonight's local state to sign-off: Codex audit → push → F0 → triggers-under-DRY_RUN → controlled first LIVE → same-thread follow-up/reply/unsubscribe → small real batch → 72h-if-needed → monitoring → sign-off.

## 20. Suite final: **57/57 passed**

## 21. Static final: **16/16 passed**

## 22. Mutations final

N7: PASS · ghost-row: PASS · N3 V3 (6 mutations): PASS · N5 (2 mutations): PASS · N4 (2 mutations): PASS · timezone (2 mutations): PASS.
All re-confirmed green under `TZ=America/Chicago`, `TZ=UTC`, and `TZ=Asia/Kolkata`.

## 23. Blockers remaining

- Independent Codex audit of tonight's cumulative diff (all 4 commits) — required before any push, per this repo's standing rule.
- N5's secondary reconciliation gap (`reconcileStaleLiveClaims_` never updates the Prospects row on success) — documented, not a duplicate-send risk, left as a follow-up (`N5_AUDIT.md` §5).
- F0 real values (`ADMIN_EMAIL`, `PHYSICAL_ADDRESS`, mailbox creation) — need Gregor's real input, cannot be invented.
- The Sheet's own file-level timezone display setting — cosmetic-only Google config step, not a blocker.

## 24. Google-real actions still required

Everything in `F1_GOOGLE_CLOSURE_PLAN.md` (push, migration, re-verification) — none of it executed tonight.

## 25. LIVE actions still required

None until `PRODUCTION_CHECKLIST.md` Stage 4 — Config is still `DRY_RUN=TRUE`, all 5 `PENDING_F0` keys still unresolved, no triggers installed.

## 26. Exact NEXT ACTION for Gregor tomorrow

Get Codex's final audit on the 4 local commits (`b31cacf`, `fef2a35`, `6805573`, `d534771`) as a unit. If PASS: proceed to `PRODUCTION_CHECKLIST.md` Stage 1 (push + `F1_GOOGLE_CLOSURE_PLAN.md`'s 20 steps). If FAIL: report the specific blocker back for a targeted fix — none of tonight's work has been pushed, so there is no live exposure either way.

## 27. Files modified (all 4 commits combined)

`.claspignore`, `Constants.gs`, `Ledger.gs`, `Mailer.gs`, `README.md`, `Schedule.gs`, `SheetRepo.gs`, `Tests.gs`, `test-harness/gas-mocks.js`, `test-harness/verify-static-findings.js`, `test-harness/mutation-test-N3.js` (rewritten), plus new: `N4_AUDIT.md`, `N5_AUDIT.md`, `TIMEZONE_AUDIT.md`, `test-harness/mutation-test-N4.js`, `test-harness/mutation-test-N5.js`, `test-harness/mutation-test-timezone.js`. Plus tonight's final docs commit: `CLOUD_READINESS_AUDIT.md`, `F0_PRODUCTION_CONFIG.md`, `F1_GOOGLE_CLOSURE_PLAN.md`, `MONITORING_SPEC.md`, `PRODUCTION_CHECKLIST.md`, `OVERNIGHT_REPORT.md`.

## 28. Local commits (this session)

```
d534771 fix(outreach): make date math environment-timezone-independent
6805573 fix(outreach): close N4 production blocker
fef2a35 fix(outreach): harden live send concurrency
b31cacf fix(outreach): harden durable Gmail preview ownership
<pending> docs(outreach): overnight autopilot — cloud/monitoring/F0/closure/checklist docs
```
(base: `88e8429` — the pre-existing verified F1 baseline from the prior session)

## 29. Explicit confirmation

**NO LIVE emails sent. DRY_RUN not changed (still TRUE). NO triggers installed. NO Google data modified. NO `clasp push`. NO `git push`.** Only local commits, on top of the existing baseline, entirely within `outreach/`. `.gitignore` and `auditoria-seo-klinnercleaning.html` (pre-existing unrelated local modifications) were left untouched and excluded from every commit, per instruction.
