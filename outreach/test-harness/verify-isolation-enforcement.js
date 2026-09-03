'use strict';
/**
 * Proves run-f1-tests.js's exit code actually enforces the ISOLATION gate,
 * not just the functional (pass/fail) gate. Priority 3, Codex final audit:
 * before this fix, a test that leaked state (leftover Prospects/
 * SendLedger/Log rows, an undeleted draft, a permanently-broken mock
 * method) could still exit 0, because the runner only ever checked
 * `passed !== total` — isolationCleanCount was computed and reported in
 * the text output but never enforced.
 *
 * Method: build a temporary copy of outreach/ with cleanupTestRows_()
 * (Tests.gs — called unconditionally by cleanupTestArtifacts_ after EVERY
 * single test) replaced with a no-op, guaranteeing every test leaks its
 * Prospects fixture row. Run the COPIED test-harness/run-f1-tests.js as a
 * real child process against that copy and confirm:
 *   1. It still reports every test's own FUNCTIONAL assertions as passing
 *      (the mutation only breaks cleanup, not the logic under test).
 *   2. Its exit code is non-zero anyway, because isolation is dirty.
 * Then confirms the UNMODIFIED real suite exits 0 (both gates clean).
 *
 * Run: node test-harness/verify-isolation-enforcement.js
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var childProcess = require('child_process');

var OUTREACH_DIR = path.join(__dirname, '..');
var COPY_FILES = [
  'Constants.gs', 'Config.gs', 'Log.gs', 'SheetRepo.gs', 'Schedule.gs', 'Suppression.gs',
  'Templates.gs', 'Validate.gs', 'StateMachine.gs', 'Ledger.gs', 'ReplySync.gs', 'Recon.gs',
  'Mailer.gs', 'Digest.gs', 'Menu.gs', 'Triggers.gs', 'Tests.gs'
];
var HARNESS_FILES = ['run-f1-tests.js', 'gas-mocks.js'];

function buildTempCopy(mutateTests) {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klinner-isolation-check-'));
  fs.mkdirSync(path.join(tmpDir, 'test-harness'));
  COPY_FILES.forEach(function (f) {
    var source = fs.readFileSync(path.join(OUTREACH_DIR, f), 'utf8');
    if (f === 'Tests.gs' && mutateTests) source = mutateTests(source);
    fs.writeFileSync(path.join(tmpDir, f), source);
  });
  HARNESS_FILES.forEach(function (f) {
    fs.copyFileSync(path.join(OUTREACH_DIR, 'test-harness', f), path.join(tmpDir, 'test-harness', f));
  });
  return tmpDir;
}

function runCopy(tmpDir) {
  var result = childProcess.spawnSync('node', [path.join(tmpDir, 'test-harness', 'run-f1-tests.js')], {
    encoding: 'utf8'
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

var CLEANUP_MARKER = 'function cleanupTestRows_() {';
// P4 (Codex re-audit): the isolation gate must also catch a leaked Gmail
// DRAFT, not just leaked sheet rows — that was the exact failure mode
// Codex found (77/77 "clean" while two real drafts survived the run).
var LEAK_ANCHOR = 'function test_T21_blankNextActionDateIgnored_() {';
function mutationLeakADraft(source) {
  if (source.indexOf(LEAK_ANCHOR) === -1) throw new Error('Draft-leak anchor not found — Tests.gs may have changed shape.');
  return source.replace(LEAK_ANCHOR,
    LEAK_ANCHOR + "\n  GmailApp.createDraft('leaked@example-corp-test.com', 'MUTATION: leaked draft', 'Deliberately never cleaned up.');");
}
function mutationBreakCleanup(source) {
  if (source.indexOf(CLEANUP_MARKER) === -1) throw new Error('cleanupTestRows_ marker not found — Tests.gs may have changed shape.');
  var start = source.indexOf(CLEANUP_MARKER);
  var end = source.indexOf('\n}', start) + 2;
  var noop = 'function cleanupTestRows_() { /* MUTATION: cleanup disabled — every test now leaks its Prospects fixture row. */ }';
  return source.slice(0, start) + noop + source.slice(end);
}

var allPassed = true;
console.log('=== Isolation-enforcement verification ===\n');

// 1. Unmodified suite: both gates must be clean, exit 0.
var cleanDir = buildTempCopy(null);
var cleanRun = runCopy(cleanDir);
fs.rmSync(cleanDir, { recursive: true, force: true });
console.log('Unmodified suite: exit=' + cleanRun.status);
var cleanFunctionalLine = /functional (\d+)\/(\d+) PASS/.exec(cleanRun.stdout);
var cleanIsolationLine = /isolation clean (\d+)\/(\d+) PASS/.exec(cleanRun.stdout);
if (cleanRun.status !== 0 || !cleanFunctionalLine || !cleanIsolationLine) {
  console.log('FAIL — the unmodified suite must exit 0 with both gates reporting PASS.');
  console.log(cleanRun.stdout.slice(-500));
  allPassed = false;
} else {
  console.log('PASS — unmodified suite: ' + cleanFunctionalLine[0] + ', ' + cleanIsolationLine[0] + ', exit 0.');
}

// 2. Cleanup disabled: functional assertions still pass, but isolation is
//    dirty for every test — exit code MUST be non-zero anyway.
var dirtyDir = buildTempCopy(mutationBreakCleanup);
var dirtyRun = runCopy(dirtyDir);
fs.rmSync(dirtyDir, { recursive: true, force: true });
console.log('\nCleanup-disabled suite: exit=' + dirtyRun.status);
var dirtyFunctionalLine = /functional (\d+)\/(\d+) (PASS|FAIL)/.exec(dirtyRun.stdout);
var dirtyIsolationLine = /isolation clean (\d+)\/(\d+) (PASS|FAIL)/.exec(dirtyRun.stdout);
if (!dirtyFunctionalLine || !dirtyIsolationLine) {
  console.log('FAIL — could not parse the mutated run\'s output.');
  console.log(dirtyRun.stdout.slice(-800));
  allPassed = false;
} else {
  var functionalStillPassed = dirtyFunctionalLine[1] === dirtyFunctionalLine[2] && dirtyFunctionalLine[3] === 'PASS';
  var isolationNowDirty = dirtyIsolationLine[1] !== dirtyIsolationLine[2] && dirtyIsolationLine[3] === 'FAIL';
  console.log((functionalStillPassed ? 'PASS' : 'FAIL') + ' — functional gate still all-green with cleanup disabled: ' + dirtyFunctionalLine[0]);
  console.log((isolationNowDirty ? 'PASS' : 'FAIL') + ' — isolation gate correctly reports dirty: ' + dirtyIsolationLine[0]);
  console.log((dirtyRun.status !== 0 ? 'PASS' : 'FAIL') + ' — exit code is non-zero despite functional gate being clean.');
  if (!functionalStillPassed || !isolationNowDirty || dirtyRun.status === 0) allPassed = false;
}

// 3. A single leaked Gmail draft: every test's own assertions still pass,
//    but the isolation gate must catch it and the exit code must be non-zero.
var leakDir = buildTempCopy(mutationLeakADraft);
var leakRun = runCopy(leakDir);
fs.rmSync(leakDir, { recursive: true, force: true });
console.log('\nLeaked-Gmail-draft suite: exit=' + leakRun.status);
var leakFunctionalLine = /functional (\d+)\/(\d+) (PASS|FAIL)/.exec(leakRun.stdout);
var leakIsolationLine = /isolation clean (\d+)\/(\d+) (PASS|FAIL)/.exec(leakRun.stdout);
if (!leakFunctionalLine || !leakIsolationLine) {
  console.log('FAIL — could not parse the draft-leak run\'s output.');
  console.log(leakRun.stdout.slice(-800));
  allPassed = false;
} else {
  var leakFunctionalGreen = leakFunctionalLine[1] === leakFunctionalLine[2] && leakFunctionalLine[3] === 'PASS';
  var leakIsolationDirty = leakIsolationLine[1] !== leakIsolationLine[2] && leakIsolationLine[3] === 'FAIL';
  console.log((leakFunctionalGreen ? 'PASS' : 'FAIL') + ' — functional gate still all-green with a leaked draft: ' + leakFunctionalLine[0]);
  console.log((leakIsolationDirty ? 'PASS' : 'FAIL') + ' — isolation gate catches the leaked Gmail draft: ' + leakIsolationLine[0]);
  console.log((leakRun.status !== 0 ? 'PASS' : 'FAIL') + ' — exit code is non-zero for a leaked draft.');
  if (!leakFunctionalGreen || !leakIsolationDirty || leakRun.status === 0) allPassed = false;
}

console.log('\n' + (allPassed ? 'ISOLATION ENFORCEMENT VERIFICATION: PASS' : 'ISOLATION ENFORCEMENT VERIFICATION: FAIL'));
if (!allPassed) process.exitCode = 1;
