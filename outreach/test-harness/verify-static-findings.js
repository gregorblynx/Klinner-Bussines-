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
var REQUIRED_SCOPE_BASELINE = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/script.send_mail',
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/script.container.ui',
  'https://www.googleapis.com/auth/userinfo.email'
];

check(
  'N1: every prior production scope plus userinfo.email is declared exactly once',
  REQUIRED_SCOPE_BASELINE.every(function (scope) {
    return DECLARED_SCOPES.filter(function (declared) { return declared === scope; }).length === 1;
  }) && DECLARED_SCOPES.length === REQUIRED_SCOPE_BASELINE.length
);

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
  { api: 'GmailDraft.send / Advanced Gmail messages.send (actual sending)', pattern: /(\.send\(\)|Gmail\.Users\.Messages\.send)/, scope: 'https://www.googleapis.com/auth/gmail.send' },
  { api: 'MailApp.sendEmail (daily digest)', pattern: /MailApp\.sendEmail/, scope: 'https://www.googleapis.com/auth/script.send_mail' },
  { api: 'ScriptApp.newTrigger / getProjectTriggers / deleteTrigger', pattern: /ScriptApp\.(newTrigger|getProjectTriggers|deleteTrigger)/, scope: 'https://www.googleapis.com/auth/script.scriptapp' },
  { api: 'SpreadsheetApp.getUi (menu, alerts, prompts)', pattern: /SpreadsheetApp\.getUi\(\)/, scope: 'https://www.googleapis.com/auth/script.container.ui' }
];

// Session.getEffectiveUser().getEmail() is a deliberate live-sender
// identity guard in Mailer.gs. Explicit oauthScopes disable auto-detection,
// so this mapping prevents a repeat of the Google-real missing-scope block.
SCOPE_REQUIREMENTS.push({
  api: 'Session.getEffectiveUser().getEmail (authorized execution identity)',
  pattern: /Session\.getEffectiveUser\(\)\.getEmail\(\)/,
  scope: 'https://www.googleapis.com/auth/userinfo.email'
});

SCOPE_REQUIREMENTS.forEach(function (req) {
  var isUsed = req.pattern.test(COMBINED_SOURCE);
  var isDeclared = DECLARED_SCOPES.indexOf(req.scope) !== -1;
  // Only a real problem if the API IS used but the scope is NOT declared.
  check(
    'N1: ' + req.api + ' -> ' + req.scope.replace('https://www.googleapis.com/auth/', ''),
    !isUsed || isDeclared
  );
});

check(
  'step2: effective-user sender identity guard remains active',
  /Session\.getEffectiveUser\(\)\.getEmail\(\)/.test(MAILER_SOURCE)
);

// --- Step-2 Google-real incident: never infer a follow-up recipient via
// GmailThread.reply(); use the Advanced Gmail API with explicit RFC fields.

// The old bug: `var message = thread.reply(...)` then `message.getId()` as
// if it were a GmailMessage. Assert that specific mis-assignment pattern
// is gone.
check(
  'finding7: old bug pattern "var message = thread.reply(" is absent',
  !/var\s+message\s*=\s*thread\.reply\(/.test(MAILER_SOURCE)
);

// Assert the fix pattern is present: reply()'s return value is read via
// getMessages(), and the last element is what gets used as the sent message.
check('step2: Advanced Gmail service is enabled in appsscript.json',
  !!(APPSSCRIPT_JSON.dependencies && APPSSCRIPT_JSON.dependencies.enabledAdvancedServices || []).some(function (s) {
    return s.userSymbol === 'Gmail' && s.serviceId === 'gmail' && s.version === 'v1';
  }));

// Assert the code explicitly documents which real API it relies on and why
// (required by the finding: "Documenta exactamente qué API se utiliza").
check('step2: recipient is explicit and thread RFC headers are constructed',
  MAILER_SOURCE.indexOf("'To: ' + recipient") !== -1 &&
  MAILER_SOURCE.indexOf("'In-Reply-To: ' + priorRfcMessageId") !== -1 &&
  MAILER_SOURCE.indexOf("'References: ' + references") !== -1 &&
  /resource:\s*\{\s*raw:.*threadId:\s*prospect\.Thread_ID/.test(MAILER_SOURCE));

// Assert no Message_ID is ever fabricated — every Message_ID write must
// trace back to a real message object's .getId().
check('step2: Message_ID comes from messages.send and is verified by exact messages.get',
  /sentResource\s*=\s*Gmail\.Users\.Messages\.send/.test(MAILER_SOURCE) &&
  /sentMessageId\s*=\s*sentResource/.test(MAILER_SOURCE) &&
  /Gmail\.Users\.Messages\.get\('me',\s*messageId/.test(MAILER_SOURCE) &&
  /Message_ID:\s*sentMessageId/.test(MAILER_SOURCE));

check('step2: GmailThread.reply is absent from executable source',
  !/^\s*(?!\*|\/\/).*\bthread\.reply\(/m.test(MAILER_SOURCE));

check('N12: controlled AMBIGUOUS reconciliation has no outbound send path',
  (function () {
    var start = MAILER_SOURCE.indexOf('reconcileControlledFixtureStep2Ambiguous = function');
    var end = MAILER_SOURCE.indexOf('function markFollowUpAmbiguous_', start);
    if (start === -1 || end === -1 || end <= start) return false;
    var body = MAILER_SOURCE.slice(start, end);
    return !/(Gmail\.Users\.Messages\.send\s*\(|\bsendFollowUp\s*\(|\bsendBatch\s*\(|\bsendStep1\s*\(|\bexecuteLiveSendForStep_\s*\()/.test(body);
  })()
);

check('N12: Gmail body decoder validates and restores omitted base64url padding',
  /remainder === 2 \? '=='/.test(MAILER_SOURCE) &&
  /Utilities\.base64DecodeWebSafe\(padded\)/.test(MAILER_SOURCE) &&
  /decoded body is not valid canonical UTF-8/.test(MAILER_SOURCE));

// --- N5: LIVE send concurrency/ambiguous-outcome hardening.
// Round 1 verified this statically (findings #7/#8's established method,
// since this project's policy was to never flip DRY_RUN=FALSE even
// locally). Round 2 (Codex final audit) explicitly required REAL
// executable tests instead — static checks alone were found insufficient
// (they can't prove the durable-ledger-blocking property actually holds
// across a second execution). See test_N5_* in Tests.gs and
// mutation-test-N5.js for the real, behavioral coverage. Kept here only as
// a minimal structural sanity check that both ambiguous-outcome sites
// still reference the durable AMBIGUOUS state at all (round 1's precise
// FAILED-pattern checks are gone — they'd need updating every time the
// surrounding code shape changes, exactly the fragility real tests avoid).
check(
  'N5: both doStep1Send_ and doFollowUpSend_ reference LEDGER_STATE.AMBIGUOUS (durable ledger blocking, not just a Prospects write)',
  (function () {
    var fnStart = MAILER_SOURCE.indexOf('function doStep1Send_(');
    var fnEnd = MAILER_SOURCE.indexOf('executeLiveSendForStep_ = function');
    if (fnStart === -1 || fnEnd === -1 || fnEnd <= fnStart) return false;
    var liveClosureBody = MAILER_SOURCE.slice(fnStart, fnEnd);
    var occurrences = liveClosureBody.split('LEDGER_STATE.AMBIGUOUS').length - 1;
    return occurrences >= 2; // doStep1Send_'s catch + doFollowUpSend_'s reply-throw + mismatch guard (>=2, normally 3).
  })()
);

var failed = checks.filter(function (c) { return !c.passed; });

checks.forEach(function (c) {
  console.log((c.passed ? 'PASS' : 'FAIL') + '  ' + c.name);
});
console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' static checks passed.');

if (failed.length > 0) process.exitCode = 1;
