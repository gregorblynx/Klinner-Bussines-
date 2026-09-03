# Monitoring — minimum viable spec

Status: **spec only, not implemented tonight** — deliberately, per the "don't touch code unnecessarily" instruction (priority 5, and a fresh addition here would compete with tonight's higher-priority N3/N5/N4/timezone work for review attention). Every field below is fully derivable from what already exists (`Prospects`, `SendLedger`, `Log`) — nothing new needs to be tracked.

## Why not spreadsheet formulas

The existing `Dashboard` sheet (`initializeDashboardSheet_`, SheetRepo.gs) already uses live `COUNTIF`/`COUNTIFS` formulas for its all-time counters — safe, because they don't involve "today"/"this week" filtering. Extending that approach to the "Today" and "Last X" fields below would require spreadsheet-native `NOW()`/`TODAY()`, which resolve in the **Sheet file's own timezone setting** (a separate, human-editable setting — see `TIMEZONE_AUDIT.md` §5), not `Config`'s `America/Chicago` via `Session.getScriptTimeZone()`. That would reintroduce exactly the class of timezone bug this session just spent real effort closing. **Recommendation: compute these fields in code** (a small `refreshDashboardSummary_()` function, following the same pattern `computeDigest_()` in Digest.gs already uses — same data sources, same `formatDateYmd_`/`getScriptTimeZone_()` safety), and write the results to the Dashboard sheet as plain values, not formulas.

## Field list — data source mapping

### Daily block

| Field | Source |
|---|---|
| SYSTEM STATUS | `PAUSE_ALL` Config value → `"PAUSED"` / `"RUNNING"` |
| DRY_RUN / LIVE | `Config.DRY_RUN` |
| Last Successful Run | `Log` sheet, latest row where `Event=RUN_END` (any handler) |
| Last Error | `Log` sheet, latest row where `Level=ERROR` |
| Emails Sent Today | `getDailyLiveSentCount_()` (Ledger.gs) — already exists, already timezone-safe |
| Daily Cap | `Config.MAX_PER_DAY` |
| New Outreach Today | `SendLedger` rows: `Mode=LIVE, State=SENT, Step=1, Confirmed_At` is today (`formatDateYmd_`) — same logic `computeDigest_()` already computes as `newSentToday` |
| Follow-ups Today | Same source, `Step>1` — `computeDigest_()`'s `followUpSentToday` |
| Replies Today | `Prospects` rows: `Replied=true, Replied_At` is today — `computeDigest_()`'s `repliedToday` |
| Errors Today | `Log` sheet rows where `Level=ERROR` and `Timestamp` is today |
| Last Reply Sync | **Gap, confirmed (not spec'd yet)**: `syncReplies()` (ReplySync.gs) does NOT currently log any `RUN_START`/`RUN_END` boundary event at all — verified via `grep -n "logEvent_(LOG_LEVEL.INFO, LOG_EVENT.RUN_START\|RUN_END" *.gs`, which finds boundary logging only in `nightlyRecon()` and `installTriggers()`. Deriving "Last Reply Sync" from `Log` would need `syncReplies()` to add its own `RUN_START`/`RUN_END` calls first (a small, real code change, not done here) — do not implement this row against a log token that does not exist. |
| Last Recon | `Log`, latest `RUN_END` row whose `Detail` starts with `nightlyRecon` (matches the exact string `nightlyRecon()` already logs) |
| Last Digest | `Log`, latest `DIGEST_SENT` or `DIGEST_NOT_SENT_PENDING_F0` row |
| Next Scheduled Run | `ScriptApp.getProjectTriggers()` (Triggers.gs already has `listManagedTriggers_()` to build on) — `getTriggerSource()`/schedule inspection; only meaningful once triggers are actually installed |

### Weekly block

| Field | Source |
|---|---|
| New Outreach | `SendLedger`: `Mode=LIVE, State=SENT, Step=1, Confirmed_At` within the last 7 days |
| Follow-ups | Same, `Step>1` |
| Total Sent | Sum of the two above |
| Replies | `Prospects`: `Replied_At` within the last 7 days |
| Reply Rate | Replies ÷ Total Sent (guard divide-by-zero) |
| Bounces | `Prospects`: `Status=BOUNCED` rows whose bounce happened within the last 7 days (needs a bounce timestamp — currently there isn't one; `ReplySync.gs`'s BOUNCE classification doesn't stamp a date. **Gap**: either accept "all-time bounces" like the existing Dashboard counter already does, or add a `Bounced_At` column — a real, if small, schema decision, deliberately not made here) |
| Suppressions | `Suppression` sheet: `Date_Added` within the last 7 days |

## Recommended implementation shape (for later, not tonight)

1. `refreshDashboardSummary_()` (new function, Digest.gs or a new `Dashboard.gs`) — pure read + one `setValues()` write to the Dashboard sheet's summary rows. No interaction with the write-authorization/origin system (Dashboard isn't a Prospects write).
2. Call it from `dailyDigest()` (already runs daily, already reads most of the same data) so it stays current without a new trigger.
3. Add a "Refresh dashboard now" ADMIN menu item (Menu.gs) for on-demand refresh, mirroring the existing "Preview today's queue" pattern.
4. Test the same way `computeDigest_()` is tested — no new mock capability needed for the daily block; the weekly block needs nothing new either (existing sheets already carry the required timestamps except the bounce-date gap noted above).

## Not doing

No new sheet, no new trigger cadence, no schema changes except the one explicitly flagged gap (bounce timestamp) — left as a decision for whoever picks this up, not assumed here.
