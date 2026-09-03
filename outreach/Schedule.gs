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

/** Adds one calendar day, preserving time-of-day, in script timezone. */
function addCalendarDays_(date, days) {
  var d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
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
