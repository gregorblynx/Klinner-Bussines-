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
  // A Thursday: 2026-01-08 is a Thursday. Built via dateFromWallClock_ (not
  // a raw `new Date(y, mo, d, ...)`, which is LOCAL-ENVIRONMENT-relative,
  // not Chicago-relative — see the TIMEZONE AUDIT finding on
  // addCalendarDays_/dateFromWallClock_ in Schedule.gs) so this fixture
  // means "Thursday 10:00 America/Chicago" regardless of what timezone the
  // machine running this test happens to have.
  var thursday = dateFromWallClock_(2026, 0, 8, 10, 0, 0, getScriptTimeZone_());
  var next = computeNextActionDate_(1, thursday, config);
  assertEquals_('2026-01-13', formatDateYmd_(next), 'Step1 sent Thursday + 3 business days must land on the following Tuesday (T16).');

  // Holiday inside the window: 2026-06-19 (Juneteenth) is a Friday holiday.
  var beforeHoliday = dateFromWallClock_(2026, 5, 17, 10, 0, 0, getScriptTimeZone_()); // Wed 2026-06-17
  var withHoliday = addBusinessDays_(beforeHoliday, 3, config.HOLIDAYS);
  // Wed->Thu(1)->Fri(2, holiday, skipped)->Mon(2)->Tue(3) = 2026-06-23
  assertEquals_('2026-06-23', formatDateYmd_(withHoliday), 'A configured holiday inside the offset window must be skipped (T17).');
}

/**
 * TIMEZONE AUDIT: proves addCalendarDays_/dateFromWallClock_ compute in
 * America/Chicago specifically, not "whatever timezone this process
 * happens to be running in". Fixes a real bug found tonight: the previous
 * addCalendarDays_ used raw JS Date.getDate()/setDate() (environment-
 * timezone-relative) and the mock Utilities.formatDate ignored its `tz`
 * argument entirely — both silently correct only because this repo's own
 * dev machine happens to already be set to America/Chicago. Verified this
 * test (and the full suite) passes identically under TZ=America/Chicago,
 * TZ=UTC, TZ=Asia/Kolkata (+5:30, no DST), TZ=Pacific/Kiritimati (+14) and
 * TZ=Etc/GMT+12 (-12) — see TIMEZONE_AUDIT.md.
 */
function test_timezoneAudit_dateMathIsChicagoRelativeNotEnvironmentRelative_() {
  // Independent ground truth, constructed WITHOUT going through
  // dateFromWallClock_/Utilities.formatDate at all (a plain ISO-8601 'Z'
  // parse is environment-independent by spec): 2026-01-08T16:00:00Z is
  // 2026-01-08 10:00 in America/Chicago (CST, UTC-6) in January. This is
  // the one assertion in this test that can actually catch Utilities.
  // formatDate itself silently ignoring its `tz` argument — every other
  // assertion here round-trips through that same function, so a mock that
  // is consistently (if silently) wrong about `tz` could otherwise pass by
  // being self-consistent.
  var knownInstant = new Date('2026-01-08T16:00:00Z');
  assertEquals_('2026-01-08', Utilities.formatDate(knownInstant, 'America/Chicago', 'yyyy-MM-dd'),
    'Ground truth: 2026-01-08T16:00:00Z must read as 2026-01-08 in America/Chicago.');
  assertEquals_('10', Utilities.formatDate(knownInstant, 'America/Chicago', 'HH'),
    'Ground truth: 2026-01-08T16:00:00Z must read as 10:00 in America/Chicago (CST, UTC-6) — proves Utilities.formatDate ' +
    'actually honors its `tz` argument rather than the executing environment\'s own timezone.');

  var chicagoNoon = dateFromWallClock_(2026, 0, 8, 12, 0, 0, 'America/Chicago'); // Thu 2026-01-08 noon CST
  assertEquals_('2026-01-08', Utilities.formatDate(chicagoNoon, 'America/Chicago', 'yyyy-MM-dd'),
    'Precondition: dateFromWallClock_ must build an instant that reads back as the exact requested Chicago wall clock.');
  assertEquals_('12', Utilities.formatDate(chicagoNoon, 'America/Chicago', 'HH'));

  var plusOne = addCalendarDays_(chicagoNoon, 1);
  assertEquals_('2026-01-09', Utilities.formatDate(plusOne, 'America/Chicago', 'yyyy-MM-dd'),
    'addCalendarDays_(+1) must land on the next Chicago calendar day.');
  assertEquals_('12', Utilities.formatDate(plusOne, 'America/Chicago', 'HH'),
    'addCalendarDays_ must preserve wall-clock time-of-day in Chicago, not in whatever timezone the process happens to run in.');

  // Cross a DST "spring forward" boundary (2026-03-08 02:00 America/Chicago
  // does not exist — clocks jump 02:00 -> 03:00). A time safely before it
  // (2026-03-07 12:00) plus 1 day must land on 2026-03-08 at the same
  // 12:00 wall clock (unaffected, since noon is nowhere near the 2am jump).
  var beforeSpringForward = dateFromWallClock_(2026, 2, 7, 12, 0, 0, 'America/Chicago');
  var afterSpringForward = addCalendarDays_(beforeSpringForward, 1);
  assertEquals_('2026-03-08', Utilities.formatDate(afterSpringForward, 'America/Chicago', 'yyyy-MM-dd'));
  assertEquals_('12', Utilities.formatDate(afterSpringForward, 'America/Chicago', 'HH'),
    'A DST transition elsewhere in the day must not perturb a noon-anchored calendar-day add.');
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

/**
 * N4 (was "BLOCKER BEFORE F3", now closed — Constants.gs): SYSTEM_REPLY_SYNC
 * and SYSTEM_NIGHTLY_RECON must be structurally forbidden from ever setting
 * Do_Not_Contact_Reason="unsubscribe" — same restrictedValues pattern
 * ADMIN_VALIDATE/ADMIN_STOP already had. Proves both the negative (rejects
 * "unsubscribe") and the positive (legitimate values these operations
 * actually use in production code — BOUNCE, MANUAL — still work).
 */
function test_N4_systemOperationsCannotSetUnsubscribeReason_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n4'), Problem_Found: 'x' });
  var p = getTestProspectByRow_(row);
  var id = Utilities.getUuid();
  assignNewProspectIdAndFields_(row, { Prospect_ID: id, Date_Added: new Date(), Status: STATUS.READY },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });

  var negativeCases = [
    { op: OPERATION.SYSTEM_REPLY_SYNC, label: 'SYSTEM_REPLY_SYNC setting Do_Not_Contact_Reason="unsubscribe"' },
    { op: OPERATION.SYSTEM_NIGHTLY_RECON, label: 'SYSTEM_NIGHTLY_RECON setting Do_Not_Contact_Reason="unsubscribe"' }
  ];
  negativeCases.forEach(function (c) {
    var threw = false;
    try {
      writeRowById_(id, { Do_Not_Contact_Reason: DNC_REASON.UNSUBSCRIBE }, { origin: ORIGIN.SYSTEM, operation: c.op });
    } catch (e) { threw = true; }
    assert_(threw, 'N4: must reject — ' + c.label);
  });

  // Positive: the values these operations actually write in production
  // code today (ReplySync.gs) must remain unaffected by the new guard.
  writeRowById_(id, { Do_Not_Contact_Reason: DNC_REASON.BOUNCE, Status: STATUS.BOUNCED },
    { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_REPLY_SYNC });
  assertEquals_(DNC_REASON.BOUNCE, getTestProspectByRow_(row).Do_Not_Contact_Reason, 'N4: SYSTEM_REPLY_SYNC must still be able to set "bounce".');

  writeRowById_(id, { Do_Not_Contact_Reason: DNC_REASON.MANUAL, Status: STATUS.STOPPED },
    { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_REPLY_SYNC });
  assertEquals_(DNC_REASON.MANUAL, getTestProspectByRow_(row).Do_Not_Contact_Reason, 'N4: SYSTEM_REPLY_SYNC must still be able to set "manual" (checkStopLabel_).');

  writeRowById_(id, { Do_Not_Contact_Reason: DNC_REASON.DUPLICATE, Status: STATUS.STOPPED },
    { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_NIGHTLY_RECON });
  assertEquals_(DNC_REASON.DUPLICATE, getTestProspectByRow_(row).Do_Not_Contact_Reason, 'N4: SYSTEM_NIGHTLY_RECON must still be able to set non-unsubscribe reasons.');
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
 * N3 (round 1 regression guard): a draft that has NOT been touched since
 * creation — Draft_ID, Thread_ID and Message_ID all still exactly what
 * previewStep() recorded — must regenerate normally on a second preview
 * run: old draft deleted, ledger row superseded, exactly one live draft
 * survives. This is CASO 1. (T25 already covers this end-to-end against a
 * real-Gmail-only path; this is the offline-runnable equivalent.)
 */
function test_N3_stableUntouchedDraftRegeneratesNormally_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3caso1'), Problem_Found: 'Original problem statement.' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var first = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', first.status, 'First preview must draft.');

  var second = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', second.status, 'CASO 1: an untouched draft must regenerate normally on the next preview.');
  assert_(first.draftId !== second.draftId, 'Regeneration must produce a new draft id.');

  var liveDrafts = GmailApp.getDrafts().filter(function (d) { return d.getId() === first.draftId || d.getId() === second.draftId; });
  assertEquals_(1, liveDrafts.length, 'CASO 1: exactly one live draft must remain — the old one deleted, not left stranded.');
  assertEquals_(second.draftId, liveDrafts[0].getId(), 'The surviving draft must be the newly created one.');

  var draftedRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, draftedRows.length, 'CASO 1: exactly one DRAFTED ledger row must remain.');
}

/**
 * Shared setup for the N3 V2 durable-preservation tests below: creates a
 * prospect, drafts step 1, and returns everything a test needs to then
 * simulate a specific kind of human edit against the live Gmail message.
 */
function n3_setupDraftedProspectForEditTest_(emailTag) {
  var row = addTestProspectRow_({ Email: testUniqueEmail_(emailTag), Problem_Found: 'Original problem statement.' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var first = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', first.status, 'First preview must draft.');

  var firstLedgerRow = findActiveDryRunDraft_(p.Prospect_ID, 1);
  assert_(!!firstLedgerRow, 'Precondition: an active DRAFTED ledger row must exist after the first preview.');
  assert_(!!firstLedgerRow.values.Draft_Fingerprint, 'Precondition: Draft_Fingerprint must have been captured at creation.');

  var liveDraft = GmailApp.getDrafts().filter(function (d) { return d.getId() === first.draftId; })[0];
  assert_(!!liveDraft, 'Precondition: the first draft must exist.');

  return { p: p, first: first, firstLedgerRow: firstLedgerRow, liveDraft: liveDraft, message: liveDraft.getMessage() };
}

function n3_assertDurablyPreserved_(ctx, outcome, expectMessageIdChanged) {
  assertEquals_('SKIPPED_DRAFT_PRESERVED_HUMAN_EDIT', outcome.status,
    'A content-fingerprint change must be recognized and durably preserved, not silently regenerated.');

  var stillThere = GmailApp.getDrafts().filter(function (d) { return d.getId() === ctx.first.draftId; })[0];
  assert_(!!stillThere, 'The human-edited draft must NOT have been deleted.');

  var activeRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === ctx.p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, activeRows.length, 'Exactly one active DRAFTED ledger row must exist — no duplicate.');
  assertEquals_(ctx.first.draftId, activeRows[0].values.Draft_ID, 'The active row must still reference the SAME (preserved) Draft_ID.');
  assertEquals_(true, activeRows[0].values.Human_Edit_Preserved, 'The active row must carry the durable Human_Edit_Preserved marker.');
  assert_(!!activeRows[0].values.Human_Edit_Detected_At, 'The active row must record when the edit was detected.');
  assert_(activeRows[0].values.Draft_Fingerprint !== ctx.firstLedgerRow.values.Draft_Fingerprint,
    'The active row\'s fingerprint must reflect the CURRENT (edited) content, not the original.');
  if (expectMessageIdChanged === true) {
    assert_(activeRows[0].values.Message_ID !== ctx.firstLedgerRow.values.Message_ID, 'Message_ID was expected to have rotated.');
  } else if (expectMessageIdChanged === false) {
    assertEquals_(ctx.firstLedgerRow.values.Message_ID, activeRows[0].values.Message_ID,
      'Message_ID was expected to stay the SAME — detection must come from the fingerprint alone, not Message_ID.');
  }

  // Audit trail: original row appended-not-deleted, marked SUPERSEDED, history untouched.
  var allRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === ctx.p.Prospect_ID && r.values.Step === 1;
  });
  var original = allRows.filter(function (r) { return r.rowIndex === ctx.firstLedgerRow.rowIndex; })[0];
  assert_(!!original, 'The ORIGINAL ledger row must still exist (appended, not deleted).');
  assertEquals_(LEDGER_STATE.SUPERSEDED, original.values.State, 'The original row must be marked SUPERSEDED, not mutated into the new state.');
  assertEquals_(ctx.firstLedgerRow.values.Message_ID, original.values.Message_ID, 'The original row must keep its ORIGINAL Message_ID forever.');
  assertEquals_(ctx.firstLedgerRow.values.Draft_Fingerprint, original.values.Draft_Fingerprint, 'The original row must keep its ORIGINAL fingerprint forever.');
  assert_(original.values.Error.indexOf('HUMAN_EDIT_PRESERVED') !== -1,
    'The original row must carry a distinguishing marker proving this was a durable preservation, not an ordinary delete+recreate supersede.');

  return activeRows[0];
}

/**
 * N3 V2 GOOGLE-REAL FINDING (round 2) — item 2: reproduces the exact
 * real-world scenario found on the "Klinner Outreach — F1 Test" Sheet with
 * the Rosa's Bakery draft, where Message_ID rotated after a human edit.
 * Also covers items 4, 5, 15, 16, 17 (durable preservation across
 * repeated later runs, with zero ledger growth once preserved).
 */
function test_N3_caso2_editWithMessageIdRotationIsPreservedDurably_() {
  var ctx = n3_setupDraftedProspectForEditTest_('n3caso2');
  var editedBody = ctx.message.getPlainBody() + '\n\nTEST EDIT';
  ctx.message.getPlainBody = function () { return editedBody; };
  ctx.message.getBody = ctx.message.getPlainBody;
  ctx.message.getId = function () { return ctx.firstLedgerRow.values.Message_ID + '-rotated-by-edit'; };

  var second = previewStep(ctx.p.Prospect_ID, 1);
  var preservedRow = n3_assertDurablyPreserved_(ctx, second, true);
  assertEquals_(editedBody, ctx.message.getPlainBody(), 'TEST EDIT must survive untouched (item 4).');

  // Item 5 / item 17: several MORE runs with no further edit — must stay
  // stable, no additional Gmail drafts, NO ledger growth (still exactly
  // 2 rows total for this key: the original + the one durable row).
  for (var i = 0; i < 3; i++) {
    var repeat = previewStep(ctx.p.Prospect_ID, 1);
    assertEquals_('SKIPPED_DRAFT_PRESERVED_HUMAN_EDIT', repeat.status, 'Run #' + (i + 3) + ' must still preserve — never recategorized as unedited (item 4/5).');
  }
  var allRowsFinal = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === ctx.p.Prospect_ID && r.values.Step === 1;
  });
  assertEquals_(2, allRowsFinal.length, 'Item 17: no repeated reconciliation rows — total row count must stay at exactly 2 (original + durable) after multiple later runs.');
  var draftsForKey = GmailApp.getDrafts().filter(function (d) { return d.getId() === ctx.first.draftId; });
  assertEquals_(1, draftsForKey.length, 'Exactly one Gmail draft must exist after repeated later runs — never duplicated.');
  assertEquals_(editedBody, draftsForKey[0].getMessage().getPlainBody(), 'TEST EDIT must still be intact after repeated later runs.');
}

/**
 * N3 V2 REAUDIT FINDING (round 3) — item 3: Message_ID staying the SAME
 * must NOT be interpreted as "unedited". Detection must come purely from
 * the content fingerprint.
 */
function test_N3_caso3_editWithoutMessageIdRotationIsPreservedDurably_() {
  var ctx = n3_setupDraftedProspectForEditTest_('n3caso3');
  var editedBody = ctx.message.getPlainBody() + '\n\nTEST EDIT (no id rotation)';
  ctx.message.getPlainBody = function () { return editedBody; };
  ctx.message.getBody = ctx.message.getPlainBody;
  // Deliberately do NOT override getId() — Message_ID stays exactly the same.

  var second = previewStep(ctx.p.Prospect_ID, 1);
  n3_assertDurablyPreserved_(ctx, second, false);
}

/**
 * N3 V2 CASO 5 — item 6: a human changing the RECIPIENT of the draft must
 * be detected (recipient is part of the fingerprint) and preserved, never
 * silently deleted or overwritten, and never mistaken for a foreign draft.
 */
function test_N3_caso5_recipientChangeIsPreservedDurably_() {
  var ctx = n3_setupDraftedProspectForEditTest_('n3caso5recipient');
  ctx.message.getTo = function () { return 'someone-completely-different@example-corp-test.com'; };

  var second = previewStep(ctx.p.Prospect_ID, 1);
  n3_assertDurablyPreserved_(ctx, second, false);
}

/**
 * N3 V2 CASO 5 — item 7: a human changing the SUBJECT of the draft must be
 * detected and preserved the same way.
 */
function test_N3_caso5_subjectChangeIsPreservedDurably_() {
  var ctx = n3_setupDraftedProspectForEditTest_('n3caso5subject');
  ctx.message.getSubject = function () { return 'A completely different subject the human typed'; };

  var second = previewStep(ctx.p.Prospect_ID, 1);
  n3_assertDurablyPreserved_(ctx, second, false);
}

/**
 * N3 V2 CASO 8 — item 12: GmailApp.getDrafts() itself failing (quota,
 * transient outage, permission) must fail closed — never interpreted as
 * "no drafts exist" (which would wrongly authorize creating a duplicate).
 */
function test_N3_caso8_gmailGetDraftsErrorFailsClosed_() {
  var ctx = n3_setupDraftedProspectForEditTest_('n3caso8getdrafts');
  var originalGetDrafts = GmailApp.getDrafts;
  GmailApp.getDrafts = function () { throw new Error('Simulated Gmail outage in getDrafts().'); };

  var second;
  try {
    second = previewStep(ctx.p.Prospect_ID, 1);
  } finally {
    GmailApp.getDrafts = originalGetDrafts; // restore immediately, even if an assertion below throws
  }

  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', second.status, 'A GmailApp.getDrafts() failure must fail closed, not create a duplicate.');
  assertEquals_('gmail_read_error', second.reason, 'The reason must identify a Gmail read error.');

  var draftedRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === ctx.p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, draftedRows.length, 'No new ledger row must have been created on a Gmail read error.');
  assert_(GmailApp.getDrafts().some(function (d) { return d.getId() === ctx.first.draftId; }), 'The original draft must be untouched.');
}

/**
 * N3 V2 CASO 8 — item 13: message.getId() failing must fail closed too,
 * distinctly from a getDrafts() failure (exercises a different call site).
 */
function test_N3_caso8_messageGetIdErrorFailsClosed_() {
  var ctx = n3_setupDraftedProspectForEditTest_('n3caso8getid');
  ctx.message.getId = function () { throw new Error('Simulated Gmail error reading message id.'); };

  var second = previewStep(ctx.p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', second.status, 'A message.getId() failure must fail closed.');
  assertEquals_('message_id_read_failed', second.reason, 'The reason must identify the failing read.');

  var draftedRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === ctx.p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, draftedRows.length, 'No new ledger row must have been created on a read error.');
  assert_(GmailApp.getDrafts().some(function (d) { return d.getId() === ctx.first.draftId; }), 'The original draft must be untouched (never deleted on a read error).');
}

/**
 * N3 V2 CASO 8 — item 14: a failure reading subject/body (content) must
 * also fail closed, distinctly from the id/thread read failures above.
 */
function test_N3_caso8_contentReadErrorFailsClosed_() {
  var ctx = n3_setupDraftedProspectForEditTest_('n3caso8content');
  ctx.message.getPlainBody = function () { throw new Error('Simulated Gmail error reading draft body.'); };
  ctx.message.getBody = ctx.message.getPlainBody;

  var second = previewStep(ctx.p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', second.status, 'A content read failure must fail closed.');
  assertEquals_('content_read_failed', second.reason, 'The reason must identify the failing read.');

  var draftedRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === ctx.p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, draftedRows.length, 'No new ledger row must have been created on a read error.');
  assert_(GmailApp.getDrafts().some(function (d) { return d.getId() === ctx.first.draftId; }), 'The original draft must be untouched (never deleted on a read error).');
}

/**
 * N3 V3 (Codex final audit) test helper: seeds a ledger row shaped exactly
 * like the two real rows Google-real found (Rosa's Bakery, Acme) —
 * created BEFORE Draft_Fingerprint/Human_Edit_Preserved/Human_Edit_Detected_At
 * existed. A real Gmail draft with the preview banner exists, but the
 * ledger row's Draft_Fingerprint is blank — bypasses previewStep()
 * entirely (which always populates a fingerprint now) to faithfully
 * reproduce the pre-migration shape.
 */
function n3v3_seedLegacyDraftedRow_(emailTag) {
  var row = addTestProspectRow_({ Email: testUniqueEmail_(emailTag), Problem_Found: 'Original problem statement.' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var subject = '[KLINNER PREVIEW · Step 1] Legacy test subject';
  var body = PREVIEW_BANNER + '\n\nOriginal legacy body, written before fingerprinting existed.';
  var draft = GmailApp.createDraft(p.Email, subject, body, {});
  var message = draft.getMessage();
  var threadId = message.getThread().getId();

  appendLedgerRow_({
    Run_ID: getRunId_(), Claimed_At: '', Prospect_ID: p.Prospect_ID, Email_Normalized: p.Email_Normalized,
    Step: 1, Idempotency_Key: getIdempotencyKey_(p.Prospect_ID, 1), Mode: LEDGER_MODE.DRY_RUN,
    State: LEDGER_STATE.DRAFTED, Thread_ID: threadId, Message_ID: message.getId(), Draft_ID: draft.getId(),
    Confirmed_At: new Date(), Error: '', Draft_Fingerprint: '', Human_Edit_Preserved: false, Human_Edit_Detected_At: ''
  });

  return { p: p, draft: draft, message: message, draftId: draft.getId(), threadId: threadId, originalBody: body };
}

/**
 * N3 V3 — item 11: reproduces ROSA exactly. Legacy row (blank
 * Draft_Fingerprint) + a KNOWN human edit (TEST EDIT appended, Message_ID
 * rotated) already applied before the first post-migration Preview runs.
 * Must never be deleted; TEST EDIT must survive; must become durably
 * preserved (not just silently skipped this one time).
 */
function test_N3v3_legacyBlankFingerprintKnownEditIsPreservedNeverDeleted_() {
  var ctx = n3v3_seedLegacyDraftedRow_('n3v3rosa');
  var editedBody = ctx.originalBody + '\n\nTEST EDIT';
  ctx.message.getPlainBody = function () { return editedBody; };
  ctx.message.getBody = ctx.message.getPlainBody;
  ctx.message.getId = function () { return ctx.message.getId ? 'rotated-legacy-message-id' : 'rotated-legacy-message-id'; };

  var outcome = previewStep(ctx.p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_PRESERVED_HUMAN_EDIT', outcome.status,
    'Item 11 (ROSA): a legacy row with a blank fingerprint and a known human edit must be preserved, never deleted.');

  assert_(GmailApp.getDrafts().some(function (d) { return d.getId() === ctx.draftId; }), 'ROSA draft must NOT have been deleted.');
  assertEquals_(editedBody, GmailApp.getDrafts().filter(function (d) { return d.getId() === ctx.draftId; })[0].getMessage().getPlainBody(),
    'TEST EDIT must survive intact.');

  var activeRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === ctx.p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, activeRows.length, 'Exactly one active row — no duplicate.');
  assertEquals_(true, activeRows[0].values.Human_Edit_Preserved, 'Item 16: the legacy row must become durably preserved.');
  assert_(!!activeRows[0].values.Draft_Fingerprint, 'A bootstrapped fingerprint must now exist on the durable row.');
}

/**
 * N3 V3 — item 12: reproduces ACME. Legacy row (blank Draft_Fingerprint),
 * NO known edit — the draft is (as far as we know) exactly as created.
 * Must STILL be preserved conservatively, never assumed intact, never
 * auto-deleted/regenerated.
 */
function test_N3v3_legacyBlankFingerprintApparentlyUntouchedIsPreservedConservatively_() {
  var ctx = n3v3_seedLegacyDraftedRow_('n3v3acme');
  // Deliberately no edit simulated — this IS the "apparently untouched" case.

  var outcome = previewStep(ctx.p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_PRESERVED_HUMAN_EDIT', outcome.status,
    'Item 12 (ACME): a legacy row must be preserved conservatively even when apparently untouched — never assumed intact without a baseline.');

  assert_(GmailApp.getDrafts().some(function (d) { return d.getId() === ctx.draftId; }), 'ACME draft must NOT have been deleted.');
  var activeRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === ctx.p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, activeRows.length, 'Exactly one active row — no duplicate.');
  assertEquals_(true, activeRows[0].values.Human_Edit_Preserved, 'The legacy row must become durably preserved even though it looked untouched.');
}

/**
 * N3 V3 — items 13/14/15/16: the FIRST post-migration Preview run
 * transitions a legacy row into the durable state (previous two tests).
 * This test additionally proves the SECOND and THIRD runs after that
 * transition still preserve, with zero ledger growth and zero duplicates
 * — the same durability guarantee CASO 2/3 already have, now proven for
 * the legacy path specifically.
 */
function test_N3v3_legacyPreservationSurvivesMultiplePostMigrationRuns_() {
  var ctx = n3v3_seedLegacyDraftedRow_('n3v3legacydurable');

  var first = previewStep(ctx.p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_PRESERVED_HUMAN_EDIT', first.status, 'First post-migration Preview must preserve, not delete (item 13).');

  for (var i = 0; i < 2; i++) {
    var repeat = previewStep(ctx.p.Prospect_ID, 1);
    assertEquals_('SKIPPED_DRAFT_PRESERVED_HUMAN_EDIT', repeat.status, 'Run #' + (i + 2) + ' must still preserve (item 14).');
  }

  var allRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === ctx.p.Prospect_ID && r.values.Step === 1;
  });
  assertEquals_(2, allRows.length, 'Item 15/16: no ledger growth after the initial legacy-to-durable transition — exactly 2 rows total (original legacy + durable).');
  var draftsForKey = GmailApp.getDrafts().filter(function (d) { return d.getId() === ctx.draftId; });
  assertEquals_(1, draftsForKey.length, 'Item 15: exactly one Gmail draft — never duplicated across repeated runs.');
}

/**
 * N3 V3 — blocker N3-4, item 41: if two active DRY_RUN/DRAFTED ledger rows
 * somehow exist for the same idempotency key (simulating the aftermath of
 * a partially-applied preserve transition: append succeeded, supersede of
 * the old row failed), resolveExistingPreviewDraft_ must never silently
 * pick one — it must fail closed.
 */
function test_N3v3_ambiguousMultipleActiveRowsBlocksRegeneration_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3v3ambiguous'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var first = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', first.status, 'First preview must draft.');
  var firstRow = findActiveDryRunDraft_(p.Prospect_ID, 1);

  // Simulate the ambiguous aftermath directly: a SECOND active DRAFTED row
  // for the exact same idempotency key, as preserveDraftDurably_'s append
  // step would produce if its own supersede step then failed.
  appendLedgerRow_({
    Run_ID: getRunId_(), Claimed_At: '', Prospect_ID: p.Prospect_ID, Email_Normalized: p.Email_Normalized,
    Step: 1, Idempotency_Key: getIdempotencyKey_(p.Prospect_ID, 1), Mode: LEDGER_MODE.DRY_RUN,
    State: LEDGER_STATE.DRAFTED, Thread_ID: firstRow.values.Thread_ID, Message_ID: firstRow.values.Message_ID,
    Draft_ID: firstRow.values.Draft_ID, Confirmed_At: new Date(), Error: '',
    Draft_Fingerprint: firstRow.values.Draft_Fingerprint, Human_Edit_Preserved: false, Human_Edit_Detected_At: ''
  });

  var activeRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(2, activeRows.length, 'Precondition: exactly two active rows must now exist.');

  var outcome = previewStep(p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', outcome.status, 'Ambiguity must fail closed, not silently pick a row.');
  assertEquals_('ambiguous_multiple_active_rows', outcome.reason, 'The reason must identify the ambiguity.');

  assert_(GmailApp.getDrafts().some(function (d) { return d.getId() === first.draftId; }), 'The original draft must NOT have been deleted while ambiguous.');
  var activeRowsAfter = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(2, activeRowsAfter.length, 'Nothing must have been superseded or added while ambiguous — no new draft created.');
}

/**
 * N3 V3 — blocker N3-4: if preserveDraftDurably_'s APPEND step itself
 * throws, the old row must be completely untouched (still State=DRAFTED,
 * still the sole active row) — proving the append-first ordering actually
 * protects against a zero-active-rows outcome.
 */
function test_N3v3_preserveTransitionAppendFailureLeavesOldRowIntact_() {
  var ctx = n3_setupDraftedProspectForEditTest_('n3v3appendfail');
  var editedBody = ctx.message.getPlainBody() + '\n\nTEST EDIT';
  ctx.message.getPlainBody = function () { return editedBody; };
  ctx.message.getBody = ctx.message.getPlainBody;

  var originalAppendLedgerRow = appendLedgerRow_;
  appendLedgerRow_ = function () { throw new Error('Simulated append failure during preserve transition.'); };

  var outcome;
  try {
    outcome = previewStep(ctx.p.Prospect_ID, 1);
  } finally {
    appendLedgerRow_ = originalAppendLedgerRow;
  }

  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', outcome.status, 'A failed preserve transition must fail closed.');
  assertEquals_('preserve_transition_failed', outcome.reason, 'The reason must identify the failed transition.');

  var activeRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === ctx.p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, activeRows.length, 'The old row must remain the SOLE active row — append-first ordering prevented a zero-active-rows outcome.');
  assertEquals_(ctx.firstLedgerRow.values.Draft_Fingerprint, activeRows[0].values.Draft_Fingerprint, 'The old row must be completely untouched by the failed append.');
  assert_(GmailApp.getDrafts().some(function (d) { return d.getId() === ctx.first.draftId; }), 'The draft itself must be untouched.');

  // Retry: with appendLedgerRow_ restored, the SAME edit must now be
  // detected and preserved successfully — proving the failure was
  // recoverable, not a permanent block.
  var retry = previewStep(ctx.p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_PRESERVED_HUMAN_EDIT', retry.status, 'Item 40: retry after a transient partial failure must succeed.');
}

/**
 * N3 V3 — blocker N3-4: if preserveDraftDurably_'s SUPERSEDE step (the
 * SECOND write) throws AFTER the append succeeded, the very next
 * resolveExistingPreviewDraft_ call must detect the resulting
 * two-active-rows ambiguity and fail closed — chains directly into the
 * ambiguity guard proven by test_N3v3_ambiguousMultipleActiveRowsBlocksRegeneration_.
 */
function test_N3v3_preserveTransitionSupersedeFailureIsCaughtByAmbiguityGuardNextRun_() {
  var ctx = n3_setupDraftedProspectForEditTest_('n3v3supersedefail');
  var editedBody = ctx.message.getPlainBody() + '\n\nTEST EDIT';
  ctx.message.getPlainBody = function () { return editedBody; };
  ctx.message.getBody = ctx.message.getPlainBody;

  var originalUpdateLedgerRow = updateLedgerRow_;
  updateLedgerRow_ = function () { throw new Error('Simulated supersede failure during preserve transition.'); };

  var outcome;
  try {
    outcome = previewStep(ctx.p.Prospect_ID, 1);
  } finally {
    updateLedgerRow_ = originalUpdateLedgerRow;
  }
  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', outcome.status, 'The supersede failure must itself fail closed on this run too.');

  var activeRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === ctx.p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(2, activeRows.length, 'Precondition: the append succeeded (new durable row exists) but the old row was NOT superseded — two active rows now exist.');

  var nextRun = previewStep(ctx.p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', nextRun.status, 'The very next run must detect the ambiguity and fail closed.');
  assertEquals_('ambiguous_multiple_active_rows', nextRun.reason, 'The reason must identify the ambiguity left by the partial failure.');
  assert_(GmailApp.getDrafts().some(function (d) { return d.getId() === ctx.first.draftId; }), 'The original draft must never have been deleted through any of this.');
}

/**
 * N3 V3 — blocker N3-3, items 31-37: a Gmail read failure while capturing
 * the JUST-CREATED draft's own metadata must fail closed — compensate
 * (delete) the draft when possible, and never write a "healthy" DRAFTED
 * row with a blank fingerprint. This variant: draft.getId() and
 * deleteDraft() both still work, so compensation succeeds and NO ledger
 * row is written at all.
 */
function test_N3v3_creationMetadataFailureWithSuccessfulCompensationWritesNoRow_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3v3createfail1'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var originalCreateDraft = GmailApp.createDraft;
  var draftCountBefore = GmailApp.getDrafts().length;
  GmailApp.createDraft = function (to, subject, body, opts) {
    var draft = originalCreateDraft(to, subject, body, opts);
    var msg = draft.getMessage();
    msg.getId = function () { throw new Error('Simulated post-create message.getId() failure.'); };
    return draft;
  };

  var outcome;
  try {
    outcome = previewStep(p.Prospect_ID, 1);
  } finally {
    GmailApp.createDraft = originalCreateDraft;
  }

  assertEquals_('ERROR_DRAFT_METADATA_CAPTURE_FAILED', outcome.status, 'A post-create metadata read failure must fail closed, not draft successfully.');
  assertEquals_(true, outcome.compensated, 'Compensation (delete) must have succeeded — draft.getId() itself still worked.');
  assertEquals_(draftCountBefore, GmailApp.getDrafts().length, 'The failed draft must have been deleted — no extra draft remains.');

  var draftedRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(0, draftedRows.length, 'No healthy DRAFTED row must have been written when compensation succeeded.');
}

/**
 * N3 V3 — blocker N3-3, items 31-37 (uncompensable variant): if the
 * compensating delete ALSO fails, previewStep must write a recovery
 * ledger row (blank fingerprint) instead of leaving a fully untracked
 * orphan — and the NEXT previewStep() run must treat that recovery row
 * via the legacy-blank-fingerprint policy: preserved, never duplicated.
 */
function test_N3v3_creationMetadataFailureWithFailedCompensationWritesRecoveryRow_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3v3createfail2'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var originalCreateDraft = GmailApp.createDraft;
  var capturedMessage = null;
  var originalGetSubject = null;
  var capturedDraft = null;
  var originalDeleteDraft = null;
  GmailApp.createDraft = function (to, subject, body, opts) {
    var draft = originalCreateDraft(to, subject, body, opts);
    var msg = draft.getMessage();
    capturedMessage = msg;
    originalGetSubject = msg.getSubject;
    msg.getSubject = function () { throw new Error('Simulated post-create message.getSubject() failure.'); };
    capturedDraft = draft;
    originalDeleteDraft = draft.deleteDraft;
    draft.deleteDraft = function () { throw new Error('Simulated compensation delete failure.'); };
    return draft;
  };

  var outcome;
  try {
    outcome = previewStep(p.Prospect_ID, 1);
  } finally {
    GmailApp.createDraft = originalCreateDraft;
  }

  assertEquals_('ERROR_DRAFT_METADATA_CAPTURE_FAILED', outcome.status, 'A post-create metadata read failure must fail closed.');
  assertEquals_(false, outcome.compensated, 'Compensation must be reported as failed (the delete itself threw).');

  var draftedRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, draftedRows.length, 'A recovery row must have been written so the orphan is not fully untracked.');
  assertEquals_('', draftedRows[0].values.Draft_Fingerprint, 'The recovery row correctly has a blank fingerprint (that is exactly what failed to capture).');
  assert_(draftedRows[0].values.Error.indexOf('CREATION_METADATA_CAPTURE_FAILED') !== -1, 'The recovery row must be clearly marked.');

  // Restore the real getSubject on the underlying message BEFORE the next
  // run — the simulated failure was a one-time creation-time event, not a
  // permanently broken Gmail draft; the point of this test is what happens
  // on a NORMAL subsequent read of the recovery row, isolated from the
  // original injected failure.
  if (capturedMessage && originalGetSubject) capturedMessage.getSubject = originalGetSubject;

  // The critical safety proof: the NEXT run must NOT create a duplicate —
  // the legacy-blank-fingerprint policy must durably preserve it instead.
  var nextRun = previewStep(p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_PRESERVED_HUMAN_EDIT', nextRun.status, 'The recovery row must be preserved via the legacy policy, never regenerated into a duplicate.');
  var draftsForKey = GmailApp.getDrafts().filter(function (d) { return d.getId() === draftedRows[0].values.Draft_ID; });
  assertEquals_(1, draftsForKey.length, 'Exactly one Gmail draft must exist — the recovery scenario never produced a duplicate.');
}

/**
 * N3 orphan-draft gap (Codex final audit, round 2): createPreviewDraft_
 * used to read `standaloneDraft.getMessage().getThread().getId()` itself,
 * AFTER GmailApp.createDraft() succeeded but BEFORE previewStep()'s
 * protected metadata-capture block ever ran — a throw there escaped
 * UNCAUGHT, past every fail-closed guard, with the draft already sitting
 * in Gmail. Fixed by moving every post-creation read into ONE protected
 * block. These four tests each inject a failure at a DIFFERENT one of
 * those reads (Codex's explicit list, items 1-4) and prove each is caught
 * cleanly, compensated via the DIRECT object reference (never an
 * enumeration lookup — see attemptDeleteDraftDirectly_), regardless of
 * which specific read failed.
 */
function n3_assertCreationFailureCompensatesCleanly_(emailTag, corruptDraftFn) {
  var row = addTestProspectRow_({ Email: testUniqueEmail_(emailTag), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var originalCreateDraft = GmailApp.createDraft;
  var draftCountBefore = GmailApp.getDrafts().length;
  GmailApp.createDraft = function (to, subject, body, opts) {
    var draft = originalCreateDraft(to, subject, body, opts);
    corruptDraftFn(draft);
    return draft;
  };

  var outcome;
  try {
    outcome = previewStep(p.Prospect_ID, 1);
  } finally {
    GmailApp.createDraft = originalCreateDraft;
    // Isolation (Priority 3, Codex final audit): deleteDraft must be
    // restored to its real implementation BEFORE this test ends — the
    // permanently-broken override otherwise made the test framework's own
    // teardown (cleanupTestArtifacts_, which deletes any DRAFTED row this
    // test's Run_ID left behind) fail too, leaking a Prospects row,
    // SendLedger rows, and Log rows into every test that ran after this
    // one. The simulated failure is a one-time creation-time event, not a
    // permanently broken Gmail draft — real cleanup must be able to
    // actually delete it once the test's own assertions are done with it.
    if (capturedDraft && originalDeleteDraft) capturedDraft.deleteDraft = originalDeleteDraft;
  }

  assertEquals_('ERROR_DRAFT_METADATA_CAPTURE_FAILED', outcome.status, 'A post-create metadata read failure must fail closed.');
  assertEquals_(true, outcome.compensated, 'Compensation via the direct object reference must succeed regardless of which read failed.');
  assertEquals_(draftCountBefore, GmailApp.getDrafts().length, 'The failed draft must have been deleted — no extra draft remains.');
  var draftedRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(0, draftedRows.length, 'No healthy DRAFTED row must have been written.');

  // Item 7: the NEXT preview must safely create a fresh draft — zero
  // duplicate creation risk, since the failed one was fully compensated.
  var next = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', next.status, 'Item 7: a subsequent Preview after a fully-compensated failure must safely create a new draft.');
  var draftedRowsAfter = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, draftedRowsAfter.length, 'Item 7: exactly one DRAFTED row must exist after recovery — no duplicate.');
}

/** N3 orphan-draft gap, item 4: draft.getId() itself throws. */
function test_N3v3_creationFailure_draftGetIdThrows_() {
  n3_assertCreationFailureCompensatesCleanly_('n3v3draftgetid', function (draft) {
    draft.getId = function () { throw new Error('Simulated draft.getId() failure.'); };
  });
}

/** N3 orphan-draft gap, item 1: draft.getMessage() itself throws. */
function test_N3v3_creationFailure_getMessageThrows_() {
  n3_assertCreationFailureCompensatesCleanly_('n3v3getmessage', function (draft) {
    draft.getMessage = function () { throw new Error('Simulated draft.getMessage() failure.'); };
  });
}

/** N3 orphan-draft gap, item 2: message.getThread() itself throws. */
function test_N3v3_creationFailure_getThreadThrows_() {
  n3_assertCreationFailureCompensatesCleanly_('n3v3getthread', function (draft) {
    var msg = draft.getMessage();
    msg.getThread = function () { throw new Error('Simulated message.getThread() failure.'); };
  });
}

/** N3 orphan-draft gap, item 3: the returned thread's own getId() throws. */
function test_N3v3_creationFailure_threadGetIdThrows_() {
  n3_assertCreationFailureCompensatesCleanly_('n3v3threadgetid', function (draft) {
    var msg = draft.getMessage();
    var originalGetThread = msg.getThread;
    msg.getThread = function () {
      var realThread = originalGetThread();
      return {
        getId: function () { throw new Error('Simulated thread.getId() failure.'); },
        getMessages: realThread.getMessages, getLabels: realThread.getLabels, addLabel: realThread.addLabel
      };
    };
  });
}

/**
 * N3 orphan-draft gap, item 9: an UNRELATED draft elsewhere in the same
 * Gmail account throwing on ITS OWN getId() during a later run's
 * enumeration (resolveExistingPreviewDraft_) must fail closed — never
 * conflated with "our tracked draft is gone" (which would wrongly
 * authorize CREATE_NEW and risk a duplicate).
 */
function test_N3v3_unrelatedDraftEnumerationErrorFailsClosedOnLaterRun_() {
  // Created BEFORE the tracked draft, and deliberately EARLIER in
  // GmailApp.getDrafts()'s enumeration order — resolveExistingPreviewDraft_'s
  // lookup loop must actually reach this poisoned entry before it would
  // reach our tracked one, or the whole point of the test (an UNRELATED
  // draft's own getId() throwing during enumeration) is never exercised.
  var poisoned = GmailApp.createDraft('someone-else@example-corp-test.com', 'Unrelated', 'Unrelated body.');
  poisoned.getId = function () { throw new Error('Simulated poisoned draft elsewhere in the account.'); };

  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3v3enumuncertain'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  // The FIRST previewStep call never enumerates drafts at all (no existing
  // ledger row yet — resolveExistingPreviewDraft_ short-circuits straight
  // to CREATE_NEW), so the poisoned draft's broken getId() cannot interfere
  // with normal creation.
  var first = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', first.status, 'First preview must draft.');

  var second;
  try {
    second = previewStep(p.Prospect_ID, 1);
  } finally {
    poisoned.deleteDraft(); // identity-based in the mock — works even with getId() broken. Test cleanup.
  }

  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', second.status,
    'Item 9: an unrelated draft throwing during enumeration must fail closed, never conflated with "our draft is gone".');
  assertEquals_('gmail_read_error', second.reason);

  var draftedRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, draftedRows.length, 'No duplicate must have been created while the enumeration was uncertain.');
  assertEquals_(first.draftId, draftedRows[0].values.Draft_ID, 'The original tracked draft must remain the active one, untouched.');
}

/**
 * N3 orphan-draft gap, item 10: if compensation (the direct delete) AND
 * the recovery-row write BOTH fail, previewStep must still return a
 * controlled status — never throw uncaught, never crash the caller
 * (previewQueue's forEach has no try/catch around previewStep calls).
 * This is the documented, acknowledged residual risk (Mailer.gs
 * docstring): a fully untracked orphan can still occur here, but the
 * function itself must degrade gracefully, not crash.
 */
function test_N3v3_bothCompensationAndRecoveryRowFailStillReturnsControlledStatus_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3v3bothfail'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var originalCreateDraft = GmailApp.createDraft;
  var capturedDraft = null;
  var originalDeleteDraft = null;
  GmailApp.createDraft = function (to, subject, body, opts) {
    var draft = originalCreateDraft(to, subject, body, opts);
    var msg = draft.getMessage();
    msg.getSubject = function () { throw new Error('Simulated post-create message.getSubject() failure.'); };
    capturedDraft = draft;
    originalDeleteDraft = draft.deleteDraft;
    draft.deleteDraft = function () { throw new Error('Simulated compensation delete failure.'); };
    return draft;
  };
  var originalAppendLedgerRow = appendLedgerRow_;
  var recoveryAttempted = false;
  appendLedgerRow_ = function () { recoveryAttempted = true; throw new Error('Simulated recovery ledger row write failure.'); };

  var outcome;
  var threw = false;
  try {
    outcome = previewStep(p.Prospect_ID, 1);
  } catch (e) {
    threw = true;
  } finally {
    GmailApp.createDraft = originalCreateDraft;
    appendLedgerRow_ = originalAppendLedgerRow;
    // Test cleanup: restore the real deleteDraft and remove the now fully
    // untracked draft ourselves, so this test leaves nothing behind for
    // the isolation harness (Priority 3) to (silently) miss.
    if (capturedDraft && originalDeleteDraft) {
      capturedDraft.deleteDraft = originalDeleteDraft;
      capturedDraft.deleteDraft();
    }
  }

  assert_(!threw, 'previewStep must never itself throw uncaught, even when BOTH compensation and the recovery-row write fail.');
  assertEquals_('ERROR_DRAFT_METADATA_CAPTURE_FAILED', outcome.status);
  assertEquals_(false, outcome.compensated, 'Compensation must be reported as failed.');
  assert_(recoveryAttempted, 'A recovery-row write must have been ATTEMPTED even though it also failed.');
}

/**
 * N3 V3 — item 1D: recipient canonicalization must absorb Gmail's
 * "Name <email>" wrapper as a structural difference, not a content edit —
 * a pure display-name wrapper change around the SAME address must NOT
 * false-positive into "edited" (a false positive here would still be safe
 * per policy, but the point of 1D is to avoid unnecessary preservation
 * noise for a non-edit).
 */
function test_N3v3_recipientDisplayNameWrapperDoesNotFalsePositive_() {
  var ctx = n3_setupDraftedProspectForEditTest_('n3v3recipientwrapper');
  var bareEmail = ctx.message.getTo();
  ctx.message.getTo = function () { return 'Test Prospect <' + bareEmail + '>'; };

  var outcome = previewStep(ctx.p.Prospect_ID, 1);
  assertEquals_('DRAFTED', outcome.status,
    'A pure "Name <email>" wrapper around the SAME address must canonicalize identically — CASO 1 (untouched), not a false edit.');
}

/**
 * N3 V2 CASO 7 — item 11: the ledger's Draft_ID no longer resolves to any
 * real Gmail draft (e.g. the operator manually deleted it from the Gmail
 * UI), and Gmail enumeration succeeded and genuinely confirmed absence.
 * Nothing exists to protect, so previewStep must safely supersede the
 * stale ledger row and create a fresh draft — never error, never leave two
 * DRAFTED rows.
 */
function test_N3_missingDraftIdCreatesNewSafely_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3caso4'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var first = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', first.status, 'First preview must draft.');

  // Simulate the operator deleting the draft directly in Gmail.
  var liveDraft = GmailApp.getDrafts().filter(function (d) { return d.getId() === first.draftId; })[0];
  assert_(!!liveDraft, 'Precondition: the first draft must exist.');
  liveDraft.deleteDraft();
  assert_(!GmailApp.getDrafts().some(function (d) { return d.getId() === first.draftId; }), 'Precondition: draft must now be gone from Gmail.');

  var second = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', second.status, 'CASO 4: previewStep must safely create a new draft when the old Draft_ID no longer resolves.');
  assert_(second.draftId !== first.draftId, 'The new draft must be a genuinely new resource.');

  var draftedRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, draftedRows.length, 'CASO 4: exactly one DRAFTED ledger row must remain — no dangling duplicate.');
}

/**
 * N3 V2 CASO 6 — item 9: the ledger's Draft_ID still resolves to a real
 * Gmail draft, but that draft's current Thread_ID does NOT match what the
 * ledger recorded at creation time. This is treated as suspicious (a
 * Draft_ID collision or a tampered ledger row) and must fail closed: never
 * delete the mismatched draft, never create a duplicate this run, and
 * (unlike a content edit) never durably preserved — re-evaluated every run.
 */
function test_N3_threadIdMismatchBlocksRegeneration_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3caso5'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var first = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', first.status, 'First preview must draft.');

  var liveDraft = GmailApp.getDrafts().filter(function (d) { return d.getId() === first.draftId; })[0];
  assert_(!!liveDraft, 'Precondition: the first draft must exist.');
  var message = liveDraft.getMessage();
  var originalThread = message.getThread();
  message.getThread = function () { return { getId: function () { return 'unexpected-different-thread-id'; } }; };

  var second = previewStep(p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', second.status,
    'CASO 5: a Thread_ID mismatch must fail closed — no regeneration, no deletion.');
  assertEquals_('thread_mismatch', second.reason, 'The refusal reason must be thread_mismatch.');

  var stillThere = GmailApp.getDrafts().some(function (d) { return d.getId() === first.draftId; });
  assert_(stillThere, 'The mismatched-thread draft must NOT have been deleted.');
  var draftedRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.State === LEDGER_STATE.DRAFTED;
  });
  assertEquals_(1, draftedRows.length, 'CASO 5: no duplicate DRAFTED row must have been created — the original stays the only one on record.');

  message.getThread = function () { return originalThread; }; // test cleanup, not part of the assertion
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

// ---------------------------------------------------------------------------
// N5 (Codex final audit, round 2) — REAL executable LIVE-path tests.
//
// Round 1 verified N5 statically only, per this project's established
// policy (findings #7/#8) of never flipping DRY_RUN=FALSE even locally.
// The round-2 audit explicitly rejected that as insufficient for N5
// specifically — static checks cannot prove the durable-ledger-blocking
// property actually holds across a SECOND execution, which is the entire
// point of N5. withLiveModeEnabledForTest_ is the one, explicit, well-
// audited exception to the "never flip DRY_RUN" policy: every Config value
// it touches (DRY_RUN, the 5 PENDING_F0 keys, and the send window/day keys
// — widened to "always open" so these tests are never flaky depending on
// what real-world hour/day they happen to run) is captured before the
// change and unconditionally restored in `finally`, even if the wrapped
// function throws.
// ---------------------------------------------------------------------------

/**
 * Wraps `fn` with DRY_RUN=FALSE, all 5 PENDING_F0 keys resolved to dummy
 * (but non-blank) values, and the send window/day widened to "always
 * open" — so a real sendStep1()/sendFollowUp() call can actually reach
 * doStep1Send_/doFollowUpSend_, deterministically, regardless of the real
 * wall-clock time this test happens to run at. Every touched Config value
 * is restored exactly, in `finally`, whether or not `fn` throws.
 */
function withLiveModeEnabledForTest_(fn) {
  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var rowByKey = {};
  for (var i = 0; i < values.length; i++) rowByKey[values[i][0]] = i + 2;

  var overrides = { DRY_RUN: 'FALSE', SEND_START_HOUR: '0', SEND_END_HOUR: '24', SEND_DAYS: 'MON,TUE,WED,THU,FRI,SAT,SUN' };
  PENDING_F0_REQUIRED_KEYS.forEach(function (key) { overrides[key] = 'test-resolved-' + key.toLowerCase() + '@example.com'; });

  var keysToTouch = Object.keys(overrides);
  var originalValues = {};
  keysToTouch.forEach(function (key) {
    var row = rowByKey[key];
    if (!row) throw new Error('withLiveModeEnabledForTest_: Config key "' + key + '" not found.');
    originalValues[key] = sheet.getRange(row, 2).getValue();
  });

  try {
    keysToTouch.forEach(function (key) { sheet.getRange(rowByKey[key], 2).setValue(overrides[key]); });
    resetConfigCache_();
    return fn();
  } finally {
    keysToTouch.forEach(function (key) { sheet.getRange(rowByKey[key], 2).setValue(originalValues[key]); });
    resetConfigCache_();
  }
}

/** N5 test setup: a READY prospect, eligible for a real step-1 LIVE send. */
function n5_setupReadyProspect_(emailTag) {
  var row = addTestProspectRow_({ Email: testUniqueEmail_(emailTag), Problem_Found: 'x' });
  validateAllRows();
  return getTestProspectByRow_(row);
}

/**
 * N5 test setup: an IN_SEQUENCE prospect due for step 2, with a real
 * seeded LIVE thread it can reply on — everything doFollowUpSend_/canSend_
 * need. Constructed directly (same pattern T21 and similar eligibility
 * tests already use) since this is test fixture setup, not production
 * write-path code.
 */
function n5_setupFollowUpDueProspect_(emailTag, config) {
  var email = testUniqueEmail_(emailTag);
  var emailNormalized = normalizeEmail_(email);
  var thread = GmailApp._seedLiveThread(email, config.SENDER_EMAIL || 'outreach-test@example.com');
  var past = new Date(); past.setDate(past.getDate() - 3);
  var row = addTestProspectRow_({
    Prospect_ID: Utilities.getUuid(), Email: email, Email_Normalized: emailNormalized,
    Domain: extractDomain_(emailNormalized), Domain_Type: DOMAIN_TYPE.CORPORATE,
    Problem_Found: 'x', Status: STATUS.IN_SEQUENCE, Sequence_Step: 1,
    Step1_Sent_At: past, Last_Contacted: past, Next_Action_Date: past, Thread_ID: thread.getId()
  });
  return { p: getTestProspectByRow_(row), thread: thread };
}

/**
 * N5 items 1, 2, 3, 13: draft.send() throws (ambiguous outcome) — the
 * ledger row must be durably AMBIGUOUS even if the secondary Prospects
 * NEEDS_REVIEW write ALSO fails; a second execution must be blocked from
 * sending again by the ledger alone; the lock must be released so the
 * second execution isn't blocked by lock contention instead (which would
 * mask whether the ledger block actually works).
 */
function test_N5_step1SendThrowsDurablyBlocksLedgerEvenIfProspectsWriteFails_() {
  withLiveModeEnabledForTest_(function () {
    var p = n5_setupReadyProspect_('n5step1throw');

    var originalCreateDraft = GmailApp.createDraft;
    GmailApp.createDraft = function (to, subject, body, opts) {
      var draft = originalCreateDraft(to, subject, body, opts);
      draft.send = function () { throw new Error('Simulated Gmail send() failure — ambiguous outcome.'); };
      return draft;
    };
    var originalWriteRowById = writeRowById_;
    writeRowById_ = function () { throw new Error('Simulated Prospects write failure.'); };

    var threw = false;
    try {
      sendStep1(p.Prospect_ID);
    } catch (e) {
      threw = true;
    } finally {
      GmailApp.createDraft = originalCreateDraft;
      writeRowById_ = originalWriteRowById;
    }
    assert_(threw, 'sendStep1 must propagate the send() failure.');
    assert_(!LockService.getScriptLock().hasLock(), 'Item 13: the lock must be released after the ambiguous exception propagated.');

    var ledgerRows = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.LIVE;
    });
    assertEquals_(1, ledgerRows.length, 'Exactly one LIVE ledger row must exist.');
    assertEquals_(LEDGER_STATE.AMBIGUOUS, ledgerRows[0].values.State,
      'Items 1/3: the ledger row must be durably AMBIGUOUS even though the secondary Prospects write ALSO failed.');

    // Item 2: a second execution must NOT attempt to send again.
    var draftCountBefore = GmailApp.getDrafts().length;
    var second = sendStep1(p.Prospect_ID);
    assertEquals_('SKIPPED_ALREADY_CLAIMED', second.status, 'Item 2: a second execution must be blocked by the ledger, never attempt to send again.');
    assertEquals_(draftCountBefore, GmailApp.getDrafts().length, 'No new draft/send attempt must have been made.');
  });
}

/** N5 item 11: the normal, unedited confirmed path — exactly one real send. */
function test_N5_normalConfirmedStep1SendsExactlyOnce_() {
  withLiveModeEnabledForTest_(function () {
    var p = n5_setupReadyProspect_('n5step1normal');
    var outcome = sendStep1(p.Prospect_ID);
    assertEquals_('SENT', outcome.status, 'A normal step-1 send must succeed.');

    var ledgerRows = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.LIVE;
    });
    assertEquals_(1, ledgerRows.length, 'Exactly one LIVE ledger row must exist.');
    assertEquals_(LEDGER_STATE.SENT, ledgerRows[0].values.State);

    var freshRow = findRowById_(p.Prospect_ID);
    assertEquals_(STATUS.IN_SEQUENCE, freshRow.values.Status, 'Prospects must be updated to IN_SEQUENCE on a confirmed send.');
    assertEquals_(1, Number(freshRow.values.Sequence_Step));

    // Item 10: a confirmed SENT key remains blocked forever at the LEDGER
    // level (checked directly — after a real successful send, canSend_'s
    // OWN state-machine logic also independently refuses a repeat, since
    // Status/Sequence_Step have advanced; that is correct and expected,
    // but a different guard than the one item 10 is about — isLiveKeyBlocked_
    // is the one this test needs to prove).
    assert_(isLiveKeyBlocked_(p.Prospect_ID, 1), 'Item 10: a confirmed SENT key must remain blocked at the ledger level — never resend.');
  });
}

/**
 * N5 items 4, 5: thread.reply() throws (ambiguous outcome) — durable
 * ledger block; a second execution must not reply again.
 */
function test_N5_followUpReplyThrowsDurablyBlocksLedger_() {
  withLiveModeEnabledForTest_(function () {
    var config = getConfig();
    var setup = n5_setupFollowUpDueProspect_('n5followupthrow', config);
    var p = setup.p;

    var originalReply = setup.thread.reply;
    setup.thread.reply = function () { throw new Error('Simulated Gmail reply() failure — ambiguous outcome.'); };

    var threw = false;
    try {
      sendFollowUp(p.Prospect_ID, 2);
    } catch (e) {
      threw = true;
    } finally {
      setup.thread.reply = originalReply;
    }
    assert_(threw, 'sendFollowUp must propagate the reply() failure.');

    var ledgerRows = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 2 && r.values.Mode === LEDGER_MODE.LIVE;
    });
    assertEquals_(1, ledgerRows.length, 'Exactly one LIVE ledger row must exist.');
    assertEquals_(LEDGER_STATE.AMBIGUOUS, ledgerRows[0].values.State, 'Item 4: reply() throwing must durably block the ledger row.');

    // Item 5: a second execution must NOT reply again — proven directly
    // (the ledger blocks the key regardless of what Prospects shows; here
    // the NEEDS_REVIEW write also succeeded, so canSend_'s OWN state-
    // machine logic independently refuses too — both guards agree, but
    // isLiveKeyBlocked_ is the one this item is specifically about).
    assert_(isLiveKeyBlocked_(p.Prospect_ID, 2), 'Item 5: the idempotency key must be blocked at the ledger level.');
    var messagesBefore = setup.thread.getMessages().length;
    var second = sendFollowUp(p.Prospect_ID, 2);
    assert_(second.status !== 'SENT', 'Item 5: a second execution must never actually send.');
    assertEquals_(messagesBefore, setup.thread.getMessages().length, 'No new message must have been added to the thread.');
  });
}

/**
 * N5 items 6, 7: message-count mismatch after a successful reply() —
 * durable block, even if the secondary Prospects write ALSO fails.
 */
function test_N5_followUpMessageCountMismatchDurablyBlocksEvenIfProspectsWriteFails_() {
  withLiveModeEnabledForTest_(function () {
    var config = getConfig();
    var setup = n5_setupFollowUpDueProspect_('n5followupmismatch', config);
    var p = setup.p;

    // Simulate an inbound reply landing in the exact race window: reply()
    // itself succeeds, but getMessages() afterward shows +2, not +1.
    var originalReply = setup.thread.reply;
    setup.thread.reply = function (body) {
      var normalResult = originalReply.call(setup.thread, body);
      setup.thread._messages = setup.thread.getMessages().concat([{
        getId: function () { return 'race-inbound-msg'; }, getFrom: function () { return p.Email; },
        getTo: function () { return config.SENDER_EMAIL; }, getSubject: function () { return 'Re:'; },
        getPlainBody: function () { return 'An inbound reply landed in the race window.'; }, getBody: function () { return ''; }
      }]);
      setup.thread.getMessages = function () { return setup.thread._messages; };
      return normalResult;
    };
    var originalWriteRowById = writeRowById_;
    writeRowById_ = function () { throw new Error('Simulated Prospects write failure.'); };

    var threw = false;
    try {
      sendFollowUp(p.Prospect_ID, 2);
    } catch (e) {
      threw = true;
    } finally {
      setup.thread.reply = originalReply;
      writeRowById_ = originalWriteRowById;
    }
    assert_(threw, 'sendFollowUp must propagate the ambiguous-outcome error.');

    var ledgerRows = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 2 && r.values.Mode === LEDGER_MODE.LIVE;
    });
    assertEquals_(1, ledgerRows.length, 'Exactly one LIVE ledger row must exist.');
    assertEquals_(LEDGER_STATE.AMBIGUOUS, ledgerRows[0].values.State,
      'Items 6/7: a message-count mismatch must durably block the ledger row even though the Prospects write ALSO failed.');

    var second = sendFollowUp(p.Prospect_ID, 2);
    assertEquals_('SKIPPED_ALREADY_CLAIMED', second.status, 'A second execution must still be blocked.');
  });
}

/** N5 item 12: the normal, unedited confirmed follow-up path — exactly one real reply. */
function test_N5_normalConfirmedFollowUpRepliesExactlyOnce_() {
  withLiveModeEnabledForTest_(function () {
    var config = getConfig();
    var setup = n5_setupFollowUpDueProspect_('n5followupnormal', config);
    var p = setup.p;

    var messagesBefore = setup.thread.getMessages().length;
    var outcome = sendFollowUp(p.Prospect_ID, 2);
    assertEquals_('SENT', outcome.status, 'A normal follow-up send must succeed.');
    assertEquals_(messagesBefore + 1, setup.thread.getMessages().length, 'Exactly one message must have been added to the thread.');

    var ledgerRows = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 2 && r.values.Mode === LEDGER_MODE.LIVE;
    });
    assertEquals_(1, ledgerRows.length);
    assertEquals_(LEDGER_STATE.SENT, ledgerRows[0].values.State);

    assert_(isLiveKeyBlocked_(p.Prospect_ID, 2), 'A confirmed SENT follow-up key must remain blocked at the ledger level.');
    var second = sendFollowUp(p.Prospect_ID, 2);
    assert_(second.status !== 'SENT', 'A second execution must never actually send.');
    assertEquals_(messagesBefore + 1, setup.thread.getMessages().length, 'No second reply must have been sent.');
  });
}

/**
 * N5 items 8, 9: Recon's stale-claim reconciliation must never authorize a
 * retry on an ambiguous outcome. Item 8: zero search results. Item 9: the
 * search call itself fails.
 */
function test_N5_reconStaleClaimZeroSearchResultsNeverBecomesRetryable_() {
  var config = getConfig();
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n5reconzero'), Problem_Found: 'x' });
  var p = getTestProspectByRow_(row);
  var staleClaimedAt = new Date(); staleClaimedAt.setMinutes(staleClaimedAt.getMinutes() - (config.CLAIM_STALE_MINUTES + 30));
  appendLedgerRow_({
    Run_ID: getRunId_(), Claimed_At: staleClaimedAt, Prospect_ID: p.Prospect_ID, Email_Normalized: normalizeEmail_(p.Email),
    Step: 1, Idempotency_Key: getIdempotencyKey_(p.Prospect_ID, 1), Mode: LEDGER_MODE.LIVE, State: LEDGER_STATE.CLAIMED,
    Thread_ID: '', Message_ID: '', Draft_ID: '', Confirmed_At: '', Error: ''
  });
  // GmailApp.search()'s default mock returns [] unless something sent a
  // real draft to this address — nothing did, so this IS the zero-result case.

  reconcileStaleLiveClaims_(config);

  var row2 = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.LIVE;
  })[0];
  assertEquals_(LEDGER_STATE.AMBIGUOUS, row2.values.State,
    'Item 8: a stale CLAIMED row with zero matching sent messages must become AMBIGUOUS (durably blocked), NEVER a retryable state.');
  assert_(row2.values.State !== LEDGER_STATE.ABANDONED, 'The dangerous ABANDONED-as-retryable state must never be produced.');
  assert_(isLiveKeyBlocked_(p.Prospect_ID, 1), 'The idempotency key must still be blocked after reconciliation.');
}

function test_N5_reconStaleClaimSearchErrorFailsClosed_() {
  var config = getConfig();
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n5reconerror'), Problem_Found: 'x' });
  var p = getTestProspectByRow_(row);
  var staleClaimedAt = new Date(); staleClaimedAt.setMinutes(staleClaimedAt.getMinutes() - (config.CLAIM_STALE_MINUTES + 30));
  appendLedgerRow_({
    Run_ID: getRunId_(), Claimed_At: staleClaimedAt, Prospect_ID: p.Prospect_ID, Email_Normalized: normalizeEmail_(p.Email),
    Step: 1, Idempotency_Key: getIdempotencyKey_(p.Prospect_ID, 1), Mode: LEDGER_MODE.LIVE, State: LEDGER_STATE.CLAIMED,
    Thread_ID: '', Message_ID: '', Draft_ID: '', Confirmed_At: '', Error: ''
  });

  var originalSearch = GmailApp.search;
  GmailApp.search = function () { throw new Error('Simulated Gmail search() failure.'); };
  try {
    reconcileStaleLiveClaims_(config);
  } finally {
    GmailApp.search = originalSearch;
  }

  var row2 = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.LIVE;
  })[0];
  assertEquals_(LEDGER_STATE.CLAIMED, row2.values.State, 'Item 9: a search failure must leave the row untouched (still CLAIMED, still blocking) — fail closed.');
  assert_(isLiveKeyBlocked_(p.Prospect_ID, 1), 'The idempotency key must still be blocked.');
}

/**
 * N5 item 14: neither nightlyRecon (which calls reconcileStaleLiveClaims_)
 * nor dailyDigest ever converts an AMBIGUOUS LIVE key into a retryable
 * state automatically — AMBIGUOUS is a terminal, human-reconciled state
 * with no code path that transitions it further.
 */
function test_N5_reconAndDigestNeverConvertAmbiguousKeyToRetryable_() {
  var config = getConfig();
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n5ambiguousstable'), Problem_Found: 'x' });
  var p = getTestProspectByRow_(row);
  appendLedgerRow_({
    Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: p.Prospect_ID, Email_Normalized: normalizeEmail_(p.Email),
    Step: 1, Idempotency_Key: getIdempotencyKey_(p.Prospect_ID, 1), Mode: LEDGER_MODE.LIVE, State: LEDGER_STATE.AMBIGUOUS,
    Thread_ID: '', Message_ID: '', Draft_ID: '', Confirmed_At: '', Error: 'Simulated pre-existing ambiguous outcome.'
  });

  nightlyRecon();
  assert_(isLiveKeyBlocked_(p.Prospect_ID, 1), 'nightlyRecon must never convert an AMBIGUOUS key into a retryable state.');

  dailyDigest();
  assert_(isLiveKeyBlocked_(p.Prospect_ID, 1), 'dailyDigest must never convert an AMBIGUOUS key into a retryable state.');

  var stillAmbiguous = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.LIVE;
  })[0];
  assertEquals_(LEDGER_STATE.AMBIGUOUS, stillAmbiguous.values.State, 'The row must remain exactly AMBIGUOUS — untouched by either sweep.');
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
 * N3 V2 schema migration: repairSendLedgerColumns_ (SheetRepo.gs) must be
 * additive-only (never touch columns A-M or any data row) and idempotent
 * (a no-op once the headers already exist). Simulates a pre-existing real
 * sheet (from before this fix) by blanking the 3 new header cells first,
 * then restores them in a finally block so this test never leaves the
 * shared SendLedger sheet's header row broken for a later test.
 */
function test_N3_repairSendLedgerColumnsIsIdempotentAndAdditive_() {
  var sheet = getSheet_(SHEET_NAMES.SEND_LEDGER);
  var startCol = SEND_LEDGER_COLUMNS.Draft_Fingerprint;
  var numCols = 3;
  var originalHeader = sheet.getRange(1, startCol, 1, numCols).getValues();

  try {
    sheet.getRange(1, startCol, 1, numCols).clearContent();
    assertEquals_('', sheet.getRange(1, startCol).getValue(), 'Precondition: header cell must now be blank (simulating a pre-fix sheet).');

    var result = repairSendLedgerColumns_();
    assert_(result.indexOf('Added') === 0, 'repairSendLedgerColumns_ must report it added the headers on a pre-existing sheet.');
    var headerAfter = sheet.getRange(1, startCol, 1, numCols).getValues()[0];
    assertEquals_(JSON.stringify(['Draft_Fingerprint', 'Human_Edit_Preserved', 'Human_Edit_Detected_At']), JSON.stringify(headerAfter),
      'repairSendLedgerColumns_ must write exactly the 3 expected header names.');

    var secondResult = repairSendLedgerColumns_();
    assert_(secondResult.indexOf('already has') !== -1, 'repairSendLedgerColumns_ must be idempotent — a no-op once headers already exist.');
  } finally {
    sheet.getRange(1, startCol, 1, numCols).setValues(originalHeader); // guarantee restoration even on assertion failure
  }
}

/**
 * Restores a previously-snapshotted range exactly: formula cells get their
 * formula back (as a real formula, via the leading '=' setValues()
 * convention — the same mechanism Dashboard's own COUNTIF cells use), and
 * plain-value cells get their literal value back. getValues() alone loses
 * formulas (it returns the computed result, not the formula string), so
 * restoration must be built from BOTH getValues() and getFormulas().
 * Codex re-audit: formatting/validation/notes/protections are
 * DELIBERATELY not part of this — this fixture never modifies any of
 * those (verified: it only ever calls getValues/getFormulas/setValues on
 * Prospects), so there is nothing there to restore.
 */
function snapshotRangeForRestore_(sheet, startRow, numRows, numCols) {
  if (numRows <= 0) return { values: [], formulas: [] };
  return {
    values: sheet.getRange(startRow, 1, numRows, numCols).getValues(),
    formulas: sheet.getRange(startRow, 1, numRows, numCols).getFormulas()
  };
}

function restoreRangeFromSnapshot_(sheet, startRow, snapshot, numCols) {
  if (!snapshot.values.length) return;
  var restoreBlock = snapshot.values.map(function (rowValues, r) {
    return rowValues.map(function (value, c) {
      var formula = snapshot.formulas[r] ? snapshot.formulas[r][c] : '';
      return formula ? formula : value;
    });
  });
  sheet.getRange(startRow, 1, restoreBlock.length, numCols).setValues(restoreBlock);
}

/**
 * Google-real finding: on the real "Klinner Outreach — F1 Test" Sheet,
 * running Validate all rows on a Prospects sheet with real data only in
 * rows 2-6 turned rows 7-1000 (994 rows) into phantom NEEDS_DATA
 * prospects. Root cause: initializeProspectsSheet_ applies checkbox data
 * validation to Stop_Contact (O) across all 999 provisioned rows up
 * front, and real Google Sheets auto-populates checkbox-validated blank
 * cells with a literal FALSE — content the old "every cell is '' or
 * null" blank-check did not recognize as blank.
 *
 * Codex re-audit (round 2) fixed two further problems in THIS fixture
 * itself (never in production code):
 *   1. Physical vs. content rows: the previous version used getLastRow()
 *      (content extent) to decide which rows were "safe to delete", which
 *      is the wrong API for that question. The critical case
 *      (baselineMaxRows=1000, lastRow=6) means 994 rows physically exist
 *      — with real validation rules already applied to them — while
 *      holding no content; getLastRow() would report 6, and deleting
 *      "everything past 6" would destroy 994 rows that were never this
 *      test's to touch. getMaxRows() (physical row count) is now what
 *      decides which physically-added rows this test may delete.
 *   2. Formula loss: getValues()/setValues() alone silently flattens any
 *      formula to its last computed value. Restoration is now built from
 *      BOTH getValues() and getFormulas() via snapshotRangeForRestore_ /
 *      restoreRangeFromSnapshot_ above.
 */
function test_ghostRowsNeverBecomeProspects_() {
  var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
  var TOTAL_ROWS = 1000;

  // Physical row count — NOT getLastRow() — decides what this test is
  // allowed to insert/delete. Rows that already physically existed before
  // this test ran (whether or not they held content) must NEVER be
  // deleted; only rows this test itself inserts may be removed afterward.
  var baselineMaxRows = sheet.getMaxRows();
  var rowsAddedByTest = Math.max(0, TOTAL_ROWS - baselineMaxRows);
  if (rowsAddedByTest > 0) {
    sheet.insertRowsAfter(baselineMaxRows, rowsAddedByTest);
  }

  // Snapshot (values + formulas) ONLY for rows that physically existed
  // before this test — rows this test itself just inserted are new and
  // have nothing to restore; they get deleted outright in `finally`.
  var priorSnapshot = snapshotRangeForRestore_(sheet, 2, Math.max(0, baselineMaxRows - 1), PROSPECTS_LAST_COL);

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
    // Step 1: delete ONLY the physical rows this test itself inserted —
    // never rows that already existed, content or no content.
    if (rowsAddedByTest > 0) {
      sheet.deleteRows(baselineMaxRows + 1, rowsAddedByTest);
    }
    // Step 2: restore every row that physically existed before this test
    // touched it — values AND formulas — exactly as it was.
    restoreRangeFromSnapshot_(sheet, 2, priorSnapshot, PROSPECTS_LAST_COL);
  }
}

/**
 * Codex re-audit finding: proves the fix above with a real sentinel — a
 * pre-existing "real" prospect row sitting INSIDE the range
 * test_ghostRowsNeverBecomeProspects_ overwrites (rows 2-1000), including
 * the exact failing case Codex demonstrated: the sheet already having
 * >= 1000 physical rows before the ghost test runs. Runs the ghost test
 * itself (not a copy of its logic) so this is a true regression guard on
 * the same code path, not a parallel one that could drift.
 *
 * Round 2: this test's OWN fixture (the sentinel at row 500) is now also
 * snapshot-and-restored properly instead of assuming "blank" is the
 * correct final state — row 500 is restored to whatever it held
 * immediately before this test wrote its sentinel, not left empty by
 * default.
 */
function test_ghostRowFixtureIsNonDestructive_() {
  var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
  var sentinelRow = 500; // deep inside the range the ghost test overwrites and must restore.

  // Never assume row 500 was blank before this test touches it.
  var priorRowSnapshot = snapshotRangeForRestore_(sheet, sentinelRow, 1, PROSPECTS_LAST_COL);

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

  if (sheet.getMaxRows() < sentinelRow) sheet.insertRowsAfter(sheet.getMaxRows(), sentinelRow - sheet.getMaxRows());
  sheet.getRange(sentinelRow, 1, 1, PROSPECTS_LAST_COL).setValues([PROSPECTS_COLUMN_ORDER.map(function (c) { return sentinelValues[c]; })]);
  var sentinelBefore = sheet.getRange(sentinelRow, 1, 1, PROSPECTS_LAST_COL).getValues()[0];

  try {
    // Exercises the EXACT snapshot/write/restore path under scrutiny —
    // including the case Codex used to prove the bug: baselineMaxRows is
    // now >= 1000 (this sentinel plus initializeSheets' own provisioning).
    test_ghostRowsNeverBecomeProspects_();

    var sentinelAfter = sheet.getRange(sentinelRow, 1, 1, PROSPECTS_LAST_COL).getValues()[0];
    var sentinelSurvivedAfterTestAndCleanup = JSON.stringify(sentinelBefore) === JSON.stringify(sentinelAfter);
    assert_(sentinelSurvivedAfterTestAndCleanup,
      'sentinelSurvivedAfterTestAndCleanup must be true. Before=' + JSON.stringify(sentinelBefore) +
      ' After=' + JSON.stringify(sentinelAfter));
  } finally {
    // Restore row 500 to EXACTLY what it held before THIS test touched it
    // — never assume blank is correct.
    restoreRangeFromSnapshot_(sheet, sentinelRow, priorRowSnapshot, PROSPECTS_LAST_COL);
  }
}

/**
 * Codex re-audit — mandatory regression scenario: a REAL pre-existing row
 * already occupies row 500 (including a formula cell) BEFORE the sentinel
 * test's own fixture ever touches it — the nested scenario Codex asked
 * for explicitly. After running test_ghostRowFixtureIsNonDestructive_()
 * (which itself seeds and restores its OWN sentinel at the same row),
 * this pre-existing row must come back byte-for-byte, formula included,
 * and the sheet's physical row count must be unchanged.
 */
function test_preexistingRow500SurvivesNestedGhostAndSentinelTests_() {
  var sheet = getSheet_(SHEET_NAMES.PROSPECTS);
  var row = 500;

  // Establish the 1000-physical-row precondition explicitly rather than
  // assuming it — by the time this runs inside the full suite, EARLIER
  // tests' own teardown (cleanupTestRows_ deleting their tagged rows via
  // sheet.deleteRow) has legitimately shrunk the physical row count below
  // 1000, exactly mirroring how deleting rows works on a real Sheet. That
  // is correct, expected suite behavior, not a bug — so this test ensures
  // its own precondition instead of asserting a suite-order-dependent
  // global, the same way initializeSheets() itself would top up a sheet
  // that has fewer than 1000 rows.
  if (sheet.getMaxRows() < 1000) sheet.insertRowsAfter(sheet.getMaxRows(), 1000 - sheet.getMaxRows());
  var baselineMaxRowsBeforeAnything = sheet.getMaxRows();
  assertEquals_(1000, baselineMaxRowsBeforeAnything, 'Precondition: the sheet must be provisioned to 1000 physical rows before this scenario runs.');

  var existingRealValues = {};
  PROSPECTS_COLUMN_ORDER.forEach(function (c) { existingRealValues[c] = ''; });
  existingRealValues.Prospect_ID = 'existing-real-row';
  existingRealValues.Date_Added = new Date();
  existingRealValues.Source = 'REAL_DATA';
  existingRealValues.Business_Name = 'Existing Real Prospect';
  existingRealValues.Email = 'existing@example-corp-test.com';
  existingRealValues.City = 'Denver';
  existingRealValues.State = 'CO';
  existingRealValues.Problem_Found = 'Already here before any sentinel/ghost test ran.';
  existingRealValues.Stop_Contact = false;
  existingRealValues.Status = STATUS.READY;

  sheet.getRange(row, 1, 1, PROSPECTS_LAST_COL).setValues([PROSPECTS_COLUMN_ORDER.map(function (c) { return existingRealValues[c]; })]);
  // A formula in an appropriate cell of the overwritten range — Notes (Q),
  // a plain free-text column with no special parsing — the mock supports
  // getFormulas()/setValues('=...') exactly like real Apps Script.
  sheet.getRange(row, PROSPECTS_COLUMNS.Notes).setValue('=CONCATENATE("Real"," ","Data")');

  var originalRow = snapshotRangeForRestore_(sheet, row, 1, PROSPECTS_LAST_COL);

  try {
    test_ghostRowFixtureIsNonDestructive_(); // nests its own sentinel write/restore at this same row.

    var afterEverything = snapshotRangeForRestore_(sheet, row, 1, PROSPECTS_LAST_COL);
    assertEquals_(JSON.stringify(originalRow.values), JSON.stringify(afterEverything.values),
      'Row 500\'s pre-existing values must be restored exactly after the nested sentinel+ghost tests run.');
    assertEquals_(JSON.stringify(originalRow.formulas), JSON.stringify(afterEverything.formulas),
      'Row 500\'s pre-existing FORMULA must be restored as a real formula, not flattened to its computed value.');
    assertEquals_('=CONCATENATE("Real"," ","Data")', afterEverything.formulas[0][PROSPECTS_COLUMNS.Notes - 1],
      'The Notes formula specifically must survive intact.');

    assertEquals_(1000, sheet.getMaxRows(), 'Physical row count must be unchanged (still 1000) after all nested test machinery completes.');
  } finally {
    // Final self-cleanup: this test's OWN fixture (the "existing real
    // row") must not leak either — blank row 500 unconditionally.
    sheet.getRange(row, 1, 1, PROSPECTS_LAST_COL).setValues([PROSPECTS_COLUMN_ORDER.map(function () { return ''; })]);
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
  ['timezoneAudit_dateMath', test_timezoneAudit_dateMathIsChicagoRelativeNotEnvironmentRelative_],
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
  ['N4_systemCannotSetUnsubscribe', test_N4_systemOperationsCannotSetUnsubscribeReason_],
  ['finding3A_stopUnsubscribe', test_finding3A_stopProspectUnsubscribeCreatesSuppression_],
  ['finding3B_reconSweep', test_finding3B_reconSweepGuaranteesSuppressionEvenIfAlreadyStopped_],
  ['N2_domainSuppressionMasking', test_N2_unsubscribeAlwaysCreatesEmailScopeRecordEvenUnderDomainSuppression_],
  ['N2_round2_reasonMasking', test_N2_round2_priorReasonNeverMasksUnsubscribeRecord_],
  ['finding4_draftOwnership', test_finding4_foreignDraftIsNeverDeleted_],
  ['N3_caso1_stableUnedited', test_N3_stableUntouchedDraftRegeneratesNormally_],
  ['N3_caso2_messageIdRotates', test_N3_caso2_editWithMessageIdRotationIsPreservedDurably_],
  ['N3_caso3_messageIdStable', test_N3_caso3_editWithoutMessageIdRotationIsPreservedDurably_],
  ['N3_caso5_recipientChange', test_N3_caso5_recipientChangeIsPreservedDurably_],
  ['N3_caso5_subjectChange', test_N3_caso5_subjectChangeIsPreservedDurably_],
  ['N3_caso7_missingDraftId', test_N3_missingDraftIdCreatesNewSafely_],
  ['N3_caso6_threadIdMismatch', test_N3_threadIdMismatchBlocksRegeneration_],
  ['N3_caso8_getDraftsError', test_N3_caso8_gmailGetDraftsErrorFailsClosed_],
  ['N3_caso8_messageIdError', test_N3_caso8_messageGetIdErrorFailsClosed_],
  ['N3_caso8_contentReadError', test_N3_caso8_contentReadErrorFailsClosed_],
  ['N3v3_legacyRosaKnownEdit', test_N3v3_legacyBlankFingerprintKnownEditIsPreservedNeverDeleted_],
  ['N3v3_legacyAcmeUntouched', test_N3v3_legacyBlankFingerprintApparentlyUntouchedIsPreservedConservatively_],
  ['N3v3_legacyDurableAcrossRuns', test_N3v3_legacyPreservationSurvivesMultiplePostMigrationRuns_],
  ['N3v3_ambiguousActiveRows', test_N3v3_ambiguousMultipleActiveRowsBlocksRegeneration_],
  ['N3v3_appendFailureLeavesOldRowIntact', test_N3v3_preserveTransitionAppendFailureLeavesOldRowIntact_],
  ['N3v3_supersedeFailureCaughtNextRun', test_N3v3_preserveTransitionSupersedeFailureIsCaughtByAmbiguityGuardNextRun_],
  ['N3v3_creationFailureCompensated', test_N3v3_creationMetadataFailureWithSuccessfulCompensationWritesNoRow_],
  ['N3v3_creationFailureRecoveryRow', test_N3v3_creationMetadataFailureWithFailedCompensationWritesRecoveryRow_],
  ['N3v3_recipientWrapperNoFalsePositive', test_N3v3_recipientDisplayNameWrapperDoesNotFalsePositive_],
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
  ['N3_repairSendLedgerColumns', test_N3_repairSendLedgerColumnsIsIdempotentAndAdditive_],
  ['ghostRowsNeverBecomeProspects', test_ghostRowsNeverBecomeProspects_],
  ['ghostRowFixtureNonDestructive', test_ghostRowFixtureIsNonDestructive_],
  ['preexistingRow500SurvivesNested', test_preexistingRow500SurvivesNestedGhostAndSentinelTests_]
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
