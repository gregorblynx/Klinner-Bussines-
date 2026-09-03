/**
 * Klinner Outreach — Tests.gs
 * F1 test suite. Runs INSIDE Apps Script against a real (ideally dedicated
 * test-copy) bound spreadsheet. Every test row it creates is tagged
 * Source="TEST_F1_AUTOMATED" and is removed by cleanupTestRows_() at the
 * end of the run — including any Suppression rows it created.
 *
 * Run runAllF1Tests() from the Apps Script editor. It requires:
 *   - initializeSheets() to have been run at least once
 *   - Templates populated (the seed templates from SheetRepo.gs are enough)
 *
 * Tests that require creating a REAL Gmail thread first (to exercise the
 * "reply on a real thread" branch of previewStep, or actual reply/bounce
 * detection) are marked NEEDS_LIVE_THREAD and are skipped by default —
 * see the final delivery report for exactly which tests fall in that
 * category and why they cannot be verified from this environment.
 */

var TEST_SOURCE_MARKER = 'TEST_F1_AUTOMATED';
var _testCreatedSuppressionValues = []; // scope=email rows tests created — tracked by Value.
var _testCreatedDomainSuppressionValues_ = []; // scope=domain rows tests created — tracked separately (different Scope).

function assert_(condition, message) {
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

function assertEquals_(expected, actual, message) {
  if (expected !== actual) {
    throw new Error('ASSERTION FAILED: ' + message + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

/** Appends a raw test row directly to Prospects, bypassing validation, for test setup. */
function addTestProspectRow_(overrides) {
  var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
  var base = {
    Prospect_ID: '', Date_Added: '', Source: TEST_SOURCE_MARKER,
    Business_Name: 'Test Business', Contact_Name: 'Test Contact', Email: 'test@example-corp.com',
    Email_Normalized: '', Domain: '', Domain_Type: '', Website: '', City: 'Austin', State: 'TX',
    Problem_Found: 'Test problem found.', Personalization_Line: '',
    Stop_Contact: false, Do_Not_Contact_Reason: '', Notes: '', Outcome: '',
    Status: '', Sequence_Step: 0, Next_Action_Date: '', Last_Contacted: '',
    Step1_Sent_At: '', Step2_Sent_At: '', Step3_Sent_At: '', Step4_Sent_At: '',
    Replied: false, Replied_At: '', Thread_ID: '', Last_Message_ID: '',
    Error_Count: 0, Last_Error: '', Last_Run_ID: ''
  };
  var merged = Object.assign({}, base, overrides || {});
  var row = PROSPECTS_COLUMN_ORDER.map(function (col) { return merged[col]; });
  sheet.appendRow(row);
  return sheet.getLastRow();
}

function getTestProspectByRow_(rowIndex) {
  var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
  var raw = sheet.getRange(rowIndex, 1, 1, PROSPECTS_LAST_COL).getValues()[0];
  return rowArrayToObject_(raw);
}

/**
 * Writes directly to one Prospects cell, bypassing writeRowById_ entirely —
 * for simulating an unmediated human edit to a non-protected column (O, P,
 * Q, R), which the origin/operation system was never meant to govern in
 * the first place. Never use this to simulate a system write to S:AG.
 */
function setRawCellForTest_(rowIndex, columnName, value) {
  var col = PROSPECTS_COLUMNS[columnName];
  if (!col) throw new Error('setRawCellForTest_: unknown column "' + columnName + '".');
  getSheet_(SHEET_NAMES.PROSPECTS).getRange(rowIndex, col).setValue(value);
}

/** Removes every row tagged TEST_SOURCE_MARKER (bottom-up) and any Suppression rows tests created. */
function cleanupTestRows_() {
  var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var sourceCol = sheet.getRange(2, PROSPECTS_COLUMNS.Source, lastRow - 1, 1).getValues();
    for (var i = sourceCol.length - 1; i >= 0; i--) {
      if (sourceCol[i][0] === TEST_SOURCE_MARKER) sheet.deleteRow(i + 2);
    }
  }
  cleanupTrackedSuppressionRows_();
}

/**
 * Removes Suppression rows tracked in _testCreatedSuppressionValues
 * (scope=email) and _testCreatedDomainSuppressionValues_ (scope=domain),
 * matching on (Value, Scope) together so an email string and a domain
 * string never accidentally cross-match. Clears both tracking arrays.
 */
function cleanupTrackedSuppressionRows_() {
  if (_testCreatedSuppressionValues.length > 0 || _testCreatedDomainSuppressionValues_.length > 0) {
    var supSheet = getSheet_(SHEET_NAMES.SUPPRESSION);
    var supLast = supSheet.getLastRow();
    if (supLast >= 2) {
      var rows = supSheet.getRange(2, 1, supLast - 1, 2).getValues(); // A=Value, B=Scope
      for (var j = rows.length - 1; j >= 0; j--) {
        var value = rows[j][0], scope = rows[j][1];
        var isTrackedEmail = scope === SUPPRESSION_SCOPE.EMAIL && _testCreatedSuppressionValues.indexOf(value) !== -1;
        var isTrackedDomain = scope === SUPPRESSION_SCOPE.DOMAIN && _testCreatedDomainSuppressionValues_.indexOf(value) !== -1;
        if (isTrackedEmail || isTrackedDomain) supSheet.deleteRow(j + 2);
      }
    }
  }
  _testCreatedSuppressionValues = [];
  _testCreatedDomainSuppressionValues_ = [];
}

/**
 * Generates a unique email on a unique corporate domain, so unrelated
 * tests never collide with the 1-active-per-corporate-domain rule (I12).
 * Tests that specifically WANT to share a domain (e.g. duplicate-detection
 * tests) build their own address instead of using this helper.
 */
function testUniqueEmail_(label) {
  var uid = Utilities.getUuid().substring(0, 8);
  return 'klinner-test-' + label + '-' + uid + '@example-corp-test-' + uid + '.com';
}

// ---------------------------------------------------------------------------
// Individual tests
// ---------------------------------------------------------------------------

function test_T2_alreadySentGuard_() {
  var row = addTestProspectRow_({ Status: STATUS.IN_SEQUENCE, Sequence_Step: 1, Step1_Sent_At: new Date() });
  var prospect = getTestProspectByRow_(row);
  var config = getConfig();
  assert_(canSend_(prospect, 1, config) === false, 'canSend_ must be false when Step1_Sent_At is already set.');
}

function test_T6_invalidEmailIsSyntaxOnly_() {
  var badRow = addTestProspectRow_({ Email: 'not-an-email@@bad', Problem_Found: 'x' });
  var goodRow = addTestProspectRow_({ Email: testUniqueEmail_('nx-domain'), Problem_Found: 'x' });
  validateAllRows();
  var bad = getTestProspectByRow_(badRow);
  var good = getTestProspectByRow_(goodRow);
  assertEquals_(STATUS.INVALID_EMAIL, bad.Status, 'Syntactically broken email must be INVALID_EMAIL.');
  assertEquals_(STATUS.READY, good.Status, 'Syntactically valid email (even on a nonexistent domain) must pass to READY — no MX check (I20).');
}

function test_T13_publicDomainsExemptFromOneDomainRule_() {
  var r1 = addTestProspectRow_({ Email: 'aaaaa+' + Utilities.getUuid().substring(0, 6) + '@gmail.com', Problem_Found: 'x' });
  var r2 = addTestProspectRow_({ Email: 'bbbbb+' + Utilities.getUuid().substring(0, 6) + '@gmail.com', Problem_Found: 'x' });
  validateAllRows();
  var p1 = getTestProspectByRow_(r1);
  var p2 = getTestProspectByRow_(r2);
  assertEquals_(DOMAIN_TYPE.PUBLIC, p1.Domain_Type, 'gmail.com must classify as public.');
  assertEquals_(STATUS.READY, p1.Status, 'First gmail.com prospect must be READY.');
  assertEquals_(STATUS.READY, p2.Status, 'Second gmail.com prospect must ALSO be READY — public domains are exempt from the 1-per-domain rule (I12).');
}

function test_T14_domainSuppressionRejectedForPublicDomain_() {
  var threw = false;
  try {
    addSuppression_('gmail.com', SUPPRESSION_SCOPE.DOMAIN, DNC_REASON.MANUAL, 'test');
  } catch (e) {
    threw = true;
  }
  assert_(threw, 'addSuppression_ must reject scope=domain for a public domain (I11).');
}

function test_T16_T17_businessDayCadence_() {
  var config = getConfig();
  // A Thursday: 2026-01-08 is a Thursday.
  var thursday = new Date(2026, 0, 8, 10, 0, 0);
  var next = computeNextActionDate_(1, thursday, config);
  assertEquals_('2026-01-13', formatDateYmd_(next), 'Step1 sent Thursday + 3 business days must land on the following Tuesday (T16).');

  // Holiday inside the window: 2026-06-19 (Juneteenth) is a Friday holiday.
  var beforeHoliday = new Date(2026, 5, 17, 10, 0, 0); // Wed 2026-06-17
  var withHoliday = addBusinessDays_(beforeHoliday, 3, config.HOLIDAYS);
  // Wed->Thu(1)->Fri(2, holiday, skipped)->Mon(2)->Tue(3) = 2026-06-23
  assertEquals_('2026-06-23', formatDateYmd_(withHoliday), 'A configured holiday inside the offset window must be skipped (T17).');
}

function test_T18_pauseAllBlocksPreview_() {
  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var pauseRow = -1;
  for (var i = 0; i < values.length; i++) if (values[i][0] === 'PAUSE_ALL') pauseRow = i + 2;
  assert_(pauseRow !== -1, 'PAUSE_ALL key must exist in Config.');

  sheet.getRange(pauseRow, 2).setValue('TRUE');
  resetConfigCache_();
  try {
    var result = previewQueue();
    assertEquals_(0, result.drafted, 'previewQueue must draft nothing while PAUSE_ALL=TRUE.');
    assertEquals_('PAUSE_ALL', result.reason, 'previewQueue must report PAUSE_ALL as the reason.');
  } finally {
    sheet.getRange(pauseRow, 2).setValue('FALSE');
    resetConfigCache_();
  }
}

function test_T19_dryRunNeverWritesProspects_() {
  var email = testUniqueEmail_('t19');
  var rowIndex = addTestProspectRow_({ Email: email, Problem_Found: 'Homepage is broken on mobile.' });
  validateAllRows(); // ADMIN write — expected and allowed.

  var before = getTestProspectByRow_(rowIndex);
  assertEquals_(STATUS.READY, before.Status, 'Row must be READY before the preview snapshot (T19 precondition).');

  var beforeSnapshotCols = snapshotOperationalColumns_(rowIndex);
  var config = getConfig();
  assert_(config.DRY_RUN === true, 'T19 requires DRY_RUN=TRUE.');

  var outcome = previewStep(before.Prospect_ID, 1);
  assertEquals_('DRAFTED', outcome.status, 'Preview of a valid READY prospect must produce a draft.');

  var afterSnapshotCols = snapshotOperationalColumns_(rowIndex);
  assertEquals_(JSON.stringify(beforeSnapshotCols), JSON.stringify(afterSnapshotCols),
    'Prospects!O,P,S:AG must be byte-for-byte identical before and after a DRY_RUN preview (T19 / I14).');

  // Cleanup the draft we just created so repeated test runs stay tidy.
  var ledgerEntry = findActiveDryRunDraft_(before.Prospect_ID, 1);
  if (ledgerEntry) deletePreviewDraftIfOwned_(ledgerEntry.values.Draft_ID, ledgerEntry.values);
}

function snapshotOperationalColumns_(rowIndex) {
  var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
  var oAndP = sheet.getRange(rowIndex, PROSPECTS_COLUMNS.Stop_Contact, 1, 2).getValues()[0];
  var sThroughAg = sheet.getRange(rowIndex, PROSPECTS_PROTECTED_RANGE_START_COL, 1,
    PROSPECTS_PROTECTED_RANGE_END_COL - PROSPECTS_PROTECTED_RANGE_START_COL + 1).getValues()[0];
  return oAndP.concat(sThroughAg).map(function (v) { return v instanceof Date ? v.getTime() : v; });
}

function test_T21_blankNextActionDateIgnored_() {
  var row = addTestProspectRow_({
    Status: STATUS.IN_SEQUENCE, Sequence_Step: 1, Step1_Sent_At: new Date(),
    Next_Action_Date: '', Thread_ID: 'fake-thread-id-for-eligibility-test'
  });
  var prospect = getTestProspectByRow_(row);
  var config = getConfig();
  assert_(isEligibleForNextStep_(prospect, config, new Date()) === false,
    'A blank Next_Action_Date must make the row ineligible regardless of Status/Sequence_Step (I6).');
}

function test_T28_liveBlockedWhilePendingF0_() {
  var pending = getPendingF0Keys_();
  assert_(pending.length > 0, 'T28 expects at least one PENDING_F0 key to still be pending in this F1 delivery.');
  var threw = false;
  try {
    assertLiveAllowed_();
  } catch (e) {
    threw = true;
  }
  assert_(threw, 'assertLiveAllowed_ must throw while PENDING_F0 keys remain (I21).');
}

function test_T33_validateAllRowsPersistsUnderDryRun_() {
  var config = getConfig();
  assert_(config.DRY_RUN === true, 'T33 requires DRY_RUN=TRUE.');

  var domain = 'dup-corp-' + Utilities.getUuid().substring(0, 6) + '.com';
  var validRow = addTestProspectRow_({ Email: 'owner@' + domain, Problem_Found: 'x' });
  var missingDataRow = addTestProspectRow_({ Problem_Found: '' });
  var badSyntaxRow = addTestProspectRow_({ Email: 'bad..email', Problem_Found: 'x' });
  var dupRow = addTestProspectRow_({ Email: 'second@' + domain, Problem_Found: 'x' });

  validateAllRows();

  var valid = getTestProspectByRow_(validRow);
  var missingData = getTestProspectByRow_(missingDataRow);
  var badSyntax = getTestProspectByRow_(badSyntaxRow);
  var dup = getTestProspectByRow_(dupRow);

  assert_(!!valid.Prospect_ID, 'Validate must assign a Prospect_ID even under DRY_RUN=TRUE.');
  assert_(!!valid.Email_Normalized && !!valid.Domain && valid.Domain_Type === DOMAIN_TYPE.CORPORATE,
    'Validate must persist Email_Normalized/Domain/Domain_Type under DRY_RUN=TRUE.');
  assertEquals_(STATUS.READY, valid.Status, 'Valid row must be READY.');
  assertEquals_(STATUS.NEEDS_DATA, missingData.Status, 'Row missing Problem_Found must be NEEDS_DATA.');
  assertEquals_(STATUS.INVALID_EMAIL, badSyntax.Status, 'Syntactically bad email must be INVALID_EMAIL.');
  assertEquals_(STATUS.DUPLICATE, dup.Status, 'Second prospect on the same corporate domain must be DUPLICATE.');
  assertEquals_(DNC_REASON.DUPLICATE, dup.Do_Not_Contact_Reason, 'DUPLICATE row must carry Do_Not_Contact_Reason=duplicate.');
}

function test_T34_originSeparation_() {
  var config = getConfig();
  assert_(config.DRY_RUN === true, 'T34 requires DRY_RUN=TRUE.');

  // (a) ADMIN Stop prospect persists under DRY_RUN.
  var rowA = addTestProspectRow_({ Email: testUniqueEmail_('t34a'), Problem_Found: 'x' });
  validateAllRows();
  var pA = getTestProspectByRow_(rowA);
  stopProspect(pA.Prospect_ID, DNC_REASON.MANUAL);
  var afterA = getTestProspectByRow_(rowA);
  assert_(afterA.Stop_Contact === true && afterA.Status === STATUS.STOPPED, '(a) Stop prospect must persist under DRY_RUN=TRUE.');

  // (b) ADMIN Process unsubscribe persists under DRY_RUN.
  var rowB = addTestProspectRow_({ Email: testUniqueEmail_('t34b'), Problem_Found: 'x', Do_Not_Contact_Reason: DNC_REASON.UNSUBSCRIBE });
  var pB = getTestProspectByRow_(rowB);
  var idB = Utilities.getUuid();
  var normEmailB = normalizeEmail_(pB.Email);
  assignNewProspectIdAndFields_(rowB, {
    Prospect_ID: idB, Date_Added: new Date(), Status: STATUS.NEEDS_DATA,
    Email_Normalized: normEmailB, Domain: extractDomain_(normEmailB), Domain_Type: DOMAIN_TYPE.CORPORATE
  }, { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });
  var unsubResult = processUnsubscribeForSelectedRow(idB);
  _testCreatedSuppressionValues.push(normalizeEmail_(getTestProspectByRow_(rowB).Email));
  var afterB = getTestProspectByRow_(rowB);
  assert_(afterB.Stop_Contact === true && afterB.Status === STATUS.STOPPED, '(b) Unsubscribe must persist under DRY_RUN=TRUE.');
  assert_(isSuppressed_(afterB.Email_Normalized, afterB.Domain), '(b) Unsubscribe must add a Suppression(email) entry under DRY_RUN=TRUE.');

  // (c) ADMIN Reset prospect persists under DRY_RUN (row without blockers).
  var rowC = addTestProspectRow_({
    Email: testUniqueEmail_('t34c'), Problem_Found: 'x', Status: STATUS.IN_SEQUENCE, Sequence_Step: 1, Step1_Sent_At: new Date()
  });
  var pC = getTestProspectByRow_(rowC);
  var idC = Utilities.getUuid();
  assignNewProspectIdAndFields_(rowC, { Prospect_ID: idC, Date_Added: new Date() },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });
  var resetResult = resetProspect(idC);
  assert_(resetResult.success === true, '(c) Reset must succeed for an unblocked prospect under DRY_RUN=TRUE.');
  assertEquals_(STATUS.READY, getTestProspectByRow_(rowC).Status, '(c) Reset must persist Status=READY under DRY_RUN=TRUE.');

  // (d) PIPELINE write is rejected outright while DRY_RUN=TRUE.
  var rowD = addTestProspectRow_({ Email: testUniqueEmail_('t34d'), Problem_Found: 'x' });
  var pD = getTestProspectByRow_(rowD);
  var idD = Utilities.getUuid();
  assignNewProspectIdAndFields_(rowD, { Prospect_ID: idD, Date_Added: new Date(), Status: STATUS.READY,
    Email_Normalized: normalizeEmail_(pD.Email), Domain: extractDomain_(normalizeEmail_(pD.Email)), Domain_Type: DOMAIN_TYPE.CORPORATE },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });
  var beforeD = getTestProspectByRow_(rowD);
  var writeResult = writeRowById_(idD, { Step1_Sent_At: new Date() }, { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
  var afterD = getTestProspectByRow_(rowD);
  assertEquals_(false, writeResult.success, '(d) A PIPELINE write to Prospects must be rejected while DRY_RUN=TRUE.');
  assertEquals_('', afterD.Step1_Sent_At, '(d) Step1_Sent_At must remain untouched after the rejected PIPELINE write.');

  // (e) SYSTEM origin is permitted and unaffected by DRY_RUN — exercised via
  // the generic DNC->Stop_Contact sync (SYSTEM_NIGHTLY_RECON).
  var rowE = addTestProspectRow_({ Email: testUniqueEmail_('t34e'), Problem_Found: 'x' });
  var pE = getTestProspectByRow_(rowE);
  var idE = Utilities.getUuid();
  assignNewProspectIdAndFields_(rowE, { Prospect_ID: idE, Date_Added: new Date(), Status: STATUS.READY,
    Email_Normalized: normalizeEmail_(pE.Email), Domain: extractDomain_(normalizeEmail_(pE.Email)), Domain_Type: DOMAIN_TYPE.CORPORATE },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });
  setRawCellForTest_(rowE, 'Do_Not_Contact_Reason', DNC_REASON.NOT_INTERESTED); // raw edit, unmediated — as a human would do.
  var syncedCount = syncDncToStopContact_();
  var afterE = getTestProspectByRow_(rowE);
  assert_(syncedCount >= 1, '(e) syncDncToStopContact_ must process at least the row just seeded.');
  assertEquals_(true, afterE.Stop_Contact, '(e) SYSTEM-origin write (SYSTEM_NIGHTLY_RECON) must persist under DRY_RUN=TRUE.');

  // (f) Codex finding #1: the bypass must be structurally impossible, not
  // just conventionally discouraged — applyFieldsToRow_ must not exist as
  // a global identifier at all (it lives inside SheetRepo.gs's IIFE).
  assertEquals_('undefined', typeof applyFieldsToRow_,
    '(f) applyFieldsToRow_ must NOT be reachable as a global — it must live only inside SheetRepo.gs\'s closure (finding #1).');

  // (g) Codex finding #2: restrictedValues must be enforced identically on
  // the fresh-identity-assignment path, not only on the update path.
  var rowG = addTestProspectRow_({ Email: testUniqueEmail_('t34g'), Problem_Found: 'x' });
  var idG1 = Utilities.getUuid();
  var threwOnUnsubscribe = false;
  try {
    assignNewProspectIdAndFields_(rowG, { Prospect_ID: idG1, Status: STATUS.DUPLICATE, Do_Not_Contact_Reason: DNC_REASON.UNSUBSCRIBE },
      { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });
  } catch (e) { threwOnUnsubscribe = true; }
  assert_(threwOnUnsubscribe, '(g) assignNewProspectIdAndFields_ must reject Do_Not_Contact_Reason="unsubscribe" under ADMIN_VALIDATE (finding #2).');
  assert_(!getTestProspectByRow_(rowG).Prospect_ID, '(g) The rejected assignment must not have partially applied — row must still have no Prospect_ID.');

  var idG2 = Utilities.getUuid();
  assignNewProspectIdAndFields_(rowG, { Prospect_ID: idG2, Date_Added: new Date(), Status: STATUS.DUPLICATE, Do_Not_Contact_Reason: DNC_REASON.DUPLICATE },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });
  assertEquals_(DNC_REASON.DUPLICATE, getTestProspectByRow_(rowG).Do_Not_Contact_Reason,
    '(g) assignNewProspectIdAndFields_ must permit Do_Not_Contact_Reason="duplicate" under ADMIN_VALIDATE.');
}

/**
 * Codex finding #1, negative cases: writing a column outside an operation's
 * allow-list must be rejected for EVERY combination, not just the ones T34
 * happens to exercise. Each of Step1_Sent_At/Status/DNC/Thread_ID is tried
 * against an operation that must NOT be allowed to touch it.
 */
function test_finding1_writeBoundaryRejectsOutOfScopeColumns_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('finding1'), Problem_Found: 'x', Status: STATUS.STOPPED, Stop_Contact: true });
  var p = getTestProspectByRow_(row);
  var id = Utilities.getUuid();
  assignNewProspectIdAndFields_(row, { Prospect_ID: id, Date_Added: new Date(), Status: STATUS.NEEDS_DATA },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });

  var cases = [
    { op: OPERATION.ADMIN_STOP, field: 'Step1_Sent_At', value: new Date(), label: 'ADMIN_STOP writing Step1_Sent_At (not in its column allow-list)' },
    { op: OPERATION.ADMIN_VALIDATE, field: 'Thread_ID', value: 'thread-x', label: 'ADMIN_VALIDATE writing Thread_ID (not in its column allow-list)' },
    { op: OPERATION.SYSTEM_REPLY_SYNC, field: 'Status', value: STATUS.IN_SEQUENCE, label: 'SYSTEM_REPLY_SYNC setting Status=IN_SEQUENCE (not in its status allow-list)' },
    { op: OPERATION.ADMIN_RESET, field: 'Do_Not_Contact_Reason', value: DNC_REASON.MANUAL, label: 'ADMIN_RESET writing Do_Not_Contact_Reason (not in its column allow-list)' }
  ];

  cases.forEach(function (c) {
    var fields = {};
    fields[c.field] = c.value;
    var threw = false;
    try {
      writeRowById_(id, fields, { origin: OPERATION_ORIGIN[c.op], operation: c.op });
    } catch (e) { threw = true; }
    assert_(threw, 'Expected rejection: ' + c.label);
  });
}

function test_T29_T30_T31_T32_unsubscribeAndResetGuards_() {
  var config = getConfig();

  // A/T29: unsubscribe is idempotent and permanent.
  var rowA = addTestProspectRow_({ Email: testUniqueEmail_('t29'), Problem_Found: 'x', Status: STATUS.IN_SEQUENCE, Sequence_Step: 1 });
  var pA = getTestProspectByRow_(rowA);
  var idA = Utilities.getUuid();
  assignNewProspectIdAndFields_(rowA, { Prospect_ID: idA, Date_Added: new Date(), Domain_Type: DOMAIN_TYPE.CORPORATE,
    Email_Normalized: normalizeEmail_(pA.Email), Domain: extractDomain_(normalizeEmail_(pA.Email)) },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });
  // Column P (Do_Not_Contact_Reason) is NOT in the protected S:AG range —
  // an operator can type "unsubscribe" straight into the cell, completely
  // outside the origin/operation system. Simulate exactly that raw,
  // unmediated edit (NOT via writeRowById_, which now structurally
  // refuses to set DNC=unsubscribe under ADMIN_STOP — Codex finding #3).
  setRawCellForTest_(rowA, 'Do_Not_Contact_Reason', DNC_REASON.UNSUBSCRIBE);
  applyUnsubscribeEffects_(idA, ORIGIN.ADMIN, OPERATION.ADMIN_UNSUBSCRIBE);
  applyUnsubscribeEffects_(idA, ORIGIN.ADMIN, OPERATION.ADMIN_UNSUBSCRIBE);
  applyUnsubscribeEffects_(idA, ORIGIN.ADMIN, OPERATION.ADMIN_UNSUBSCRIBE);
  var emailA = normalizeEmail_(pA.Email);
  _testCreatedSuppressionValues.push(emailA);
  var suppressionCount = readAllSuppression_().filter(function (s) { return s.Value === emailA; }).length;
  assertEquals_(1, suppressionCount, 'A/T29: exactly one Suppression(email) entry must exist after repeated unsubscribe processing.');
  var afterA = getTestProspectByRow_(rowA);
  assert_(afterA.Stop_Contact === true && afterA.Status === STATUS.STOPPED, 'A/T29: prospect must be stopped after unsubscribe.');

  // B/T30: Reset must be REJECTED for an unsubscribed prospect.
  var resetResultA = resetProspect(idA);
  assertEquals_(false, resetResultA.success, 'B/T30: Reset must be rejected for a prospect with DNC=unsubscribe.');
  var afterReset = getTestProspectByRow_(rowA);
  assertEquals_(DNC_REASON.UNSUBSCRIBE, afterReset.Do_Not_Contact_Reason, 'B/T30: unsubscribe reason must survive a rejected reset.');

  // C/T31: Reset must be rejected for every DNC reason + bare Stop_Contact.
  var reasonsToTest = DNC_REASON_VALUES.concat(['__STOP_ONLY__']);
  reasonsToTest.forEach(function (reason) {
    var overrides = reason === '__STOP_ONLY__'
      ? { Stop_Contact: true, Do_Not_Contact_Reason: '' }
      : { Stop_Contact: true, Do_Not_Contact_Reason: reason };
    var r = addTestProspectRow_(Object.assign({ Email: testUniqueEmail_('t31-' + reason.replace(/\s/g, '')), Problem_Found: 'x' }, overrides));
    var p = getTestProspectByRow_(r);
    var id = Utilities.getUuid();
    assignNewProspectIdAndFields_(r, { Prospect_ID: id, Date_Added: new Date() }, { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });
    var result = resetProspect(id);
    assertEquals_(false, result.success, 'C/T31: Reset must be rejected when blocked by "' + reason + '".');
  });

  // T32: clearing the columns manually still leaves Suppression blocking the send.
  writeRowById_(idA, { Stop_Contact: false, Do_Not_Contact_Reason: '' }, { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_STOP });
  var resetAfterManualClear = resetProspect(idA);
  assert_(resetAfterManualClear.success === true, 'T32: reset succeeds once blockers are manually cleared.');
  var afterClearReset = getTestProspectByRow_(rowA);
  assert_(isSuppressed_(afterClearReset.Email_Normalized, afterClearReset.Domain),
    'T32: Suppression must still block this email even after Reset succeeded (I4 backstop).');
}

function test_T5_needsDataPersistsAndPipelineNeverWrites_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('t5'), Problem_Found: '' });
  validateAllRows();
  var afterValidate = getTestProspectByRow_(row);
  assertEquals_(STATUS.NEEDS_DATA, afterValidate.Status, 'Row missing Problem_Found must be classified NEEDS_DATA by Validate (ADMIN write persists).');

  var beforeSnapshot = snapshotOperationalColumns_(row);
  var outcome = previewStep(afterValidate.Prospect_ID, 1);
  var afterSnapshot = snapshotOperationalColumns_(row);

  assertEquals_('SKIPPED_NEEDS_DATA', outcome.status, 'previewStep must report SKIPPED_NEEDS_DATA for a missing required field.');
  assertEquals_(JSON.stringify(beforeSnapshot), JSON.stringify(afterSnapshot),
    'previewStep must not write anything to Prospects even when it skips (T5).');
  var noLedgerRow = findActiveDryRunDraft_(afterValidate.Prospect_ID, 1);
  assert_(!noLedgerRow, 'No SendLedger DRAFTED row should exist for a skipped (needs-data) preview.');
}

function test_T23_followUpsPrioritizedOverNewProspects_() {
  var rows = [];
  for (var i = 0; i < 5; i++) {
    var futureBack = new Date(); futureBack.setDate(futureBack.getDate() - (5 - i));
    rows.push({
      rowIndex: -1,
      values: { Sequence_Step: 1, Next_Action_Date: futureBack, Last_Contacted: futureBack, Date_Added: new Date() }
    });
  }
  for (var j = 0; j < 5; j++) {
    var added = new Date(); added.setDate(added.getDate() - j);
    rows.push({ rowIndex: -1, values: { Sequence_Step: 0, Next_Action_Date: '', Date_Added: added } });
  }
  var ordered = orderQueue_(rows);
  var top2 = ordered.slice(0, 2);
  top2.forEach(function (r) {
    assert_(Number(r.values.Sequence_Step) >= 1, 'T23: the first entries taken by a MAX_PER_RUN=2 budget must be follow-ups, not new prospects.');
  });
}

/**
 * T25 / T26 / T27 require a real Gmail mailbox (creating and inspecting
 * actual GmailApp drafts and, for T26, a real prior LIVE thread). These
 * are NOT executed by this offline delivery — see the final report,
 * category B. They are included here, fully written, for Gregor to run
 * from the Apps Script editor against a real or sandbox Google account.
 */
function test_T25_draftRegenerationLeavesOnlyOneLiveDraft_NEEDS_LIVE_GMAIL_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('t25'), Problem_Found: 'Original problem statement.' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var first = previewStep(p.Prospect_ID, 1);
  var second = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', first.status, 'First preview must draft.');
  assertEquals_('DRAFTED', second.status, 'Second preview (regeneration) must draft.');
  assert_(first.draftId !== second.draftId, 'Regeneration must produce a NEW draft id, not reuse the old one.');

  var drafts = GmailApp.getDrafts();
  var stillExistsOld = drafts.some(function (d) { return d.getId() === first.draftId; });
  assert_(!stillExistsOld, 'T25: the superseded draft must have been deleted from Gmail.');

  var ledgerRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1;
  });
  var drafted = ledgerRows.filter(function (r) { return r.values.State === LEDGER_STATE.DRAFTED; });
  assertEquals_(1, drafted.length, 'T25: exactly one live DRAFTED ledger row must remain for this (prospect, step).');

  deletePreviewDraftIfOwned_(second.draftId, drafted[0].values);
}

/**
 * T26/T27 require a REAL LIVE Thread_ID (i.e. an actual prior sent thread),
 * which cannot exist in F1 (DRY_RUN=TRUE, zero LIVE sends possible). To run
 * these manually once a Google test environment is available:
 *   1. Manually send one real email to a throwaway test address you control.
 *   2. Copy that thread's ID (Thread_ID = GmailApp.getInboxThreads()[0].getId()
 *      or from the URL) into a test prospect's Prospects!AC cell directly
 *      (bypassing writeRowById_, since this is test setup, not a real
 *      PIPELINE write — do this via the Sheets UI or getRange().setValue()).
 *   3. Call previewStep(prospectId, 2) — T26 asserts the resulting draft is
 *      a reply on that real thread (draft.getMessage().getThread().getId()
 *      === the Thread_ID you set) and that Prospects!AC is unchanged.
 *   4. Repeat with Thread_ID left blank — T27 asserts a standalone draft is
 *      created instead, subject-prefixed "[KLINNER PREVIEW · Step 2]".
 * Not automated here because it requires a real prior LIVE send, which is
 * explicitly out of scope for F1. See final report, category B.
 */
function test_T26_T27_previewThreadingBranches_MANUAL_SEE_DOCSTRING_() {
  throw new Error('T26/T27 require manual setup with a real Gmail thread — see this function\'s docstring. Not part of the automated F1 suite.');
}

/** Scans the last N Log rows for one matching Event (col E). Portable across the mock and real Sheets. */
function findLogEventInSheet_(eventName, lookbackRows) {
  var sheet = getSheet_(SHEET_NAMES.LOG);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var n = Math.min(lookbackRows || 100, lastRow - 1);
  var values = sheet.getRange(lastRow - n + 1, 1, n, LOG_COLUMN_ORDER.length).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (values[i][LOG_COLUMNS.Event - 1] === eventName) return values[i];
  }
  return null;
}

function test_T35_digestSkipsSendWhenAdminEmailPending_() {
  assert_(isPendingF0_('ADMIN_EMAIL'), 'T35 requires ADMIN_EMAIL=PENDING_F0 in this F1 delivery.');

  // Portable, real-API-based proof that no email was sent: MailApp's daily
  // quota is decremented by exactly 1 per real sendEmail() call — if it is
  // unchanged, sendEmail() was never invoked. This works whether or not
  // the mock's extra _sent introspection array exists.
  var quotaBefore = MailApp.getRemainingDailyQuota();
  var sentCountBefore = (typeof MailApp._sent !== 'undefined') ? MailApp._sent.length : null;
  var result = dailyDigest(); // Must not throw.
  var quotaAfter = MailApp.getRemainingDailyQuota();

  assertEquals_(false, result.sent, 'dailyDigest must report sent=false while ADMIN_EMAIL is PENDING_F0.');
  assertEquals_('ADMIN_EMAIL_PENDING_F0', result.reason, 'dailyDigest must report the correct skip reason.');
  assert_(result.digest.indexOf('Klinner Outreach — Daily Digest') === 0, 'The digest text must still be fully computed.');
  assertEquals_(quotaBefore, quotaAfter,
    'MailApp.getRemainingDailyQuota() must be UNCHANGED — proof MailApp.sendEmail() was never called.');
  if (sentCountBefore !== null) {
    assertEquals_(sentCountBefore, MailApp._sent.length, '(mock-only) MailApp._sent must not have grown — sendEmail() was never called.');
  }

  var loggedEvent = findLogEventInSheet_(LOG_EVENT.DIGEST_NOT_SENT_PENDING_F0);
  assert_(!!loggedEvent, 'DIGEST_NOT_SENT_PENDING_F0 must be recorded in the Log sheet.');
}

// ---------------------------------------------------------------------------
// Codex audit fix-round tests (findings #3B/A, #4, #5, #6, #9, #10, #11,
// #12, #13, #14). Findings #7 and #8's LIVE-only branches cannot be
// exercised here without flipping DRY_RUN=FALSE, which this delivery must
// not do — they are covered instead by a static source check in
// test-harness/verify-static-findings.js. See the final delivery report.
// ---------------------------------------------------------------------------

/** Requirement A: stopProspect(id, "unsubscribe") itself must guarantee Suppression, not just Recon. */
function test_finding3A_stopProspectUnsubscribeCreatesSuppression_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('finding3a'), Problem_Found: 'x' });
  var p = getTestProspectByRow_(row);
  var id = Utilities.getUuid();
  var normEmail = normalizeEmail_(p.Email);
  assignNewProspectIdAndFields_(row, { Prospect_ID: id, Date_Added: new Date(), Domain_Type: DOMAIN_TYPE.CORPORATE,
    Email_Normalized: normEmail, Domain: extractDomain_(normEmail) }, { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });

  var result = stopProspect(id, DNC_REASON.UNSUBSCRIBE);
  _testCreatedSuppressionValues.push(normEmail);

  assert_(result.success === true, 'stopProspect(id, "unsubscribe") must succeed.');
  assert_(isSuppressed_(normEmail, extractDomain_(normEmail)),
    'stopProspect(id, "unsubscribe") must itself guarantee a Suppression(email) entry (finding #3, requirement A).');
  var after = getTestProspectByRow_(row);
  assertEquals_(STATUS.STOPPED, after.Status, 'Status must be STOPPED.');
  assertEquals_(true, after.Stop_Contact, 'Stop_Contact must be TRUE.');
  assertEquals_('', after.Next_Action_Date, 'Next_Action_Date must be cleared.');
}

/** Requirement B: the sweep must create a missing Suppression even when Stop_Contact is already TRUE. */
function test_finding3B_reconSweepGuaranteesSuppressionEvenIfAlreadyStopped_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('finding3b'), Problem_Found: 'x' });
  var p = getTestProspectByRow_(row);
  var id = Utilities.getUuid();
  var normEmail = normalizeEmail_(p.Email);
  assignNewProspectIdAndFields_(row, { Prospect_ID: id, Date_Added: new Date(), Domain_Type: DOMAIN_TYPE.CORPORATE,
    Email_Normalized: normEmail, Domain: extractDomain_(normEmail) }, { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });

  // Simulate the exact bug scenario: Stop_Contact and DNC=unsubscribe are
  // ALREADY set (as stopProspect() used to do, pre-fix), but Suppression
  // was never created.
  setRawCellForTest_(row, 'Stop_Contact', true);
  setRawCellForTest_(row, 'Do_Not_Contact_Reason', DNC_REASON.UNSUBSCRIBE);
  setRawCellForTest_(row, 'Status', STATUS.STOPPED);

  assert_(!isSuppressed_(normEmail, extractDomain_(normEmail)), 'Precondition: no Suppression entry exists yet.');

  var processed = sweepPendingUnsubscribes_();
  _testCreatedSuppressionValues.push(normEmail);

  assert_(processed >= 1, 'sweepPendingUnsubscribes_ must have processed this row even though Stop_Contact was already TRUE (finding #3).');
  assert_(isSuppressed_(normEmail, extractDomain_(normEmail)),
    'Suppression(email) must now exist — the old bug let this go undetected forever because Stop_Contact was already TRUE.');
}

/**
 * Reaudit finding N2: sweepPendingUnsubscribes_ used the general
 * isSuppressed_() (which matches on scope=domain too) to decide whether
 * the per-email unsubscribe guarantee was already satisfied. A prospect
 * whose whole company domain was separately blocked by a human would
 * therefore NEVER get their own permanent scope=email/unsubscribe record
 * — the individual opt-out fact was silently lost, masked by the
 * (reversible, human-controlled) domain block.
 */
function test_N2_unsubscribeAlwaysCreatesEmailScopeRecordEvenUnderDomainSuppression_() {
  var domain = 'blocked-corp-' + Utilities.getUuid().substring(0, 6) + '.com';
  var row = addTestProspectRow_({ Email: 'someone@' + domain, Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);
  var normEmail = p.Email_Normalized;

  // A human explicitly blocks the whole domain — independent, legitimate action.
  ctxAddSuppressionForTest_(domain, SUPPRESSION_SCOPE.DOMAIN);

  // This specific person also unsubscribes individually.
  setRawCellForTest_(row, 'Stop_Contact', true);
  setRawCellForTest_(row, 'Do_Not_Contact_Reason', DNC_REASON.UNSUBSCRIBE);
  setRawCellForTest_(row, 'Status', STATUS.STOPPED);

  assert_(!findSuppressionEntry_(normEmail, SUPPRESSION_SCOPE.EMAIL),
    'Precondition: no scope=email record exists yet for this specific address.');
  assert_(isSuppressed_(normEmail, domain), 'Precondition: the address IS currently blocked, but only via the domain-level entry.');

  var processed = sweepPendingUnsubscribes_();
  _testCreatedSuppressionValues.push(normEmail);

  assert_(processed >= 1, 'The sweep must still process this row — being blocked by domain is not the same as having a personal unsubscribe record (N2).');
  var emailRecord = findSuppressionEntry_(normEmail, SUPPRESSION_SCOPE.EMAIL);
  assert_(!!emailRecord, 'A scope=email/unsubscribe record for this EXACT address must exist, independent of the domain-level suppression (N2).');
  assertEquals_(DNC_REASON.UNSUBSCRIBE, emailRecord.Reason, 'The email-scope record\'s reason must be "unsubscribe".');

  // Idempotency still holds under this same condition.
  sweepPendingUnsubscribes_();
  sweepPendingUnsubscribes_();
  var count = readAllSuppression_().filter(function (r) { return r.Value === normEmail && r.Scope === SUPPRESSION_SCOPE.EMAIL; }).length;
  assertEquals_(1, count, 'Exactly one scope=email/unsubscribe row must exist after repeated sweeps (N2 idempotency).');
}

/** Test-only: adds a domain-scope Suppression row and tracks it for teardown (mirrors addSuppression_ but tags cleanup). */
function ctxAddSuppressionForTest_(value, scope) {
  addSuppression_(value, scope, DNC_REASON.MANUAL, 'test');
  _testCreatedDomainSuppressionValues_.push(value);
}

/**
 * N2 (round 2 — Codex final verification). Round 1 fixed the
 * scope=domain-vs-scope=email confusion. This is the reason-blindness
 * left behind: findSuppressionEntry_(value, scope) ignored Reason
 * entirely, so a pre-existing scope=email row for ANY reason (bounce,
 * manual, wrong person, ...) made both addSuppression_'s idempotency
 * check and sweepPendingUnsubscribes_'s completeness check believe an
 * unsubscribe was already recorded — when it never had been. Fixed by
 * making findSuppressionEntry_'s match include Reason wherever the caller
 * needs reason-specific truth (addSuppression_'s idempotency check, and
 * the unsubscribe-completeness check), while isSuppressed_ (the I4
 * send-blocking gate) deliberately stays reason-agnostic.
 *
 * Four cases, exactly as specified: (1) bounce pre-exists, unsubscribe
 * must still create its own row; (2) repeating the unsubscribe processing
 * is idempotent under that same condition; (3) a domain-scope suppression
 * is untouched and does not block the email-scope unsubscribe row from
 * being created; (4) Suppression alone keeps blocking sends even after
 * Stop_Contact/DNC are manually cleared.
 */
function test_N2_round2_priorReasonNeverMasksUnsubscribeRecord_() {
  function countByReason(email, scope) {
    var rows = readAllSuppression_().filter(function (r) { return r.Value === email && r.Scope === scope; });
    var byReason = {};
    rows.forEach(function (r) { byReason[r.Reason] = (byReason[r.Reason] || 0) + 1; });
    return byReason;
  }

  // --- CASO 1: pre-existing scope=email/bounce, then unsubscribe. ---------
  var row1 = addTestProspectRow_({ Email: testUniqueEmail_('n2r2-case1'), Problem_Found: 'x' });
  validateAllRows();
  var p1 = getTestProspectByRow_(row1);
  var email1 = p1.Email_Normalized;

  addSuppression_(email1, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.BOUNCE, 'system');
  _testCreatedSuppressionValues.push(email1);
  assertEquals_(1, countByReason(email1, SUPPRESSION_SCOPE.EMAIL).bounce || 0, 'Precondition: exactly one bounce row exists.');
  assert_(!findSuppressionEntry_(email1, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.UNSUBSCRIBE),
    'Precondition: no unsubscribe row exists yet for this address.');

  // Processing goes through sweepPendingUnsubscribes_ (the SYSTEM self-
  // healing path — what actually runs a row through in real operation
  // after a human sets the dropdown to "unsubscribe") rather than calling
  // applyUnsubscribeEffects_ directly, so this test exercises the sweep's
  // OWN completeness check (Recon.gs) in addition to addSuppression_'s
  // idempotency (Suppression.gs) — both were separately reason-blind.
  setRawCellForTest_(row1, 'Do_Not_Contact_Reason', DNC_REASON.UNSUBSCRIBE);
  setRawCellForTest_(row1, 'Stop_Contact', true); // Matches how stopProspect() would have already set it.
  setRawCellForTest_(row1, 'Status', STATUS.STOPPED);
  sweepPendingUnsubscribes_();

  var counts1 = countByReason(email1, SUPPRESSION_SCOPE.EMAIL);
  assertEquals_(1, counts1.bounce || 0, 'CASO 1: the pre-existing bounce row must survive untouched — exactly 1.');
  assertEquals_(1, counts1.unsubscribe || 0, 'CASO 1: a separate unsubscribe row must now also exist — exactly 1.');

  // --- CASO 2: process 3 more times — no duplicates of either row. --------
  sweepPendingUnsubscribes_();
  sweepPendingUnsubscribes_();
  sweepPendingUnsubscribes_();
  var counts1After = countByReason(email1, SUPPRESSION_SCOPE.EMAIL);
  assertEquals_(1, counts1After.bounce || 0, 'CASO 2: still exactly 1 bounce row after 3 more unsubscribe runs.');
  assertEquals_(1, counts1After.unsubscribe || 0, 'CASO 2: still exactly 1 unsubscribe row after 3 more runs — no duplicates.');

  // --- CASO 3: pre-existing scope=domain, then unsubscribe of one address. ---
  var domain3 = 'n2r2-domain-' + Utilities.getUuid().substring(0, 6) + '.com';
  var row3 = addTestProspectRow_({ Email: 'test@' + domain3, Problem_Found: 'x' });
  validateAllRows();
  var p3 = getTestProspectByRow_(row3);
  var email3 = p3.Email_Normalized;

  ctxAddSuppressionForTest_(domain3, SUPPRESSION_SCOPE.DOMAIN);
  assert_(!!findSuppressionEntry_(domain3, SUPPRESSION_SCOPE.DOMAIN), 'Precondition: the domain suppression exists.');

  setRawCellForTest_(row3, 'Do_Not_Contact_Reason', DNC_REASON.UNSUBSCRIBE);
  sweepPendingUnsubscribes_();
  _testCreatedSuppressionValues.push(email3);

  assert_(!!findSuppressionEntry_(domain3, SUPPRESSION_SCOPE.DOMAIN), 'CASO 3: the domain suppression must remain intact, untouched.');
  var domainRowsAfter = readAllSuppression_().filter(function (r) { return r.Value === domain3 && r.Scope === SUPPRESSION_SCOPE.DOMAIN; }).length;
  assertEquals_(1, domainRowsAfter, 'CASO 3: exactly one domain-scope row — the unsubscribe must not have touched or duplicated it.');
  var emailUnsubRows3 = readAllSuppression_().filter(function (r) {
    return r.Value === email3 && r.Scope === SUPPRESSION_SCOPE.EMAIL && r.Reason === DNC_REASON.UNSUBSCRIBE;
  }).length;
  assertEquals_(1, emailUnsubRows3, 'CASO 3: exactly one email-scope/unsubscribe row must be created for the individual address.');

  // --- CASO 4: manually clearing Stop_Contact/DNC (and even resetting the
  // prospect back to READY) afterward must not un-block — Suppression is
  // the backstop, independent of those columns.
  writeRowById_(p1.Prospect_ID, { Stop_Contact: false, Do_Not_Contact_Reason: '' },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_STOP });
  var resetResult = resetProspect(p1.Prospect_ID); // Now unblocked at the column level, so Reset is allowed to succeed.
  assert_(resetResult.success === true, 'CASO 4: reset succeeds once Stop_Contact/DNC are manually cleared.');

  var cleared = getTestProspectByRow_(row1);
  assertEquals_(false, cleared.Stop_Contact, 'Precondition: Stop_Contact cleared.');
  assertEquals_('', cleared.Do_Not_Contact_Reason, 'Precondition: Do_Not_Contact_Reason cleared.');
  assertEquals_(STATUS.READY, cleared.Status, 'Precondition: Status reset to READY (isolates the Suppression check from any leftover STOPPED status).');
  assert_(isSuppressed_(email1, cleared.Domain), 'CASO 4: isSuppressed_ must still be true — Suppression alone keeps blocking.');
  assert_(canPreview_(cleared, 1) === false, 'CASO 4: canPreview_ must still refuse — blocked by Suppression regardless of Stop_Contact/DNC/Status.');
  assert_(canSend_(cleared, 1, getConfig(), new Date()) === false, 'CASO 4: canSend_ must still refuse — blocked by Suppression regardless of Stop_Contact/DNC/Status.');
}

function test_finding4_foreignDraftIsNeverDeleted_() {
  // A "foreign" draft: created directly via GmailApp, with a body that does
  // NOT carry the Klinner preview banner AND no matching stored Message_ID
  // — exactly what an unrelated personal draft would look like, and
  // exactly the attack shape (tampered Draft_ID alone) N3 requires to keep
  // failing closed even after the two-signal ownership upgrade.
  var foreignDraft = GmailApp.createDraft('someone-else@example.com', 'Unrelated personal draft',
    'This has nothing to do with Klinner Outreach.');
  var foreignDraftId = foreignDraft.getId();

  var fakeLedgerEntry = {
    Prospect_ID: 'fake-prospect', Email_Normalized: 'nobody@example-corp-test.com', Step: 1,
    Draft_ID: foreignDraftId, Message_ID: 'a-legit-stored-id-that-does-not-match-the-foreign-draft'
  };
  var result = deletePreviewDraftIfOwned_(foreignDraftId, fakeLedgerEntry);

  assertEquals_(false, result.deleted, 'A draft without the preview banner AND without a matching Message_ID must NEVER be deleted, regardless of a matching Draft_ID (finding #4 / N3).');
  assertEquals_('ownership_unverified', result.reason, 'The refusal reason must be ownership_unverified.');
  var stillThere = GmailApp.getDrafts().some(function (d) { return d.getId() === foreignDraftId; });
  assert_(stillThere, 'The foreign draft must still exist in Gmail — it was NOT deleted.');

  foreignDraft.deleteDraft(); // test cleanup, not part of the assertion
}

/**
 * N3 positive case: the operator opens a preview draft in Gmail and edits
 * its visible content during review (exactly what F1 asks them to do).
 * The banner-based signal breaks, but the persistent Message_ID captured
 * at creation time must still let the system recognize the draft as its
 * own — regeneration must end with exactly ONE live draft, not two.
 */
function test_N3_editedDraftStillRecognizedViaMessageId_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3positive'), Problem_Found: 'Original problem statement.' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var first = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', first.status, 'First preview must draft.');

  // Simulate the operator editing the draft's body in Gmail — the banner
  // line is gone, replaced with content they wrote themselves.
  var liveDraft = GmailApp.getDrafts().filter(function (d) { return d.getId() === first.draftId; })[0];
  assert_(!!liveDraft, 'Precondition: the first draft must exist.');
  var message = liveDraft.getMessage();
  var originalMessageId = message.getId();
  message.getPlainBody = function () { return 'Hi, I rewrote this myself during review.'; };
  message.getBody = message.getPlainBody;

  var second = previewStep(p.Prospect_ID, 1); // Regeneration.
  assertEquals_('DRAFTED', second.status, 'Second preview (regeneration after an operator edit) must still draft.');

  var liveDrafts = GmailApp.getDrafts().filter(function (d) { return d.getId() === first.draftId || d.getId() === second.draftId; });
  assertEquals_(1, liveDrafts.length,
    'Exactly one live draft must remain after regenerating an edited draft — the edited one must have been recognized and superseded via Message_ID, not left stranded (N3).');
  assertEquals_(second.draftId, liveDrafts[0].getId(), 'The surviving draft must be the newly created one.');

  var draftedLedgerRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, draftedLedgerRows.length, 'Exactly one DRAFTED ledger row must remain (N3).');
  assert_(!!draftedLedgerRows[0].values.Message_ID, 'The surviving ledger row must have a Message_ID captured, for future regenerations to key off of.');
}

function test_finding5_previewLocksCriticalSection_() {
  if (typeof LockService._forceHeldForTest !== 'function') {
    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SKIP, '', '', '', 'finding5: LockService test hook unavailable (real Apps Script) — skipped locally.');
    return;
  }
  var row = addTestProspectRow_({ Email: testUniqueEmail_('finding5'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  LockService._forceHeldForTest(true); // Simulate a concurrent execution already holding the script lock.
  try {
    var outcome = previewStep(p.Prospect_ID, 1);
    assertEquals_('SKIPPED_LOCK_BUSY', outcome.status,
      'previewStep must report SKIPPED_LOCK_BUSY (not create a draft) when the script lock is already held (finding #5).');
    var noLedgerRow = findActiveDryRunDraft_(p.Prospect_ID, 1);
    assert_(!noLedgerRow, 'No draft/ledger row should exist when the critical section could not acquire the lock.');
  } finally {
    LockService._forceHeldForTest(false);
  }

  var secondAttempt = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', secondAttempt.status, 'Once the lock is free, previewStep must proceed normally.');
}

function test_finding6_orphanedDraftIsCompensatedOnLedgerFailure_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('finding6'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var originalAppendLedgerRow = appendLedgerRow_;
  var draftCountBefore = GmailApp.getDrafts().length;
  appendLedgerRow_ = function () { throw new Error('Simulated ledger write failure for finding #6 test.'); };

  var outcome;
  try {
    outcome = previewStep(p.Prospect_ID, 1);
  } finally {
    appendLedgerRow_ = originalAppendLedgerRow; // restore immediately, even if an assertion below throws
  }

  assertEquals_('ERROR_LEDGER_WRITE_FAILED', outcome.status, 'previewStep must report the ledger failure explicitly, not silently succeed (finding #6).');
  assertEquals_(true, outcome.compensated, 'The orphaned draft must be compensated (deleted) when the ledger write fails.');
  assertEquals_(draftCountBefore, GmailApp.getDrafts().length, 'No extra draft must remain in Gmail after compensation.');
}

function test_finding9_quotaBudgetRespectsAllFourFactors_() {
  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var rows = {};
  for (var i = 0; i < values.length; i++) rows[values[i][0]] = i + 2;

  var originalMaxPerDay = sheet.getRange(rows.MAX_PER_DAY, 2).getValue();
  var originalMargin = sheet.getRange(rows.QUOTA_SAFETY_MARGIN, 2).getValue();
  var originalQuota = MailApp._remainingQuota;

  try {
    sheet.getRange(rows.MAX_PER_DAY, 2).setValue('5');
    sheet.getRange(rows.QUOTA_SAFETY_MARGIN, 2).setValue('2');
    resetConfigCache_();
    var config = getConfig();

    if (typeof MailApp._remainingQuota !== 'undefined') MailApp._remainingQuota = 3;
    assertEquals_(1, computeLiveSendBudget_(config), 'Budget must be min(MAX_PER_DAY - sentToday, remainingGmailQuota - margin) = min(5, 3-2) = 1 (finding #9).');

    if (typeof MailApp._remainingQuota !== 'undefined') MailApp._remainingQuota = 1500;
    assertEquals_(5, computeLiveSendBudget_(config), 'Budget must be min(5, 1500-2) = 5 when Gmail quota is not the binding constraint.');

    if (typeof MailApp._remainingQuota !== 'undefined') MailApp._remainingQuota = 0;
    assertEquals_(0, computeLiveSendBudget_(config), 'Budget must floor at 0, never go negative.');
  } finally {
    sheet.getRange(rows.MAX_PER_DAY, 2).setValue(originalMaxPerDay);
    sheet.getRange(rows.QUOTA_SAFETY_MARGIN, 2).setValue(originalMargin);
    if (typeof MailApp._remainingQuota !== 'undefined') MailApp._remainingQuota = originalQuota;
    resetConfigCache_();
  }
}

function test_finding10_canSendEnforcesStepSequence_() {
  var config = getConfig();
  var now = new Date();

  var readyProspect = { Status: STATUS.READY, Sequence_Step: 0, Step1_Sent_At: '', Step2_Sent_At: '', Next_Action_Date: '' };
  assert_(canSend_(readyProspect, 2, config, now) === false, 'canSend_ must refuse step 2 when step 1 was never LIVE-sent (finding #10).');
  assert_(canSend_(readyProspect, 1, config, now) === true, 'canSend_ must allow step 1 for a plain READY prospect.');

  var future = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 3);
  var notDueYet = { Status: STATUS.IN_SEQUENCE, Sequence_Step: 1, Step1_Sent_At: new Date(), Step2_Sent_At: '', Next_Action_Date: future };
  assert_(canSend_(notDueYet, 2, config, now) === false, 'canSend_ must refuse a follow-up before Next_Action_Date is due.');

  var past = new Date(now.getTime() - 1000 * 60 * 60 * 24);
  var due = { Status: STATUS.IN_SEQUENCE, Sequence_Step: 1, Step1_Sent_At: new Date(), Step2_Sent_At: '', Next_Action_Date: past };
  assert_(canSend_(due, 2, config, now) === true, 'canSend_ must allow a due follow-up.');
  assert_(canSend_(due, 4, config, now) === false, 'canSend_ must refuse a step that is not the exact next expected step (out-of-order).');

  // --- N7: isolate expectedStep !== step from every OTHER guard. -----------
  // The two assertions above (readyProspect step 2, due step 4) are each
  // ALSO caught by a different guard even without the sequence check:
  //   - readyProspect/step 2 -> the "prior step (Step1_Sent_At) must exist"
  //     check fails on its own (Step1_Sent_At is blank).
  //   - due/step 4 -> the "prior step (Step3_Sent_At) must exist" check
  //     fails on its own (Step3_Sent_At is blank).
  // Proven by mutation testing (test-harness/mutation-test-N7.js): removing
  // ONLY `expectedStep !== step` from canSend_ still leaves both of THOSE
  // assertions passing — they do not actually exercise the line N7 asks to
  // isolate. This next case is built specifically so ONLY the sequence
  // check can catch it: Sequence_Step says step 2 is already complete (so
  // the next expected step is 3), but Step2_Sent_At's own cell is blank —
  // a plausible data anomaly (e.g. a single stray manual edit). Every
  // OTHER guard passes on this data:
  //   - I1 (stepColName blank) passes, because Step2_Sent_At IS blank.
  //   - the "prior step exists" check passes, because Step1_Sent_At IS set.
  //   - Next_Action_Date is due, Stop/DNC/Replied/Suppressed are all clear.
  // Only expectedStep (3) !== requestedStep (2) can refuse this — it is
  // the sole line standing between "re-run a step the system already
  // considers complete" and a real send.
  var completedButCellCleared = {
    Status: STATUS.IN_SEQUENCE, Sequence_Step: 2, Step1_Sent_At: new Date(), Step2_Sent_At: '', Step3_Sent_At: '',
    Next_Action_Date: past
  };
  assert_(canSend_(completedButCellCleared, 2, config, now) === false,
    'canSend_ must refuse to re-run step 2 when Sequence_Step already says step 2 is complete — ' +
    'this is caught ONLY by expectedStep !== step (N7).');
}

function test_finding11_previewSkipsOnBrokenThreadReference_() {
  var row = addTestProspectRow_({
    Email: testUniqueEmail_('finding11'), Problem_Found: 'x',
    Status: STATUS.IN_SEQUENCE, Sequence_Step: 1, Step1_Sent_At: new Date(),
    Thread_ID: 'a-thread-id-that-does-not-exist-anywhere'
  });
  var p = getTestProspectByRow_(row);
  var id = Utilities.getUuid();
  var normEmail = normalizeEmail_(p.Email);
  assignNewProspectIdAndFields_(row, { Prospect_ID: id, Date_Added: new Date(), Domain_Type: DOMAIN_TYPE.CORPORATE,
    Email_Normalized: normEmail, Domain: extractDomain_(normEmail) }, { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });

  var beforeSnapshot = snapshotOperationalColumns_(row);
  var outcome = previewStep(id, 2);
  var afterSnapshot = snapshotOperationalColumns_(row);

  assertEquals_('SKIPPED_THREAD_NOT_FOUND', outcome.status,
    'previewStep must not silently fall back to a standalone draft when a LIVE Thread_ID is set but unresolvable (finding #11).');
  assertEquals_(JSON.stringify(beforeSnapshot), JSON.stringify(afterSnapshot), 'Prospects must remain untouched even on this error path.');
  var noLedgerRow = findActiveDryRunDraft_(id, 2);
  assert_(!noLedgerRow, 'No draft/ledger row should have been created.');
}

function test_finding12_protectionEditorPolicyNeverThrows_() {
  var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
  var protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  var target = protections.filter(function (p) { return p.getDescription() === 'Klinner Outreach — system-owned columns'; })[0];
  assert_(!!target, 'Precondition: the Prospects protected range must already exist (initializeSheets ran).');

  var effectiveEmail = Session.getEffectiveUser().getEmail();
  var editors = target.getEditors().map(function (e) { return e.getEmail(); });
  assert_(editors.indexOf(effectiveEmail) !== -1,
    'The effective user running the installer must remain an editor of the protected range (finding #12) — never locked out.');

  // (mock-only) A Group-derived editor that the mock refuses to remove
  // (mirroring real Apps Script's behavior for Group/domain-derived
  // access) must be left in place rather than crash initializeSheets() —
  // proof of graceful degradation. Real Google Group-derived-access
  // semantics still need verification against an actual Workspace-shared
  // Sheet — see the delivery report.
  assert_(editors.indexOf('shared-via-group@example.com') !== -1,
    '(mock) A Group-derived editor that cannot be removed must be left in place, not crash the setup.');
}

function test_finding13_publicDomainPolicyToggleIsConsulted_() {
  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var targetRow = -1;
  for (var i = 0; i < values.length; i++) if (values[i][0] === 'ALLOW_PUBLIC_DOMAIN_PROSPECTS') targetRow = i + 2;
  assert_(targetRow !== -1, 'ALLOW_PUBLIC_DOMAIN_PROSPECTS must exist in Config.');
  var original = sheet.getRange(targetRow, 2).getValue();

  try {
    sheet.getRange(targetRow, 2).setValue('TRUE');
    resetConfigCache_();
    var rowTrue = addTestProspectRow_({ Email: 'finding13-true-' + Utilities.getUuid().substring(0, 8) + '@gmail.com', Problem_Found: 'x' });
    validateAllRows();
    assertEquals_(STATUS.READY, getTestProspectByRow_(rowTrue).Status,
      'ALLOW_PUBLIC_DOMAIN_PROSPECTS=TRUE must leave a gmail.com prospect READY (finding #13).');

    sheet.getRange(targetRow, 2).setValue('FALSE');
    resetConfigCache_();
    var rowFalse = addTestProspectRow_({ Email: 'finding13-false-' + Utilities.getUuid().substring(0, 8) + '@gmail.com', Problem_Found: 'x' });
    validateAllRows();
    var afterFalse = getTestProspectByRow_(rowFalse);
    assertEquals_(STATUS.STOPPED, afterFalse.Status,
      'ALLOW_PUBLIC_DOMAIN_PROSPECTS=FALSE must make a gmail.com prospect ineligible (Status=STOPPED) (finding #13).');
    assert_(getNextStepNumber_(afterFalse, getConfig()) === null, 'A policy-excluded prospect must never be eligible to receive a step.');
  } finally {
    sheet.getRange(targetRow, 2).setValue(original);
    resetConfigCache_();
  }
}

/**
 * Codex finding #8. Unlike #7, this IS fully testable without going LIVE —
 * it is a pure structural check of the JS global scope (mirrors the
 * finding #1 proof in T34(f)): the real Gmail-calling helpers must not be
 * reachable as globals, and the public wrappers must route through the
 * exact same guard as the single entry point, with no alternate path.
 */
function test_finding8_liveHelpersAreNotGlobalEntryPoints_() {
  assertEquals_('undefined', typeof doStep1Send_,
    'doStep1Send_ must NOT be reachable as a global — it must live only inside Mailer.gs\'s LIVE closure (finding #8).');
  assertEquals_('undefined', typeof doFollowUpSend_,
    'doFollowUpSend_ must NOT be reachable as a global — it must live only inside Mailer.gs\'s LIVE closure (finding #8).');
  assertEquals_('function', typeof executeLiveSendForStep_, 'executeLiveSendForStep_ must exist as the single guarded LIVE entry point.');

  // sendStep1/sendFollowUp must be thin wrappers around the SAME guard —
  // proven by getting the exact same DRY_RUN rejection, before any
  // Prospect_ID lookup even happens (a fabricated, nonexistent ID would
  // throw a DIFFERENT error — "not found" — if a guard were skipped).
  assert_(getConfig().DRY_RUN === true, 'finding #8 test requires DRY_RUN=TRUE.');
  ['sendStep1', 'sendFollowUp'].forEach(function (fnName) {
    var threwDryRun = false;
    try {
      if (fnName === 'sendStep1') sendStep1('nonexistent-prospect-id-for-finding8-test');
      else sendFollowUp('nonexistent-prospect-id-for-finding8-test', 2);
    } catch (e) {
      threwDryRun = String(e.message || e).indexOf('DRY_RUN=TRUE') !== -1;
    }
    assert_(threwDryRun, fnName + '() must be blocked by the SAME DRY_RUN guard as the single LIVE entry point, with no alternate path (finding #8).');
  });
}

function test_finding14_whitespaceOnlyFieldsCountAsBlank_() {
  var config = getConfig();
  var prospectMissingRequired = { Business_Name: 'X', Problem_Found: '   ' };
  var threw = false;
  try {
    renderTemplateText_('Body: {{Problem_Found}}', prospectMissingRequired, config);
  } catch (e) {
    threw = !!e.isMissingRequiredFieldError;
  }
  assert_(threw, 'A whitespace-only value for a required ({{field}}, no fallback) merge field must be treated as missing (finding #14).');

  var prospectWithFallback = { Personalization_Line: '   ' };
  var rendered = renderTemplateText_('Line: {{Personalization_Line|default text}}', prospectWithFallback, config);
  assertEquals_('Line: default text', rendered, 'A whitespace-only value for a field WITH a fallback must use the fallback (finding #14).');
}

/**
 * Google-real diagnostic fix: confirmed on the real "Klinner Outreach —
 * F1 Test" Sheet that numeric-looking Config values (MAX_PER_DAY etc.)
 * were stored correctly (visible in the formula bar) but rendered
 * invisible by Sheets' own cell auto-formatting — CASE A, display-only,
 * no data loss. Fixed by forcing Config!B to plain-text format before
 * writing. This test asserts the fix is actually applied, both for a
 * fresh initialization AND for the one-time repair helper that must fix
 * the already-initialized real sheet without touching any value.
 */
function test_configValueColumnIsPlainTextFormatted_() {
  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var maxPerDayRow = -1;
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === 'MAX_PER_DAY') { maxPerDayRow = i + 2; break; }
  }
  assert_(maxPerDayRow !== -1, 'Precondition: MAX_PER_DAY row must exist in Config.');

  var format = sheet.getRange(maxPerDayRow, 2).getNumberFormat();
  assertEquals_('@', format, 'initializeConfigSheet_ must format Config!B (Value) as plain text ("@") so numeric-looking defaults never render invisible.');

  // The value itself must be completely unaffected by the format fix.
  assertEquals_('5', String(sheet.getRange(maxPerDayRow, 2).getValue()), 'MAX_PER_DAY value must still read exactly "5".');

  // The repair helper (for the already-initialized real sheet) must be
  // non-destructive and idempotent: re-running it must not alter ANY
  // Key/Value/Description, only (re-)apply the same format.
  var beforeRepair = sheet.getRange(1, 1, lastRow, 3).getValues();
  var repairResult = repairConfigValueColumnFormat_();
  var afterRepair = sheet.getRange(1, 1, lastRow, 3).getValues();
  assertEquals_(JSON.stringify(beforeRepair), JSON.stringify(afterRepair),
    'repairConfigValueColumnFormat_ must not alter any Key/Value/Description cell — format-only.');
  assert_(repairResult.indexOf('Repaired') === 0, 'repairConfigValueColumnFormat_ must report what it did.');
  assertEquals_('@', sheet.getRange(maxPerDayRow, 2).getNumberFormat(), 'Format must still be plain text after the repair helper runs.');
}

/**
 * Google-real finding: on the real "Klinner Outreach — F1 Test" Sheet,
 * running Validate all rows on a Prospects sheet with real data only in
 * rows 2-6 turned rows 7-1000 (994 rows) into phantom NEEDS_DATA
 * prospects — each assigned a real Prospect_ID/Date_Added. Root cause:
 * initializeProspectsSheet_ applies checkbox data validation to
 * Stop_Contact (O) across all 999 provisioned rows up front, and real
 * Google Sheets auto-populates checkbox-validated blank cells with a
 * literal FALSE — content the old "every cell is '' or null" blank-check
 * did not recognize as blank. This test reproduces that exact real-world
 * cell state (not just an empty array) and proves readAllProspects()/
 * validateAllRows() now ignore it correctly.
 */
function test_ghostRowsNeverBecomeProspects_() {
  var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
  var TOTAL_ROWS = 1000;

  // Codex re-audit fix: the previous version only handled "delete rows
  // added BEYOND the original size" — it never restored the CONTENT of
  // rows that already existed inside 2..baselineLastRow before this test
  // overwrote them. When baselineLastRow was already >= TOTAL_ROWS (the
  // real-world case, since initializeSheets always provisions 1000 rows),
  // that delete-only cleanup was a complete no-op and any real pre-
  // existing data in that range was silently destroyed — demonstrated
  // with a sentinel row (see test_ghostRowFixtureIsNonDestructive_).
  //
  // Fix: snapshot the FULL affected range (2 .. max(baselineLastRow,
  // TOTAL_ROWS)) before writing anything, then in `finally` (a) delete
  // only the rows this test added beyond the original sheet size, and
  // (b) re-write the snapshot back over 2..baselineLastRow so every cell
  // this test touched — not just "extra" rows — is restored exactly.
  var baselineLastRow = sheet.getLastRow();
  var snapshotRowCount = Math.max(baselineLastRow, TOTAL_ROWS);
  var priorSnapshot = snapshotRowCount >= 2
    ? sheet.getRange(2, 1, snapshotRowCount - 1, PROSPECTS_LAST_COL).getValues()
    : [];

  try {
    var sharedDupEmail = testUniqueEmail_('ghost-dup');
    var realRowsByLineNumber = {
      2: { Business_Name: 'Acme Plumbing LLC', Contact_Name: 'Dana Ruiz', Email: sharedDupEmail, City: 'Austin', State: 'TX', Problem_Found: 'Homepage has no phone number.' },
      3: { Business_Name: "Rosa's Bakery", Contact_Name: 'Rosa Mendez', Email: 'ghost-b-' + Utilities.getUuid().substring(0, 6) + '@gmail.com', City: 'Dallas', State: 'TX', Problem_Found: 'Hours mismatch.' },
      4: { Business_Name: 'Blue Sky HVAC', Email: testUniqueEmail_('ghost-c'), City: 'Houston', State: 'TX', Problem_Found: '' },
      5: { Business_Name: 'Green Lawn Care', Contact_Name: 'Tom Lee', Email: 'not-an-email@@bad', City: 'San Antonio', State: 'TX', Problem_Found: 'Contact form 404s.' },
      6: { Business_Name: 'Acme Plumbing LLC', Contact_Name: 'Dana Ruiz', Email: sharedDupEmail, City: 'Austin', State: 'TX', Problem_Found: 'Homepage has no phone number.' } // exact duplicate of row 2
    };

    var block = [];
    for (var rowNum = 2; rowNum <= TOTAL_ROWS; rowNum++) {
      var blankRow = {};
      PROSPECTS_COLUMN_ORDER.forEach(function (c) { blankRow[c] = ''; });
      // The one real-world artifact every one of these 999 rows carries:
      // Stop_Contact checkbox validation auto-fills FALSE, human-touched or not.
      blankRow.Stop_Contact = false;

      if (realRowsByLineNumber[rowNum]) {
        var src = realRowsByLineNumber[rowNum];
        blankRow.Source = TEST_SOURCE_MARKER;
        blankRow.Business_Name = src.Business_Name;
        blankRow.Contact_Name = src.Contact_Name || '';
        blankRow.Email = src.Email;
        blankRow.City = src.City;
        blankRow.State = src.State;
        blankRow.Problem_Found = src.Problem_Found;
      }
      block.push(PROSPECTS_COLUMN_ORDER.map(function (c) { return blankRow[c]; }));
    }
    sheet.getRange(2, 1, block.length, PROSPECTS_LAST_COL).setValues(block);

    var result = validateAllRows();
    assertEquals_(5, result.processed,
      'Only the 5 rows with real human input may be processed — the 994 checkbox-only rows (7-1000) must be ignored entirely.');

    for (var r = 2; r <= 6; r++) {
      var v = rowArrayToObject_(sheet.getRange(r, 1, 1, PROSPECTS_LAST_COL).getValues()[0]);
      assert_(!!v.Prospect_ID, 'Row ' + r + ' (real data) must have been assigned a Prospect_ID.');
      assert_(!!v.Date_Added, 'Row ' + r + ' (real data) must have a Date_Added.');
      assert_(!!v.Status, 'Row ' + r + ' (real data) must have a Status.');
    }

    var ghostRows = sheet.getRange(7, 1, TOTAL_ROWS - 6, PROSPECTS_LAST_COL).getValues();
    var touchedGhost = ghostRows.filter(function (row) {
      var obj = rowArrayToObject_(row);
      return !!obj.Prospect_ID || !!obj.Date_Added || !!obj.Status;
    });
    assertEquals_(0, touchedGhost.length,
      'None of the 994 checkbox-only rows (7-1000) may have Prospect_ID/Date_Added/Status written — confirmed empty exactly as required.');
  } finally {
    // True restore, not just cleanup: most of this fixture (rows 7-1000)
    // is deliberately untagged (mirrors real blank rows, which never carry
    // Source="TEST_F1_AUTOMATED"), so the standard per-test Source-based
    // sweep cannot see it — and more importantly, ANY pre-existing content
    // in 2..baselineLastRow that this test's own write overwrote must come
    // back exactly, not just have "extra" rows trimmed.
    //
    // Step 1: shrink the sheet back to its original row count (deletes
    // only rows this test itself added beyond what already existed).
    var currentLastRow = sheet.getLastRow();
    if (currentLastRow > baselineLastRow) {
      sheet.deleteRows(baselineLastRow + 1, currentLastRow - baselineLastRow);
    }
    // Step 2: re-write the pre-test snapshot back over 2..baselineLastRow,
    // restoring every cell this test's fixture overwrote — including a
    // baselineLastRow that was already >= TOTAL_ROWS (the real-world case).
    if (baselineLastRow >= 2) {
      sheet.getRange(2, 1, baselineLastRow - 1, PROSPECTS_LAST_COL).setValues(priorSnapshot.slice(0, baselineLastRow - 1));
    }
  }
}

/**
 * Codex re-audit finding: proves the fix above with a real sentinel — a
 * pre-existing "real" prospect row sitting INSIDE the range
 * test_ghostRowsNeverBecomeProspects_ overwrites (rows 2-1000), including
 * the exact failing case Codex demonstrated: the sheet already having
 * >= 1000 rows of real content before the ghost test runs. Runs the ghost
 * test itself (not a copy of its logic) so this is a true regression
 * guard on the same code path, not a parallel one that could drift.
 */
function test_ghostRowFixtureIsNonDestructive_() {
  var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
  var sentinelRow = 500; // deep inside the range the ghost test overwrites and must restore.

  var sentinelValues = {};
  PROSPECTS_COLUMN_ORDER.forEach(function (c) { sentinelValues[c] = ''; });
  sentinelValues.Prospect_ID = 'sentinel-preserve-me';
  sentinelValues.Date_Added = new Date();
  sentinelValues.Source = 'REAL_DATA';
  sentinelValues.Business_Name = 'Original Real Prospect';
  sentinelValues.Email = 'sentinel@example-corp-test.com';
  sentinelValues.Email_Normalized = 'sentinel@example-corp-test.com';
  sentinelValues.Domain = 'example-corp-test.com';
  sentinelValues.Domain_Type = DOMAIN_TYPE.CORPORATE;
  sentinelValues.City = 'Chicago';
  sentinelValues.State = 'IL';
  sentinelValues.Problem_Found = 'Pre-existing real data that must never be touched.';
  sentinelValues.Stop_Contact = false;
  sentinelValues.Status = STATUS.READY;

  // The sheet should already have >= sentinelRow rows from initializeSheets'
  // own 1000-row provisioning; this is defensive, not the point of the test.
  if (sheet.getLastRow() < sentinelRow) sheet.insertRowsAfter(sheet.getLastRow(), sentinelRow - sheet.getLastRow());
  sheet.getRange(sentinelRow, 1, 1, PROSPECTS_LAST_COL).setValues([PROSPECTS_COLUMN_ORDER.map(function (c) { return sentinelValues[c]; })]);
  var sentinelBefore = sheet.getRange(sentinelRow, 1, 1, PROSPECTS_LAST_COL).getValues()[0];

  try {
    // Exercises the EXACT snapshot/write/restore path under scrutiny —
    // including the case Codex used to prove the bug: baselineLastRow is
    // now >= 1000 (this sentinel plus initializeSheets' own provisioning),
    // which is precisely the scenario the old delete-only cleanup silently
    // did nothing for.
    test_ghostRowsNeverBecomeProspects_();

    var sentinelAfter = sheet.getRange(sentinelRow, 1, 1, PROSPECTS_LAST_COL).getValues()[0];
    var sentinelSurvivedAfterTestAndCleanup = JSON.stringify(sentinelBefore) === JSON.stringify(sentinelAfter);
    assert_(sentinelSurvivedAfterTestAndCleanup,
      'sentinelSurvivedAfterTestAndCleanup must be true. Before=' + JSON.stringify(sentinelBefore) +
      ' After=' + JSON.stringify(sentinelAfter));
  } finally {
    // Self-cleanup of the sentinel row itself — independent of whatever
    // the inner ghost test's own cleanup did.
    sheet.getRange(sentinelRow, 1, 1, PROSPECTS_LAST_COL).setValues([PROSPECTS_COLUMN_ORDER.map(function () { return ''; })]);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

var F1_TEST_FUNCTIONS = [
  ['T2', test_T2_alreadySentGuard_],
  ['T5', test_T5_needsDataPersistsAndPipelineNeverWrites_],
  ['T6', test_T6_invalidEmailIsSyntaxOnly_],
  ['T13', test_T13_publicDomainsExemptFromOneDomainRule_],
  ['T14', test_T14_domainSuppressionRejectedForPublicDomain_],
  ['T16_T17', test_T16_T17_businessDayCadence_],
  ['T18', test_T18_pauseAllBlocksPreview_],
  ['T19', test_T19_dryRunNeverWritesProspects_],
  ['T21', test_T21_blankNextActionDateIgnored_],
  ['T23', test_T23_followUpsPrioritizedOverNewProspects_],
  ['T25', test_T25_draftRegenerationLeavesOnlyOneLiveDraft_NEEDS_LIVE_GMAIL_],
  ['T28', test_T28_liveBlockedWhilePendingF0_],
  ['T29_T30_T31_T32', test_T29_T30_T31_T32_unsubscribeAndResetGuards_],
  ['T33', test_T33_validateAllRowsPersistsUnderDryRun_],
  ['T34', test_T34_originSeparation_],
  ['T35', test_T35_digestSkipsSendWhenAdminEmailPending_],
  ['finding1_writeBoundary', test_finding1_writeBoundaryRejectsOutOfScopeColumns_],
  ['finding3A_stopUnsubscribe', test_finding3A_stopProspectUnsubscribeCreatesSuppression_],
  ['finding3B_reconSweep', test_finding3B_reconSweepGuaranteesSuppressionEvenIfAlreadyStopped_],
  ['N2_domainSuppressionMasking', test_N2_unsubscribeAlwaysCreatesEmailScopeRecordEvenUnderDomainSuppression_],
  ['N2_round2_reasonMasking', test_N2_round2_priorReasonNeverMasksUnsubscribeRecord_],
  ['finding4_draftOwnership', test_finding4_foreignDraftIsNeverDeleted_],
  ['N3_editedDraftRecognized', test_N3_editedDraftStillRecognizedViaMessageId_],
  ['finding5_previewLocking', test_finding5_previewLocksCriticalSection_],
  ['finding6_orphanCompensation', test_finding6_orphanedDraftIsCompensatedOnLedgerFailure_],
  ['finding8_liveEntryPoint', test_finding8_liveHelpersAreNotGlobalEntryPoints_],
  ['finding9_quotaBudget', test_finding9_quotaBudgetRespectsAllFourFactors_],
  ['finding10_canSendSequence', test_finding10_canSendEnforcesStepSequence_],
  ['finding11_brokenThreadPreview', test_finding11_previewSkipsOnBrokenThreadReference_],
  ['finding12_protectionPolicy', test_finding12_protectionEditorPolicyNeverThrows_],
  ['finding13_publicDomainToggle', test_finding13_publicDomainPolicyToggleIsConsulted_],
  ['finding14_whitespaceBlank', test_finding14_whitespaceOnlyFieldsCountAsBlank_],
  ['configValuePlainTextFormat', test_configValueColumnIsPlainTextFormatted_],
  ['ghostRowsNeverBecomeProspects', test_ghostRowsNeverBecomeProspects_],
  ['ghostRowFixtureNonDestructive', test_ghostRowFixtureIsNonDestructive_]
];

/** Run manually once a real Gmail thread has been set up per its docstring — not part of the automated suite. */
var F1_MANUAL_ONLY_TESTS = [
  ['T26_T27', test_T26_T27_previewThreadingBranches_MANUAL_SEE_DOCSTRING_]
];

/**
 * Reaudit finding N6: isolation can no longer be "clean up once at the end
 * of the whole suite" — that let test N leak state (a Prospects row, a
 * Suppression row, a draft) that test N+1 then silently ran against,
 * exactly as the reaudit demonstrated (T31's leftover unsubscribe row got
 * picked up by a later test's sweep). Every test now gets its OWN Run_ID
 * (via resetRunId_() immediately before it runs) and its own full
 * teardown pass immediately after it finishes — pass or fail, since a
 * failing test must not skip cleanup either.
 */
function runAllF1Tests() {
  var results = [];
  var allTestRunIds = [];

  F1_TEST_FUNCTIONS.forEach(function (pair) {
    var name = pair[0];
    var fn = pair[1];

    resetRunId_();
    var testRunId = getRunId_(); // Fresh, unique to this one test.
    allTestRunIds.push(testRunId);

    var testError = null;
    try {
      fn();
    } catch (e) {
      testError = String(e.message || e);
    }

    var cleanupError = null;
    try {
      cleanupTestArtifacts_(testRunId);
    } catch (e) {
      cleanupError = String(e.message || e);
    }

    var isolation = { clean: false, detail: 'not checked' };
    try {
      isolation = verifyCleanTestState_(testRunId);
    } catch (e) {
      isolation = { clean: false, detail: 'verifyCleanTestState_ threw: ' + e };
    }

    results.push({
      name: name,
      passed: !testError,
      error: testError,
      isolationOk: isolation.clean,
      isolationDetail: isolation.detail,
      cleanupError: cleanupError
    });
  });

  // Belt-and-suspenders: sweep every Run_ID this suite ever minted, in case
  // any single test's own cleanup pass threw before finishing (already
  // logged as cleanupError above, but this still leaves no residue).
  allTestRunIds.forEach(function (id) { cleanupTestLedgerAndLog_(id); });
  cleanupTestRows_(); // Also clears _testCreatedSuppressionValues.

  var passed = results.filter(function (r) { return r.passed; }).length;
  var isolationFailures = results.filter(function (r) { return !r.isolationOk; });
  var report = results.map(function (r) {
    var line = (r.passed ? 'PASS' : 'FAIL') + '  ' + r.name + (r.passed ? '' : '  — ' + r.error);
    if (!r.isolationOk) line += '\n       ISOLATION LEAK: ' + r.isolationDetail;
    if (r.cleanupError) line += '\n       CLEANUP ERROR: ' + r.cleanupError;
    return line;
  }).join('\n');

  console.log('Klinner Outreach F1 tests: ' + passed + '/' + results.length + ' passed. ' +
    'Isolation clean: ' + (results.length - isolationFailures.length) + '/' + results.length + '.\n' + report);
  return {
    passed: passed, total: results.length, results: results, report: report,
    isolationCleanCount: results.length - isolationFailures.length
  };
}

/**
 * Per-test teardown (N6). Removes everything the single test that just ran
 * could have produced: Prospects fixtures, its SendLedger rows (including
 * deleting any real DRY_RUN drafts they reference, via the SAME ownership-
 * verified path production code uses — never a blind wipe), its Log rows,
 * and any Suppression rows it created. Safe to call even if the test threw
 * partway through.
 */
function cleanupTestArtifacts_(testRunId) {
  flushLog_(); // Force out anything still buffered so it's actually in the sheet to clean.

  var ledgerRows = readAllLedgerRows_().filter(function (r) { return r.values.Run_ID === testRunId; });
  ledgerRows.forEach(function (r) {
    if (r.values.Mode === LEDGER_MODE.DRY_RUN && r.values.State === LEDGER_STATE.DRAFTED && r.values.Draft_ID) {
      deletePreviewDraftIfOwned_(r.values.Draft_ID, r.values); // Best-effort; already-gone or unverifiable is fine here.
    }
  });

  cleanupTestLedgerAndLog_(testRunId);
  cleanupTestRows_(); // Prospects fixtures + tracked Suppression rows for this test.
}

/**
 * N6: a positive check that teardown actually worked, not just an
 * assumption. Only checks what THIS test could have touched — pre-existing
 * production data (on a non-dedicated test spreadsheet) is untouched by
 * design and must not trip this.
 */
function verifyCleanTestState_(testRunId) {
  var leftoverProspects = readAllProspects().filter(function (r) { return r.values.Source === TEST_SOURCE_MARKER; }).length;
  var leftoverLedger = readAllLedgerRows_().filter(function (r) { return r.values.Run_ID === testRunId; }).length;

  var logSheet = getSheet_(SHEET_NAMES.LOG);
  var logLastRow = logSheet.getLastRow();
  var leftoverLog = 0;
  if (logLastRow >= 2) {
    var logRunIdCol = logSheet.getRange(2, LOG_COLUMNS.Run_ID, logLastRow - 1, 1).getValues();
    leftoverLog = logRunIdCol.filter(function (row) { return row[0] === testRunId; }).length;
  }

  var leftoverSuppression = _testCreatedSuppressionValues.length + _testCreatedDomainSuppressionValues_.length; // cleanupTestArtifacts_ should have zeroed both.

  var problems = [];
  if (leftoverProspects > 0) problems.push(leftoverProspects + ' Prospects test row(s)');
  if (leftoverLedger > 0) problems.push(leftoverLedger + ' SendLedger row(s) for Run_ID=' + testRunId);
  if (leftoverLog > 0) problems.push(leftoverLog + ' Log row(s) for Run_ID=' + testRunId);
  if (leftoverSuppression > 0) problems.push(leftoverSuppression + ' tracked Suppression row(s) not cleared');

  return { clean: problems.length === 0, detail: problems.length === 0 ? 'clean' : problems.join('; ') };
}

/**
 * Finding #15 / N6: setup/teardown must also clean SendLedger and Log so
 * repeated test runs never contaminate each other. Every row a given test
 * run produced shares one Run_ID — delete exactly those, bottom-up,
 * leaving any pre-existing production data untouched.
 */
function cleanupTestLedgerAndLog_(testRunId) {
  var ledgerSheet = getSheet_(SHEET_NAMES.SEND_LEDGER);
  var ledgerLastRow = ledgerSheet.getLastRow();
  if (ledgerLastRow >= 2) {
    var runIdCol = ledgerSheet.getRange(2, SEND_LEDGER_COLUMNS.Run_ID, ledgerLastRow - 1, 1).getValues();
    for (var i = runIdCol.length - 1; i >= 0; i--) {
      if (runIdCol[i][0] === testRunId) ledgerSheet.deleteRow(i + 2);
    }
  }

  var logSheet = getSheet_(SHEET_NAMES.LOG);
  var logLastRow = logSheet.getLastRow();
  if (logLastRow >= 2) {
    var logRunIdCol = logSheet.getRange(2, LOG_COLUMNS.Run_ID, logLastRow - 1, 1).getValues();
    for (var j = logRunIdCol.length - 1; j >= 0; j--) {
      if (logRunIdCol[j][0] === testRunId) logSheet.deleteRow(j + 2);
    }
  }
}
