# Klinner Outreach v1.0 — production checklist

Shortest safe path from tonight's state to production-ready. No new features — closing what already exists. Each stage gates the next; do not skip ahead.

## Stage 0 — Tonight's local work (done, not yet pushed)

- [x] N3 V3 durable ownership/human-edit protection — implemented, tested (55→57 tests across the session), committed locally (`b31cacf`).
- [x] N5 LIVE-send ambiguous-outcome hardening — implemented, statically verified, committed locally (`fef2a35`).
- [x] N4 SYSTEM-origin unsubscribe guard — implemented, tested, committed locally (`6805573`).
- [x] Timezone audit — real bug found and fixed, committed locally (`d534771`).
- [ ] Codex final audit of tonight's cumulative diff (all 4 commits) — **required before any push**.

## Stage 1 — Push and Google-real re-verification

- [ ] `clasp push` (only after Codex approval — independent gate, per this repo's standing rule).
- [ ] Remote-verification method B (isolated `clasp clone`, confirm `Tests.gs` absent, confirm exactly 17 files) — same procedure already used successfully for the earlier baseline push.
- [ ] Run `F1_GOOGLE_CLOSURE_PLAN.md`'s 20-step checklist in full, in order.

## Stage 2 — F0 (production identity)

- [ ] Gregor supplies: `ADMIN_EMAIL`, `PHYSICAL_ADDRESS`, confirms/creates the dedicated `outreach@klinnercleaning.com` mailbox — see `F0_PRODUCTION_CONFIG.md`.
- [ ] Set all 5 Config values on the real Sheet (manual, Google-side).
- [ ] Confirm `assertLiveAllowed_`/I21 now passes (all 5 keys resolved) — verifiable by attempting a Preview run and checking no `LIVE_BLOCKED_PENDING_F0` log entry appears when `sendBatch`-adjacent code paths are exercised (still under DRY_RUN=TRUE at this point — just confirming the config gate itself, not sending anything).

## Stage 3 — Triggers, still in DRY_RUN

- [ ] Install triggers (`installTriggers()`) while `DRY_RUN` is still `TRUE` — `sendBatch`/`syncReplies`/`nightlyRecon`/`dailyDigest` all run for real on schedule, but `sendBatch` is a guaranteed no-op under DRY_RUN (`Mailer.gs` checks this first, before anything else) and `dailyDigest` won't send until `ADMIN_EMAIL` is resolved (already true from Stage 2).
- [ ] Observe real trigger-driven runs for **24 hours**: confirm each of the 4 handlers actually fires on schedule, confirm no unexpected errors in Log, confirm `syncReplies`/`nightlyRecon` behave correctly against real (still DRY_RUN) data.
- [ ] This is also the first real-world test of `CLOUD_READINESS_AUDIT.md`'s reasoning (Mac-off resilience) — confirm triggers keep firing regardless of whether any local machine is on.

## Stage 4 — Controlled first LIVE send

- [ ] Flip `DRY_RUN` to `FALSE` on the real Sheet (Gregor, manual, with full understanding of consequences — never done by this session).
- [ ] `MAX_PER_DAY` set deliberately low for the first real day (e.g. 1-2), not the eventual steady-state value.
- [ ] Send to ONE real, low-risk prospect first (or a controlled test address Gregor owns) — confirm: real email arrives, `SendLedger` shows `SENT` with real `Message_ID`/`Thread_ID`, `Prospects` row correctly updates to `IN_SEQUENCE`/`Step1_Sent_At`.
- [ ] Confirm the `KLINNER/Outreach` Gmail label is applied to the real sent thread.

## Stage 5 — Same-thread follow-up + reply sync + unsubscribe + suppression, for real

- [ ] Reply to the test send from Stage 4 (from a mailbox Gregor controls) — confirm `syncReplies` correctly classifies it (REPLY, not BOUNCE/AUTOREPLY), sets `Replied=true`, stops the sequence.
- [ ] Separately, test the unsubscribe path for real: reply with the unsubscribe keyword(s) `classifyInboundMessage_` recognizes, confirm `Suppression(email)` row is created and `Do_Not_Contact_Reason=unsubscribe` is set.
- [ ] Confirm a follow-up send (step 2) correctly threads into the SAME Gmail conversation, not a new one — the core thing N5's fixes protect.
- [ ] Confirm the N5 ambiguous-outcome paths (`NEEDS_REVIEW` routing) have not fired spuriously during this real testing — if they did, investigate before proceeding; a `NEEDS_REVIEW` prospect from real usage needs manual reconciliation before Stage 6.

## Stage 6 — Small real batch

- [ ] Raise `MAX_PER_DAY` to a small-but-real batch size (Gregor's call — a handful, not the eventual full volume).
- [ ] Run for a few real days, watching Log/SendLedger/Dashboard daily.
- [ ] Confirm quota math (`computeLiveSendBudget_` — `MAX_PER_DAY`, `QUOTA_SAFETY_MARGIN`, Gmail's own remaining quota) behaves as expected against real Gmail quota numbers.

## Stage 7 — 72h observation (if the small batch surfaces anything ambiguous)

- [ ] Only needed if Stage 6 produced any `NEEDS_REVIEW` rows, any N5 ambiguous-outcome log entries, or any surprising Gmail behavior — extend observation to 72h specifically watching for a recurrence before scaling further. Skip this stage if Stage 6 was clean.

## Stage 8 — Monitoring

- [ ] Implement `MONITORING_SPEC.md`'s `refreshDashboardSummary_()` (small, isolated, was deliberately deferred tonight) — now that real LIVE data exists to validate it against.
- [ ] Confirm the Dashboard reflects real numbers correctly for at least one full day before relying on it.

## Stage 9 — Sign-off

- [ ] N4 (closed tonight) — no further action, already structural.
- [ ] N5 — confirm no ambiguous-outcome (`NEEDS_REVIEW`) incidents occurred during Stages 4-7 that remain unexplained.
- [ ] Full regression suite still green (`run-f1-tests.js`, static verifier, all mutation tests) — re-run once more before calling this done.
- [ ] Gregor's explicit sign-off that real send volume, deliverability, and reply handling all match expectations.

**KLINNER OUTREACH v1.0 — PRODUCTION READY** once Stage 9 is complete.
