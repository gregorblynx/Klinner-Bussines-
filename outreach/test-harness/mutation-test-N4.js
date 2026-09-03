'use strict';
/**
 * N4 mutation test: proves the restrictedValues guard added to
 * SYSTEM_REPLY_SYNC/SYSTEM_NIGHTLY_RECON (Constants.gs) is load-bearing —
 * removing either one must let that operation set
 * Do_Not_Contact_Reason="unsubscribe" without the Suppression guarantee,
 * and test_N4_systemOperationsCannotSetUnsubscribeReason_ must catch it.
 *
 * Run: node test-harness/mutation-test-N4.js
 */

var vm = require('vm');
var fs = require('fs');
var path = require('path');
var mocks = require('./gas-mocks');

var OUTREACH_DIR = path.join(__dirname, '..');
var LOAD_ORDER = [
  'Constants.gs', 'Config.gs', 'Log.gs', 'SheetRepo.gs', 'Schedule.gs', 'Suppression.gs',
  'Templates.gs', 'Validate.gs', 'StateMachine.gs', 'Ledger.gs', 'ReplySync.gs', 'Recon.gs',
  'Mailer.gs', 'Digest.gs', 'Menu.gs', 'Triggers.gs', 'Tests.gs'
];

function runSuite(mutateConstants) {
  var sandbox = mocks.buildSandbox();
  var context = vm.createContext(sandbox);
  LOAD_ORDER.forEach(function (filename) {
    var source = fs.readFileSync(path.join(OUTREACH_DIR, filename), 'utf8');
    if (filename === 'Constants.gs' && mutateConstants) source = mutateConstants(source);
    new vm.Script(source, { filename: filename }).runInContext(context);
  });
  var originalLog = console.log;
  console.log = function () {};
  context.initializeSheets();
  var result = context.runAllF1Tests();
  console.log = originalLog;
  return result;
}

function replaceOrThrow(source, label, oldStr, newStr) {
  if (source.indexOf(oldStr) === -1) throw new Error('Mutation ' + label + ': expected text not found — Constants.gs may have changed shape.');
  return source.replace(oldStr, newStr);
}

var REPLY_SYNC_RESTRICTED =
  "OPERATION_PERMISSIONS[OPERATION.SYSTEM_REPLY_SYNC] = {\n" +
  "  columns: ['Stop_Contact', 'Do_Not_Contact_Reason', 'Status', 'Next_Action_Date', 'Replied', 'Replied_At'],\n" +
  "  statuses: [STATUS.REPLIED, STATUS.BOUNCED, STATUS.STOPPED],\n" +
  "  restrictedValues: {\n" +
  "    Do_Not_Contact_Reason: DNC_REASON_VALUES.filter(function (r) { return r !== DNC_REASON.UNSUBSCRIBE; })\n" +
  "  }\n" +
  "};";
var REPLY_SYNC_UNRESTRICTED =
  "OPERATION_PERMISSIONS[OPERATION.SYSTEM_REPLY_SYNC] = {\n" +
  "  columns: ['Stop_Contact', 'Do_Not_Contact_Reason', 'Status', 'Next_Action_Date', 'Replied', 'Replied_At'],\n" +
  "  statuses: [STATUS.REPLIED, STATUS.BOUNCED, STATUS.STOPPED]\n" +
  "  // MUTATION: restrictedValues removed.\n" +
  "};";
function mutationA_removeReplySyncGuard(source) {
  return replaceOrThrow(source, 'A', REPLY_SYNC_RESTRICTED, REPLY_SYNC_UNRESTRICTED);
}

var NIGHTLY_RECON_RESTRICTED =
  "OPERATION_PERMISSIONS[OPERATION.SYSTEM_NIGHTLY_RECON] = {\n" +
  "  columns: ['Stop_Contact', 'Do_Not_Contact_Reason', 'Status', 'Sequence_Step', 'Next_Action_Date', 'Error_Count', 'Last_Error'],\n" +
  "  restrictedValues: {\n" +
  "    Do_Not_Contact_Reason: DNC_REASON_VALUES.filter(function (r) { return r !== DNC_REASON.UNSUBSCRIBE; })\n" +
  "  },\n" +
  "  statuses: [STATUS.STOPPED, STATUS.SEQUENCE_DONE, STATUS.NEEDS_REVIEW]\n" +
  "};";
var NIGHTLY_RECON_UNRESTRICTED =
  "OPERATION_PERMISSIONS[OPERATION.SYSTEM_NIGHTLY_RECON] = {\n" +
  "  columns: ['Stop_Contact', 'Do_Not_Contact_Reason', 'Status', 'Sequence_Step', 'Next_Action_Date', 'Error_Count', 'Last_Error'],\n" +
  "  // MUTATION: restrictedValues removed.\n" +
  "  statuses: [STATUS.STOPPED, STATUS.SEQUENCE_DONE, STATUS.NEEDS_REVIEW]\n" +
  "};";
function mutationB_removeNightlyReconGuard(source) {
  return replaceOrThrow(source, 'B', NIGHTLY_RECON_RESTRICTED, NIGHTLY_RECON_UNRESTRICTED);
}

var MUTATIONS = [
  { label: 'A (SYSTEM_REPLY_SYNC restrictedValues removed)', mutate: mutationA_removeReplySyncGuard },
  { label: 'B (SYSTEM_NIGHTLY_RECON restrictedValues removed)', mutate: mutationB_removeNightlyReconGuard }
];

var allPassed = true;
console.log('=== N4 mutation test (SYSTEM-origin unsubscribe guard) ===\n');

var baseline = runSuite(null);
console.log('Baseline (no mutation): ' + baseline.passed + '/' + baseline.total);
if (baseline.passed !== baseline.total) { console.log('FAIL — baseline suite is not green.'); allPassed = false; }

MUTATIONS.forEach(function (m) {
  var mutated;
  try {
    mutated = runSuite(m.mutate);
  } catch (e) {
    console.log('Mutation ' + m.label + ': THREW — ' + e.message);
    allPassed = false;
    return;
  }
  var failed = mutated.results.filter(function (r) { return !r.passed; }).map(function (r) { return r.name; });
  console.log('Mutation ' + m.label + ': ' + mutated.passed + '/' + mutated.total +
    (failed.length ? ' — caught by: ' + failed.join(', ') : ' — *** NOT CAUGHT ***'));
  if (failed.indexOf('N4_systemCannotSetUnsubscribe') === -1) {
    console.log('FAIL — N4_systemCannotSetUnsubscribe must catch this mutation.');
    allPassed = false;
  } else {
    console.log('PASS — N4_systemCannotSetUnsubscribe caught the regression.');
  }
});

var restored = runSuite(null);
console.log('Restored (unmutated): ' + restored.passed + '/' + restored.total);
if (restored.passed !== restored.total) { console.log('FAIL — restoring the original source did not return the suite to green.'); allPassed = false; }

console.log('\n' + (allPassed ? 'N4 MUTATION TEST: PASS' : 'N4 MUTATION TEST: FAIL'));
if (!allPassed) process.exitCode = 1;
