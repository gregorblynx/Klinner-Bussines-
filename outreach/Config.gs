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
    ['LOG_MAX_ROWS', '5000', 'Log sheet row cap enforced nightly.'],
    ['INVENTORY_REFILL_THRESHOLD', String(DEFAULT_INVENTORY_REFILL_THRESHOLD), 'Low-inventory alert fires once when qualified future inventory falls to this number or fewer.'],
    ['INVENTORY_CRITICAL_THRESHOLD', String(DEFAULT_INVENTORY_CRITICAL_THRESHOLD), 'Critical-inventory alert fires once at this number or fewer. Must be lower than INVENTORY_REFILL_THRESHOLD or the default is used.'],
    ['REPLY_ALERT_EMAIL', DEFAULT_REPLY_ALERT_EMAIL, 'Receives a notification when a real prospect replies.']
  ];
}

var CONFIG_BOOLEAN_KEYS = ['PAUSE_ALL', 'DRY_RUN', 'ONE_ACTIVE_PER_CORPORATE_DOMAIN', 'ALLOW_PUBLIC_DOMAIN_PROSPECTS'];
var CONFIG_NUMBER_KEYS = [
  'MAX_PER_DAY', 'MAX_PER_RUN', 'MAX_PREVIEW_PER_RUN', 'SEND_START_HOUR', 'SEND_END_HOUR',
  'MIN_SLEEP_SECONDS', 'MAX_SLEEP_SECONDS', 'MAX_STEPS', 'MAX_ERROR_COUNT', 'CLAIM_STALE_MINUTES',
  'REPLY_SYNC_START_HOUR', 'REPLY_SYNC_END_HOUR', 'RECON_LOOKBACK_DAYS', 'QUOTA_SAFETY_MARGIN', 'LOG_MAX_ROWS',
  'INVENTORY_REFILL_THRESHOLD', 'INVENTORY_CRITICAL_THRESHOLD'
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

// ---------------------------------------------------------------------------
// Exact operator control for one-shot LIVE arming / safe restoration
// ---------------------------------------------------------------------------

var LIVE_CONTROL_KEYS_ = ['PAUSE_ALL', 'DRY_RUN', 'MAX_PER_DAY', 'MAX_PER_RUN'];

/** Returns the unique Config row for `key`; duplicates are unsafe and fail closed. */
function findUniqueConfigRow_(key) {
  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  var lastRow = sheet.getLastRow();
  var matches = [];
  if (lastRow >= 2) {
    var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0] || '').trim() === key) matches.push(i + 2);
    }
  }
  if (matches.length !== 1) {
    throw new Error('Config control blocked: expected exactly one row for ' + key + ', found ' + matches.length + '.');
  }
  return matches[0];
}

/** Strict serializer. Unlike getConfig(), malformed FALSE-like strings are rejected. */
function normalizeLiveControlValue_(key, value) {
  if (LIVE_CONTROL_KEYS_.indexOf(key) === -1) {
    throw new Error('Config control blocked: unsupported key ' + key + '.');
  }
  if (key === 'PAUSE_ALL' || key === 'DRY_RUN') {
    if (typeof value !== 'boolean') {
      throw new Error('Config control blocked: ' + key + ' must be the boolean true or false.');
    }
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value || value < 1) {
    throw new Error('Config control blocked: ' + key + ' must be a positive integer.');
  }
  return String(value);
}

/** Reads one control value and requires a canonical raw representation. */
function readLiveControlValueExact_(key) {
  var row = findUniqueConfigRow_(key);
  var raw = String(getSheet_(SHEET_NAMES.CONFIG).getRange(row, 2).getValue()).trim();
  if (key === 'PAUSE_ALL' || key === 'DRY_RUN') {
    if (raw !== 'TRUE' && raw !== 'FALSE') {
      throw new Error('Config control blocked: ' + key + ' contains malformed raw value "' + raw + '".');
    }
    return { key: key, raw: raw, value: raw === 'TRUE' };
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error('Config control blocked: ' + key + ' contains malformed raw value "' + raw + '".');
  }
  return { key: key, raw: raw, value: Number(raw) };
}

/** Writes one control cell exactly, flushes, then verifies raw AND typed read-back. */
function writeLiveControlValueExact_(key, value) {
  var expectedRaw = normalizeLiveControlValue_(key, value);
  var row = findUniqueConfigRow_(key);
  var cell = getSheet_(SHEET_NAMES.CONFIG).getRange(row, 2);
  cell.setNumberFormat('@');
  cell.setValue(expectedRaw);
  SpreadsheetApp.flush();
  resetConfigCache_();

  var actual = readLiveControlValueExact_(key);
  if (actual.raw !== expectedRaw || actual.value !== value) {
    throw new Error('Config control read-back failed for ' + key + ': expected ' + expectedRaw + ', got ' + actual.raw + '.');
  }
  return actual;
}

function readLiveControlStateExact_() {
  return {
    PAUSE_ALL: readLiveControlValueExact_('PAUSE_ALL').value,
    DRY_RUN: readLiveControlValueExact_('DRY_RUN').value,
    MAX_PER_DAY: readLiveControlValueExact_('MAX_PER_DAY').value,
    MAX_PER_RUN: readLiveControlValueExact_('MAX_PER_RUN').value
  };
}

function assertLiveControlStateExact_(expected, label) {
  var actual = readLiveControlStateExact_();
  for (var i = 0; i < LIVE_CONTROL_KEYS_.length; i++) {
    var key = LIVE_CONTROL_KEYS_[i];
    if (actual[key] !== expected[key]) {
      throw new Error((label || 'Config control') + ' verification failed: ' + key +
        ' expected ' + expected[key] + ', got ' + actual[key] + '.');
    }
  }
  return actual;
}

/** Internal restore body. Caller must already hold the script lock. */
function restoreSafeLiveConfigUnlocked_() {
  // Master kill switch FIRST. Every later failure therefore remains fail closed.
  writeLiveControlValueExact_('PAUSE_ALL', true);
  writeLiveControlValueExact_('DRY_RUN', true);
  writeLiveControlValueExact_('MAX_PER_DAY', 1);
  writeLiveControlValueExact_('MAX_PER_RUN', 1);
  return assertLiveControlStateExact_({
    PAUSE_ALL: true, DRY_RUN: true, MAX_PER_DAY: 1, MAX_PER_RUN: 1
  }, 'SAFE Config');
}

/**
 * Establishes the exact one-shot LIVE control state without sending email.
 * Requires the canonical SAFE state as its starting point. PAUSE_ALL is
 * disabled LAST. Any failure attempts an immediate SAFE restoration before
 * surfacing the error; a failed restoration is reported explicitly.
 */
function armLiveConfig(approvedMaxPerDay) {
  normalizeLiveControlValue_('MAX_PER_DAY', approvedMaxPerDay); // validate before any write
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('LIVE Config arm blocked: script lock busy.');
  try {
    assertLiveControlStateExact_({
      PAUSE_ALL: true, DRY_RUN: true, MAX_PER_DAY: 1, MAX_PER_RUN: 1
    }, 'Pre-arm SAFE Config');

    writeLiveControlValueExact_('PAUSE_ALL', true);
    writeLiveControlValueExact_('MAX_PER_RUN', 1);
    writeLiveControlValueExact_('MAX_PER_DAY', approvedMaxPerDay);
    writeLiveControlValueExact_('DRY_RUN', false);
    writeLiveControlValueExact_('PAUSE_ALL', false); // LAST safety switch disabled

    return assertLiveControlStateExact_({
      PAUSE_ALL: false, DRY_RUN: false,
      MAX_PER_DAY: approvedMaxPerDay, MAX_PER_RUN: 1
    }, 'ARMED Config');
  } catch (armError) {
    try {
      restoreSafeLiveConfigUnlocked_();
    } catch (restoreError) {
      throw new Error('LIVE Config arm failed: ' + String(armError.message || armError) +
        ' SAFE RESTORATION ALSO FAILED: ' + String(restoreError.message || restoreError));
    }
    throw new Error('LIVE Config arm failed closed and SAFE state was restored: ' + String(armError.message || armError));
  } finally {
    lock.releaseLock();
  }
}

/** Public operator-safe restoration. Does not touch Gmail, Ledger or Prospects. */
function restoreSafeLiveConfig() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('SAFE Config restoration blocked: script lock busy.');
  try {
    return restoreSafeLiveConfigUnlocked_();
  } catch (e) {
    throw new Error('SAFE Config restoration FAILED: ' + String(e.message || e));
  } finally {
    lock.releaseLock();
  }
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

/**
 * F0/N5 (Codex final audit, round 2 — documentation correction): a SAFE,
 * READ-ONLY way to check whether LIVE is currently allowed, WITHOUT ever
 * attempting to send, WITHOUT touching Gmail, and WITHOUT changing
 * DRY_RUN. Calls the EXACT SAME getPendingF0Keys_() that
 * assertLiveAllowed_ (I21) itself uses — this can never drift out of sync
 * with what actually gates a real send, because it is not a parallel
 * re-implementation.
 *
 * Prior drafts of this project's own documentation incorrectly claimed
 * that running Preview ("Preview today's queue" etc.) could be used to
 * verify F0 configuration status — false: previewStep()/previewQueue()
 * NEVER call assertLiveAllowed_ at all (Preview is safe by construction
 * and simply does not need the F0 gate — see Mailer.gs's SAFETY MODEL
 * docstring at the top of the file). This function is the actually-
 * correct way to check F0 status before ever flipping DRY_RUN — exposed
 * via the "Check LIVE readiness (F0)" menu item (Menu.gs).
 */
function checkLiveReadiness() {
  var config = getConfig();
  var pending = getPendingF0Keys_();
  return {
    dryRun: config.DRY_RUN === true,
    pendingF0Keys: pending,
    liveConfigResolved: pending.length === 0
  };
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
