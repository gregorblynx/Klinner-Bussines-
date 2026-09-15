/**
 * Klinner Outreach — Menu.gs
 * Builds the "Klinner Outreach" custom menu and wraps every action in a
 * try/catch that surfaces errors to the operator via SpreadsheetApp UI
 * alerts (never a silent failure). All destructive actions confirm first.
 */

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Klinner Outreach')
    .addItem('Initialize Klinner Outreach sheets', 'menu_initializeSheets_')
    .addSeparator()
    .addItem('Validate all rows', 'menu_validateAllRows_')
    .addItem('Preview today\'s queue', 'menu_previewQueue_')
    .addItem('Preview full sequence for selected row', 'menu_previewFullSequence_')
    .addItem('Delete Klinner preview drafts', 'menu_deletePreviewDrafts_')
    .addSeparator()
    .addItem('Check LIVE readiness (F0)', 'menu_checkLiveReadiness_')
    .addItem('Arm one-shot LIVE config…', 'menu_armLiveConfig_')
    .addItem('Restore SAFE config', 'menu_restoreSafeLiveConfig_')
    .addItem('Send now (LIVE)', 'menu_sendNowLive_')
    .addItem('Send selected CONTROLLED fixture (LIVE)', 'menu_sendControlledFixtureLive_')
    .addItem('Make selected CONTROLLED fixture due now', 'menu_makeControlledFixtureDueNow_')
    .addItem('Send selected CONTROLLED fixture Step 2 (LIVE)', 'menu_sendControlledFixtureStep2Live_')
    .addItem('Recover selected CONTROLLED Step 2 pre-send failure', 'menu_recoverControlledFixtureStep2PreSendFailure_')
    .addItem('Sync replies now', 'menu_syncRepliesNow_')
    .addSeparator()
    .addItem('Stop prospect (selected row)', 'menu_stopProspect_')
    .addItem('Process unsubscribe for selected row', 'menu_processUnsubscribe_')
    .addItem('Reset prospect (selected row)', 'menu_resetProspect_')
    .addSeparator()
    .addItem('Install / repair triggers', 'menu_installTriggers_')
    .addToUi();
}

function guardedMenuAction_(fn) {
  var ui = SpreadsheetApp.getUi();
  try {
    return fn(ui);
  } catch (e) {
    ui.alert('Klinner Outreach — Error', String(e.message || e), ui.ButtonSet.OK);
  }
}

/** Reads the Prospect_ID from column A of the currently active row on the Prospects sheet. */
function getSelectedProspectId_(ui) {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== SHEET_NAMES.PROSPECTS) {
    throw new Error('Select a row on the "' + SHEET_NAMES.PROSPECTS + '" sheet first.');
  }
  var activeRow = sheet.getActiveCell().getRow();
  if (activeRow < 2) throw new Error('Select a prospect data row (not the header).');
  var prospectId = sheet.getRange(activeRow, PROSPECTS_COLUMNS.Prospect_ID).getValue();
  if (!prospectId) throw new Error('This row has no Prospect_ID yet — run "Validate all rows" first.');
  return prospectId;
}

function menu_initializeSheets_() {
  guardedMenuAction_(function (ui) {
    initializeSheets();
    ui.alert('Klinner Outreach', 'Sheets initialized.', ui.ButtonSet.OK);
  });
}

function menu_validateAllRows_() {
  guardedMenuAction_(function (ui) {
    var r = validateAllRows();
    ui.alert('Validate all rows',
      'Processed: ' + r.processed + '\nREADY: ' + r.ready + '\nNEEDS_DATA: ' + r.needsData +
      '\nINVALID_EMAIL: ' + r.invalidEmail + '\nDUPLICATE: ' + r.duplicate + '\nSkipped (already classified): ' + r.skipped,
      ui.ButtonSet.OK);
  });
}

function menu_previewQueue_() {
  guardedMenuAction_(function (ui) {
    var r = previewQueue();
    ui.alert('Preview today\'s queue',
      'Drafted: ' + r.drafted + '\nSkipped (needs data): ' + (r.skippedNeedsData || 0) +
      '\nSkipped (not eligible): ' + (r.skippedNotEligible || 0), ui.ButtonSet.OK);
  });
}

function menu_previewFullSequence_() {
  guardedMenuAction_(function (ui) {
    var prospectId = getSelectedProspectId_(ui);
    var outcomes = previewFullSequenceForSelectedRow(prospectId);
    var summary = outcomes.map(function (o) { return 'Step ' + o.step + ': ' + o.outcome.status; }).join('\n');
    ui.alert('Preview full sequence', summary, ui.ButtonSet.OK);
  });
}

function menu_deletePreviewDrafts_() {
  guardedMenuAction_(function (ui) {
    var r = deleteKlinnerPreviewDrafts();
    ui.alert('Delete Klinner preview drafts', 'Deleted: ' + r.deleted, ui.ButtonSet.OK);
  });
}

/**
 * F0/N5: read-only — never sends, never touches Gmail, never changes
 * DRY_RUN. The correct way to check F0 status (see checkLiveReadiness_'s
 * docstring in Config.gs for why Preview cannot be used for this).
 */
function menu_checkLiveReadiness_() {
  guardedMenuAction_(function (ui) {
    var r = checkLiveReadiness();
    var lines = ['DRY_RUN: ' + (r.dryRun ? 'TRUE (safe — LIVE sending is disabled regardless of F0 status)' : 'FALSE')];
    if (r.liveConfigResolved) {
      lines.push('F0 config: all 5 required keys resolved.');
    } else {
      lines.push('F0 config: ' + r.pendingF0Keys.length + ' key(s) still PENDING_F0: ' + r.pendingF0Keys.join(', '));
    }
    ui.alert('Check LIVE readiness (F0)', lines.join('\n'), ui.ButtonSet.OK);
  });
}

/** Exact, programmatic LIVE arming. This changes Config only and never sends. */
function menu_armLiveConfig_() {
  guardedMenuAction_(function (ui) {
    var response = ui.prompt('Arm one-shot LIVE config',
      'Approved MAX_PER_DAY (positive integer). This does NOT send email:', ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    var raw = response.getResponseText().trim();
    if (!/^[1-9][0-9]*$/.test(raw)) {
      throw new Error('MAX_PER_DAY must be a positive integer with no extra characters.');
    }
    var cap = Number(raw);
    var confirm = ui.alert('Confirm LIVE Config arm',
      'Config only — no email will be sent by this action.\n\n' +
      'DRY_RUN=FALSE\nPAUSE_ALL=FALSE\nMAX_PER_DAY=' + cap + '\nMAX_PER_RUN=1\n\nContinue?',
      ui.ButtonSet.YES_NO);
    if (confirm !== ui.Button.YES) return;
    var state = armLiveConfig(cap);
    ui.alert('LIVE Config armed',
      'Exact read-back verified:\nDRY_RUN=' + state.DRY_RUN + '\nPAUSE_ALL=' + state.PAUSE_ALL +
      '\nMAX_PER_DAY=' + state.MAX_PER_DAY + '\nMAX_PER_RUN=' + state.MAX_PER_RUN,
      ui.ButtonSet.OK);
  });
}

/** Exact, programmatic SAFE restoration. PAUSE_ALL is restored first. */
function menu_restoreSafeLiveConfig_() {
  guardedMenuAction_(function (ui) {
    var state = restoreSafeLiveConfig();
    ui.alert('SAFE Config restored',
      'Exact read-back verified:\nDRY_RUN=' + state.DRY_RUN + '\nPAUSE_ALL=' + state.PAUSE_ALL +
      '\nMAX_PER_DAY=' + state.MAX_PER_DAY + '\nMAX_PER_RUN=' + state.MAX_PER_RUN,
      ui.ButtonSet.OK);
  });
}

function menu_sendNowLive_() {
  guardedMenuAction_(function (ui) {
    var response = ui.alert('Send now (LIVE)',
      'This will send REAL emails via sendBatch() using the current LIVE quota and window rules. Continue?',
      ui.ButtonSet.YES_NO);
    if (response !== ui.Button.YES) return;
    sendBatch();
    ui.alert('Klinner Outreach', 'sendBatch() finished. Check the Log sheet for details.', ui.ButtonSet.OK);
  });
}

/**
 * Operator-only, exact-target LIVE send for ONE explicitly controlled test
 * fixture — never a real prospect (sendControlledFixtureLive enforces the
 * Source allowlist in Constants.gs before touching Gmail). Uses the
 * currently selected Prospects row, exactly like the other selected-row
 * actions below.
 */
function menu_sendControlledFixtureLive_() {
  guardedMenuAction_(function (ui) {
    var prospectId = getSelectedProspectId_(ui);
    var response = ui.alert('Send selected CONTROLLED fixture (LIVE)',
      'This sends ONE real email to the selected row, ONLY if its Source is an approved controlled-test ' +
      'fixture — real prospects are refused before any Gmail call. Prospect_ID: ' + prospectId + '\n\nContinue?',
      ui.ButtonSet.YES_NO);
    if (response !== ui.Button.YES) return;
    var result = sendControlledFixtureLive(prospectId);
    ui.alert('Send selected CONTROLLED fixture (LIVE)', 'Result: ' + result.status, ui.ButtonSet.OK);
  });
}

/**
 * Operator-only: makes ONE explicitly controlled test fixture due for
 * Step 2 immediately, for a Google-real retest. Real prospects are
 * refused before any write (makeControlledFixtureDueNow enforces the
 * same Source allowlist as the LIVE-targeting action above). The ONLY
 * field this can ever change is Next_Action_Date.
 */
function menu_makeControlledFixtureDueNow_() {
  guardedMenuAction_(function (ui) {
    var prospectId = getSelectedProspectId_(ui);
    var response = ui.alert('Make selected CONTROLLED fixture due now',
      'This sets Next_Action_Date to now for the selected row, ONLY if its Source is an approved ' +
      'controlled-test fixture — real prospects are refused before any write. No other field changes. ' +
      'Prospect_ID: ' + prospectId + '\n\nContinue?',
      ui.ButtonSet.YES_NO);
    if (response !== ui.Button.YES) return;
    var result = makeControlledFixtureDueNow(prospectId);
    ui.alert('Make selected CONTROLLED fixture due now', 'Result: ' + result.status, ui.ButtonSet.OK);
  });
}

/**
 * Operator-only, exact-target LIVE Step 2 send for ONE explicitly
 * controlled test fixture — never a real prospect
 * (sendControlledFixtureStep2Live enforces the same Source allowlist as
 * the other controlled-fixture actions before touching Gmail).
 */
function menu_sendControlledFixtureStep2Live_() {
  guardedMenuAction_(function (ui) {
    var prospectId = getSelectedProspectId_(ui);
    var response = ui.alert('Send selected CONTROLLED fixture Step 2 (LIVE)',
      'This sends ONE real Step 2 follow-up to the selected row, ONLY if its Source is an approved ' +
      'controlled-test fixture — real prospects are refused before any Gmail call. Prospect_ID: ' + prospectId +
      '\n\nContinue?',
      ui.ButtonSet.YES_NO);
    if (response !== ui.Button.YES) return;
    var result = sendControlledFixtureStep2Live(prospectId);
    ui.alert('Send selected CONTROLLED fixture Step 2 (LIVE)', 'Result: ' + result.status, ui.ButtonSet.OK);
  });
}

/** One-fixture recovery for the documented userinfo.email pre-claim failure. */
function menu_recoverControlledFixtureStep2PreSendFailure_() {
  guardedMenuAction_(function (ui) {
    var prospectId = getSelectedProspectId_(ui);
    var response = ui.alert('Recover selected CONTROLLED Step 2 pre-send failure',
      'This can recover ONLY the exact approved controlled fixture when Step 2 has NO LIVE ledger history. ' +
      'It changes only Status from NEEDS_REVIEW to IN_SEQUENCE and never sends email. Prospect_ID: ' + prospectId +
      '\n\nContinue?', ui.ButtonSet.YES_NO);
    if (response !== ui.Button.YES) return;
    var result = recoverControlledFixtureStep2PreSendFailure(prospectId);
    ui.alert('Recover selected CONTROLLED Step 2 pre-send failure', 'Result: ' + result.status, ui.ButtonSet.OK);
  });
}

function menu_syncRepliesNow_() {
  guardedMenuAction_(function (ui) {
    syncReplies();
    ui.alert('Klinner Outreach', 'syncReplies() finished. Check the Log sheet for details.', ui.ButtonSet.OK);
  });
}

function menu_stopProspect_() {
  guardedMenuAction_(function (ui) {
    var prospectId = getSelectedProspectId_(ui);
    var response = ui.prompt('Stop prospect',
      'Reason (' + DNC_REASON_VALUES.join(', ') + '):', ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    var reason = response.getResponseText().trim();
    if (DNC_REASON_VALUES.indexOf(reason) === -1) {
      ui.alert('Invalid reason. Must be one of: ' + DNC_REASON_VALUES.join(', '));
      return;
    }
    stopProspect(prospectId, reason);
    ui.alert('Klinner Outreach', 'Prospect stopped.', ui.ButtonSet.OK);
  });
}

function menu_processUnsubscribe_() {
  guardedMenuAction_(function (ui) {
    var prospectId = getSelectedProspectId_(ui);
    var result = processUnsubscribeForSelectedRow(prospectId);
    ui.alert('Klinner Outreach', 'Unsubscribe processed. Suppression added: ' + result.suppressionAdded, ui.ButtonSet.OK);
  });
}

function menu_resetProspect_() {
  guardedMenuAction_(function (ui) {
    var prospectId = getSelectedProspectId_(ui);
    var response = ui.alert('Reset prospect',
      'This clears all send history for this prospect and returns it to READY. Continue?', ui.ButtonSet.YES_NO);
    if (response !== ui.Button.YES) return;
    var result = resetProspect(prospectId);
    if (!result.success) {
      ui.alert('Reset refused', result.message, ui.ButtonSet.OK);
    } else {
      ui.alert('Klinner Outreach', 'Prospect reset to READY.', ui.ButtonSet.OK);
    }
  });
}

function menu_installTriggers_() {
  guardedMenuAction_(function (ui) {
    var response = ui.alert('Install / repair triggers',
      'This installs the 4 Klinner Outreach triggers (sendBatch, syncReplies, nightlyRecon, dailyDigest). ' +
      'Any other trigger in this project is left untouched. Continue?', ui.ButtonSet.YES_NO);
    if (response !== ui.Button.YES) return;
    var result = installTriggers();
    ui.alert('Klinner Outreach', 'Installed: ' + result.installed.join(', '), ui.ButtonSet.OK);
  });
}
