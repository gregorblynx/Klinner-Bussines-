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
 */
function dateFromWallClock_(y, mo, d, hh, mi, ss, tz) {
  var neutral = new Date(Date.UTC(y, mo, d, hh, mi, ss));
  var offsetMinutes = timezoneOffsetMinutes_(neutral, tz);
  return new Date(neutral.getTime() - offsetMinutes * 60000);
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
 * Residual (inherent to "same wall-clock time N days later", not specific
 * to the bug above): a DST transition crossed by the `days` shift makes
 * that phrase itself ambiguous (an hour either does not exist or occurs
 * twice). Resolved here the same way most calendar libraries do — using
 * the TARGET date's own UTC offset — a separate, much narrower, twice-a-
 * year edge case, not the environment-dependency bug being fixed.
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
