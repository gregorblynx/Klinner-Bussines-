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
  console.log('\n' + result.passed + '/' + result.total + ' passed.');

  if (result.passed !== result.total) {
    process.exitCode = 1;
  }
}

main();
