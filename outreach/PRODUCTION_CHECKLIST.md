# Klinner Outreach v1.0 — production checklist

Shortest safe path from current state to production-ready. No new features — closing what already exists. Each stage gates the next; do not skip ahead.

**Deploy-order correction (Codex final audit):** an earlier draft of this checklist had triggers installed BEFORE the first LIVE send was manually verified. That is backwards — automating `sendBatch` before a human has watched exactly one real send succeed, end to end, with full manual control, is precisely the wrong order for a system whose whole design point is "controlled, observable rollout." The corrected order below installs triggers only AFTER Stage 5 (manual sends verified safe).

## Stage 0 — Local work (done, not yet pushed)

- [x] N3 V3 durable ownership/human-edit protection, then N3 orphan-draft-gap hardening (round 2) — implemented, tested, committed locally.
- [x] N5 LIVE-send ambiguous-outcome hardening, round 1 (Prospects-write-only) then round 2 (durable ledger-level `AMBIGUOUS` state, real executable tests) after an independent audit found round 1 insufficient — implemented, tested, committed locally.
- [x] N4 SYSTEM-origin unsubscribe guard — implemented, tested, committed locally.
- [x] Timezone environment-independence fix, then a DST algorithm fix (round 2) after an independent audit found the wall-clock resolution wrong near transitions — implemented, tested, committed locally.
- [x] Test-harness isolation enforcement (the runner now fails on a state leak, not just a functional failure) — implemented, verified.
- [ ] Fresh independent (Codex) audit of the cumulative diff — **required before any push**. See `AUTOPILOT_FIX_REPORT.md` for exact commit hashes and validation counts.

## Stage 1 — Push and Google-real re-verification

- [ ] `clasp push` (only after audit approval — independent gate, per this repo's standing rule).
- [ ] Remote-verification method B (isolated `clasp clone`, confirm `Tests.gs` absent, confirm exactly the expected file count).
- [ ] Run `F1_GOOGLE_CLOSURE_PLAN.md`'s step-by-step checklist in full, in order.

## Stage 2 — F0 (production identity) — still under DRY_RUN

- [ ] Gregor supplies: `ADMIN_EMAIL`, `PHYSICAL_ADDRESS`, confirms/creates the dedicated `outreach@klinnercleaning.com` mailbox — see `F0_PRODUCTION_CONFIG.md`.
- [ ] Set all 5 `PENDING_F0` Config values on the real Sheet (manual, Google-side). `DRY_RUN` stays `TRUE` through this entire stage.

## Stage 3 — Assert the LIVE gate explicitly (still no sending)

- [ ] Run **"Check LIVE readiness (F0)"** from the menu (`checkLiveReadiness()`, Config.gs) — a read-only function that calls the EXACT SAME `getPendingF0Keys_()` `assertLiveAllowed_`/I21 itself uses, so it cannot drift out of sync with what actually gates a real send. Confirm it reports all 5 keys resolved.
  - **Correction:** an earlier draft of this checklist incorrectly suggested running Preview to verify this. That is wrong — `previewStep()`/`previewQueue()` NEVER call `assertLiveAllowed_` at all (Preview is safe by construction and doesn't need the F0 gate; see Mailer.gs's SAFETY MODEL docstring). `checkLiveReadiness()` is the only function that actually reflects the real gate.
- [ ] Confirm the readiness check reports `dryRun: true` still — nothing about checking readiness should have changed it.

## Stage 4 — Controlled first LIVE send — triggers still ABSENT

- [ ] Flip `DRY_RUN` to `FALSE` on the real Sheet (Gregor, manual, with full understanding of consequences — never done by this session). No triggers exist yet at this point — every action in this stage is manual, one click at a time, fully observable.
- [ ] `MAX_PER_DAY` set deliberately low for the first real send (e.g. 1), not the eventual steady-state value.
- [ ] Manually trigger ONE send (e.g. via the "Send now (LIVE)" menu action, or `sendStep1` for a single selected prospect) to ONE real, low-risk prospect (or a controlled test address Gregor owns) — confirm: real email arrives, `SendLedger` shows `SENT` with real `Message_ID`/`Thread_ID`, `Prospects` row correctly updates to `IN_SEQUENCE`/`Step1_Sent_At`.
- [ ] Confirm the `KLINNER/Outreach` Gmail label is applied to the real sent thread.
- [ ] Confirm SendLedger shows NO `AMBIGUOUS` rows from this send — if one appears, STOP and reconcile manually before proceeding; do not treat it as expected noise.

## Stage 5 — Same-thread follow-up + reply sync + unsubscribe + suppression, for real — still manual, still no triggers

- [ ] Reply to the test send from Stage 4 (from a mailbox Gregor controls) — confirm `syncReplies` (run manually via the menu) correctly classifies it (REPLY, not BOUNCE/AUTOREPLY), sets `Replied=true`, stops the sequence.
- [ ] Separately, test the unsubscribe path for real: reply with the unsubscribe keyword(s) `classifyInboundMessage_` recognizes, confirm `Suppression(email)` row is created and `Do_Not_Contact_Reason=unsubscribe` is set.
- [ ] Manually trigger a follow-up send (step 2) and confirm it threads into the SAME Gmail conversation, not a new one — the core thing N5's fixes protect.
- [ ] Confirm no `AMBIGUOUS` ledger rows or unexplained `NEEDS_REVIEW` prospects resulted from any of this manual testing. If one appears, STOP, reconcile it manually, and understand exactly why before proceeding — do not move to triggers with an open, unexplained ambiguous-outcome incident.

## Stage 6 — Monitoring minimum, still manual

- [ ] Implement `MONITORING_SPEC.md`'s `refreshDashboardSummary_()` (small, isolated — deliberately deferred until real LIVE data exists to validate it against).
- [ ] Confirm the Dashboard reflects the real Stage 4/5 sends correctly.

## Stage 7 — ONLY NOW: install triggers

- [ ] Everything above ran manually, one action at a time, fully observed, with zero `AMBIGUOUS`/unexplained `NEEDS_REVIEW` incidents. Only now install triggers (`installTriggers()` — idempotent, scoped to exactly the 4 managed handlers, per `CLOUD_READINESS_AUDIT.md`).
- [ ] `MAX_PER_DAY` still deliberately low (e.g. 1-2) for the first trigger-driven day — this is the first time `sendBatch` runs unattended.

## Stage 8 — Cloud observation

- [ ] Observe real trigger-driven runs for **24 hours**: confirm each of the 4 handlers fires on schedule, no unexpected errors in Log, `syncReplies`/`nightlyRecon` behave correctly, quota math (`computeLiveSendBudget_`) matches real Gmail quota numbers. This is also the first real-world test of `CLOUD_READINESS_AUDIT.md`'s Mac-off-resilience reasoning.
- [ ] **72h extension**: only if the 24h window produced any `AMBIGUOUS` ledger row, any unexplained `NEEDS_REVIEW` prospect, or any surprising Gmail behavior — extend observation specifically watching for a recurrence before raising `MAX_PER_DAY` further. Skip if the 24h window was clean.
- [ ] Once observation is clean, raise `MAX_PER_DAY` to a small-but-real batch size (Gregor's call) and continue watching Log/SendLedger/Dashboard daily before scaling to steady-state volume.

## Stage 9 — Sign-off

- [ ] N4 — no further action, already structural.
- [ ] N5 — confirm no `AMBIGUOUS`/unexplained `NEEDS_REVIEW` incidents occurred anywhere in Stages 4-8 that remain unresolved.
- [ ] Full regression suite still green (`run-f1-tests.js` functional AND isolation, static verifier, all mutation tests) — re-run once more before calling this done.
- [ ] Gregor's explicit sign-off that real send volume, deliverability, and reply handling all match expectations.

**KLINNER OUTREACH v1.0 — PRODUCTION READY** once Stage 9 is complete.
