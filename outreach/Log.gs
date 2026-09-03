/**
 * Klinner Outreach — Log.gs
 * Buffered operational log. Buffer is flushed with a single setValues()
 * call at the end of a run (flushLog_) and again in every finally block.
 * This is NOT the idempotency source of truth — that is SendLedger.
 */

var _logBuffer = [];
var _currentRunId = null;

function getRunId_() {
  if (!_currentRunId) _currentRunId = Utilities.getUuid();
  return _currentRunId;
}

function resetRunId_() {
  _currentRunId = null;
}

/**
 * Queues one log row. Never throws — logging must never break a run.
 * @param {string} level LOG_LEVEL.*
 * @param {string} event LOG_EVENT.*
 * @param {string} prospectId
 * @param {string} email
 * @param {string|number} step
 * @param {string} detail
 */
function logEvent_(level, event, prospectId, email, step, detail) {
  try {
    var config = getConfig();
    var mode = config.DRY_RUN ? LEDGER_MODE.DRY_RUN : LEDGER_MODE.LIVE;
    _logBuffer.push([
      new Date(),
      getRunId_(),
      mode,
      level,
      event,
      prospectId || '',
      email || '',
      step === undefined || step === null ? '' : step,
      detail || ''
    ]);
    // Mirrors to Cloud Logging (Executions panel) for live debugging.
    console.log('[' + level + '] ' + event + ' prospect=' + (prospectId || '-') +
      ' step=' + (step === undefined ? '-' : step) + ' :: ' + (detail || ''));
  } catch (e) {
    // Never let logging itself take down a run.
    console.error('logEvent_ failed: ' + e);
  }
}

/** Writes the buffered log rows to the Log sheet and clears the buffer. */
function flushLog_() {
  if (_logBuffer.length === 0) return;
  try {
    var sheet = getSheet_(SHEET_NAMES.LOG);
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, _logBuffer.length, LOG_COLUMN_ORDER.length).setValues(_logBuffer);
    _logBuffer = [];
  } catch (e) {
    console.error('flushLog_ failed: ' + e);
  }
}

/** Trims the Log sheet to the most recent LOG_MAX_ROWS rows. Called by nightlyRecon. */
function trimLog_() {
  var config = getConfig();
  var maxRows = config.LOG_MAX_ROWS || 5000;
  var sheet = getSheet_(SHEET_NAMES.LOG);
  var lastRow = sheet.getLastRow();
  var dataRows = lastRow - 1; // minus header
  if (dataRows <= maxRows) return;
  var excess = dataRows - maxRows;
  sheet.deleteRows(2, excess);
}
