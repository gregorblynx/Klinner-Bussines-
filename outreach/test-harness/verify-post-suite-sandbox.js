'use strict';
/**
 * INDEPENDENT post-suite sandbox inspection (Codex atomicity round).
 *
 * verifyCleanTestState_ (Tests.gs) checks isolation from INSIDE the suite,
 * using the suite's own snapshot helpers. That is exactly the arrangement
 * that let two leaked Gmail drafts be reported as "clean" in an earlier
 * round: if the checker is blind to a dimension, so is its verdict, and
 * nothing else is looking.
 *
 * This file looks from the outside. It builds the sandbox, captures the
 * whole shared state with its OWN inspection code, runs the ENTIRE suite
 * once, captures it again, and diffs. It shares no helper with Tests.gs
 * beyond the mock objects themselves, so a hole in verifyCleanTestState_
 * cannot hide a leak from it.
 *
 * Exits non-zero on any residue.
 *
 * Run: node test-harness/verify-post-suite-sandbox.js
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

var sandbox = mocks.buildSandbox();
var ctx = vm.createContext(sandbox);
LOAD_ORDER.forEach(function (filename) {
  new vm.Script(fs.readFileSync(path.join(OUTREACH_DIR, filename), 'utf8'), { filename: filename }).runInContext(ctx);
});

function quiet(fn) {
  var real = console.log;
  console.log = function () {};
  try { return fn(); } finally { console.log = real; }
}

quiet(function () { ctx.initializeSheets(); });

// ---------------------------------------------------------------------
// Our OWN inspection. Deliberately does not call snapshotSandboxState_.
// ---------------------------------------------------------------------
var SHEETS = ['Prospects', 'SendLedger', 'Log', 'Suppression', 'Config', 'Templates'];

function sheetDump(name) {
  var sheet = ctx.SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) return 'MISSING_SHEET';
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return '';
  var values = sheet.getRange(1, 1, lastRow, sheet.getMaxColumns()).getValues();
  return JSON.stringify(values.map(function (row) {
    return row.map(function (cell) { return (cell instanceof Date) ? 'D' + cell.getTime() : String(cell); });
  }));
}

/**
 * Our OWN rendering of the shared Config cache, written here rather than
 * imported from Tests.gs on purpose: the point of this file is that a bug
 * in the suite's own isolation helpers cannot hide a leak from it, and
 * reusing configCacheSignature_ would reintroduce exactly that shared
 * failure mode. Distinguishes "nothing cached" from "cached", and renders
 * the full key/value content so a divergent value (the MAX_PER_DAY=999
 * case) shows up as a difference, not just a presence.
 */
function configCacheView() {
  var cache = ctx._configCache;
  if (cache === null || cache === undefined) return 'NULL (nothing cached)';
  var out = [];
  Object.keys(cache).sort().forEach(function (k) { out.push(k + '=' + JSON.stringify(cache[k])); });
  return 'CACHED{' + out.join(';') + '}';
}

function inspect() {
  var G = ctx.GmailApp;
  var drafts = G.getDrafts().map(function (d) {
    try { return d.getId() + ':' + d.getMessage().getSubject(); } catch (e) { return 'UNREADABLE'; }
  }).sort();

  var threads = Object.keys(G._threads).sort().map(function (id) {
    var msgs;
    try { msgs = G._threads[id].getMessages(); } catch (e) { return id + '#UNREADABLE'; }
    return id + '#' + msgs.map(function (m) { return m.getId(); }).join(',');
  });

  var sheetsOut = {};
  SHEETS.forEach(function (n) { sheetsOut[n] = sheetDump(n); });

  var lockHeld = false;
  try {
    var l = ctx.LockService.getScriptLock();
    lockHeld = (typeof l.hasLock === 'function') ? l.hasLock() : false;
  } catch (e) { lockHeld = 'UNKNOWN'; }

  return {
    drafts: drafts,
    threads: threads,
    messageCount: threads.reduce(function (n, t) {
      var part = t.split('#')[1];
      return n + (part && part !== 'UNREADABLE' ? part.split(',').length : 0);
    }, 0),
    labels: G._labelNames().sort(),
    sentIndex: G._sentIndex.map(function (e) { return e.recipientEmail + '>' + e.thread.getId(); }).sort(),
    callCounts: JSON.stringify(G._callCounts),
    configCache: configCacheView(),
    sheets: sheetsOut,
    lockHeld: lockHeld,
    patched: {
      'GmailApp.createDraft': G.createDraft,
      'GmailApp.getDrafts': G.getDrafts,
      'GmailApp.search': G.search,
      'GmailApp.getThreadById': G.getThreadById,
      'GmailApp.createLabel': G.createLabel,
      'appendLedgerRow_': ctx.appendLedgerRow_,
      'updateLedgerRow_': ctx.updateLedgerRow_,
      'writeLedgerMetadataThenState_': ctx.writeLedgerMetadataThenState_,
      'getLedgerSheet_': ctx.getLedgerSheet_,
      'writeRowById_': ctx.writeRowById_
    }
  };
}

var before = inspect();
var suite = quiet(function () { return ctx.runAllF1Tests(); });
var after = inspect();

console.log('=== Independent post-suite sandbox inspection ===\n');
console.log('Suite: functional ' + suite.passed + '/' + suite.total +
  ', isolation clean ' + suite.isolationCleanCount + '/' + suite.total + '\n');

var problems = [];

function compareList(label, a, b) {
  var same = a.length === b.length && a.every(function (v, i) { return v === b[i]; });
  console.log((same ? 'OK  ' : 'LEAK') + '  ' + label + ': before=' + a.length + ' after=' + b.length);
  if (!same) {
    var extra = b.filter(function (v) { return a.indexOf(v) === -1; });
    var missing = a.filter(function (v) { return b.indexOf(v) === -1; });
    if (extra.length) console.log('        extra:   ' + extra.slice(0, 5).join(', '));
    if (missing.length) console.log('        missing: ' + missing.slice(0, 5).join(', '));
    problems.push(label);
  }
}

function brief(v) {
  var str = String(v);
  return str.length > 90 ? str.slice(0, 90) + '... (' + str.length + ' chars)' : str;
}

function compareValue(label, a, b) {
  var same = a === b;
  console.log((same ? 'OK  ' : 'LEAK') + '  ' + label + ': ' +
    (same ? 'identical [' + brief(a) + ']' : 'before=' + brief(a) + ' | after=' + brief(b)));
  if (!same) problems.push(label);
}

compareList('Gmail drafts', before.drafts, after.drafts);
compareList('Gmail threads', before.threads, after.threads);
compareValue('Gmail messages (total across threads)', before.messageCount, after.messageCount);
compareList('Gmail labels', before.labels, after.labels);
compareList('Gmail sent index', before.sentIndex, after.sentIndex);
compareValue('Gmail call counters', before.callCounts, after.callCounts);
compareValue('_configCache', before.configCache, after.configCache);
SHEETS.forEach(function (n) { compareValue(n + ' sheet content', before.sheets[n], after.sheets[n]); });

// Independent coherence check: whatever is cached at the end must agree
// with what the Config SHEET actually says. A restored-but-wrong cache
// would pass the before/after comparison above and fail this one.
(function () {
  var cache = ctx._configCache;
  if (cache === null || cache === undefined) {
    console.log('OK    _configCache coherence: nothing cached, so nothing can diverge from the Config sheet');
    return;
  }
  var saved = cache;
  ctx._configCache = null;
  var fresh;
  try { fresh = ctx.getConfig(); } finally { ctx._configCache = saved; }
  var mismatched = Object.keys(saved).filter(function (k) {
    return JSON.stringify(saved[k]) !== JSON.stringify(fresh[k]);
  });
  var ok = mismatched.length === 0;
  console.log((ok ? 'OK  ' : 'LEAK') + '  _configCache coherence with the Config sheet: ' +
    (ok ? 'every cached key matches' : 'DIVERGENT keys: ' + mismatched.join(', ')));
  if (!ok) problems.push('_configCache diverges from the Config sheet');
})();
compareValue('script lock held', before.lockHeld, after.lockHeld);

var patchedNames = Object.keys(before.patched).filter(function (n) { return before.patched[n] !== after.patched[n]; });
console.log((patchedNames.length === 0 ? 'OK  ' : 'LEAK') + '  patched functions restored: ' +
  (patchedNames.length === 0 ? 'all ' + Object.keys(before.patched).length : 'NOT restored: ' + patchedNames.join(', ')));
if (patchedNames.length > 0) problems.push('patched functions');

if (suite.passed !== suite.total) problems.push('functional gate (' + suite.passed + '/' + suite.total + ')');
if (suite.isolationCleanCount !== suite.total) problems.push('suite-internal isolation gate');

console.log('\n' + (problems.length === 0
  ? 'POST-SUITE SANDBOX INSPECTION: PASS — every dimension is byte-identical to the pre-suite baseline.'
  : 'POST-SUITE SANDBOX INSPECTION: FAIL — ' + problems.join('; ')));
if (problems.length > 0) process.exitCode = 1;
