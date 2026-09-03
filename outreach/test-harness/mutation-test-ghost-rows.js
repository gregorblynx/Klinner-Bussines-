'use strict';
/**
 * Google-real finding: reproducibly proves that isProspectRowSubstantive_
 * (SheetRepo.gs's fix for the 994-phantom-row bug found on the real
 * "Klinner Outreach — F1 Test" Sheet) is load-bearing — removing it and
 * reverting to the old naive "every cell === '' or null" blank-check must
 * make test_ghostRowsNeverBecomeProspects_ fail, and restoring the fix
 * must return the suite to green.
 *
 * Run: node test-harness/mutation-test-ghost-rows.js
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

function runSuite(mutateSheetRepo) {
  var sandbox = mocks.buildSandbox();
  var context = vm.createContext(sandbox);
  LOAD_ORDER.forEach(function (filename) {
    var source = fs.readFileSync(path.join(OUTREACH_DIR, filename), 'utf8');
    if (filename === 'SheetRepo.gs' && mutateSheetRepo) source = mutateSheetRepo(source);
    new vm.Script(source, { filename: filename }).runInContext(context);
  });
  var originalLog = console.log;
  console.log = function () {};
  context.initializeSheets();
  var result = context.runAllF1Tests();
  console.log = originalLog;
  return result;
}

var ORIGINAL_LINE = 'if (!isProspectRowSubstantive_(raw)) continue;';
var OLD_NAIVE_CHECK = "var isBlank = raw.every(function (v) { return v === '' || v === null; }); if (isBlank) continue;";

function mutationRevertToNaiveBlankCheck(source) {
  if (source.indexOf(ORIGINAL_LINE) === -1) throw new Error('Expected line not found — SheetRepo.gs may have changed shape.');
  return source.replace(ORIGINAL_LINE, OLD_NAIVE_CHECK);
}

var allPassed = true;
console.log('=== Ghost-row guard mutation test (isProspectRowSubstantive_) ===\n');

var baseline = runSuite(null);
console.log('Baseline (no mutation): ' + baseline.passed + '/' + baseline.total);
if (baseline.passed !== baseline.total) { console.log('FAIL — baseline suite is not green.'); allPassed = false; }

var mutated;
try {
  mutated = runSuite(mutationRevertToNaiveBlankCheck);
} catch (e) {
  console.log('Mutation: THREW — ' + e.message);
  mutated = null;
  allPassed = false;
}
if (mutated) {
  var failed = mutated.results.filter(function (r) { return !r.passed; }).map(function (r) { return r.name; });
  console.log('Mutation (naive blank-check restored): ' + mutated.passed + '/' + mutated.total +
    (failed.length ? ' — caught by: ' + failed.join(', ') : ' — *** NOT CAUGHT ***'));
  if (failed.indexOf('ghostRowsNeverBecomeProspects') === -1) {
    console.log('FAIL — ghostRowsNeverBecomeProspects must catch this mutation.');
    allPassed = false;
  } else {
    console.log('PASS — ghostRowsNeverBecomeProspects caught the regression.');
  }
}

var restored = runSuite(null);
console.log('Restored (unmutated): ' + restored.passed + '/' + restored.total);
if (restored.passed !== restored.total) { console.log('FAIL — restoring the original source did not return the suite to green.'); allPassed = false; }

console.log('\n' + (allPassed ? 'GHOST-ROW MUTATION TEST: PASS' : 'GHOST-ROW MUTATION TEST: FAIL'));
if (!allPassed) process.exitCode = 1;
