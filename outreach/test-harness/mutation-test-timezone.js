'use strict';
/**
 * Timezone-independence mutation test. Proves three fixes found by
 * tonight's timezone audits are load-bearing:
 *
 *   A. addCalendarDays_ (Schedule.gs) reverted to the old raw
 *      Date.getDate()/setDate() implementation (environment-timezone-
 *      relative instead of America/Chicago-relative).
 *   B. The mock Utilities.formatDate (gas-mocks.js) reverted to ignoring
 *      its `tz` argument and using raw JS Date getters instead.
 *   C. (Round 2, Codex final audit) dateFromWallClock_ (Schedule.gs)
 *      reverted to the old single-shot offset lookup (no fixed-point
 *      iteration) — wrong for any wall clock close enough to a DST
 *      transition that the neutral instant and the true target instant
 *      fall on opposite sides of the transition moment. Confirmed
 *      concretely: 2026-03-08 03:30 used to resolve to 04:30; 2026-11-01
 *      02:30 used to resolve to 01:30.
 *
 * Mutations A and B are run with process.env.TZ forced to Asia/Kolkata
 * (UTC+5:30, no DST) — an offset large enough to cross a day boundary for
 * the T16 fixture — so this test is deliberately NOT dependent on the
 * timezone of whatever machine happens to run it. Mutation C is a DST
 * transition bug, not a host-timezone bug, so it reproduces identically
 * regardless of host TZ — run under the host's own default (no override).
 *
 * Run: node test-harness/mutation-test-timezone.js
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

// --- Mutation A: revert addCalendarDays_ to the old environment-relative implementation. ---
var NEW_ADD_CALENDAR_DAYS =
  "function addCalendarDays_(date, days) {\n" +
  "  var tz = getScriptTimeZone_();\n" +
  "  var c = wallClockComponents_(date, tz);\n" +
  "  var y = Number(c.ymd.substring(0, 4));\n" +
  "  var mo = Number(c.ymd.substring(5, 7)) - 1;\n" +
  "  var d = Number(c.ymd.substring(8, 10)) + days;\n" +
  "  return dateFromWallClock_(y, mo, d, Number(c.hh), Number(c.mi), Number(c.ss), tz);\n" +
  "}";
var OLD_ADD_CALENDAR_DAYS =
  "function addCalendarDays_(date, days) {\n" +
  "  // MUTATION A: old environment-timezone-relative implementation.\n" +
  "  var d = new Date(date.getTime());\n" +
  "  d.setDate(d.getDate() + days);\n" +
  "  return d;\n" +
  "}";
function mutationA_revertToEnvironmentRelative(source) {
  return replaceOrThrow(source, 'A', NEW_ADD_CALENDAR_DAYS, OLD_ADD_CALENDAR_DAYS);
}

// --- Mutation B: revert the mock's formatDate to ignore `tz`. ---
function mutationB_mockIgnoresTz(mocksSource) {
  var marker = 'formatDate: function (date, tz, pattern) {';
  if (mocksSource.indexOf(marker) === -1) throw new Error('Mutation B: marker not found — gas-mocks.js may have changed shape.');
  var start = mocksSource.indexOf(marker);
  var end = mocksSource.indexOf('\n    },', start);
  if (end === -1) throw new Error('Mutation B: end marker not found.');
  var oldBlock =
    "formatDate: function (date, tz, pattern) {\n" +
    "      // MUTATION B: ignores `tz` entirely — raw JS Date getters (environment-relative).\n" +
    "      var d = new Date(date.getTime());\n" +
    "      var pad = function (n) { return String(n).length < 2 ? '0' + n : String(n); };\n" +
    "      if (pattern === 'yyyy-MM-dd') return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());\n" +
    "      if (pattern === 'u') { var jsDay = d.getDay(); return String(jsDay === 0 ? 7 : jsDay); }\n" +
    "      if (pattern === 'H') return String(d.getHours());\n" +
    "      if (pattern === 'HH') { var hh = d.getHours(); return (hh < 10 ? '0' : '') + hh; }\n" +
    "      if (pattern === 'mm') { var mi = d.getMinutes(); return (mi < 10 ? '0' : '') + mi; }\n" +
    "      if (pattern === 'ss') { var ss = d.getSeconds(); return (ss < 10 ? '0' : '') + ss; }\n" +
    "      if (pattern === 'EEE') { var names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']; return names[d.getDay()]; }\n" +
    "      throw new Error('Mock Utilities.formatDate: unsupported pattern \"' + pattern + '\"');\n" +
    "    }";
  return mocksSource.slice(0, start) + oldBlock + mocksSource.slice(end + 6);
}

// --- Mutation C: revert dateFromWallClock_ to the old single-shot (non-iterative) DST-broken lookup. ---
var NEW_DATE_FROM_WALL_CLOCK =
  "function dateFromWallClock_(y, mo, d, hh, mi, ss, tz) {\n" +
  "  var neutral = new Date(Date.UTC(y, mo, d, hh, mi, ss));\n" +
  "  var candidate = neutral;\n" +
  "  var previous = null;\n" +
  "  var MAX_ITERATIONS = 6; // Defensive only — real IANA zones converge or oscillate within 3.\n" +
  "  for (var i = 0; i < MAX_ITERATIONS; i++) {\n" +
  "    var offsetMinutes = timezoneOffsetMinutes_(candidate, tz);\n" +
  "    var next = new Date(neutral.getTime() - offsetMinutes * 60000);\n" +
  "    if (next.getTime() === candidate.getTime()) return next; // Converged: valid, unambiguous (or ambiguous-resolved) wall clock.\n" +
  "    if (previous !== null && next.getTime() === previous.getTime()) {\n" +
  "      // Oscillating between exactly two candidates: the wall clock does\n" +
  "      // not exist (DST gap). Policy: resolve to the LATER of the two.\n" +
  "      return next.getTime() > candidate.getTime() ? next : candidate;\n" +
  "    }\n" +
  "    previous = candidate;\n" +
  "    candidate = next;\n" +
  "  }\n" +
  "  // Unreachable for any real IANA timezone (see MAX_ITERATIONS comment) —\n" +
  "  // fail loud rather than silently return an unverified guess.\n" +
  "  throw new Error('dateFromWallClock_: offset resolution did not converge for ' +\n" +
  "    y + '-' + (mo + 1) + '-' + d + ' ' + hh + ':' + mi + ':' + ss + ' in ' + tz);\n" +
  "}";
var OLD_DATE_FROM_WALL_CLOCK =
  "function dateFromWallClock_(y, mo, d, hh, mi, ss, tz) {\n" +
  "  // MUTATION C: old single-shot lookup — offset computed ONCE at the\n" +
  "  // neutral (literal-UTC) instant, wrong near a DST transition.\n" +
  "  var neutral = new Date(Date.UTC(y, mo, d, hh, mi, ss));\n" +
  "  var offsetMinutes = timezoneOffsetMinutes_(neutral, tz);\n" +
  "  return new Date(neutral.getTime() - offsetMinutes * 60000);\n" +
  "}";
function mutationC_revertToSingleShotDstBroken(source) {
  return replaceOrThrow(source, 'C', NEW_DATE_FROM_WALL_CLOCK, OLD_DATE_FROM_WALL_CLOCK);
}

var allPassed = true;
console.log('=== Timezone-independence mutation test ===\n');

var originalTz = process.env.TZ;
process.env.TZ = 'Asia/Kolkata'; // Forced regardless of the host machine — see docstring.

try {
  var baseline = runSuite(null);
  console.log('Baseline (no mutation, TZ=Asia/Kolkata forced): ' + baseline.passed + '/' + baseline.total);
  if (baseline.passed !== baseline.total) { console.log('FAIL — baseline suite is not green under a non-Chicago TZ.'); allPassed = false; }

  // Mutation A (Schedule.gs)
  var mutatedA;
  try {
    mutatedA = runSuite({ 'Schedule.gs': mutationA_revertToEnvironmentRelative });
  } catch (e) {
    console.log('Mutation A: THREW — ' + e.message);
    allPassed = false;
    mutatedA = null;
  }
  if (mutatedA) {
    var failedA = mutatedA.results.filter(function (r) { return !r.passed; }).map(function (r) { return r.name; });
    console.log('Mutation A (addCalendarDays_ reverted): ' + mutatedA.passed + '/' + mutatedA.total +
      (failedA.length ? ' — caught by: ' + failedA.join(', ') : ' — *** NOT CAUGHT ***'));
    if (failedA.indexOf('T16_T17') === -1 && failedA.indexOf('timezoneAudit_dateMath') === -1) {
      console.log('FAIL — T16_T17 or timezoneAudit_dateMath must catch this mutation.');
      allPassed = false;
    } else {
      console.log('PASS — caught the regression.');
    }
  }

  // Mutation B (gas-mocks.js) — mutate the mocks MODULE SOURCE, not loaded via
  // require() (already cached); load it fresh via vm instead so the LOAD_ORDER
  // .gs files still use the mutated mock implementation.
  var mocksSource = fs.readFileSync(path.join(__dirname, 'gas-mocks.js'), 'utf8');
  var mutatedMocksSource;
  try {
    mutatedMocksSource = mutationB_mockIgnoresTz(mocksSource);
  } catch (e) {
    console.log('Mutation B: THREW — ' + e.message);
    allPassed = false;
    mutatedMocksSource = null;
  }
  if (mutatedMocksSource) {
    var mocksModule = { exports: {} };
    var mocksFn = new Function('module', 'exports', 'require', '__dirname', mutatedMocksSource);
    mocksFn(mocksModule, mocksModule.exports, require, __dirname);
    var mutatedMocks = mocksModule.exports;

    var sandboxB = mutatedMocks.buildSandbox();
    var contextB = vm.createContext(sandboxB);
    LOAD_ORDER.forEach(function (filename) {
      var src = fs.readFileSync(path.join(OUTREACH_DIR, filename), 'utf8');
      new vm.Script(src, { filename: filename }).runInContext(contextB);
    });
    var originalLog = console.log;
    console.log = function () {};
    contextB.initializeSheets();
    var mutatedB = contextB.runAllF1Tests();
    console.log = originalLog;

    var failedB = mutatedB.results.filter(function (r) { return !r.passed; }).map(function (r) { return r.name; });
    console.log('Mutation B (mock formatDate ignores tz): ' + mutatedB.passed + '/' + mutatedB.total +
      (failedB.length ? ' — caught by: ' + failedB.join(', ') : ' — *** NOT CAUGHT ***'));
    if (failedB.indexOf('T16_T17') === -1 && failedB.indexOf('timezoneAudit_dateMath') === -1) {
      console.log('FAIL — T16_T17 or timezoneAudit_dateMath must catch this mutation.');
      allPassed = false;
    } else {
      console.log('PASS — caught the regression.');
    }
  }

  var restored = runSuite(null);
  console.log('Restored (unmutated, TZ=Asia/Kolkata still forced): ' + restored.passed + '/' + restored.total);
  if (restored.passed !== restored.total) { console.log('FAIL — restoring the original source did not return the suite to green.'); allPassed = false; }
} finally {
  if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
}

// Mutation C (Schedule.gs) — DST bug, not a host-timezone bug: run under
// whatever TZ this process already has (no override needed or wanted).
var mutatedC;
try {
  mutatedC = runSuite({ 'Schedule.gs': mutationC_revertToSingleShotDstBroken });
} catch (e) {
  console.log('Mutation C: THREW — ' + e.message);
  allPassed = false;
  mutatedC = null;
}
if (mutatedC) {
  var failedC = mutatedC.results.filter(function (r) { return !r.passed; }).map(function (r) { return r.name; });
  console.log('Mutation C (dateFromWallClock_ reverted to single-shot): ' + mutatedC.passed + '/' + mutatedC.total +
    (failedC.length ? ' — caught by: ' + failedC.join(', ') : ' — *** NOT CAUGHT ***'));
  if (failedC.indexOf('dstAudit_validWallClocks') === -1) {
    console.log('FAIL — dstAudit_validWallClocks must catch this mutation.');
    allPassed = false;
  } else {
    console.log('PASS — caught the regression.');
  }
}

var restoredC = runSuite(null);
console.log('Restored (unmutated, host TZ): ' + restoredC.passed + '/' + restoredC.total);
if (restoredC.passed !== restoredC.total) { console.log('FAIL — restoring the original source did not return the suite to green.'); allPassed = false; }

console.log('\n' + (allPassed ? 'TIMEZONE MUTATION TEST: PASS' : 'TIMEZONE MUTATION TEST: FAIL'));
if (!allPassed) process.exitCode = 1;
