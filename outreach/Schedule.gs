/**
 * Klinner Outreach — Schedule.gs
 * Business-day math, send window checks, cadence offsets, queue ordering.
 * All date math happens in Session.getScriptTimeZone() (America/Chicago),
 * never in the default JS timezone.
 */

function getScriptTimeZone_() {
  return Session.getScriptTimeZone();
}

function formatDateYmd_(date) {
  return Utilities.formatDate(date, getScriptTimeZone_(), 'yyyy-MM-dd');
}

function isHoliday_(date, holidays) {
  var ymd = formatDateYmd_(date);
  return holidays.indexOf(ymd) !== -1;
}

function isWeekend_(date) {
  var dow = Number(Utilities.formatDate(date, getScriptTimeZone_(), 'u')); // 1=Mon..7=Sun (ISO)
  return dow === 6 || dow === 7;
}

function isBusinessDay_(date, holidays) {
  return !isWeekend_(date) && !isHoliday_(date, holidays);
}

/**
 * Wall-clock Y/M/D/H/M/S for `date` as seen in `tz`, via Utilities.formatDate
 * only — never a raw JS Date getter. See addCalendarDays_ for why.
 */
function wallClockComponents_(date, tz) {
  return {
    ymd: Utilities.formatDate(date, tz, 'yyyy-MM-dd'),
    hh: Utilities.formatDate(date, tz, 'HH'),
    mi: Utilities.formatDate(date, tz, 'mm'),
    ss: Utilities.formatDate(date, tz, 'ss')
  };
}

/**
 * Timezone offset in minutes (tz ahead of UTC = positive) for `tz` AT
 * approximately `date`. Standard trick: format `date` in `tz` to get its
 * wall-clock string, then parse that SAME string as literal UTC (the
 * trailing 'Z' makes ISO 8601 parsing environment-independent — this does
 * not claim the wall clock IS UTC, it is just a neutral way to turn a
 * Y/M/D/H/M/S tuple into milliseconds without involving any timezone),
 * and diff against the real instant.
 */
function timezoneOffsetMinutes_(date, tz) {
  var c = wallClockComponents_(date, tz);
  var wallClockAsUtcMs = new Date(c.ymd + 'T' + c.hh + ':' + c.mi + ':' + c.ss + 'Z').getTime();
  return (wallClockAsUtcMs - date.getTime()) / 60000;
}

/**
 * Builds the real Date instant whose wall clock in `tz` reads exactly
 * (y, mo [0-based], d, hh, mi, ss) — the environment-independent inverse of
 * wallClockComponents_. Used by addCalendarDays_ below, and also exposed
 * for test fixtures that need to construct "a specific wall-clock moment
 * in America/Chicago" without depending on whatever timezone the machine
 * running the tests happens to have (see the TIMEZONE AUDIT finding on
 * addCalendarDays_ — the same class of bug applies just as much to a raw
 * `new Date(y, mo, d, hh, mi, ss)` fixture, which is LOCAL-environment-
 * relative, not Chicago-relative).
 *
 * DST FIX (Codex final audit, round 2): a single-shot version of this
 * function — compute the offset ONCE, at the neutral (literal UTC) instant,
 * and apply it — is WRONG for any wall clock close enough to a DST
 * transition that the neutral instant and the true target instant fall on
 * OPPOSITE sides of the transition moment (which is common: the gap
 * between them is the offset itself, ~5-6 hours for America/Chicago, and
 * the transition window is exactly ±1 hour around 2am). Confirmed
 * examples that were wrong under the single-shot version:
 *   - 2026-03-08 03:30 (valid, just after spring-forward) used to resolve
 *     to 04:30 — the neutral instant (03:30Z) falls BEFORE the transition
 *     instant (08:00Z = 2am CDT), so the offset looked up there is still
 *     CST, one hour off from the CDT that actually applies at 03:30 local.
 *   - 2026-11-01 02:30 (valid, just after fall-back) used to resolve to
 *     01:30 — the equivalent error in the other direction.
 *
 * FIX: fixed-point iteration. Re-derive the offset at the CURRENT
 * candidate instant (not the original neutral one) and repeat until the
 * candidate stops changing. Any real IANA timezone has at most two
 * distinct offsets in play near a single transition, so this converges in
 * 1-3 iterations for a valid wall clock.
 *
 * EXPLICIT POLICY for the two DST edge cases (never silently invented):
 *   - NONEXISTENT wall clock (a "spring forward" gap, e.g. 2026-03-08
 *     02:30 — clocks jump 02:00 straight to 03:00, so 02:xx never occurs):
 *     the iteration OSCILLATES between exactly two candidates forever
 *     instead of converging. Detected explicitly (compared against the
 *     previous iteration's result) and resolved by taking the LATER of
 *     the two — i.e. the wall clock is treated as if the clock had kept
 *     running through the gap ("skip forward"), the same default
 *     convention most standard timezone libraries (Java's
 *     ZonedDateTime, Python's zoneinfo) use for a nonexistent local time.
 *   - AMBIGUOUS wall clock (a "fall back" overlap, e.g. 2026-11-01 01:30 —
 *     occurs once in CDT, once in CST): the iteration converges cleanly
 *     (no oscillation — both offsets are independently self-consistent
 *     fixed points), landing on whichever offset applied at the NEUTRAL
 *     instant first — which is always the EARLIER (pre-transition, CDT)
 *     occurrence for a fall-back overlap. This is a real, documented,
 *     deterministic choice, not an accident: ambiguity has no single
 *     universally-"correct" resolution, so this codebase picks the
 *     earlier occurrence and states so here.
 *   - Neither policy is exercised by any current production call site:
 *     `addCalendarDays_` only ever starts from a REAL previously-recorded
 *     instant (never a human-typed edge time), and the only direct
 *     production callers of wall-clock construction (isWithinSendWindow_
 *     etc.) always operate on `new Date()` — an already-real instant, never
 *     user-constructed — so 09:00-17:00 send hours and the 07:00 reply
 *     window are entirely unaffected by either policy. Both are exercised
 *     here only for the algorithm's own correctness and by explicit DST
 *     edge-case tests (Tests.gs).
 */
function dateFromWallClock_(y, mo, d, hh, mi, ss, tz) {
  var neutral = new Date(Date.UTC(y, mo, d, hh, mi, ss));
  var candidate = neutral;
  var previous = null;
  var MAX_ITERATIONS = 6; // Defensive only — real IANA zones converge or oscillate within 3.
  for (var i = 0; i < MAX_ITERATIONS; i++) {
    var offsetMinutes = timezoneOffsetMinutes_(candidate, tz);
    var next = new Date(neutral.getTime() - offsetMinutes * 60000);
    if (next.getTime() === candidate.getTime()) return next; // Converged: valid, unambiguous (or ambiguous-resolved) wall clock.
    if (previous !== null && next.getTime() === previous.getTime()) {
      // Oscillating between exactly two candidates: the wall clock does
      // not exist (DST gap). Policy: resolve to the LATER of the two.
      return next.getTime() > candidate.getTime() ? next : candidate;
    }
    previous = candidate;
    candidate = next;
  }
  // Unreachable for any real IANA timezone (see MAX_ITERATIONS comment) —
  // fail loud rather than silently return an unverified guess.
  throw new Error('dateFromWallClock_: offset resolution did not converge for ' +
    y + '-' + (mo + 1) + '-' + d + ' ' + hh + ':' + mi + ':' + ss + ' in ' + tz);
}

/**
 * Adds `days` calendar days, preserving wall-clock time-of-day, ALL
 * measured in the script's configured timezone (getScriptTimeZone_()).
 *
 * TIMEZONE AUDIT FINDING: the previous implementation used raw JS
 * `Date.getDate()`/`setDate()`, which resolve according to the EXECUTING
 * ENVIRONMENT's own timezone. Real Apps Script's V8 runtime happens to
 * honor the project's configured timeZone for those same raw getters, so
 * this worked there — but this exact file also loads unmodified into the
 * local Node.js test harness (test-harness/gas-mocks.js), where those same
 * JS Date getters resolve according to whatever OS/env timezone the
 * machine running the tests has, NOT necessarily America/Chicago. A test
 * run on a machine outside Chicago's UTC offset could have silently
 * validated the WRONG calendar-day arithmetic. Rewritten to go exclusively
 * through Utilities.formatDate + explicit offset arithmetic — both
 * environment-independent by specification — so correctness no longer
 * depends on which runtime/machine loaded this file.
 *
 * DST transitions crossed by the `days` shift: delegated entirely to
 * dateFromWallClock_'s fixed-point resolution and its explicitly documented
 * policy for nonexistent/ambiguous wall clocks — see that function's
 * docstring. This function itself does no DST reasoning of its own.
 */
function addCalendarDays_(date, days) {
  var tz = getScriptTimeZone_();
  var c = wallClockComponents_(date, tz);
  var y = Number(c.ymd.substring(0, 4));
  var mo = Number(c.ymd.substring(5, 7)) - 1;
  var d = Number(c.ymd.substring(8, 10)) + days;
  return dateFromWallClock_(y, mo, d, Number(c.hh), Number(c.mi), Number(c.ss), tz);
}

/**
 * Adds N business days to fromDate, skipping weekends and configured
 * holidays. offsetBusinessDays=0 returns fromDate unchanged.
 */
function addBusinessDays_(fromDate, offsetBusinessDays, holidays) {
  var result = new Date(fromDate.getTime());
  var remaining = offsetBusinessDays;
  while (remaining > 0) {
    result = addCalendarDays_(result, 1);
    if (isBusinessDay_(result, holidays)) remaining--;
  }
  return result;
}

/**
 * Computes Next_Action_Date for the step AFTER `completedStep`, given the
 * real timestamp the completed step was sent at (I15 — always computed
 * from the real send time, never from a plan).
 * @param {number} completedStep 1..MAX_STEPS
 * @param {Date} sentAt
 * @param {Object} config
 * @return {Date|null} null if completedStep is the last step (sequence done).
 */
function computeNextActionDate_(completedStep, sentAt, config) {
  var offsets = (config.CADENCE_OFFSETS_BD || []).map(Number);
  var maxSteps = config.MAX_STEPS || offsets.length;
  if (completedStep >= maxSteps) return null;
  var nextStep = completedStep + 1;
  var offsetForNextStep = offsets[nextStep - 1]; // offsets[0] is step1's own offset (0), offsets[1]=step2 offset, etc.
  var holidays = config.HOLIDAYS || [];
  return addBusinessDays_(sentAt, offsetForNextStep, holidays);
}

/** True if `now` falls within the configured LIVE send window (day + hour). */
function isWithinSendWindow_(now, config) {
  var sendDays = config.SEND_DAYS || [];
  var weekdayAbbrev = Utilities.formatDate(now, getScriptTimeZone_(), 'EEE').toUpperCase().substring(0, 3);
  if (sendDays.indexOf(weekdayAbbrev) === -1) return false;

  var hour = Number(Utilities.formatDate(now, getScriptTimeZone_(), 'H'));
  return hour >= config.SEND_START_HOUR && hour < config.SEND_END_HOUR;
}

/** True if `now` falls within the configured reply-sync window. */
function isWithinReplySyncWindow_(now, config) {
  var hour = Number(Utilities.formatDate(now, getScriptTimeZone_(), 'H'));
  return hour >= config.REPLY_SYNC_START_HOUR && hour < config.REPLY_SYNC_END_HOUR;
}

/**
 * Orders an eligible-prospect queue: follow-ups (step >= 2) first, by
 * Next_Action_Date ascending (tie-break Last_Contacted ascending), then
 * new prospects (READY / step 0) by Date_Added ascending.
 */
function orderQueue_(eligibleRows) {
  var followUps = eligibleRows.filter(function (r) { return Number(r.values.Sequence_Step) >= 1; });
  var fresh = eligibleRows.filter(function (r) { return !(Number(r.values.Sequence_Step) >= 1); });

  followUps.sort(function (a, b) {
    var byNext = compareDates_(a.values.Next_Action_Date, b.values.Next_Action_Date);
    if (byNext !== 0) return byNext;
    return compareDates_(a.values.Last_Contacted, b.values.Last_Contacted);
  });
  fresh.sort(function (a, b) { return compareDates_(a.values.Date_Added, b.values.Date_Added); });

  return followUps.concat(fresh);
}

function compareDates_(a, b) {
  var ta = a ? new Date(a).getTime() : 0;
  var tb = b ? new Date(b).getTime() : 0;
  return ta - tb;
}
