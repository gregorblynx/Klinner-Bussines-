/**
 * Klinner Outreach — Ledger.gs
 * SendLedger read/write. Implements the idempotency scoping rule from
 * PATCH FINAL V1.1 (Patch 1 / I13): uniqueness and the LIVE daily-quota
 * count are evaluated ONLY over Mode=LIVE rows. DRY_RUN rows are written
 * for traceability and draft-regeneration bookkeeping, but are invisible
 * to every LIVE guard.
 */

function getLedgerSheet_() {
  return getSheet_(SHEET_NAMES.SEND_LEDGER);
}

function getIdempotencyKey_(prospectId, step) {
  return prospectId + ':' + step;
}

function ledgerRowToObject_(raw) {
  var obj = {};
  for (var i = 0; i < SEND_LEDGER_COLUMN_ORDER.length; i++) obj[SEND_LEDGER_COLUMN_ORDER[i]] = raw[i];
  return obj;
}

/** Reads the full ledger into memory. Fine at F1/F2 volumes (tens/hundreds of rows). */
function readAllLedgerRows_() {
  var sheet = getLedgerSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var data = sheet.getRange(2, 1, lastRow - 1, SEND_LEDGER_COLUMN_ORDER.length).getValues();
  var rows = [];
  for (var i = 0; i < data.length; i++) {
    rows.push({ rowIndex: i + 2, values: ledgerRowToObject_(data[i]) });
  }
  return rows;
}

function appendLedgerRow_(entry) {
  var sheet = getLedgerSheet_();
  var row = SEND_LEDGER_COLUMN_ORDER.map(function (col) {
    return entry.hasOwnProperty(col) ? entry[col] : '';
  });
  sheet.appendRow(row);
  SpreadsheetApp.flush();
  return sheet.getLastRow();
}

function updateLedgerRow_(rowIndex, fields) {
  var sheet = getLedgerSheet_();
  for (var name in fields) {
    if (!fields.hasOwnProperty(name)) continue;
    var col = SEND_LEDGER_COLUMNS[name];
    if (!col) throw new Error('Unknown SendLedger column: ' + name);
    sheet.getRange(rowIndex, col).setValue(fields[name]);
  }
}

/**
 * I13: a step is "claimed or sent" for LIVE purposes ONLY if a Mode=LIVE
 * row exists with State CLAIMED or SENT for that idempotency key.
 * DRY_RUN rows never participate in this check.
 */
function isLiveKeyClaimedOrSent_(prospectId, step) {
  var key = getIdempotencyKey_(prospectId, step);
  var rows = readAllLedgerRows_();
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i].values;
    if (v.Idempotency_Key === key && v.Mode === LEDGER_MODE.LIVE &&
        (v.State === LEDGER_STATE.CLAIMED || v.State === LEDGER_STATE.SENT)) {
      return true;
    }
  }
  return false;
}

/** I10: LIVE sends already counted TODAY (script timezone), for the daily quota. */
function getDailyLiveSentCount_() {
  var today = formatDateYmd_(new Date());
  var rows = readAllLedgerRows_();
  var count = 0;
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i].values;
    if (v.Mode === LEDGER_MODE.LIVE && v.State === LEDGER_STATE.SENT && v.Confirmed_At) {
      if (formatDateYmd_(new Date(v.Confirmed_At)) === today) count++;
    }
  }
  return count;
}

/**
 * Finds the currently-live (non-superseded) DRY_RUN draft ledger row for
 * (prospectId, step), if any. Used by Mailer's draft-regeneration logic
 * (§6.4 — at most one live preview draft per prospect+step).
 */
function findActiveDryRunDraft_(prospectId, step) {
  var key = getIdempotencyKey_(prospectId, step);
  var rows = readAllLedgerRows_();
  for (var i = rows.length - 1; i >= 0; i--) {
    var v = rows[i].values;
    if (v.Idempotency_Key === key && v.Mode === LEDGER_MODE.DRY_RUN && v.State === LEDGER_STATE.DRAFTED) {
      return rows[i];
    }
  }
  return null;
}

function supersedeLedgerRow_(rowIndex) {
  updateLedgerRow_(rowIndex, { State: LEDGER_STATE.SUPERSEDED });
}

/**
 * F2 functionality — defined per the approved file list, NOT exercised or
 * activated during F1 (no LIVE claims exist yet; nothing calls this).
 * Finds CLAIMED (Mode=LIVE) rows older than CLAIM_STALE_MINUTES for
 * nightlyRecon's orphan-claim reconciliation.
 */
function findStaleLiveClaims_(config) {
  var staleMs = (config.CLAIM_STALE_MINUTES || 120) * 60 * 1000;
  var now = new Date().getTime();
  var rows = readAllLedgerRows_();
  return rows.filter(function (r) {
    var v = r.values;
    if (v.Mode !== LEDGER_MODE.LIVE || v.State !== LEDGER_STATE.CLAIMED) return false;
    var claimedAt = v.Claimed_At ? new Date(v.Claimed_At).getTime() : 0;
    return (now - claimedAt) >= staleMs;
  });
}
