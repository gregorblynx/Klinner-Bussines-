# Cloud / trigger readiness audit

Status: **audited, no code changes needed**. Goal ("Mac apagada + Apps Script cloud sigue funcionando") is already structurally satisfied by the platform + existing design.

## 1. Why this is already true

Apps Script triggers execute entirely server-side on Google's infrastructure once installed — there is no dependency anywhere in this codebase on Gregor's local machine, a running terminal, or `clasp`. This is inherent to the platform, not something this project could break. The audit below checked for code-level risks that *could* undermine that (duplicate installs, unbounded runtimes, one bad row crashing a whole batch) rather than re-verifying the platform property itself.

## 2. `installTriggers()` (Triggers.gs) — idempotence and scope

Confirmed by reading: deletes only triggers whose handler is one of the 4 managed names (`sendBatch`, `syncReplies`, `nightlyRecon`, `dailyDigest`), then recreates exactly those 4. Any other project trigger (this project's or anyone else's) is left completely untouched, and re-running never duplicates — genuinely idempotent by construction (I19). `uninstallTriggers()`/`listManagedTriggers_()` mirror the same scoping. No bug found.

## 3. Per-run bounded execution time

`sendBatch()`: `MAX_PER_RUN` defaults to `2`, with `MIN_SLEEP_SECONDS`/`MAX_SLEEP_SECONDS` (20-60s) between sends. Worst case ≈ 2 sends × 60s sleep + Gmail API latency — comfortably inside both the 1-hour trigger interval and Apps Script's 6-minute per-execution limit. No risk of one `sendBatch` run still executing when the next hourly trigger fires, with the shipped defaults. (If `MAX_PER_RUN` or the sleep bounds are ever raised significantly, re-check this arithmetic.)

## 4. One bad row cannot abort a whole run

`sendBatch()`'s per-prospect loop wraps each `sendStep1`/`sendFollowUp` call in its own `try/catch`, logging the error and continuing to the next prospect rather than aborting the batch. `nightlyRecon()`'s 5 steps run sequentially without inter-step try/catch — a genuinely thrown exception in one step (e.g. `validateAllRows()`) would abort the remaining steps for that run. This is standard, safe Apps Script trigger semantics: Google's own trigger runtime catches any uncaught exception, emails the script owner an execution-failure notification, and the trigger simply runs again on its next scheduled tick — it does not corrupt state, skip the schedule going forward, or duplicate anything (every step in `nightlyRecon` is independently idempotent, so a skipped night just means one night's delay in reconciliation, not incorrect reconciliation).

## 5. Lock discipline

`syncReplies()` (ReplySync.gs) and `previewStep()`/LIVE sends (Mailer.gs) all acquire `LockService.getScriptLock()` around their critical sections with `try/finally` releasing it, and `flushLog_()` runs in every exit path (including `finally` blocks) so buffered log rows are never lost even on a thrown exception. `dailyDigest()` and `nightlyRecon()` don't need a lock (no shared mutable resource they contend over beyond what the write-authorization layer already serializes at the cell level).

## 6. Not verifiable locally

Real concurrent trigger execution, real Apps Script 6-minute enforcement, and Google's own retry/backoff behavior on trigger failure cannot be proven from this environment — this audit is a code-level reasoning pass, not a substitute for observing real trigger behavior once installed (see PRODUCTION_CHECKLIST.md's 24h/72h cloud observation step).

## 7. Action for Gregor

None required now. When triggers are eventually installed (explicit, later step — not done tonight, not automatic), watch the Log sheet for the first few real trigger-driven runs of each of the 4 handlers to confirm real-world execution time and error behavior match this reasoning.
