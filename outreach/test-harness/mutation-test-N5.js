'use strict';
/**
 * N5 (Codex final audit, round 2) BEHAVIORAL mutation test — replaces the
 * round-1 static-only version. The round-2 audit explicitly required real
 * executable tests for N5 (test_N5_* in Tests.gs); this mutation test
 * proves those tests actually catch regressions in the durable-ledger-
 * blocking design, not just that certain source patterns are present.
 *
 * Six mutations, each targeting a distinct structural property Codex's
 * final audit named explicitly:
 *
 *   A. Remove AMBIGUOUS from isLiveKeyBlocked_'s blocking check (Ledger.gs)
 *      — the ledger-level guard itself disabled.
 *   B. doFollowUpSend_'s reply()-throw handler downgraded from AMBIGUOUS
 *      back to FAILED (round-1 bug reintroduced for this specific site).
 *   C. reconcileStaleLiveClaims_ reverted to inferring SENT from a single
 *      generic recipient-search match — a match that cannot identify THIS
 *      step (Recon.gs).
 *   D. doStep1Send_'s ledger CLAIM moved from BEFORE the risky Gmail call
 *      to AFTER it succeeds — reproducing "no ledger protection exists
 *      while a Gmail operation that could have sent is in flight or
 *      throws", the deeper architectural property the whole durable-
 *      blocking design depends on.
 *   E. doFollowUpSend_'s ledger CLAIM moved from BEFORE thread.reply() to
 *      AFTER it succeeds — the follow-up equivalent of D.
 *   F. isLiveKeyBlocked_ deliberately ignores a key when it finds MORE
 *      THAN ONE blocking LIVE row — singles still block, so only the new
 *      duplicate-active adversarial coverage can catch this regression.
 *
 * Run: node test-harness/mutation-test-N5.js
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

function runSuite(mutators) {
  var sandbox = mocks.buildSandbox();
  var context = vm.createContext(sandbox);
  LOAD_ORDER.forEach(function (filename) {
    var source = fs.readFileSync(path.join(OUTREACH_DIR, filename), 'utf8');
    if (mutators && mutators[filename]) source = mutators[filename](source);
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
  if (source.indexOf(oldStr) === -1) throw new Error('Mutation ' + label + ': expected text not found — source may have changed shape.');
  return source.replace(oldStr, newStr);
}

// --- Mutation A: remove AMBIGUOUS from isLiveKeyBlocked_'s check (Ledger.gs). ---
function mutationA_removeAmbiguousFromBlockingCheck(source) {
  return replaceOrThrow(source, 'A',
    "    if (v.Idempotency_Key === key && v.Mode === LEDGER_MODE.LIVE &&\n" +
    "        (v.State === LEDGER_STATE.CLAIMED || v.State === LEDGER_STATE.SENT || v.State === LEDGER_STATE.AMBIGUOUS)) {",
    "    if (v.Idempotency_Key === key && v.Mode === LEDGER_MODE.LIVE &&\n" +
    "        (v.State === LEDGER_STATE.CLAIMED || v.State === LEDGER_STATE.SENT /* MUTATION A: AMBIGUOUS removed */)) {");
}

// --- Mutation B: Gmail API send ambiguity downgraded to FAILED. ---
function mutationB_followUpReplyThrowDowngradedToFailed(source) {
  return replaceOrThrow(source, 'B',
    "    updateLedgerRow_(ledgerRowNum, {\n" +
    "      State: LEDGER_STATE.AMBIGUOUS,\n" +
    "      Error: String(error) + ' (ambiguous outcome after Gmail API send invocation — durably blocked; SEND is never retried)'\n" +
    "    });",
    "    updateLedgerRow_(ledgerRowNum, {\n" +
    "      State: LEDGER_STATE.FAILED, // MUTATION B: downgraded — no longer blocks isLiveKeyBlocked_.\n" +
    "      Error: String(error)\n" +
    "    });");
}

// --- Mutation C: reintroduce the false-SENT inference — a single generic
// recipient-search match treated as proof that THIS step was sent. ---
function mutationC_falseSentInference(source) {
  return replaceOrThrow(source, 'C',
    "      evidence = threads.length + ' message(s) to this recipient found in Sent (diagnostic only — a generic ' +\n" +
    "        'recipient search cannot prove THIS specific step was or was not sent)';",
    "      evidence = threads.length + ' message(s) found';\n" +
    "      if (threads.length === 1) { // MUTATION C: treat one generic match as proof of SENT.\n" +
    "        updateLedgerRow_(row.rowIndex, { State: LEDGER_STATE.SENT, Confirmed_At: new Date() });\n" +
    "        return;\n" +
    "      }");
}

// --- Mutation D: doStep1Send_'s ledger CLAIM moved to AFTER send() succeeds (Mailer.gs). ---
function mutationD_claimMovedAfterSend(source) {
  var s = source;
  s = replaceOrThrow(s, 'D1',
    "  function doStep1Send_(prospectId, prospect, rendered, config) {\n" +
    "    var ledgerRowNum = appendLedgerRow_({\n" +
    "      Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: prospectId, Email_Normalized: prospect.Email_Normalized,\n" +
    "      Step: 1, Idempotency_Key: getIdempotencyKey_(prospectId, 1), Mode: LEDGER_MODE.LIVE, State: LEDGER_STATE.CLAIMED,\n" +
    "      Thread_ID: '', Message_ID: '', Draft_ID: '', Confirmed_At: '', Error: ''\n" +
    "    });\n",
    "  function doStep1Send_(prospectId, prospect, rendered, config) {\n" +
    "    // MUTATION D: claim removed from here — no ledger protection exists\n" +
    "    // while send() is in flight or if it throws.\n" +
    "    var ledgerRowNum = null;\n");
  s = replaceOrThrow(s, 'D2',
    "      var compensated = false;\n" +
    "      try { draft.deleteDraft(); compensated = true; } catch (deleteError) { compensated = false; }\n" +
    "      updateLedgerRow_(ledgerRowNum, {\n" +
    "        State: LEDGER_STATE.AMBIGUOUS,\n" +
    "        Error: String(sendError) + ' (ambiguous outcome — durably blocked in the ledger, never automatically retryable)'\n" +
    "      });",
    "      var compensated = false;\n" +
    "      try { draft.deleteDraft(); compensated = true; } catch (deleteError) { compensated = false; }\n" +
    "      if (ledgerRowNum) updateLedgerRow_(ledgerRowNum, { // MUTATION D: no-op — ledgerRowNum is null.\n" +
    "        State: LEDGER_STATE.AMBIGUOUS,\n" +
    "        Error: String(sendError) + ' (ambiguous outcome — durably blocked in the ledger, never automatically retryable)'\n" +
    "      });");
  s = replaceOrThrow(s, 'D3',
    "    var confirmedAt = new Date();\n" +
    "    updateLedgerRow_(ledgerRowNum, {\n" +
    "      State: LEDGER_STATE.SENT, Thread_ID: thread.getId(), Message_ID: message.getId(), Confirmed_At: confirmedAt\n" +
    "    });",
    "    var confirmedAt = new Date();\n" +
    "    if (ledgerRowNum) {\n" +
    "      updateLedgerRow_(ledgerRowNum, {\n" +
    "        State: LEDGER_STATE.SENT, Thread_ID: thread.getId(), Message_ID: message.getId(), Confirmed_At: confirmedAt\n" +
    "      });\n" +
    "    } else {\n" +
    "      ledgerRowNum = appendLedgerRow_({ // MUTATION D: claimed only NOW, after send() already succeeded.\n" +
    "        Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: prospectId, Email_Normalized: prospect.Email_Normalized,\n" +
    "        Step: 1, Idempotency_Key: getIdempotencyKey_(prospectId, 1), Mode: LEDGER_MODE.LIVE, State: LEDGER_STATE.SENT,\n" +
    "        Thread_ID: thread.getId(), Message_ID: message.getId(), Draft_ID: '', Confirmed_At: confirmedAt, Error: ''\n" +
    "      });\n" +
    "    }");
  return s;
}

// --- Mutation E: remove the durable follow-up claim from before the
// Advanced Gmail API send. The send-error test must catch the missing row. ---
function mutationE_followUpClaimMovedAfterReply(source) {
  return replaceOrThrow(source, 'E',
    "    var ledgerRowNum = appendLedgerRow_({\n" +
    "      Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: prospectId, Email_Normalized: prepared.recipient,\n" +
    "      Step: step, Idempotency_Key: getIdempotencyKey_(prospectId, step), Mode: LEDGER_MODE.LIVE, State: LEDGER_STATE.CLAIMED,\n" +
    "      Thread_ID: prospect.Thread_ID, Message_ID: '', Draft_ID: '', Confirmed_At: '', Error: ''\n" +
    "    });",
    "    var ledgerRowNum = null; // MUTATION E: no durable claim exists before Gmail API send.");
}

function mutationH_followUpRecipientUsesSender(source) {
  return replaceOrThrow(source, 'H',
    "      'To: ' + recipient,",
    "      'To: ' + sender, // MUTATION H: reproduces wrong-recipient incident.");
}

function mutationI_skipExactPostSendVerification(source) {
  return replaceOrThrow(source, 'I',
    "  function verifyExplicitFollowUpMessage_(messageId, expected) {\n" +
    "    var lastError = null;",
    "  function verifyExplicitFollowUpMessage_(messageId, expected) {\n" +
    "    return Gmail.Users.Messages.get('me', messageId, { format: 'full' }); // MUTATION I: accept anything.\n" +
    "    var lastError = null;");
}

// --- Mutation F (final N5 coverage gap): make duplicate-active ledger
// corruption permissive while preserving the normal single-row guard.
// Existing one-row N5 tests therefore remain green; the dedicated
// CLAIMED+AMBIGUOUS adversarial test must be what kills this mutant. ---
function mutationF_ignoreMultipleBlockingLiveRows(source) {
  return replaceOrThrow(source, 'F',
    "function isLiveKeyBlocked_(prospectId, step) {\n" +
    "  var key = getIdempotencyKey_(prospectId, step);\n" +
    "  var rows = readAllLedgerRows_();\n",
    "function isLiveKeyBlocked_(prospectId, step) {\n" +
    "  var key = getIdempotencyKey_(prospectId, step);\n" +
    "  var rows = readAllLedgerRows_();\n" +
    "  var blockingMatches = rows.filter(function (row) {\n" +
    "    var v = row.values;\n" +
    "    return v.Idempotency_Key === key && v.Mode === LEDGER_MODE.LIVE &&\n" +
    "      (v.State === LEDGER_STATE.CLAIMED || v.State === LEDGER_STATE.SENT || v.State === LEDGER_STATE.AMBIGUOUS);\n" +
    "  }).length;\n" +
    "  if (blockingMatches > 1) return false; // MUTATION F: corrupt duplicate-active keys are incorrectly reopened.\n");
}

// --- Mutation G (independent review of the post-send persistence fix):
// disable sendBatch's hard stop, so a post-send persistence failure lets the
// batch roll on to the next prospect and send it a real email. Every
// single-prospect N5/N6 test stays green under this mutation — only the
// two-prospect batch test can kill it. ---
function mutationG_batchDoesNotHardStop(source) {
  return replaceOrThrow(source, 'G',
    "    if (outcome && outcome.status === 'SENT_PERSISTENCE_FAILED') {",
    "    if (false && outcome && outcome.status === 'SENT_PERSISTENCE_FAILED') { // MUTATION G: hard stop disabled.");
}

var MUTATIONS = [
  { label: 'A (AMBIGUOUS removed from isLiveKeyBlocked_)', file: 'Ledger.gs', mutate: mutationA_removeAmbiguousFromBlockingCheck, mustBeCaughtBy: 'N5_step1ThrowsDurableBlock' },
  { label: 'B (follow-up API send ambiguity downgraded to FAILED)', file: 'Mailer.gs', mutate: mutationB_followUpReplyThrowDowngradedToFailed, mustBeCaughtBy: 'N5_followUpThrowsDurableBlock' },
  { label: 'C (false SENT inferred from one search match)', file: 'Recon.gs', mutate: mutationC_falseSentInference, mustBeCaughtBy: 'N5_reconSingleMatchAmbiguous' },
  { label: 'D (claim moved to after send() succeeds)', file: 'Mailer.gs', mutate: mutationD_claimMovedAfterSend, mustBeCaughtBy: 'N5_step1ThrowsDurableBlock' },
  { label: 'E (follow-up durable claim removed before API send)', file: 'Mailer.gs', mutate: mutationE_followUpClaimMovedAfterReply, mustBeCaughtBy: 'N5_followUpThrowsDurableBlock' },
  { label: 'F (multiple blocking LIVE rows incorrectly reopen key)', file: 'Ledger.gs', mutate: mutationF_ignoreMultipleBlockingLiveRows, mustBeCaughtBy: 'N5_multipleLiveClaimedAmbiguousBlocks' },
  { label: 'G (batch does not hard-stop on persistence failure)', file: 'Mailer.gs', mutate: mutationG_batchDoesNotHardStop, mustBeCaughtBy: 'N6_batchHardStopsAfterPersistenceFailure' },
  { label: 'H (follow-up MIME To changed to sender)', file: 'Mailer.gs', mutate: mutationH_followUpRecipientUsesSender, mustBeCaughtBy: 'N5_followUpExplicitRecipient' },
  { label: 'I (exact post-send verification bypassed)', file: 'Mailer.gs', mutate: mutationI_skipExactPostSendVerification, mustBeCaughtBy: 'N5_followUpWrongReturnedRecipient' }
];

var allPassed = true;
console.log('=== N5 behavioral mutation test (durable ledger blocking) ===\n');

var baseline = runSuite(null);
console.log('Baseline (no mutation): ' + baseline.passed + '/' + baseline.total);
if (baseline.passed !== baseline.total) { console.log('FAIL — baseline suite is not green.'); allPassed = false; }

MUTATIONS.forEach(function (m) {
  var mutated;
  try {
    var mutators = {};
    mutators[m.file] = m.mutate;
    mutated = runSuite(mutators);
  } catch (e) {
    console.log('Mutation ' + m.label + ': THREW — ' + e.message);
    allPassed = false;
    return;
  }
  var failed = mutated.results.filter(function (r) { return !r.passed; }).map(function (r) { return r.name; });
  console.log('Mutation ' + m.label + ': ' + mutated.passed + '/' + mutated.total +
    (failed.length ? ' — caught by: ' + failed.join(', ') : ' — *** NOT CAUGHT ***'));
  if (failed.indexOf(m.mustBeCaughtBy) === -1) {
    console.log('FAIL — ' + m.mustBeCaughtBy + ' must catch this mutation.');
    allPassed = false;
  } else {
    console.log('PASS — ' + m.mustBeCaughtBy + ' caught the regression.');
  }
});

var restored = runSuite(null);
console.log('Restored (unmutated): ' + restored.passed + '/' + restored.total);
if (restored.passed !== restored.total) { console.log('FAIL — restoring the original source did not return the suite to green.'); allPassed = false; }

console.log('\n' + (allPassed ? 'N5 BEHAVIORAL MUTATION TEST: PASS' : 'N5 BEHAVIORAL MUTATION TEST: FAIL'));
if (!allPassed) process.exitCode = 1;
