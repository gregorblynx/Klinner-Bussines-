/**
 * Klinner Outreach — SheetRepo.gs
 * All spreadsheet access goes through this file. It owns:
 *   - sheet creation / initialization (F1)
 *   - reading Prospects
 *   - the ORIGIN-gated write path for Prospects (PATCH FINAL V1.1, Patch 1)
 *
 * PATCH 1 — the rule this file enforces at runtime, not just by convention:
 *   origin = PIPELINE + DRY_RUN = TRUE  ->  write REJECTED, zero exceptions.
 *   origin = ADMIN or SYSTEM            ->  never blocked by DRY_RUN.
 * Every write additionally validates against OPERATION_PERMISSIONS
 * (allowed columns + allowed Status values) — a bug in Mailer.gs cannot
 * bypass this by mislabeling its origin, because the operation's column
 * allow-list is checked independently of who called it.
 */

function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name) {
  var sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name + '. Run "Initialize Klinner Outreach sheets" first.');
  return sheet;
}

function getOrCreateSheet_(name) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

/**
 * Creates/initializes all 7 sheets. Idempotent: never clears a sheet that
 * already has the expected header row, so re-running never destroys data.
 */
function initializeSheets() {
  initializeProspectsSheet_();
  initializeConfigSheet_();
  initializeTemplatesSheet_();
  initializeSendLedgerSheet_();
  initializeLogSheet_();
  initializeSuppressionSheet_();
  initializeDashboardSheet_();
  return 'Klinner Outreach sheets initialized.';
}

function sheetHasExpectedHeader_(sheet, expectedFirstCell) {
  if (sheet.getLastRow() < 1) return false;
  var firstCell = sheet.getRange(1, 1).getValue();
  return firstCell === expectedFirstCell;
}

function initializeProspectsSheet_() {
  var sheet = getOrCreateSheet_(SHEET_NAMES.PROSPECTS);
  if (sheetHasExpectedHeader_(sheet, 'Prospect_ID')) {
    applyProspectsValidationsAndProtection_(sheet);
    return sheet;
  }
  sheet.clear();
  sheet.getRange(1, 1, 1, PROSPECTS_HEADER_ROW.length).setValues([PROSPECTS_HEADER_ROW]);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(6); // A:F
  applyProspectsValidationsAndProtection_(sheet);
  return sheet;
}

function applyProspectsValidationsAndProtection_(sheet) {
  var maxRows = Math.max(sheet.getMaxRows(), 1000);
  if (sheet.getMaxRows() < maxRows) sheet.insertRowsAfter(sheet.getMaxRows(), maxRows - sheet.getMaxRows());

  // O: Stop_Contact checkbox
  var stopContactRange = sheet.getRange(2, PROSPECTS_COLUMNS.Stop_Contact, maxRows - 1, 1);
  stopContactRange.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());

  // P: Do_Not_Contact_Reason dropdown (blank allowed)
  var dncRange = sheet.getRange(2, PROSPECTS_COLUMNS.Do_Not_Contact_Reason, maxRows - 1, 1);
  dncRange.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(DNC_REASON_VALUES, true)
      .setAllowInvalid(false)
      .build()
  );

  // R: Outcome dropdown (blank allowed)
  var outcomeRange = sheet.getRange(2, PROSPECTS_COLUMNS.Outcome, maxRows - 1, 1);
  outcomeRange.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(OUTCOME_VALUES, true)
      .setAllowInvalid(false)
      .build()
  );

  // Protected range S:AG — system-owned columns.
  var protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  var alreadyProtected = false;
  for (var i = 0; i < protections.length; i++) {
    if (protections[i].getDescription() === 'Klinner Outreach — system-owned columns') {
      alreadyProtected = true;
      break;
    }
  }
  if (!alreadyProtected) {
    var protectedRange = sheet.getRange(
      2, PROSPECTS_PROTECTED_RANGE_START_COL, maxRows - 1,
      PROSPECTS_PROTECTED_RANGE_END_COL - PROSPECTS_PROTECTED_RANGE_START_COL + 1
    );
    var protection = protectedRange.protect().setDescription('Klinner Outreach — system-owned columns');
    applyProtectionEditorPolicy_(protection);
  }
}

/**
 * Codex finding #12: the previous version called
 * protection.removeEditors(protection.getEditors()) in one shot. Two real
 * risks with that, neither provable against a mock:
 *   1. Real Protection.removeEditors() can throw when an editor's access is
 *      derived from a Google Group / domain-wide share rather than an
 *      individually-added editor — one bad entry would abort the whole
 *      call and could leave initializeSheets() crashing on a shared sheet.
 *   2. Blindly stripping every editor, including the person/script
 *      currently running the installer, risks locking out the very
 *      account doing the setup.
 * Fix: resolve the actual effective user via Session.getEffectiveUser()
 * (the real API for "who is running this"), always keep them as an
 * editor, and remove the rest ONE AT A TIME inside their own try/catch so
 * a single Group-derived entry can't abort the others or the whole
 * initialization. Never lets a protection-setup problem propagate out of
 * initializeSheets() — it logs and moves on instead.
 *
 * NOTE: this is exactly the kind of thing "don't trust the mock" applies
 * to — Group-derived editor removal semantics cannot be verified without
 * a real Workspace-shared Sheet. Flagged explicitly in the delivery report
 * as needing Google-real verification.
 */
function applyProtectionEditorPolicy_(protection) {
  try {
    var effectiveUser = null;
    try { effectiveUser = Session.getEffectiveUser(); } catch (e) { effectiveUser = null; }
    var effectiveEmail = (effectiveUser && effectiveUser.getEmail) ? effectiveUser.getEmail() : '';

    var currentEditors = protection.getEditors();
    for (var i = 0; i < currentEditors.length; i++) {
      var editor = currentEditors[i];
      var editorEmail = editor && editor.getEmail ? editor.getEmail() : '';
      if (effectiveEmail && editorEmail === effectiveEmail) continue; // never remove the account running this.
      try {
        protection.removeEditor(editor);
      } catch (removeError) {
        // Expected for Group/domain-derived access on a real Workspace
        // sheet — not fatal, just means that editor keeps access.
        logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, '', '', '',
          'applyProtectionEditorPolicy_: could not remove editor "' + editorEmail + '" from protected range (likely Group/domain-derived access): ' + removeError);
      }
    }

    if (effectiveEmail) {
      try { protection.addEditor(effectiveEmail); } catch (e) { /* already an editor, or not addable — non-fatal */ }
    }
    try { if (protection.canDomainEdit()) protection.setDomainEdit(false); } catch (e) { /* not on a Workspace domain */ }
  } catch (e) {
    logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, '', '', '',
      'applyProtectionEditorPolicy_: protection setup encountered an issue and was left partially applied (sheets/validations are unaffected): ' + e);
  }
}

function initializeTemplatesSheet_() {
  var sheet = getOrCreateSheet_(SHEET_NAMES.TEMPLATES);
  if (sheetHasExpectedHeader_(sheet, 'Step')) return sheet;
  sheet.clear();
  sheet.getRange(1, 1, 1, 5).setValues([['Step', 'Subject', 'Body', 'Active', 'Internal_Note']]);
  sheet.setFrozenRows(1);
  var seed = getSeedTemplates_();
  sheet.getRange(2, 1, seed.length, 5).setValues(seed);
  return sheet;
}

function initializeSendLedgerSheet_() {
  var sheet = getOrCreateSheet_(SHEET_NAMES.SEND_LEDGER);
  if (sheetHasExpectedHeader_(sheet, 'Run_ID')) return sheet;
  sheet.clear();
  sheet.getRange(1, 1, 1, SEND_LEDGER_COLUMN_ORDER.length).setValues([SEND_LEDGER_COLUMN_ORDER]);
  sheet.setFrozenRows(1);
  return sheet;
}

/**
 * N3 V2 migration for a real SendLedger sheet that was already initialized
 * BEFORE Draft_Fingerprint/Human_Edit_Preserved/Human_Edit_Detected_At
 * (Constants.gs columns 14-16) existed. Because those columns were
 * APPENDED at the end of the layout (never inserted), the fix is purely
 * additive: write the 3 missing header cells into N1:P1. Existing data
 * rows need no migration at all — Sheets already treats any cell past a
 * row's last written column as blank, which is exactly the correct value
 * for every pre-existing row (they have no fingerprint/durable-preserve
 * state yet; appendLedgerRow_/updateLedgerRow_ from this point forward
 * populate those columns normally for new/changed rows).
 *
 * initializeSendLedgerSheet_() cannot do this itself: it intentionally
 * early-returns once a SendLedger sheet exists (by design — it must never
 * clear or reorder real ledger history), so it will never re-apply a
 * header change to an existing sheet on its own.
 *
 * Guarantees:
 *   - Only ever writes to row 1, columns 14-16 (N1:P1) — never touches
 *     columns A-M or any data row.
 *   - Never calls clear/clearContent/clearFormat.
 *   - Idempotent — if N1 already reads 'Draft_Fingerprint', this is a
 *     no-op; re-running it after it already ran changes nothing further.
 * Run manually (once, on the real Sheet) from the Apps Script editor — not
 * wired into a trigger or the menu, since it is a one-time repair for a
 * ledger initialized before this fix existed, not a routine operation.
 * NOT executed against Google as part of this delivery — see README.md.
 */
function repairSendLedgerColumns_() {
  var sheet = getSheet_(SHEET_NAMES.SEND_LEDGER);
  var newColumnNames = ['Draft_Fingerprint', 'Human_Edit_Preserved', 'Human_Edit_Detected_At'];
  var startCol = SEND_LEDGER_COLUMNS.Draft_Fingerprint; // 14
  if (sheet.getRange(1, startCol).getValue() === newColumnNames[0]) {
    return 'SendLedger already has Draft_Fingerprint/Human_Edit_Preserved/Human_Edit_Detected_At headers — nothing to repair.';
  }
  sheet.getRange(1, startCol, 1, newColumnNames.length).setValues([newColumnNames]);
  return 'Added SendLedger headers N1:P1 (Draft_Fingerprint, Human_Edit_Preserved, Human_Edit_Detected_At). ' +
    'No existing row or column A-M was changed.';
}

/**
 * Temporary public wrapper, no parameters, matching the same pattern as
 * repairConfigValueColumnFormat() in Config.gs — see that function's
 * docstring for why the trailing-underscore name alone was not reliably
 * selectable from the Apps Script editor's "Select function to run"
 * dropdown. Delegates entirely to repairSendLedgerColumns_() — zero logic
 * duplicated, zero behavior change.
 */
function repairSendLedgerColumns() {
  return repairSendLedgerColumns_();
}

function initializeLogSheet_() {
  var sheet = getOrCreateSheet_(SHEET_NAMES.LOG);
  if (sheetHasExpectedHeader_(sheet, 'Timestamp')) return sheet;
  sheet.clear();
  sheet.getRange(1, 1, 1, LOG_COLUMN_ORDER.length).setValues([LOG_COLUMN_ORDER]);
  sheet.setFrozenRows(1);
  return sheet;
}

function initializeSuppressionSheet_() {
  var sheet = getOrCreateSheet_(SHEET_NAMES.SUPPRESSION);
  if (sheetHasExpectedHeader_(sheet, 'Value')) return sheet;
  sheet.clear();
  sheet.getRange(1, 1, 1, 5).setValues([['Value', 'Scope', 'Reason', 'Date_Added', 'Added_By']]);
  sheet.setFrozenRows(1);
  return sheet;
}

function initializeDashboardSheet_() {
  var sheet = getOrCreateSheet_(SHEET_NAMES.DASHBOARD);
  if (sheetHasExpectedHeader_(sheet, 'Klinner Outreach — Dashboard')) return sheet;
  sheet.clear();
  var p = "'" + SHEET_NAMES.PROSPECTS + "'!S:S";
  var ledger = "'" + SHEET_NAMES.SEND_LEDGER + "'";
  var rows = [
    ['Klinner Outreach — Dashboard', ''],
    ['', ''],
    ['Metric', 'Value'],
    ['READY', '=COUNTIF(' + p + ',"READY")'],
    ['NEEDS_DATA', '=COUNTIF(' + p + ',"NEEDS_DATA")'],
    ['INVALID_EMAIL', '=COUNTIF(' + p + ',"INVALID_EMAIL")'],
    ['DUPLICATE', '=COUNTIF(' + p + ',"DUPLICATE")'],
    ['IN_SEQUENCE', '=COUNTIF(' + p + ',"IN_SEQUENCE")'],
    ['SEQUENCE_DONE', '=COUNTIF(' + p + ',"SEQUENCE_DONE")'],
    ['REPLIED', '=COUNTIF(' + p + ',"REPLIED")'],
    ['BOUNCED', '=COUNTIF(' + p + ',"BOUNCED")'],
    ['STOPPED', '=COUNTIF(' + p + ',"STOPPED")'],
    ['NEEDS_REVIEW', '=COUNTIF(' + p + ',"NEEDS_REVIEW")'],
    ['Total prospects', "=COUNTA('" + SHEET_NAMES.PROSPECTS + "'!A2:A)"],
    ['LIVE sends (ledger SENT rows, all-time)', '=COUNTIFS(' + ledger + '!G:G,"LIVE",' + ledger + '!H:H,"SENT")'],
    ['Preview drafts (ledger DRAFTED rows, all-time)', '=COUNTIFS(' + ledger + '!G:G,"DRY_RUN",' + ledger + '!H:H,"DRAFTED")']
  ];
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.setFrozenRows(3);
  return sheet;
}

function getSeedTemplates_() {
  var note1 = 'Step 1 — the specific problem found. No pitch. One question.';
  var note2 = 'Step 2 — short bump in the same thread, +3 business days.';
  var note3 = 'Step 3 — different angle: result, similar case, or a second issue. +7 business days.';
  var note4 = 'Step 4 — breakup. No pressure, door left open. +7 business days.';

  var body1 = 'Hi {{Contact_Name|there}},\n\n' +
    "I was looking at {{Business_Name}}'s online presence in {{City}}, {{State}} and noticed {{Problem_Found}}.\n\n" +
    '{{Personalization_Line|}}\n\n' +
    'Would it be worth a quick look?\n\n' +
    'Best,\n{{Sender_Name}}\n\n' +
    '{{Physical_Address}}\n{{Unsubscribe_Line}}';

  var body2 = 'Hi {{Contact_Name|there}},\n\n' +
    'Following up on my note about {{Business_Name}} — happy to send over what I found if useful.\n\n' +
    'Best,\n{{Sender_Name}}\n\n' +
    '{{Physical_Address}}\n{{Unsubscribe_Line}}';

  var body3 = 'Hi {{Contact_Name|there}},\n\n' +
    "One more thing I noticed for {{Business_Name}} — {{Problem_Found}}. Happy to share how we've helped " +
    'similar businesses in {{City}} with this.\n\n' +
    'Best,\n{{Sender_Name}}\n\n' +
    '{{Physical_Address}}\n{{Unsubscribe_Line}}';

  var body4 = "Hi {{Contact_Name|there}},\n\nI'll leave it here for now — if it's not a priority, no worries at all. " +
    "Feel free to reach out if that changes.\n\nBest,\n{{Sender_Name}}\n\n{{Physical_Address}}\n{{Unsubscribe_Line}}";

  return [
    [1, 'A quick note about {{Business_Name}}', body1, true, note1],
    [2, '', body2, true, note2],
    [3, '', body3, true, note3],
    [4, '', body4, true, note4]
  ];
}

/**
 * Reads the entire Prospects sheet into memory as an array of row objects:
 * { rowIndex, values: { Prospect_ID: ..., Business_Name: ..., ... } }
 * rowIndex is the 1-indexed sheet row (includes header offset).
 */
function readAllProspects() {
  var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var data = sheet.getRange(2, 1, lastRow - 1, PROSPECTS_LAST_COL).getValues();
  var rows = [];
  for (var i = 0; i < data.length; i++) {
    var raw = data[i];
    if (!isProspectRowSubstantive_(raw)) continue;
    rows.push({ rowIndex: i + 2, values: rowArrayToObject_(raw) });
  }
  return rows;
}

/**
 * Google-real finding: a naive "every cell is '' or null" blank-check is
 * wrong on a real Sheet. initializeProspectsSheet_ applies checkbox data
 * validation to Stop_Contact (O) across all 999 provisioned data rows
 * (2:1000) up front — and real Google Sheets auto-populates a literal
 * FALSE into every checkbox-validated cell that was previously blank,
 * including rows no human ever touched. That FALSE is real, stored
 * content: it makes sheet.getLastRow() report 1000, and it made every one
 * of those 999 rows look "non-blank" to the old check — Validate all rows
 * then dutifully assigned a Prospect_ID/Date_Added/Status=NEEDS_DATA to
 * 994 template rows that were never real prospects (confirmed on the real
 * "Klinner Outreach — F1 Test" Sheet).
 *
 * The fix: "is this a real prospect row" must be judged ONLY by whether a
 * human actually typed something into one of the columns a human types
 * into (PROSPECT_SUBSTANTIVE_INPUT_COLUMNS — Constants.gs), OR the row
 * already has a Prospect_ID (a previously-processed row must never
 * silently disappear even if, for some reason, its input columns were
 * later cleared). Stop_Contact/Outcome/other checkbox-or-dropdown-backed
 * control columns are never part of this check.
 *
 * A partially-filled row (e.g. Business_Name present, Email still blank)
 * still counts as substantive and is still returned — it is expected to
 * end up NEEDS_DATA, not be silently skipped (explicit requirement).
 */
function isProspectRowSubstantive_(raw) {
  if (raw[PROSPECTS_COLUMNS.Prospect_ID - 1]) return true;
  for (var i = 0; i < PROSPECT_SUBSTANTIVE_INPUT_COLUMNS.length; i++) {
    var col = PROSPECTS_COLUMNS[PROSPECT_SUBSTANTIVE_INPUT_COLUMNS[i]];
    var v = raw[col - 1];
    if (v !== '' && v !== null && v !== undefined && String(v).trim() !== '') return true;
  }
  return false;
}

function rowArrayToObject_(raw) {
  var obj = {};
  for (var i = 0; i < PROSPECTS_COLUMN_ORDER.length; i++) {
    obj[PROSPECTS_COLUMN_ORDER[i]] = raw[i];
  }
  return obj;
}

/**
 * Finds one prospect row by Prospect_ID via a fresh column-A scan
 * (never trusts a cached row index across a run — I7).
 * Returns { rowIndex, values } or null.
 */
function findRowById_(prospectId) {
  if (!prospectId) return null;
  var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var ids = sheet.getRange(2, PROSPECTS_COLUMNS.Prospect_ID, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === prospectId) {
      var rowIndex = i + 2;
      var raw = sheet.getRange(rowIndex, 1, 1, PROSPECTS_LAST_COL).getValues()[0];
      return { rowIndex: rowIndex, values: rowArrayToObject_(raw) };
    }
  }
  return null;
}

/**
 * THE single authorized boundary for every business write to Prospects.
 *
 * Codex audit finding #1: a previous version exposed applyFieldsToRow_()
 * as an ordinary top-level function, which meant ANY code anywhere in the
 * project could call it directly and skip origin/operation/column/status/
 * restrictedValues/DRY_RUN checks entirely — the guard model was only a
 * convention, not a structural barrier. Apps Script has no per-file
 * privacy, but plain JS closures work fine across concatenated .gs files
 * (they all share one global scope at runtime): this IIFE keeps the raw
 * row-setter (`applyFieldsToRow_`) as a variable inside its own function
 * scope. It is not assigned to `this`/the global object anywhere, so no
 * other file — not even one deliberately trying to bypass validation —
 * can reach it. Only `writeRowById_` and `assignNewProspectIdAndFields_`,
 * assigned to the pre-declared globals below, are reachable from outside.
 * Tests.gs's finding-1 tests assert `typeof applyFieldsToRow_ ===
 * 'undefined'` in the global scope as a structural proof of this.
 */
var writeRowById_, assignNewProspectIdAndFields_;

(function () {
  /** Raw setter. Deliberately NOT a global — see the boundary comment above. */
  function applyFieldsToRow_(rowIndex, fields) {
    var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
    for (var name in fields) {
      if (!fields.hasOwnProperty(name)) continue;
      var col = PROSPECTS_COLUMNS[name];
      if (!col) throw new Error('Unknown Prospects column: ' + name);
      sheet.getRange(rowIndex, col).setValue(fields[name]);
    }
  }

  /**
   * Shared authorization check used by BOTH entry points below, so a fix
   * to one (e.g. restrictedValues enforcement, Codex finding #2) can never
   * silently apply to only one of the two write paths.
   * Throws on any violation except the DRY_RUN/PIPELINE case, which is
   * reported back to the caller instead (existing, intentional behavior —
   * see writeRowById_'s docstring).
   * @return {{blockedByDryRun: boolean}}
   */
  function authorizeWrite_(fields, options) {
    if (!options || !options.origin || !options.operation) {
      throw new Error('Prospects write requires { origin, operation }. Anonymous writes are not allowed.');
    }
    var origin = options.origin;
    var operation = options.operation;

    if (OPERATION_ORIGIN[operation] !== origin) {
      throw new Error('Origin/operation mismatch: operation "' + operation + '" does not belong to origin "' + origin + '".');
    }

    var permissions = OPERATION_PERMISSIONS[operation];
    if (!permissions) throw new Error('Unknown operation: ' + operation);

    // --- I14 / PATCH 1: PIPELINE writes are rejected outright while DRY_RUN=TRUE.
    if (origin === ORIGIN.PIPELINE && getConfig().DRY_RUN === true) {
      return { blockedByDryRun: true, permissions: permissions };
    }

    // --- Column allow-list enforcement, independent of caller intent.
    var fieldNames = Object.keys(fields);
    for (var i = 0; i < fieldNames.length; i++) {
      if (permissions.columns.indexOf(fieldNames[i]) === -1) {
        throw new Error('Operation "' + operation + '" is not permitted to write column "' + fieldNames[i] + '".');
      }
    }

    // --- Status value allow-list.
    if (fields.hasOwnProperty('Status') && permissions.statuses.indexOf(fields.Status) === -1) {
      throw new Error('Operation "' + operation + '" is not permitted to set Status="' + fields.Status + '".');
    }

    // --- Restricted-value fields (e.g. ADMIN_VALIDATE may ONLY ever set
    // Do_Not_Contact_Reason to "duplicate" — never "unsubscribe", which
    // must go through the dedicated unsubscribe procedure — Codex #2).
    if (permissions.restrictedValues) {
      for (var col in permissions.restrictedValues) {
        if (fields.hasOwnProperty(col) && fields[col] !== '' &&
            permissions.restrictedValues[col].indexOf(fields[col]) === -1) {
          throw new Error('Operation "' + operation + '" is not permitted to set ' + col + '="' + fields[col] + '".');
        }
      }
    }

    return { blockedByDryRun: false, permissions: permissions };
  }

  /**
   * @param {string} prospectId
   * @param {Object} fields  Partial map of column-name -> new value.
   * @param {Object} options { origin: ORIGIN.*, operation: OPERATION.* }
   * @return {{success: boolean, reason: (string|undefined)}}
   */
  writeRowById_ = function (prospectId, fields, options) {
    var auth = authorizeWrite_(fields, options);
    if (auth.blockedByDryRun) {
      logEvent_(LOG_LEVEL.WARN, LOG_EVENT.WRITE_REFUSED_DRY_RUN, prospectId, '', '',
        'Rejected PIPELINE write to Prospects while DRY_RUN=TRUE. Fields attempted: ' + Object.keys(fields).join(','));
      return { success: false, reason: 'WRITE_REFUSED_DRY_RUN' };
    }

    // --- I7: locate the row fresh by Prospect_ID; verify identity before writing.
    var found = findRowById_(prospectId);
    if (!found) throw new Error('writeRowById_: Prospect_ID not found: ' + prospectId);
    if (found.values.Prospect_ID !== prospectId) {
      throw new Error('writeRowById_: row identity mismatch for ' + prospectId + ' (I7 guard tripped).');
    }

    applyFieldsToRow_(found.rowIndex, fields);
    return { success: true };
  };

  /**
   * Assigns a brand-new Prospect_ID (+ any other permitted fields) to a row
   * that does not have one yet. Used ONLY by "Validate all rows" for rows
   * freshly pasted by the operator. Never overwrites an existing ID — that
   * would defeat I7 for every subsequent write to this prospect.
   *
   * @param {number} rowIndex 1-indexed sheet row, from a readAllProspects()
   *                 result taken in this same synchronous operation.
   * @param {Object} fields Must include Prospect_ID.
   * @param {Object} options { origin, operation } — same authorizeWrite_ as writeRowById_.
   */
  assignNewProspectIdAndFields_ = function (rowIndex, fields, options) {
    if (!fields.Prospect_ID) throw new Error('assignNewProspectIdAndFields_ requires fields.Prospect_ID.');
    var auth = authorizeWrite_(fields, options);
    if (auth.blockedByDryRun) {
      logEvent_(LOG_LEVEL.WARN, LOG_EVENT.WRITE_REFUSED_DRY_RUN, fields.Prospect_ID, '', '',
        'Rejected PIPELINE identity-assignment write while DRY_RUN=TRUE.');
      return { success: false, reason: 'WRITE_REFUSED_DRY_RUN' };
    }

    var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
    var existingId = sheet.getRange(rowIndex, PROSPECTS_COLUMNS.Prospect_ID).getValue();
    if (existingId) {
      throw new Error('assignNewProspectIdAndFields_: row ' + rowIndex + ' already has Prospect_ID "' + existingId +
        '". Use writeRowById_ instead.');
    }

    applyFieldsToRow_(rowIndex, fields);
    return { success: true };
  };
})();

/** Read-only convenience: current Config-driven DRY_RUN flag. */
function isDryRun_() {
  return getConfig().DRY_RUN === true;
}
