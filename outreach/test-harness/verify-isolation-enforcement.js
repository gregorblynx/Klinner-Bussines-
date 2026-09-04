'use strict';
/**
 * Proves run-f1-tests.js's exit code actually enforces the ISOLATION gate,
 * not just the functional (pass/fail) gate — and that the isolation gate
 * itself sees every class of shared state, not just the ones that were
 * easy to track.
 *
 * History: before any of this, a test that leaked state could still exit 0,
 * because the runner only ever checked `passed !== total`. That was fixed.
 * Codex's atomicity re-audit then found the NEXT layer of the same problem:
 * the gate was being enforced, but it was blind to Gmail call counters,
 * Gmail labels, messages appended to an already-existing thread, and any
 * sheet row written without the test marker or under a foreign Run_ID — so
 * "isolation clean N/N" was still not the guarantee it claimed to be.
 *
 * Method: build a temporary copy of outreach/, apply ONE mutation to it,
 * run the COPIED test-harness/run-f1-tests.js as a real child process, and
 * assert that
 *   1. every test's own FUNCTIONAL assertions still pass (the mutation
 *      breaks isolation, not the logic under test), and
 *   2. the isolation gate reports dirty and the exit code is non-zero.
 * A scenario that fails to be caught is a hole in the gate, and this file
 * exits non-zero for it.
 *
 * Scenarios:
 *   1. unmodified suite            -> exit 0, both gates clean
 *   2. sheet-row residue           -> caught
 *   3. leaked Gmail draft          -> caught
 *   4. leaked Gmail call counter   -> caught
 *   5. leaked Gmail label          -> caught
 *   6. message appended to an
 *      already-existing thread     -> caught (no id set changes at all)
 *   7. untracked Suppression row   -> caught (no test marker, no Run_ID)
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

function replaceOrThrow(source, label, oldStr, newStr) {
  if (source.indexOf(oldStr) === -1) {
    throw new Error('Scenario ' + label + ': anchor not found — Tests.gs may have changed shape.');
  }
  return source.replace(oldStr, newStr);
}

// A test body every scenario can safely hang a side effect off.
var LEAK_ANCHOR = 'function test_T21_blankNextActionDateIgnored_() {';

// --- 2. Sheet-row residue: cleanupTestRows_ neutered, so every test leaks
//        its Prospects fixture row. ---
function mutationBreakCleanup(source) {
  var CLEANUP_MARKER = 'function cleanupTestRows_() {';
  if (source.indexOf(CLEANUP_MARKER) === -1) throw new Error('cleanupTestRows_ marker not found — Tests.gs may have changed shape.');
  var start = source.indexOf(CLEANUP_MARKER);
  var end = source.indexOf('\n}', start) + 2;
  var noop = 'function cleanupTestRows_() { /* MUTATION: cleanup disabled — every test now leaks its Prospects fixture row. */ }';
  return source.slice(0, start) + noop + source.slice(end);
}

// --- 3. A Gmail draft nothing tracks and no teardown can find. ---
function mutationLeakADraft(source) {
  return replaceOrThrow(source, '3', LEAK_ANCHOR,
    LEAK_ANCHOR + "\n  GmailApp.createDraft('leaked@example-corp-test.com', 'MUTATION: leaked draft', 'Deliberately never cleaned up.');");
}

// --- 4. A residual Gmail call counter. Teardown normally restores the
//        counters to each test's own baseline; with that restore removed,
//        every test that touches Gmail leaves the counters bumped. The
//        gate must treat that as dirty — a stale counter is exactly what
//        makes a later test's "exactly one send" assertion meaningless. ---
function mutationLeakCallCounters(source) {
  return replaceOrThrow(source, '4',
    "      try { GmailApp._setCallCounts(sandboxBefore.callCounts); } catch (e) { /* best effort */ }",
    "      /* MUTATION: call-counter restore removed — counters now leak between tests. */");
}

// --- 5. A Gmail label created by a test and never removed. ---
function mutationLeakALabel(source) {
  var s = replaceOrThrow(source, '5a', LEAK_ANCHOR,
    LEAK_ANCHOR + "\n  GmailApp.createLabel('MUTATION/leaked-label');");
  return replaceOrThrow(s, '5b',
    "        GmailApp._labelNames().forEach(function (n) {\n          if (!baselineLabels[n]) GmailApp._removeLabelForTest(n);\n        });",
    "        /* MUTATION: label restore removed — a test-created label now survives the run. */");
}

// --- 6. The subtlest one: a message appended to a thread that ALREADY
//        existed at snapshot time. No draft is created, no thread is
//        created, no sheet row is written — every id list is byte-identical
//        before and after. Only message-level comparison can see it. ---
function mutationModifyExistingThreadMessages(source) {
  var loopAnchor = "  F1_TEST_FUNCTIONS.forEach(function (pair) {\n    var name = pair[0];\n    var fn = pair[1];";
  var s = replaceOrThrow(source, '6a', loopAnchor,
    "  // MUTATION: a thread that exists BEFORE every snapshot is taken, so\n" +
    "  // appending to it changes no id set anywhere.\n" +
    "  var _mutationPersistentThread = GmailApp._seedLiveThread('persistent@example-corp-test.com', 'sender@example-corp-test.com');\n" +
    loopAnchor);
  return replaceOrThrow(s, '6b',
    "    var testError = null;\n    try {\n      fn();\n    } catch (e) {\n      testError = String(e.message || e);\n    }",
    "    var testError = null;\n    try {\n      fn();\n      if (name === 'T21') _mutationPersistentThread.reply('MUTATION: message appended to a pre-existing thread.');\n    } catch (e) {\n      testError = String(e.message || e);\n    }");
}

// --- 7. A Suppression row written straight to the sheet: no test marker,
//        no Run_ID, not in any tracking array. The row-count and
//        marker-based checks are all blind to it; only real content
//        comparison catches it. ---
function mutationLeakSuppressionRow(source) {
  return replaceOrThrow(source, '7', LEAK_ANCHOR,
    LEAK_ANCHOR +
    "\n  getSheet_(SHEET_NAMES.SUPPRESSION).appendRow(['untracked-leak@example-corp-test.com', SUPPRESSION_SCOPE.EMAIL, 'MUTATION', new Date()]);");
}

var SCENARIOS = [
  { label: '2. sheet-row residue (cleanup disabled)', mutate: mutationBreakCleanup },
  { label: '3. leaked Gmail draft', mutate: mutationLeakADraft },
  { label: '4. leaked Gmail call counter', mutate: mutationLeakCallCounters },
  { label: '5. leaked Gmail label', mutate: mutationLeakALabel },
  { label: '6. message appended to a pre-existing thread', mutate: mutationModifyExistingThreadMessages },
  { label: '7. untracked Suppression row', mutate: mutationLeakSuppressionRow }
];

var allPassed = true;
console.log('=== Isolation-enforcement verification ===\n');

// 1. Unmodified suite: both gates must be clean, exit 0.
var cleanDir = buildTempCopy(null);
var cleanRun = runCopy(cleanDir);
fs.rmSync(cleanDir, { recursive: true, force: true });
var cleanFunctionalLine = /functional (\d+)\/(\d+) PASS/.exec(cleanRun.stdout);
var cleanIsolationLine = /isolation clean (\d+)\/(\d+) PASS/.exec(cleanRun.stdout);
if (cleanRun.status !== 0 || !cleanFunctionalLine || !cleanIsolationLine) {
  console.log('FAIL — 1. unmodified suite must exit 0 with both gates reporting PASS (exit=' + cleanRun.status + ').');
  console.log(cleanRun.stdout.slice(-800));
  allPassed = false;
} else {
  console.log('PASS — 1. unmodified suite: ' + cleanFunctionalLine[0] + ', ' + cleanIsolationLine[0] + ', exit 0.');
}

SCENARIOS.forEach(function (scenario) {
  var dir;
  var run;
  try {
    dir = buildTempCopy(scenario.mutate);
    run = runCopy(dir);
  } catch (e) {
    console.log('FAIL — ' + scenario.label + ': could not build the mutated copy — ' + e.message);
    allPassed = false;
    return;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }

  var functionalLine = /functional (\d+)\/(\d+) (PASS|FAIL)/.exec(run.stdout);
  var isolationLine = /isolation clean (\d+)\/(\d+) (PASS|FAIL)/.exec(run.stdout);
  if (!functionalLine || !isolationLine) {
    console.log('FAIL — ' + scenario.label + ': could not parse the mutated run\'s output.');
    console.log(run.stdout.slice(-800));
    allPassed = false;
    return;
  }

  var functionalStillGreen = functionalLine[1] === functionalLine[2] && functionalLine[3] === 'PASS';
  var isolationDirty = isolationLine[1] !== isolationLine[2] && isolationLine[3] === 'FAIL';
  var exitNonZero = run.status !== 0;
  var ok = functionalStillGreen && isolationDirty && exitNonZero;
  if (!ok) allPassed = false;

  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + scenario.label +
    ': ' + functionalLine[0] + ', ' + isolationLine[0] + ', exit=' + run.status);
  if (!ok) {
    if (!functionalStillGreen) console.log('       (expected the functional gate to stay all-green — this mutation must break isolation only)');
    if (!isolationDirty) console.log('       (expected the isolation gate to report dirty — THIS IS A HOLE IN THE GATE)');
    if (!exitNonZero) console.log('       (expected a non-zero exit code)');
  }
});

console.log('\n' + (allPassed ? 'ISOLATION ENFORCEMENT VERIFICATION: PASS' : 'ISOLATION ENFORCEMENT VERIFICATION: FAIL'));
if (!allPassed) process.exitCode = 1;
