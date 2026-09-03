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
    .addItem('Send now (LIVE)', 'menu_sendNowLive_')
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
