'use strict';
/**
 * Loads the REAL outreach/*.gs source files (unmodified — no transpilation,
 * no rewriting) into a Node vm context wired up with mocked GAS services,
 * then calls the SAME runAllF1Tests() function that ships in Tests.gs.
 *
 * This is honest local verification of pure logic (state machine, origin
 * guards, business-day math, template rendering, idempotency bookkeeping)
 * against a mocked Sheets/Gmail. It is NOT proof of behavior against real
 * Google APIs — see the delivery report for what still needs Google real.
 */

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var mocks = require('./gas-mocks');

var OUTREACH_DIR = path.join(__dirname, '..');

var LOAD_ORDER = [
  'Constants.gs',
  'Config.gs',
  'Log.gs',
  'SheetRepo.gs',
  'Schedule.gs',
  'Suppression.gs',
  'Templates.gs',
  'Validate.gs',
  'StateMachine.gs',
  'Ledger.gs',
  'ReplySync.gs',
  'Recon.gs',
  'Mailer.gs',
  'Digest.gs',
  'Menu.gs',
  'Triggers.gs',
  'Tests.gs'
];

function main() {
  var sandbox = mocks.buildSandbox();
  var context = vm.createContext(sandbox);

  LOAD_ORDER.forEach(function (filename) {
    var fullPath = path.join(OUTREACH_DIR, filename);
    var source = fs.readFileSync(fullPath, 'utf8');
    var script = new vm.Script(source, { filename: filename });
    script.runInContext(context);
  });

  console.log('Loaded ' + LOAD_ORDER.length + ' source files into the mock GAS sandbox with zero errors.\n');

  context.initializeSheets();
  console.log('initializeSheets() ran cleanly against mocked Sheets.\n');

  var result = context.runAllF1Tests();

  console.log('\n=== Klinner Outreach — local F1 test run (mocked Sheets/Gmail) ===');
  console.log(result.report);

  // Priority 3 (Codex final audit): functional pass/fail and isolation
  // clean/leaked are TWO SEPARATE gates. Before this fix, a test could
  // leak state (leftover Prospects/SendLedger/Log rows, an undeleted
  // draft, a permanently-broken mock method) into every test that ran
  // after it — silently, because the runner's exit code only ever looked
  // at `passed !== total`. A leak that happened not to flip any later
  // test's assertions to FAIL (or one in the very last test, with nothing
  // after it to corrupt) would exit 0 even with isolationCleanCount below
  // total. Both counts are now checked independently and BOTH must be
  // clean for a green exit.
  var functionalOk = result.passed === result.total;
  var isolationOk = result.isolationCleanCount === result.total;

  console.log('\nfunctional ' + result.passed + '/' + result.total + ' ' + (functionalOk ? 'PASS' : 'FAIL'));
  console.log('isolation clean ' + result.isolationCleanCount + '/' + result.total + ' ' + (isolationOk ? 'PASS' : 'FAIL'));

  if (!functionalOk || !isolationOk) {
    process.exitCode = 1;
  }
}

main();
