# Timezone audit

Status: **real bug found and fixed, locally, with tests**. One Google-config-only item documented, not touched.

## 1. Scope audited

`Session.getScriptTimeZone()`, `Config` (confirmed: there is no `TIMEZONE` Config key in this codebase — it was never introduced; all date math intentionally goes through `Session.getScriptTimeZone()` alone), `Utilities.formatDate` usage, raw JS `Date` getter/setter usage, send window (`isWithinSendWindow_`), business-day cadence (`addBusinessDays_`/`addCalendarDays_`/`computeNextActionDate_`), `Next_Action_Date`, `dailyDigest` (Digest.gs), `nightlyRecon`/triggers (Recon.gs/Triggers.gs).

## 2. Real bug found (fixed)

`Schedule.gs`'s `addCalendarDays_` used raw `Date.getDate()`/`setDate()`. Those resolve according to the **executing environment's own timezone**. Real Apps Script's V8 runtime happens to honor the *project's* configured `timeZone` (`appsscript.json`, confirmed `America/Chicago`) for those same raw getters — so this worked correctly there. But this exact file also loads unmodified into the local Node.js test harness (`test-harness/gas-mocks.js`), where JS `Date` getters resolve according to whatever OS/`TZ` env the machine running the tests has — **not necessarily America/Chicago**.

Made worse by a second bug found while investigating: the mock `Utilities.formatDate` **ignored its `tz` argument entirely** and also used raw `Date` getters — so even the parts of Schedule.gs that correctly called `Utilities.formatDate(date, getScriptTimeZone_(), ...)` were, in the local test harness, silently validated against the test machine's own timezone instead of `'America/Chicago'`.

**Why this was invisible until tonight:** this repo's own dev machine happens to already be set to `America/Chicago` (confirmed: `Intl.DateTimeFormat().resolvedOptions().timeZone` → `America/Chicago`). Every prior local test run was accidentally correct by coincidence of machine configuration. A CI runner, a different developer's machine, or any machine set to a timezone whose offset from Chicago is large enough to cross a day boundary would have silently validated wrong behavior (or made correct behavior look broken).

**Confirmed exploitable**: running the (pre-fix) suite with `TZ=Asia/Kolkata` (UTC+5:30, no DST) reproduced a real, wrong result: `test_T16_T17_businessDayCadence_`'s "Thursday 2026-01-08" fixture, built via `new Date(2026, 0, 8, 10, 0, 0)`, actually represented **Wednesday 2026-01-07 22:30 in America/Chicago** once the 11.5-hour offset between Kolkata and Chicago was accounted for — shifting the computed business-day result by one day (`2026-01-12` instead of the correct `2026-01-13`).

## 3. Fix

- `Schedule.gs`: added `wallClockComponents_`, `timezoneOffsetMinutes_`, and `dateFromWallClock_` — all built exclusively on `Utilities.formatDate` (never a raw `Date` getter) plus environment-independent arithmetic (`Date.UTC` as neutral scratch space, ISO-8601-with-`'Z'`-suffix parsing for the offset trick). `addCalendarDays_` rewritten in terms of these. `dateFromWallClock_` is also exposed as a reusable "build a specific wall-clock instant in an arbitrary named timezone" helper.
- `test-harness/gas-mocks.js`: `Utilities.formatDate` rewritten to use `Intl.DateTimeFormat` with an explicit `timeZone: tz` (verified environment-independent — resolves `America/Chicago` correctly even when the Node process itself is forced to `TZ=UTC`). Added `'HH'`/`'mm'`/`'ss'` pattern support (needed by the fix above).
- `Tests.gs`: the two environment-relative test fixtures (`new Date(2026, 0, 8, 10, 0, 0)` and similar) rewritten via `dateFromWallClock_(..., getScriptTimeZone_())` so they mean "this wall clock in Chicago" regardless of the test machine.
- New test `test_timezoneAudit_dateMathIsChicagoRelativeNotEnvironmentRelative_` (Tests.gs): includes one assertion built from an independent ISO-8601 ground truth (not round-tripped through the code under test), specifically so it can catch `Utilities.formatDate` itself silently ignoring `tz` — a self-consistency-only test could otherwise pass even with that bug (verified: an early version of this test did NOT catch it; see `mutation-test-timezone.js`'s mutation B).
- Also includes a DST "spring forward" boundary case (2026-03-08, when America/Chicago's clocks skip 02:00→03:00) to confirm a noon-anchored add is unaffected by a same-day DST transition elsewhere.

## 4. Residual, documented, not fixed (inherent, not a bug)

"The same wall-clock time N days later" is itself ambiguous exactly at a DST transition (an hour either doesn't exist or occurs twice). `dateFromWallClock_`/`addCalendarDays_` resolve this the same way most calendar libraries do (using the *target* date's own UTC offset) — a separate, much narrower, twice-a-year edge case, distinct from the environment-dependency bug this fix closes.

## 5. Google-config-only item (documented, NOT touched — no code depends on it)

The user's brief mentioned a prior observation: "Spreadsheet metadata previously: `Etc/GMT`". This refers to the **Google Sheets file's own timezone setting** (File → Settings → General → Time zone in the Sheets UI) — a setting that is completely separate from the Apps Script **project's** `timeZone` (`appsscript.json`, confirmed `America/Chicago`) that all of this codebase's date math actually uses via `Session.getScriptTimeZone()`.

**No code in this repo reads or depends on the Spreadsheet's own file-level timezone setting** — confirmed by this audit (grep for any spreadsheet-native date function or `SpreadsheetApp`-based timezone read; none exists). So this cannot cause a functional bug. It CAN cause **visual confusion for a human** reviewing the real Sheet: if the file's own timezone is still `Etc/GMT` (Google's default for a blank new Sheet), any Date-typed cell (`Date_Added`, `Confirmed_At`, `Next_Action_Date`, etc., all written via `setValue(new Date())`/`setValues()`) could *display* in Sheets' UI shifted from what a Chicago-based reader expects, even though the underlying computed value and all business logic are correct.

**Manual step for Gregor** (Google-config-only, not executed tonight — matches the hard-stop "NO modificar Config Google real"): in the real "Klinner Outreach — F1 Test" Sheet, check File → Settings → General → Time zone. If it reads anything other than `(GMT-06:00) Central Time`, changing it to Chicago improves human readability of Date cells but changes **no code behavior at all** — purely cosmetic/display, safe to do at Gregor's convenience, not a blocker for anything.

## 6. Tests / validation

New tests: `test_timezoneAudit_dateMathIsChicagoRelativeNotEnvironmentRelative_` (Tests.gs), `test-harness/mutation-test-timezone.js` (2 mutations, both independently caught).

Full suite + static + every existing mutation test (N7, ghost-row, N3, N5, N4) re-run and confirmed identical (green) under three different forced timezones: `America/Chicago`, `UTC`, `Asia/Kolkata` — proving the whole test harness, not just the new test, is now genuinely environment-independent.

## 7. Files changed

`Schedule.gs`, `test-harness/gas-mocks.js`, `Tests.gs`, `test-harness/mutation-test-timezone.js` (new).
