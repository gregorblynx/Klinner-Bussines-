'use strict';
/**
 * N5 (LIVE send concurrency / ambiguous-outcome hardening) mutation test.
 *
 * doStep1Send_/doFollowUpSend_ are LIVE-only and this project's own
 * established policy (see Tests.gs's comment on findings #7/#8, and the
 * matching static checks in verify-static-findings.js) is to never flip
 * DRY_RUN=FALSE even in the local mock harness — so there is no runtime
 * suite to mutation-test against here. Instead this reproduces the SAME
 * static-check logic verify-static-findings.js uses, against a
 * deliberately mutated in-memory copy of Mailer.gs's source, proving the
 * checks actually catch the two regressions they exist to catch:
 *
 *   A. doStep1Send_'s send()-failure catch reverted to the old
 *      bare-FAILED-no-NEEDS_REVIEW behavior (retryable, duplicate-send risk).
 *   B. doFollowUpSend_'s message-count-mismatch guard reverted to the old
 *      throw-with-no-NEEDS_REVIEW-write behavior (the originally documented
 *      N5 blocker).
 *
 * Run: node test-harness/mutation-test-N5.js
 */

var fs = require('fs');
var path = require('path');

var OUTREACH_DIR = path.join(__dirname, '..');
var ORIGINAL_SOURCE = fs.readFileSync(path.join(OUTREACH_DIR, 'Mailer.gs'), 'utf8');

function checkStep1NeedsReview(source) {
  var fnStart = source.indexOf('function doStep1Send_(');
  var fnEnd = source.indexOf('function doFollowUpSend_(');
  if (fnStart === -1 || fnEnd === -1 || fnEnd <= fnStart) return false;
  var fnBody = source.slice(fnStart, fnEnd);
  var catchStart = fnBody.indexOf('catch (sendError)');
  if (catchStart === -1) return false;
  var catchBody = fnBody.slice(catchStart);
  return /LEDGER_STATE\.FAILED/.test(catchBody) &&
    /Status:\s*STATUS\.NEEDS_REVIEW/.test(catchBody) &&
    /origin:\s*ORIGIN\.PIPELINE,\s*operation:\s*OPERATION\.PIPELINE_SEND/.test(catchBody);
}

function checkFollowUpNeedsReview(source) {
  var fnStart = source.indexOf('function doFollowUpSend_(');
  var fnEnd = source.indexOf('executeLiveSendForStep_ = function');
  if (fnStart === -1 || fnEnd === -1 || fnEnd <= fnStart) return false;
  var fnBody = source.slice(fnStart, fnEnd);
  var guardStart = fnBody.indexOf('messagesAfter.length !== messagesBefore + 1');
  if (guardStart === -1) return false;
  var guardBody = fnBody.slice(guardStart, guardStart + 1500);
  return /LEDGER_STATE\.FAILED/.test(guardBody) &&
    /Status:\s*STATUS\.NEEDS_REVIEW/.test(guardBody) &&
    /origin:\s*ORIGIN\.PIPELINE,\s*operation:\s*OPERATION\.PIPELINE_SEND/.test(guardBody);
}

function replaceOrThrow(source, label, oldStr, newStr) {
  if (source.indexOf(oldStr) === -1) throw new Error('Mutation ' + label + ': expected text not found — Mailer.gs may have changed shape.');
  return source.replace(oldStr, newStr);
}

// --- Mutation A: revert doStep1Send_'s catch to the old bare-FAILED behavior. ---
var STEP1_CATCH_OLD_STYLE_MARKER = "      try {\n        writeRowById_(prospectId, { Status: STATUS.NEEDS_REVIEW },\n          { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });\n      } catch (writeError) {\n        logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, 1,\n          'doStep1Send_: ALSO failed to write NEEDS_REVIEW after an ambiguous send failure: ' + writeError +\n          ' — this prospect may remain automatically retryable. NEEDS MANUAL REVIEW.');\n      }\n";
function mutationA_removeStep1NeedsReview(source) {
  return replaceOrThrow(source, 'A', STEP1_CATCH_OLD_STYLE_MARKER, '      // MUTATION A: NEEDS_REVIEW write removed — reverts to the old retryable-on-ambiguous-failure bug.\n');
}

// --- Mutation B: revert doFollowUpSend_'s mismatch guard to the old throw-only behavior. ---
var FOLLOWUP_GUARD_NEEDS_REVIEW_MARKER = "      try {\n        writeRowById_(prospectId, { Status: STATUS.NEEDS_REVIEW },\n          { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });\n      } catch (writeError) {\n        logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,\n          'doFollowUpSend_: ALSO failed to write NEEDS_REVIEW after an ambiguous reply() outcome: ' + writeError +\n          ' — this prospect may remain automatically retryable. NEEDS MANUAL REVIEW.');\n      }\n";
function mutationB_removeFollowUpNeedsReview(source) {
  return replaceOrThrow(source, 'B', FOLLOWUP_GUARD_NEEDS_REVIEW_MARKER, '      // MUTATION B: NEEDS_REVIEW write removed — reverts to the original documented N5 blocker.\n');
}

var MUTATIONS = [
  { label: 'A (doStep1Send_ NEEDS_REVIEW removed)', mutate: mutationA_removeStep1NeedsReview, check: checkStep1NeedsReview },
  { label: 'B (doFollowUpSend_ NEEDS_REVIEW removed)', mutate: mutationB_removeFollowUpNeedsReview, check: checkFollowUpNeedsReview }
];

var allPassed = true;
console.log('=== N5 mutation test (LIVE send ambiguous-outcome hardening, static) ===\n');

var baselineA = checkStep1NeedsReview(ORIGINAL_SOURCE);
var baselineB = checkFollowUpNeedsReview(ORIGINAL_SOURCE);
console.log('Baseline: step1 check=' + baselineA + ', followUp check=' + baselineB);
if (!baselineA || !baselineB) { console.log('FAIL — baseline checks are not both green.'); allPassed = false; }

MUTATIONS.forEach(function (m) {
  var mutatedSource;
  try {
    mutatedSource = m.mutate(ORIGINAL_SOURCE);
  } catch (e) {
    console.log('Mutation ' + m.label + ': THREW — ' + e.message);
    allPassed = false;
    return;
  }
  var result = m.check(mutatedSource);
  console.log('Mutation ' + m.label + ': check result=' + result + (result ? ' — *** NOT CAUGHT ***' : ' — caught (check correctly fails).'));
  if (result) {
    console.log('FAIL — this mutation must make its corresponding check fail.');
    allPassed = false;
  } else {
    console.log('PASS — mutation caught.');
  }
});

var restoredA = checkStep1NeedsReview(ORIGINAL_SOURCE);
var restoredB = checkFollowUpNeedsReview(ORIGINAL_SOURCE);
console.log('Restored (unmutated, re-checked): step1=' + restoredA + ', followUp=' + restoredB);
if (!restoredA || !restoredB) { console.log('FAIL — original source no longer passes its own checks.'); allPassed = false; }

console.log('\n' + (allPassed ? 'N5 MUTATION TEST: PASS' : 'N5 MUTATION TEST: FAIL'));
if (!allPassed) process.exitCode = 1;
