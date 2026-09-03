/**
 * Klinner Outreach — Config.gs
 * Reads/writes the Config sheet (key/value/description). Every operational
 * parameter lives here — none is hardcoded elsewhere.
 */

/** The 32 Config rows written on first initialization (see Constants.gs note
 *  on the 31-vs-32 discrepancy between the spec's summary count and its
 *  enumerated table — this implements the full enumerated table). */
function getConfigDefaults_() {
  return [
    ['PAUSE_ALL', 'FALSE', 'Kill switch. TRUE = sendBatch/previewStep refuse to run.'],
    ['DRY_RUN', 'TRUE', 'TRUE = preview-only pipeline. Must stay TRUE through F1.'],
    ['MAX_PER_DAY', '5', 'Max LIVE sends per day. Conservative ramp for a brand-new dedicated mailbox — raise manually in Config once deliverability/bounces/replies look healthy.'],
    ['MAX_PER_RUN', '2', 'Max LIVE sends per sendBatch execution.'],
    ['MAX_PREVIEW_PER_RUN', '10', 'Max drafts created per preview run. Does not consume LIVE quota.'],
    ['SEND_DAYS', 'MON,TUE,WED,THU,FRI', 'Days sendBatch is allowed to run.'],
    ['SEND_START_HOUR', '9', 'Send window start (24h, America/Chicago).'],
    ['SEND_END_HOUR', '17', 'Send window end, exclusive.'],
    ['MIN_SLEEP_SECONDS', '20', 'Min sleep between LIVE sends.'],
    ['MAX_SLEEP_SECONDS', '60', 'Max sleep between LIVE sends.'],
    ['CADENCE_OFFSETS_BD', '0,3,7,7', 'Business-day offsets per step, relative to previous step.'],
    ['MAX_STEPS', '4', 'Number of steps in the sequence. Must match CADENCE_OFFSETS_BD length.'],
    ['SENDER_NAME', 'Klinner Cleaning & Maintenance', 'Display name used in templates and drafts.'],
    ['SENDER_EMAIL', PENDING_F0, 'Dedicated outreach mailbox. Set during F0.'],
    ['REPLY_TO', PENDING_F0, 'Reply-To address. Set during F0.'],
    ['ADMIN_EMAIL', PENDING_F0, 'Destination of daily digest and failure alerts. Set during F0.'],
    ['PHYSICAL_ADDRESS', PENDING_F0, 'CAN-SPAM required postal address. Set during F0.'],
    ['UNSUBSCRIBE_LINE', PENDING_F0, 'Opt-out sentence rendered in every template. Set during F0.'],
    ['GMAIL_LABEL', DEFAULT_GMAIL_LABEL, 'Label applied to LIVE outreach threads only.'],
    ['GMAIL_STOP_LABEL', DEFAULT_GMAIL_STOP_LABEL, 'Manual escape-hatch label — marks a thread STOPPED.'],
    ['MAX_ERROR_COUNT', '3', 'Error_Count threshold that moves a prospect to NEEDS_REVIEW.'],
    ['CLAIM_STALE_MINUTES', '120', 'Age at which a CLAIMED ledger row is treated as orphaned.'],
    ['PUBLIC_EMAIL_DOMAINS', DEFAULT_PUBLIC_EMAIL_DOMAINS, 'CSV of consumer email domains. Editable.'],
    ['ONE_ACTIVE_PER_CORPORATE_DOMAIN', 'TRUE', 'Max 1 active sequence per corporate domain.'],
    ['ALLOW_PUBLIC_DOMAIN_PROSPECTS', 'TRUE', 'Public-domain contacts (gmail.com etc.) are prospectable.'],
    ['HOLIDAYS', DEFAULT_HOLIDAYS, 'CSV of YYYY-MM-DD dates excluded from business-day math.'],
    ['REPLY_SYNC_START_HOUR', '7', 'syncReplies allowed window start.'],
    ['REPLY_SYNC_END_HOUR', '21', 'syncReplies allowed window end.'],
    ['FAST_SWEEP_QUERY_WINDOW', 'newer_than:3d', 'Gmail search window for the hourly reply sweep.'],
    ['RECON_LOOKBACK_DAYS', '35', 'Nightly reconciliation lookback for active prospects.'],
    ['QUOTA_SAFETY_MARGIN', '5', 'Reserve subtracted from MailApp.getRemainingDailyQuota().'],
    ['LOG_MAX_ROWS', '5000', 'Log sheet row cap enforced nightly.']
  ];
}

var CONFIG_BOOLEAN_KEYS = ['PAUSE_ALL', 'DRY_RUN', 'ONE_ACTIVE_PER_CORPORATE_DOMAIN', 'ALLOW_PUBLIC_DOMAIN_PROSPECTS'];
var CONFIG_NUMBER_KEYS = [
  'MAX_PER_DAY', 'MAX_PER_RUN', 'MAX_PREVIEW_PER_RUN', 'SEND_START_HOUR', 'SEND_END_HOUR',
  'MIN_SLEEP_SECONDS', 'MAX_SLEEP_SECONDS', 'MAX_STEPS', 'MAX_ERROR_COUNT', 'CLAIM_STALE_MINUTES',
  'REPLY_SYNC_START_HOUR', 'REPLY_SYNC_END_HOUR', 'RECON_LOOKBACK_DAYS', 'QUOTA_SAFETY_MARGIN', 'LOG_MAX_ROWS'
];
var CONFIG_CSV_KEYS = ['SEND_DAYS', 'CADENCE_OFFSETS_BD', 'PUBLIC_EMAIL_DOMAINS', 'HOLIDAYS'];

var _configCache = null;

/** Reads Config sheet into a typed, cached object. Call resetConfigCache_() after writes. */
function getConfig() {
  if (_configCache) return _configCache;

  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  var lastRow = sheet.getLastRow();
  var raw = {};
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (var i = 0; i < values.length; i++) {
      var key = String(values[i][0] || '').trim();
      if (!key) continue;
      raw[key] = values[i][1];
    }
  }

  var config = {};
  for (var k in raw) {
    if (!raw.hasOwnProperty(k)) continue;
    config[k] = coerceConfigValue_(k, raw[k]);
  }
  _configCache = config;
  return config;
}

function coerceConfigValue_(key, rawValue) {
  var str = (rawValue === null || rawValue === undefined) ? '' : String(rawValue).trim();
  if (CONFIG_BOOLEAN_KEYS.indexOf(key) !== -1) {
    return str.toUpperCase() === 'TRUE';
  }
  if (CONFIG_NUMBER_KEYS.indexOf(key) !== -1) {
    var n = Number(str);
    return isNaN(n) ? 0 : n;
  }
  if (CONFIG_CSV_KEYS.indexOf(key) !== -1) {
    if (!str) return [];
    return str.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
  }
  return str;
}

function resetConfigCache_() {
  _configCache = null;
}

/** True if the given Config key currently holds the PENDING_F0 sentinel. */
function isPendingF0_(key) {
  var config = getConfig();
  var v = config[key];
  return typeof v === 'string' && v.trim() === PENDING_F0;
}

/**
 * Invariant I21: LIVE mode is rejected while ANY of the 5 required
 * Config keys still contains PENDING_F0. Returns the list of keys still
 * pending (empty array = LIVE is allowed to proceed).
 */
function getPendingF0Keys_() {
  var pending = [];
  for (var i = 0; i < PENDING_F0_REQUIRED_KEYS.length; i++) {
    if (isPendingF0_(PENDING_F0_REQUIRED_KEYS[i])) pending.push(PENDING_F0_REQUIRED_KEYS[i]);
  }
  return pending;
}

/** Throws if LIVE mode is attempted while PENDING_F0 keys remain unresolved. */
function assertLiveAllowed_() {
  var pending = getPendingF0Keys_();
  if (pending.length > 0) {
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.LIVE_BLOCKED_PENDING_F0, '', '', '', pending.join(','));
    throw new Error('LIVE blocked: pending F0 config keys: ' + pending.join(', '));
  }
}

/** Creates the Config sheet with defaults if it does not already have rows. */
function initializeConfigSheet_() {
  var sheet = getOrCreateSheet_(SHEET_NAMES.CONFIG);
  if (sheet.getLastRow() >= 1) {
    var existingHeader = sheet.getRange(1, 1, 1, 3).getValues()[0];
    if (existingHeader[0] === 'Key') {
      resetConfigCache_();
      return sheet; // Already initialized; never overwrite operator edits.
    }
  }
  sheet.clear();
  sheet.getRange(1, 1, 1, 3).setValues([['Key', 'Value', 'Description']]);
  sheet.setFrozenRows(1);
  var defaults = getConfigDefaults_();
  // Google-real diagnostic (confirmed CASE A — display-only, no data loss):
  // every value here is written as a plain JS string, including
  // numeric-looking ones ('5', '2', '10', ...). Without an explicit format,
  // Google Sheets' own client-side auto-detection can render those cells
  // as visually empty (while the real value is still present, visible in
  // the formula bar) — while non-numeric-looking values (TRUE,
  // PENDING_F0) never trigger that auto-detection and always render fine.
  // Forcing column B to plain-text format BEFORE writing removes the
  // ambiguity entirely, regardless of the exact Sheets-side mechanism.
  sheet.getRange(2, 2, defaults.length, 1).setNumberFormat('@');
  sheet.getRange(2, 1, defaults.length, 3).setValues(defaults);
  sheet.autoResizeColumns(1, 3);
  resetConfigCache_();
  return sheet;
}

/**
 * ADMIN, format-only repair for a Config sheet that was already
 * initialized BEFORE the plain-text fix above existed — i.e. exactly the
 * real "Klinner Outreach — F1 Test" Sheet right now. initializeConfigSheet_
 * early-returns once a Config sheet exists (by design — it must never
 * overwrite operator edits), so it will never re-apply this format on its
 * own to an existing sheet. This function does ONLY ONE thing: sets
 * column B's number format to plain text for every existing data row.
 *
 * Guarantees:
 *   - Never calls setValue/setValues — cannot alter any Key, Value, or
 *     Description, including DRY_RUN, MAX_PER_DAY, or any PENDING_F0.
 *   - Never calls clear/clearContent/clearFormat.
 *   - Never touches column A or C, or the header row.
 *   - Idempotent — re-running it re-applies the same format, a no-op.
 * Run manually (once, on the real Sheet) from the Apps Script editor —
 * not wired into a trigger or the menu, since it is a one-time repair for
 * data initialized before this fix existed, not a routine operation.
 */
function repairConfigValueColumnFormat_() {
  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 'Config sheet has no data rows — nothing to repair.';
  sheet.getRange(2, 2, lastRow - 1, 1).setNumberFormat('@');
  return 'Repaired Config!B2:B' + lastRow + ' to plain-text format. No Key/Value/Description content was changed.';
}

/**
 * Temporary public wrapper, no parameters, so this is selectable in the
 * Apps Script editor's "Select function to run" dropdown even if a
 * trailing-underscore name is not being listed there for some environment/
 * UI reason. Delegates entirely to repairConfigValueColumnFormat_() —
 * zero logic duplicated, zero behavior change.
 */
function repairConfigValueColumnFormat() {
  return repairConfigValueColumnFormat_();
}
