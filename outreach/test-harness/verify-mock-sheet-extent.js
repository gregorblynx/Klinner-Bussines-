'use strict';
/**
 * Sheets-mock CONTENT EXTENT verification (Codex test-infra round, P2).
 *
 * The whole isolation gate rests on comparing real sheet content, and that
 * comparison is only as trustworthy as the mock's notion of "what content
 * this sheet has". Codex found the two write paths disagreeing about it:
 *
 *   setValues([['']]) at row 1000  ->  getLastRow() unchanged   (correct)
 *   setValue('')      at row 1000  ->  getLastRow() = 1000      (wrong)
 *
 * so whether a blank write extended the content extent depended on which
 * API a caller happened to use. This file pins the rule down directly on
 * the mock — not through production code, which never sees the difference
 * — and then MUTATES the mock to reintroduce the bug and proves a named
 * assertion here turns red. The ghost-row mutation exercises setValues()
 * only, so it could not have caught this on its own.
 *
 * Run: node test-harness/verify-mock-sheet-extent.js
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var Module = require('module');

var MOCKS_PATH = path.join(__dirname, 'gas-mocks.js');

function loadMocks(mutate) {
  var source = fs.readFileSync(MOCKS_PATH, 'utf8');
  if (!mutate) return require(MOCKS_PATH);
  var mutated = mutate(source);
  if (mutated === source) throw new Error('Mutation did not change gas-mocks.js — the anchor may have moved.');
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klinner-mock-extent-'));
  var tmpFile = path.join(tmpDir, 'gas-mocks.js');
  fs.writeFileSync(tmpFile, mutated);
  var loaded = require(tmpFile);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return loaded;
}

/** A bare sheet with a header row and nothing else — content extent = 1. */
function freshSheet(mocks) {
  var sandbox = mocks.buildSandbox();
  var ss = sandbox.SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.insertSheet('ExtentProbe');
  sheet.appendRow(['Header']);
  return sheet;
}

var CASES = [
  {
    name: 'setValue blank at row 1000 does not extend the content extent',
    run: function (sheet) {
      sheet.getRange(1000, 1).setValue('');
      return { actual: sheet.getLastRow(), expected: 1 };
    }
  },
  {
    name: 'setValues blank at row 1000 does not extend the content extent',
    run: function (sheet) {
      sheet.getRange(1000, 1, 1, 1).setValues([['']]);
      return { actual: sheet.getLastRow(), expected: 1 };
    }
  },
  {
    name: 'setValue and setValues agree on a blank write',
    run: function (sheet) {
      sheet.getRange(1000, 1).setValue('');
      var viaSetValue = sheet.getLastRow();
      sheet.getRange(1000, 1, 1, 1).setValues([['']]);
      var viaSetValues = sheet.getLastRow();
      return { actual: viaSetValue + '/' + viaSetValues, expected: '1/1' };
    }
  },
  {
    name: 'setValue(false) counts as content (the checkbox case)',
    run: function (sheet) {
      sheet.getRange(1000, 1).setValue(false);
      return { actual: sheet.getLastRow(), expected: 1000 };
    }
  },
  {
    name: 'setValue(0) counts as content',
    run: function (sheet) {
      sheet.getRange(1000, 1).setValue(0);
      return { actual: sheet.getLastRow(), expected: 1000 };
    }
  },
  {
    name: "setValue('0') counts as content",
    run: function (sheet) {
      sheet.getRange(1000, 1).setValue('0');
      return { actual: sheet.getLastRow(), expected: 1000 };
    }
  },
  {
    name: 'a formula counts as content',
    run: function (sheet) {
      sheet.getRange(1000, 1).setValue('=1+1');
      return { actual: sheet.getLastRow(), expected: 1000 };
    }
  },
  {
    name: 'setValue(null) is blank',
    run: function (sheet) {
      sheet.getRange(1000, 1).setValue(null);
      return { actual: sheet.getLastRow(), expected: 1 };
    }
  },
  {
    name: 'blanking the last content cell SHRINKS the extent back',
    run: function (sheet) {
      sheet.getRange(1000, 1).setValue('real content');
      var grown = sheet.getLastRow();
      sheet.getRange(1000, 1).setValue('');
      return { actual: grown + '->' + sheet.getLastRow(), expected: '1000->1' };
    }
  },
  {
    name: 'blanking a cell does NOT shrink past a row that still holds content',
    run: function (sheet) {
      sheet.getRange(500, 1).setValue('kept');
      sheet.getRange(1000, 1).setValue('temporary');
      sheet.getRange(1000, 1).setValue('');
      return { actual: sheet.getLastRow(), expected: 500 };
    }
  },
  {
    name: 'clearContent on the last content row shrinks the extent',
    run: function (sheet) {
      sheet.getRange(1000, 1).setValue('temporary');
      sheet.getRange(1000, 1, 1, 1).clearContent();
      return { actual: sheet.getLastRow(), expected: 1 };
    }
  },
  {
    name: 'the physical grid still grows even when the content extent does not',
    run: function (sheet) {
      var before = sheet.getMaxRows();
      sheet.getRange(1000, 1).setValue('');
      return { actual: (sheet.getMaxRows() >= 1000) + '/' + (sheet.getLastRow() === 1) + '/' + (before <= 1000), expected: 'true/true/true' };
    }
  }
];

// The mutation: setValue() stops recomputing the content extent, exactly
// as it behaved before this round. setValues() is left correct, so this
// reproduces the INCONSISTENCY rather than a blanket regression.
function mutationSetValueExtendsExtent(source) {
  var anchor = "          finishWrite(sheet); // same content-extent rule as setValues — see finishWrite/isBlankCellValue.";
  if (source.indexOf(anchor) === -1) throw new Error('setValue anchor not found — gas-mocks.js may have changed shape.');
  return source.replace(anchor,
    "          if (sheet.data.length > sheet.physicalRowCount) sheet.physicalRowCount = sheet.data.length; // MUTATION: extent not recomputed.");
}

var MUST_CATCH = [
  'setValue blank at row 1000 does not extend the content extent',
  'setValue and setValues agree on a blank write',
  'blanking the last content cell SHRINKS the extent back'
];

function runCases(mocks) {
  return CASES.map(function (c) {
    var sheet = freshSheet(mocks);
    try {
      var r = c.run(sheet);
      return { name: c.name, passed: String(r.actual) === String(r.expected), actual: r.actual, expected: r.expected };
    } catch (e) {
      return { name: c.name, passed: false, actual: 'THREW: ' + e.message, expected: '(no throw)' };
    }
  });
}

var allPassed = true;
console.log('=== Sheets-mock content-extent verification ===\n');

var baseline = runCases(loadMocks(null));
baseline.forEach(function (r) {
  console.log((r.passed ? 'PASS' : 'FAIL') + '  ' + r.name +
    (r.passed ? '' : '  — expected ' + r.expected + ', got ' + r.actual));
  if (!r.passed) allPassed = false;
});
console.log('\nBaseline: ' + baseline.filter(function (r) { return r.passed; }).length + '/' + baseline.length);

console.log('\n--- Mutation: setValue() stops recomputing the content extent ---');
var mutated;
try {
  mutated = runCases(loadMocks(mutationSetValueExtendsExtent));
} catch (e) {
  console.log('FAIL — the mutation could not be applied: ' + e.message);
  mutated = null;
  allPassed = false;
}

if (mutated) {
  var failedNames = mutated.filter(function (r) { return !r.passed; }).map(function (r) { return r.name; });
  console.log('Mutated: ' + mutated.filter(function (r) { return r.passed; }).length + '/' + mutated.length +
    (failedNames.length ? ' — caught by:\n       - ' + failedNames.join('\n       - ') : ' — *** NOT CAUGHT ***'));
  MUST_CATCH.forEach(function (name) {
    var caught = failedNames.indexOf(name) !== -1;
    console.log((caught ? 'PASS' : 'FAIL') + ' — "' + name + '" must go red under the mutation.');
    if (!caught) allPassed = false;
  });
  // The setValues path must stay green: this is an inconsistency, not a
  // blanket regression, and proving that is what shows the ghost-row
  // mutation (setValues-only) could never have caught it.
  var setValuesCaseStillGreen = mutated.filter(function (r) {
    return r.name === 'setValues blank at row 1000 does not extend the content extent';
  })[0];
  console.log((setValuesCaseStillGreen && setValuesCaseStillGreen.passed ? 'PASS' : 'FAIL') +
    ' — the setValues() path stays correct under the mutation (so a setValues-only test could not catch it).');
  if (!setValuesCaseStillGreen || !setValuesCaseStillGreen.passed) allPassed = false;
}

console.log('\n' + (allPassed ? 'MOCK SHEET EXTENT VERIFICATION: PASS' : 'MOCK SHEET EXTENT VERIFICATION: FAIL'));
if (!allPassed) process.exitCode = 1;
