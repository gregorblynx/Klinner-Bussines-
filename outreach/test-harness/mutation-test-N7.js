'use strict';
/**
 * Reaudit finding N7: prove — reproducibly, not as a one-off manual check —
 * that `expectedStep === null || expectedStep !== step` in StateMachine.gs's
 * canSend_() is load-bearing, isolated from every other guard in that
 * function. Two mutations are tried:
 *
 *   1. Remove the WHOLE line (both null-check and mismatch-check) — a
 *      gross regression, expected to break several tests.
 *   2. Remove ONLY the `|| expectedStep !== step` half, keeping
 *      `expectedStep === null` — the narrow, easy-to-miss regression this
 *      finding is actually worried about (someone "simplifying" the check
 *      without realizing the mismatch half was carrying real weight).
 *
 * For mutation 2 specifically, this script asserts that test
 * `finding10_canSendSequence` is ALWAYS in the failing set (not just that
 * ANY test fails) — that is the proof the strengthened N7 case in that
 * test, and only that test, depends on the exact line.
 *
 * Run: node test-harness/mutation-test-N7.js
 * Exits non-zero if the mutation escapes detection, or if restoring the
 * original source does not return the suite to green.
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

function runSuite(mutateStateMachine) {
  var sandbox = mocks.buildSandbox();
  var context = vm.createContext(sandbox);
  LOAD_ORDER.forEach(function (filename) {
    var source = fs.readFileSync(path.join(OUTREACH_DIR, filename), 'utf8');
    if (filename === 'StateMachine.gs' && mutateStateMachine) source = mutateStateMachine(source);
    new vm.Script(source, { filename: filename }).runInContext(context);
  });
  var originalLog = console.log;
  console.log = function () {}; // Silence the suite's own console.log during this probe.
  context.initializeSheets();
  var result = context.runAllF1Tests();
  console.log = originalLog;
  return result;
}

var ORIGINAL_LINE = 'if (expectedStep === null || expectedStep !== step) return false;';

function mutationRemoveWholeCheck(source) {
  if (source.indexOf(ORIGINAL_LINE) === -1) throw new Error('Expected line not found — StateMachine.gs may have changed shape.');
  return source.replace(ORIGINAL_LINE, '/* mutation: sequence check removed entirely */');
}

function mutationRemoveOnlyMismatchHalf(source) {
  if (source.indexOf(ORIGINAL_LINE) === -1) throw new Error('Expected line not found — StateMachine.gs may have changed shape.');
  return source.replace(ORIGINAL_LINE, 'if (expectedStep === null) return false; /* mutation: only null-check kept, mismatch half removed */');
}

var allPassed = true;

console.log('=== N7 mutation test: expectedStep !== step in canSend_ ===\n');

// --- Baseline: everything green. ---
var baseline = runSuite(null);
console.log('Baseline (no mutation): ' + baseline.passed + '/' + baseline.total);
if (baseline.passed !== baseline.total) {
  console.log('FAIL — baseline suite is not green; cannot trust mutation results.');
  allPassed = false;
}

// --- Mutation 1: whole-line removal. ---
var mut1;
try {
  mut1 = runSuite(mutationRemoveWholeCheck);
} catch (e) {
  console.log('Mutation 1 (whole line removed): THREW — ' + e.message);
  mut1 = null;
  allPassed = false;
}
if (mut1) {
  var failed1 = mut1.results.filter(function (r) { return !r.passed; }).map(function (r) { return r.name; });
  console.log('Mutation 1 (whole line removed): ' + mut1.passed + '/' + mut1.total +
    (failed1.length ? ' — caught by: ' + failed1.join(', ') : ' — *** NOT CAUGHT ***'));
  if (failed1.indexOf('finding10_canSendSequence') === -1) {
    console.log('FAIL — finding10_canSendSequence must be among the failing tests for mutation 1.');
    allPassed = false;
  }
}

// --- Mutation 2: the narrow, easy-to-miss one N7 is actually about. ---
var mut2;
try {
  mut2 = runSuite(mutationRemoveOnlyMismatchHalf);
} catch (e) {
  console.log('Mutation 2 (mismatch half only removed): THREW — ' + e.message);
  mut2 = null;
  allPassed = false;
}
if (mut2) {
  var failed2 = mut2.results.filter(function (r) { return !r.passed; }).map(function (r) { return r.name; });
  console.log('Mutation 2 (mismatch half only removed): ' + mut2.passed + '/' + mut2.total +
    (failed2.length ? ' — caught by: ' + failed2.join(', ') : ' — *** NOT CAUGHT ***'));
  if (failed2.indexOf('finding10_canSendSequence') === -1) {
    console.log('FAIL — finding10_canSendSequence must catch mutation 2 (the narrow regression N7 targets). ' +
      'If some OTHER test fails instead, that is not proof this specific check is load-bearing.');
    allPassed = false;
  } else {
    console.log('PASS — finding10_canSendSequence (and only the check it targets) caught the narrow mutation.');
  }
}

// --- Restore: confirm the real, unmutated source is still green. ---
var restored = runSuite(null);
console.log('Restored (unmutated): ' + restored.passed + '/' + restored.total);
if (restored.passed !== restored.total) {
  console.log('FAIL — restoring the original source did not return the suite to green.');
  allPassed = false;
}

console.log('\n' + (allPassed ? 'N7 MUTATION TEST: PASS' : 'N7 MUTATION TEST: FAIL'));
if (!allPassed) process.exitCode = 1;
