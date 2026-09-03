'use strict';
/**
 * Static source-text checks for Codex audit findings that cannot be
 * exercised behaviorally without flipping DRY_RUN=FALSE and touching a
 * real Gmail thread — which this delivery must not do (finding #7's
 * GmailThread.reply() return-value fix, specifically). Per the finding's
 * own text ("Añade test estático/unitario correspondiente"), a static
 * check is the explicitly acceptable option here.
 *
 * This is NOT a replacement for real testing once F2 is authorized against
 * a real Google account — it only proves the SOURCE no longer contains the
 * bug pattern and DOES contain the documented fix pattern.
 */

var fs = require('fs');
var path = require('path');

var OUTREACH_DIR = path.join(__dirname, '..');
var MAILER_SOURCE = fs.readFileSync(path.join(OUTREACH_DIR, 'Mailer.gs'), 'utf8');

var checks = [];
function check(name, condition) {
  checks.push({ name: name, passed: !!condition });
}

// ---------------------------------------------------------------------------
// N1: appsscript.json oauthScopes vs. actual API usage.
// Menu.gs calls SpreadsheetApp.getUi() to build the menu and drive every
// alert()/prompt() — that requires script.container.ui, which a prior
// version of appsscript.json omitted (an explicit oauthScopes list turns
// off Google's scope auto-detection, so a missing entry is a real bug, not
// a formality). This check fails loudly if that scope ever disappears
// again, and cross-checks the rest of the declared list against actual
// usage so a real gap doesn't go unnoticed a second time.
// ---------------------------------------------------------------------------

var APPSSCRIPT_JSON = JSON.parse(fs.readFileSync(path.join(OUTREACH_DIR, 'appsscript.json'), 'utf8'));
var DECLARED_SCOPES = APPSSCRIPT_JSON.oauthScopes || [];

var ALL_GS_SOURCE = {};
fs.readdirSync(OUTREACH_DIR).filter(function (f) { return f.endsWith('.gs'); }).forEach(function (f) {
  ALL_GS_SOURCE[f] = fs.readFileSync(path.join(OUTREACH_DIR, f), 'utf8');
});
var COMBINED_SOURCE = Object.keys(ALL_GS_SOURCE).map(function (f) { return ALL_GS_SOURCE[f]; }).join('\n');
// Test-only code (Tests.gs) doesn't need production scopes on its own, but
// exercising getUi()-driven Menu.gs functions still requires it — so it is
// intentionally included in the scan, not excluded.

check(
  'N1: appsscript.json declares script.container.ui (required by Menu.gs\'s SpreadsheetApp.getUi())',
  DECLARED_SCOPES.indexOf('https://www.googleapis.com/auth/script.container.ui') !== -1
);

check(
  'N1: Menu.gs actually uses SpreadsheetApp.getUi() (i.e. the scope above is not dead weight)',
  /SpreadsheetApp\.getUi\(\)/.test(ALL_GS_SOURCE['Menu.gs'] || '')
);

// Full scope-usage cross-reference: every API family this codebase calls
// must have its corresponding scope declared. Each entry is a real API
// pattern found via `grep` against the source, mapped to the scope it
// requires per Google's documented Apps Script scope reference.
var SCOPE_REQUIREMENTS = [
  { api: 'SpreadsheetApp (sheets read/write)', pattern: /SpreadsheetApp\.(getActiveSpreadsheet|getRange|newDataValidation|getActiveSheet)/, scope: 'https://www.googleapis.com/auth/spreadsheets' },
  { api: 'GmailApp.createDraft / GmailThread.createDraftReply / GmailDraft.deleteDraft', pattern: /(GmailApp\.createDraft|\.createDraftReply\(|\.deleteDraft\()/, scope: 'https://www.googleapis.com/auth/gmail.compose' },
  { api: 'GmailApp.getThreadById / .search / GmailThread.addLabel / label read-modify', pattern: /(GmailApp\.getThreadById|GmailApp\.search|\.addLabel\(|GmailApp\.(createLabel|getUserLabelByName))/, scope: 'https://www.googleapis.com/auth/gmail.modify' },
  { api: 'GmailDraft.send / GmailThread.reply (actual sending)', pattern: /(\.send\(\)|\.reply\()/, scope: 'https://www.googleapis.com/auth/gmail.send' },
  { api: 'MailApp.sendEmail (daily digest)', pattern: /MailApp\.sendEmail/, scope: 'https://www.googleapis.com/auth/script.send_mail' },
  { api: 'ScriptApp.newTrigger / getProjectTriggers / deleteTrigger', pattern: /ScriptApp\.(newTrigger|getProjectTriggers|deleteTrigger)/, scope: 'https://www.googleapis.com/auth/script.scriptapp' },
  { api: 'SpreadsheetApp.getUi (menu, alerts, prompts)', pattern: /SpreadsheetApp\.getUi\(\)/, scope: 'https://www.googleapis.com/auth/script.container.ui' }
];

SCOPE_REQUIREMENTS.forEach(function (req) {
  var isUsed = req.pattern.test(COMBINED_SOURCE);
  var isDeclared = DECLARED_SCOPES.indexOf(req.scope) !== -1;
  // Only a real problem if the API IS used but the scope is NOT declared.
  check(
    'N1: ' + req.api + ' -> ' + req.scope.replace('https://www.googleapis.com/auth/', ''),
    !isUsed || isDeclared
  );
});

// --- Finding #7: GmailThread.reply() returns GmailThread, not GmailMessage.

// The old bug: `var message = thread.reply(...)` then `message.getId()` as
// if it were a GmailMessage. Assert that specific mis-assignment pattern
// is gone.
check(
  'finding7: old bug pattern "var message = thread.reply(" is absent',
  !/var\s+message\s*=\s*thread\.reply\(/.test(MAILER_SOURCE)
);

// Assert the fix pattern is present: reply()'s return value is read via
// getMessages(), and the last element is what gets used as the sent message.
check(
  'finding7: reply() result is used via getMessages() (fix pattern present)',
  /repliedThread\s*=\s*thread\.reply\(/.test(MAILER_SOURCE) &&
  /messagesAfter\s*=\s*repliedThread\.getMessages\(\)/.test(MAILER_SOURCE) &&
  /messagesAfter\[messagesAfter\.length\s*-\s*1\]/.test(MAILER_SOURCE)
);

// Assert the code explicitly documents which real API it relies on and why
// (required by the finding: "Documenta exactamente qué API se utiliza").
check(
  'finding7: fix is documented inline with the real API it depends on',
  /GmailThread\.reply\(body\) returns the GmailThread/.test(MAILER_SOURCE) &&
  /NOT a GmailMessage/.test(MAILER_SOURCE) &&
  MAILER_SOURCE.indexOf('GmailThread.getMessages()') !== -1
);

// Assert no Message_ID is ever fabricated — every Message_ID write must
// trace back to a real message object's .getId().
check(
  'finding7: no invented Message_ID — sentMessage always comes from a real message object',
  /var\s+sentMessage\s*=\s*messagesAfter\[messagesAfter\.length\s*-\s*1\];/.test(MAILER_SOURCE) &&
  /Message_ID:\s*sentMessage\.getId\(\)/.test(MAILER_SOURCE)
);

// --- N5: LIVE send concurrency/ambiguous-outcome hardening. Like finding
// #7/#8 above, doStep1Send_/doFollowUpSend_ are LIVE-only and this project's
// own established policy (see Tests.gs's comment on findings #7/#8) is to
// never flip DRY_RUN=FALSE even in the local mock harness — so these are
// verified statically, the same accepted method already used for #7/#8.

// doStep1Send_'s send() failure handler must route the prospect into
// NEEDS_REVIEW (not leave it silently retryable) — proves the ambiguous-
// outcome fix is actually wired to the one call site that can duplicate a
// real step-1 send.
check(
  'N5: doStep1Send_\'s send() failure handler writes Status: STATUS.NEEDS_REVIEW (ambiguous-outcome fix)',
  (function () {
    var fnStart = MAILER_SOURCE.indexOf('function doStep1Send_(');
    var fnEnd = MAILER_SOURCE.indexOf('function doFollowUpSend_(');
    if (fnStart === -1 || fnEnd === -1 || fnEnd <= fnStart) return false;
    var fnBody = MAILER_SOURCE.slice(fnStart, fnEnd);
    var catchStart = fnBody.indexOf('catch (sendError)');
    if (catchStart === -1) return false;
    var catchBody = fnBody.slice(catchStart);
    return /LEDGER_STATE\.FAILED/.test(catchBody) &&
      /Status:\s*STATUS\.NEEDS_REVIEW/.test(catchBody) &&
      /origin:\s*ORIGIN\.PIPELINE,\s*operation:\s*OPERATION\.PIPELINE_SEND/.test(catchBody);
  })()
);

// doFollowUpSend_'s message-count-mismatch guard (the documented N5 race)
// must ALSO route the prospect into NEEDS_REVIEW, not just mark the ledger
// row FAILED (which alone would still be automatically retryable).
check(
  'N5: doFollowUpSend_\'s message-count-mismatch guard writes Status: STATUS.NEEDS_REVIEW (closes the documented race)',
  (function () {
    var fnStart = MAILER_SOURCE.indexOf('function doFollowUpSend_(');
    var fnEnd = MAILER_SOURCE.indexOf('executeLiveSendForStep_ = function');
    if (fnStart === -1 || fnEnd === -1 || fnEnd <= fnStart) return false;
    var fnBody = MAILER_SOURCE.slice(fnStart, fnEnd);
    var guardStart = fnBody.indexOf('messagesAfter.length !== messagesBefore + 1');
    if (guardStart === -1) return false;
    var guardBody = fnBody.slice(guardStart, guardStart + 1500);
    return /LEDGER_STATE\.FAILED/.test(guardBody) &&
      /Status:\s*STATUS\.NEEDS_REVIEW/.test(guardBody) &&
      /origin:\s*ORIGIN\.PIPELINE,\s*operation:\s*OPERATION\.PIPELINE_SEND/.test(guardBody);
  })()
);

// The old, unsafe pattern (throw immediately with NO Prospects write, only
// a bare ledger FAILED mark) must be gone from the mismatch guard.
check(
  'N5: the old un-guarded "throw new Error(...)" with no NEEDS_REVIEW write is gone from the mismatch guard',
  !/Error:\s*'Unexpected message count after reply\(\)\.'\s*\}\);\s*\n\s*throw new Error/.test(MAILER_SOURCE)
);

var failed = checks.filter(function (c) { return !c.passed; });

checks.forEach(function (c) {
  console.log((c.passed ? 'PASS' : 'FAIL') + '  ' + c.name);
});
console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' static checks passed.');

if (failed.length > 0) process.exitCode = 1;
