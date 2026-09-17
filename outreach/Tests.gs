/**
 * Klinner Outreach — Tests.gs
 *
 * ============================================================
 * LOCAL TEST ONLY. NEVER DEPLOY. NEVER RUN AGAINST THE REAL
 * GOOGLE SHEET OR THE REAL GMAIL MAILBOX.
 * ============================================================
 *
 * This file is excluded from every deployment by .claspignore, and that
 * exclusion is the protection that matters — but the instructions in this
 * header used to say the opposite ("Runs INSIDE Apps Script", "Run
 * runAllF1Tests() from the Apps Script editor"), which is how the file was
 * originally written and is no longer true. Following that stale advice
 * would run destructive fixtures — most visibly
 * test_ghostRowsNeverBecomeProspects_, which overwrites Prospects rows
 * 2-1000 — against live prospect data, and would create and delete real
 * Gmail drafts in the real mailbox. Do not do it.
 *
 * The suite runs against the Node mock harness ONLY:
 *
 *   node test-harness/run-f1-tests.js
 *
 * which loads the .gs sources into a sandbox backed by
 * test-harness/gas-mocks.js (in-memory Sheets, Gmail, Lock and Utilities)
 * and enforces BOTH gates in its exit code: functional assertions and
 * per-test isolation. Nothing in this file ever touches Google.
 *
 * Fixtures are tagged Source="TEST_F1_AUTOMATED" and torn down per test by
 * cleanupTestArtifacts_(), whose work verifyCleanTestState_() then
 * independently verifies against a full pre-test snapshot of the shared
 * sandbox — sheets, Gmail drafts, threads and their messages, labels, call
 * counters, the script lock, and the identity of every monkey-patchable
 * function.
 *
 * Behaviour that genuinely cannot be proven against a mock (real Gmail
 * draft-id/fingerprint round-trips, real concurrent executions, real quota
 * and search semantics) is NOT faked here. It is enumerated as a
 * Google-real gate in F1_GOOGLE_CLOSURE_PLAN.md and PRODUCTION_CHECKLIST.md
 * and must be verified by a human, on Google, before F2.
 */

var TEST_SOURCE_MARKER = 'TEST_F1_AUTOMATED';
var _testCreatedSuppressionValues = []; // scope=email rows tests created — tracked by Value.
var _testCreatedDomainSuppressionValues_ = []; // scope=domain rows tests created — tracked separately (different Scope).
// P4 (Codex re-audit): Gmail threads a test seeded or caused to be
// created. The isolation check now diffs the mock's thread map, so these
// must be removed in teardown like any other shared-sandbox artifact.
var _testCreatedThreadIds_ = [];

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

/**
 * DST audit (Codex final audit, round 2): dateFromWallClock_'s previous
 * single-shot offset lookup was wrong for any wall clock close enough to a
 * DST transition that the neutral (literal-UTC) instant and the true
 * target instant fall on OPPOSITE sides of the transition moment.
 * Confirmed wrong before this fix: 2026-03-08 03:30 resolved to 04:30;
 * 2026-11-01 02:30 resolved to 01:30. Both are now covered directly,
 * alongside normal winter/summer dates and the two genuinely undefined
 * cases (a nonexistent spring-forward gap, an ambiguous fall-back
 * overlap), each with its explicitly documented policy.
 */
function test_dstAudit_validWallClocksNearTransitions_() {
  // Normal winter date (CST, UTC-6), far from any transition.
  var winter = dateFromWallClock_(2026, 0, 15, 14, 0, 0, 'America/Chicago');
  assertEquals_('14', Utilities.formatDate(winter, 'America/Chicago', 'HH'));
  assertEquals_('2026-01-15T20:00:00.000Z', winter.toISOString(), 'January 14:00 Chicago must be CST (UTC-6) = 20:00Z.');

  // Normal summer date (CDT, UTC-5), far from any transition.
  var summer = dateFromWallClock_(2026, 6, 15, 14, 0, 0, 'America/Chicago');
  assertEquals_('14', Utilities.formatDate(summer, 'America/Chicago', 'HH'));
  assertEquals_('2026-07-15T19:00:00.000Z', summer.toISOString(), 'July 14:00 Chicago must be CDT (UTC-5) = 19:00Z.');

  // Spring-forward transition (2026-03-08, 02:00 CST -> 03:00 CDT): the
  // exact wall clock Codex confirmed was wrong (resolved to 04:30 before
  // this fix).
  var springValid = dateFromWallClock_(2026, 2, 8, 3, 30, 0, 'America/Chicago');
  assertEquals_('03', Utilities.formatDate(springValid, 'America/Chicago', 'HH'), 'MUST resolve 03:30, not 04:30.');
  assertEquals_('30', Utilities.formatDate(springValid, 'America/Chicago', 'mm'));
  assertEquals_('2026-03-08T08:30:00.000Z', springValid.toISOString(), 'Must be CDT (UTC-5): 08:30Z.');

  // Fall-back transition (2026-11-01, 02:00 CDT -> 01:00 CST): the exact
  // wall clock Codex confirmed was wrong (resolved to 01:30 before this
  // fix). 02:30 is AFTER the fall-back completes — valid, unambiguous CST.
  var fallValid = dateFromWallClock_(2026, 10, 1, 2, 30, 0, 'America/Chicago');
  assertEquals_('02', Utilities.formatDate(fallValid, 'America/Chicago', 'HH'), 'MUST resolve 02:30, not 01:30.');
  assertEquals_('30', Utilities.formatDate(fallValid, 'America/Chicago', 'mm'));
  assertEquals_('2026-11-01T08:30:00.000Z', fallValid.toISOString(), 'Must be CST (UTC-6): 08:30Z.');
}

/** DST audit: addCalendarDays_ across both real transition dates. */
function test_dstAudit_addCalendarDaysAcrossTransitions_() {
  // Spring: 2026-03-07 09:00 (CST) + 1 day must land on 2026-03-08 09:00,
  // now CDT — same wall clock, different absolute UTC offset.
  var beforeSpring = dateFromWallClock_(2026, 2, 7, 9, 0, 0, 'America/Chicago');
  var afterSpring = addCalendarDays_(beforeSpring, 1);
  assertEquals_('2026-03-08', Utilities.formatDate(afterSpring, 'America/Chicago', 'yyyy-MM-dd'));
  assertEquals_('09', Utilities.formatDate(afterSpring, 'America/Chicago', 'HH'), 'Wall-clock hour must be preserved across spring-forward.');

  // Fall: 2026-10-31 09:00 (CDT) + 1 day must land on 2026-11-01 09:00, now CST.
  var beforeFall = dateFromWallClock_(2026, 9, 31, 9, 0, 0, 'America/Chicago');
  var afterFall = addCalendarDays_(beforeFall, 1);
  assertEquals_('2026-11-01', Utilities.formatDate(afterFall, 'America/Chicago', 'yyyy-MM-dd'));
  assertEquals_('09', Utilities.formatDate(afterFall, 'America/Chicago', 'HH'), 'Wall-clock hour must be preserved across fall-back.');
}

/**
 * DST audit: the two genuinely UNDEFINED wall clocks, each resolved per
 * dateFromWallClock_'s explicitly documented policy (never silently
 * invented — see its docstring).
 */
function test_dstAudit_nonexistentAndAmbiguousWallClocksFollowDocumentedPolicy_() {
  // NONEXISTENT: 2026-03-08 02:30 never occurs (clocks jump 02:00 -> 03:00).
  // Policy: resolve to the LATER equivalent (skip forward past the gap) -> 03:30.
  var gap = dateFromWallClock_(2026, 2, 8, 2, 30, 0, 'America/Chicago');
  assertEquals_('03', Utilities.formatDate(gap, 'America/Chicago', 'HH'), 'Nonexistent wall clock must resolve to the later (post-gap) equivalent per documented policy.');
  assertEquals_('30', Utilities.formatDate(gap, 'America/Chicago', 'mm'));

  // AMBIGUOUS: 2026-11-01 01:30 occurs twice (once CDT, once CST). Policy:
  // resolve to the EARLIER (pre-transition, CDT) occurrence -> UTC-5.
  var ambiguous = dateFromWallClock_(2026, 10, 1, 1, 30, 0, 'America/Chicago');
  assertEquals_('01', Utilities.formatDate(ambiguous, 'America/Chicago', 'HH'));
  assertEquals_('30', Utilities.formatDate(ambiguous, 'America/Chicago', 'mm'));
  assertEquals_('2026-11-01T06:30:00.000Z', ambiguous.toISOString(),
    'Ambiguous wall clock must resolve to the EARLIER (CDT, UTC-5) occurrence per documented policy — 06:30Z, not 07:30Z (CST).');
}

/**
 * DST audit: production send/reply windows (09:00-17:00 send, 07:00-21:00
 * reply) must remain correct on both sides of a DST transition — these
 * operate on `new Date()` (always a real, already-unambiguous instant),
 * never a human-constructed wall clock, so they were never actually
 * exposed to the dateFromWallClock_ bug — this is regression coverage
 * proving that remains true, not a fix.
 */
function test_dstAudit_sendAndReplyWindowsCorrectAcrossTransitions_() {
  var config = getConfig();

  var winterMorning = dateFromWallClock_(2026, 0, 15, 8, 59, 0, 'America/Chicago'); // Thu, just before window
  assert_(!isWithinSendWindow_(winterMorning, config), 'Winter 08:59 must be outside the 09:00-17:00 send window.');
  var winterOpen = dateFromWallClock_(2026, 0, 15, 9, 0, 0, 'America/Chicago');
  assert_(isWithinSendWindow_(winterOpen, config), 'Winter 09:00 must be inside the send window.');
  var winterClose = dateFromWallClock_(2026, 0, 15, 17, 0, 0, 'America/Chicago');
  assert_(!isWithinSendWindow_(winterClose, config), 'Winter 17:00 must be outside the send window (exclusive end).');

  var summerOpen = dateFromWallClock_(2026, 6, 15, 9, 0, 0, 'America/Chicago');
  assert_(isWithinSendWindow_(summerOpen, config), 'Summer (CDT) 09:00 must be inside the send window.');
  var summerClose = dateFromWallClock_(2026, 6, 15, 17, 0, 0, 'America/Chicago');
  assert_(!isWithinSendWindow_(summerClose, config), 'Summer (CDT) 17:00 must be outside the send window.');

  // The Monday immediately after the spring-forward Sunday (2026-03-08) —
  // a business day, already fully in CDT.
  var springAfterOpen = dateFromWallClock_(2026, 2, 9, 9, 0, 0, 'America/Chicago');
  assert_(isWithinSendWindow_(springAfterOpen, config), 'Monday after spring-forward, 09:00 (already CDT) must be inside the send window.');

  var replyOpen = dateFromWallClock_(2026, 0, 15, 7, 0, 0, 'America/Chicago');
  assert_(isWithinReplySyncWindow_(replyOpen, config), 'Reply-sync window must open at 07:00 (winter).');
  var replyBefore = dateFromWallClock_(2026, 0, 15, 6, 59, 0, 'America/Chicago');
  assert_(!isWithinReplySyncWindow_(replyBefore, config), 'Reply-sync window must be closed at 06:59 (winter).');
  var replyOpenSummer = dateFromWallClock_(2026, 6, 15, 7, 0, 0, 'America/Chicago');
  assert_(isWithinReplySyncWindow_(replyOpenSummer, config), 'Reply-sync window must open at 07:00 (summer, CDT) too.');
}

/**
 * DST audit: weekend/business-day cadence must remain correct across the
 * transition weekend (spring-forward 2026-03-08 is itself a Sunday).
 */
function test_dstAudit_businessDayCadenceAcrossTransitionWeekend_() {
  var config = getConfig();
  // Friday 2026-03-06, 3 business days later must land on Wednesday
  // 2026-03-11 — spanning the spring-forward weekend in between.
  var friday = dateFromWallClock_(2026, 2, 6, 10, 0, 0, 'America/Chicago');
  var result = addBusinessDays_(friday, 3, config.HOLIDAYS || []);
  assertEquals_('2026-03-11', formatDateYmd_(result), 'Fri + 3 business days across the spring-forward weekend must land on the following Wednesday.');

  // Same check across the fall-back weekend: Friday 2026-10-30 + 3
  // business days must land on Wednesday 2026-11-04.
  var fridayFall = dateFromWallClock_(2026, 9, 30, 10, 0, 0, 'America/Chicago');
  var resultFall = addBusinessDays_(fridayFall, 3, config.HOLIDAYS || []);
  assertEquals_('2026-11-04', formatDateYmd_(resultFall), 'Fri + 3 business days across the fall-back weekend must land on the following Wednesday.');
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

/**
 * F0/N5 (Codex final audit, round 2 — documentation correction):
 * checkLiveReadiness() must be read-only (never sends, never touches
 * Gmail, never changes DRY_RUN) and must report the SAME pending-keys
 * list assertLiveAllowed_ itself uses — proving it cannot drift out of
 * sync with the real gate.
 */
function test_checkLiveReadinessIsReadOnlyAndMatchesAssertLiveAllowed_() {
  var draftCountBefore = GmailApp.getDrafts().length;
  var r = checkLiveReadiness();

  assertEquals_(true, r.dryRun, 'This F1 delivery must report DRY_RUN=TRUE.');
  assertEquals_(false, r.liveConfigResolved, 'This F1 delivery must still have PENDING_F0 keys.');
  assertEquals_(JSON.stringify(getPendingF0Keys_().slice().sort()), JSON.stringify(r.pendingF0Keys.slice().sort()),
    'checkLiveReadiness() must report the EXACT same pending keys assertLiveAllowed_ itself checks — no separate/drifted logic.');
  assertEquals_(draftCountBefore, GmailApp.getDrafts().length, 'checkLiveReadiness() must never touch Gmail.');
  assertEquals_(true, getConfig().DRY_RUN === true, 'checkLiveReadiness() must never change DRY_RUN.');
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
 * Administrative-unsubscribe regression: the official menu entry point is
 * itself the operator's unsubscribe intent. A READY or REPLIED prospect
 * must not require a manual pre-edit of Do_Not_Contact_Reason, and replay
 * must remain idempotent on the durable Suppression triple.
 */
function test_adminUnsubscribeCompletesFromBlankReasonAndIsIdempotent_() {
  var gmailBefore = JSON.stringify(GmailApp._callCounts);
  var ledgerBefore = readAllLedgerRows_().length;

  function createFixture(label, status, replied) {
    var email = testUniqueEmail_(label);
    var repliedAt = replied ? new Date('2026-09-09T16:27:00.000Z') : '';
    var row = addTestProspectRow_({
      Email: email,
      Problem_Found: 'Controlled administrative unsubscribe regression.',
      Status: status,
      Replied: replied,
      Replied_At: repliedAt,
      Do_Not_Contact_Reason: '',
      Stop_Contact: false,
      Next_Action_Date: replied ? '' : new Date('2026-09-12T15:00:00.000Z')
    });
    var id = Utilities.getUuid();
    var normalized = normalizeEmail_(email);
    assignNewProspectIdAndFields_(row, {
      Prospect_ID: id,
      Date_Added: new Date(),
      Email_Normalized: normalized,
      Domain: extractDomain_(normalized),
      Domain_Type: DOMAIN_TYPE.CORPORATE
    }, { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });
    // Track before the production call so teardown remains safe even if an
    // assertion or a later stage of the operation throws.
    _testCreatedSuppressionValues.push(normalized);
    return { row: row, id: id, email: normalized, repliedAt: repliedAt };
  }

  var replied = createFixture('admin-unsub-replied', STATUS.REPLIED, true);
  var repliedBefore = getTestProspectByRow_(replied.row);
  assertEquals_('', repliedBefore.Do_Not_Contact_Reason,
    'Precondition: a normal REPLY must not itself become an unsubscribe.');
  assertEquals_(false, !!findSuppressionEntry_(replied.email, SUPPRESSION_SCOPE.EMAIL),
    'Precondition: ReplySync semantics must not create permanent Suppression for a normal reply.');

  var first = processUnsubscribeForSelectedRow(replied.id);
  assertEquals_(true, first.success, 'Official administrative unsubscribe must succeed for a REPLIED prospect with blank DNC reason.');
  assertEquals_(true, first.suppressionAdded, 'First administrative unsubscribe must create the durable Suppression row.');

  var repliedAfter = getTestProspectByRow_(replied.row);
  assertEquals_(DNC_REASON.UNSUBSCRIBE, repliedAfter.Do_Not_Contact_Reason,
    'Administrative unsubscribe must persist Do_Not_Contact_Reason=unsubscribe itself.');
  assertEquals_(true, repliedAfter.Stop_Contact, 'Administrative unsubscribe must set Stop_Contact=TRUE.');
  assertEquals_(STATUS.STOPPED, repliedAfter.Status, 'Administrative unsubscribe must set Status=STOPPED.');
  assertEquals_('', repliedAfter.Next_Action_Date, 'Administrative unsubscribe must clear Next_Action_Date.');
  assertEquals_(true, repliedAfter.Replied, 'Permanent unsubscribe must preserve the historical Replied=TRUE fact.');
  assertEquals_(replied.repliedAt.getTime(), new Date(repliedAfter.Replied_At).getTime(),
    'Permanent unsubscribe must preserve the historical Replied_At timestamp.');

  var exactRows = readAllSuppression_().filter(function (s) {
    return s.Value === replied.email && s.Scope === SUPPRESSION_SCOPE.EMAIL && s.Reason === DNC_REASON.UNSUBSCRIBE;
  });
  assertEquals_(1, exactRows.length, 'Exactly one email-scope/unsubscribe Suppression row must exist.');
  assertEquals_('operator', exactRows[0].Added_By, 'The official menu action must attribute Suppression to the operator.');
  assertEquals_(false, isEligibleForNextStep_(repliedAfter, getConfig(), new Date()),
    'A permanently unsubscribed prospect must be excluded by production eligibility.');
  assertEquals_(false, canSend_(repliedAfter, 2, getConfig(), new Date('2030-01-01T00:00:00.000Z')),
    'A permanently unsubscribed prospect must be rejected by the hard LIVE send guard.');

  var replay2 = processUnsubscribeForSelectedRow(replied.id);
  var replay3 = processUnsubscribeForSelectedRow(replied.id);
  assertEquals_(false, replay2.suppressionAdded, 'Second administrative unsubscribe must be an idempotent no-op for Suppression.');
  assertEquals_(false, replay3.suppressionAdded, 'Third administrative unsubscribe must be an idempotent no-op for Suppression.');
  exactRows = readAllSuppression_().filter(function (s) {
    return s.Value === replied.email && s.Scope === SUPPRESSION_SCOPE.EMAIL && s.Reason === DNC_REASON.UNSUBSCRIBE;
  });
  assertEquals_(1, exactRows.length, 'Replay must never duplicate the exact unsubscribe Suppression row.');

  var ready = createFixture('admin-unsub-ready', STATUS.READY, false);
  var readyResult = processUnsubscribeForSelectedRow(ready.id);
  var readyAfter = getTestProspectByRow_(ready.row);
  assertEquals_(true, readyResult.success, 'Official administrative unsubscribe must also succeed for a READY prospect with blank DNC reason.');
  assertEquals_(DNC_REASON.UNSUBSCRIBE, readyAfter.Do_Not_Contact_Reason, 'READY prospect must receive the same durable unsubscribe intent.');
  assertEquals_(STATUS.STOPPED, readyAfter.Status, 'READY prospect must become STOPPED.');
  assert_(!!findSuppressionEntry_(ready.email, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.UNSUBSCRIBE),
    'READY prospect must receive its exact durable email-scope/unsubscribe Suppression row.');

  assertEquals_(gmailBefore, JSON.stringify(GmailApp._callCounts),
    'Administrative unsubscribe must not invoke any Gmail primitive.');
  assertEquals_(ledgerBefore, readAllLedgerRows_().length,
    'Administrative unsubscribe must not create or mutate LIVE ledger rows.');
}

/**
 * Partial failures must be visible and fail closed. No branch is allowed to
 * return success unless the complete administrative unsubscribe procedure
 * finished, while any durable intent already written must keep blocking sends.
 */
function test_adminUnsubscribeFailuresAreVisibleAndFailClosed_() {
  var gmailBefore = JSON.stringify(GmailApp._callCounts);
  var ledgerBefore = readAllLedgerRows_().length;

  var missingThrew = false;
  try {
    processUnsubscribeForSelectedRow('missing-admin-unsubscribe-id');
  } catch (e) { missingThrew = true; }
  assertEquals_(true, missingThrew, 'An invalid selected row must be rejected visibly.');

  var noEmailRow = addTestProspectRow_({ Email: '', Email_Normalized: '', Status: STATUS.READY, Problem_Found: 'x' });
  var noEmailId = Utilities.getUuid();
  assignNewProspectIdAndFields_(noEmailRow, { Prospect_ID: noEmailId, Date_Added: new Date() },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });
  var noEmailThrew = false;
  try {
    processUnsubscribeForSelectedRow(noEmailId);
  } catch (e2) { noEmailThrew = true; }
  assertEquals_(true, noEmailThrew, 'A selected row without a suppressible email must be rejected visibly.');
  assertEquals_('', getTestProspectByRow_(noEmailRow).Do_Not_Contact_Reason,
    'Prevalidation failure must not claim an unsubscribe intent that can never be completed.');

  var suppressionEmail = testUniqueEmail_('admin-unsub-suppression-fail');
  var suppressionNormalized = normalizeEmail_(suppressionEmail);
  var suppressionRow = addTestProspectRow_({ Email: suppressionEmail, Status: STATUS.READY, Problem_Found: 'x' });
  var suppressionId = Utilities.getUuid();
  assignNewProspectIdAndFields_(suppressionRow, {
    Prospect_ID: suppressionId, Date_Added: new Date(), Email_Normalized: suppressionNormalized,
    Domain: extractDomain_(suppressionNormalized), Domain_Type: DOMAIN_TYPE.CORPORATE
  }, { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });
  _testCreatedSuppressionValues.push(suppressionNormalized);

  var suppressionSheet = getSheet_(SHEET_NAMES.SUPPRESSION);
  var originalAppendRow = suppressionSheet.appendRow;
  var suppressionFailureThrew = false;
  try {
    suppressionSheet.appendRow = function () { throw new Error('TEST_INJECTED_SUPPRESSION_WRITE_FAILURE'); };
    processUnsubscribeForSelectedRow(suppressionId);
  } catch (e3) {
    suppressionFailureThrew = String(e3 && e3.message || e3).indexOf('TEST_INJECTED_SUPPRESSION_WRITE_FAILURE') !== -1;
  } finally {
    suppressionSheet.appendRow = originalAppendRow;
  }
  assertEquals_(true, suppressionFailureThrew, 'Suppression write failure must propagate; the menu must not report false success.');
  assertEquals_(false, !!findSuppressionEntry_(suppressionNormalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.UNSUBSCRIBE),
    'A failed Suppression append must not fabricate a durable Suppression row.');
  var suppressionAfter = getTestProspectByRow_(suppressionRow);
  assertEquals_(DNC_REASON.UNSUBSCRIBE, suppressionAfter.Do_Not_Contact_Reason,
    'If Suppression persistence fails, the already-durable unsubscribe intent must remain as a fail-closed send block.');
  assertEquals_(false, canSend_(suppressionAfter, 1, getConfig(), new Date()),
    'The durable unsubscribe intent must independently block LIVE after Suppression failure.');

  var stateEmail = testUniqueEmail_('admin-unsub-state-fail');
  var stateNormalized = normalizeEmail_(stateEmail);
  var stateRow = addTestProspectRow_({ Email: stateEmail, Status: STATUS.READY, Problem_Found: 'x' });
  var stateId = Utilities.getUuid();
  assignNewProspectIdAndFields_(stateRow, {
    Prospect_ID: stateId, Date_Added: new Date(), Email_Normalized: stateNormalized,
    Domain: extractDomain_(stateNormalized), Domain_Type: DOMAIN_TYPE.CORPORATE
  }, { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });
  _testCreatedSuppressionValues.push(stateNormalized);

  var originalWriteRowById = writeRowById_;
  var targetWriteCalls = 0;
  var stateFailureThrew = false;
  try {
    writeRowById_ = function (prospectId, fields, options) {
      if (prospectId === stateId) {
        targetWriteCalls++;
        if (targetWriteCalls === 2) throw new Error('TEST_INJECTED_PROSPECT_STATE_WRITE_FAILURE');
      }
      return originalWriteRowById(prospectId, fields, options);
    };
    processUnsubscribeForSelectedRow(stateId);
  } catch (e4) {
    stateFailureThrew = String(e4 && e4.message || e4).indexOf('TEST_INJECTED_PROSPECT_STATE_WRITE_FAILURE') !== -1;
  } finally {
    writeRowById_ = originalWriteRowById;
  }
  assertEquals_(true, stateFailureThrew, 'Prospect-state write failure must propagate; the menu must not report false success.');
  assertEquals_(false, !!findSuppressionEntry_(stateNormalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.UNSUBSCRIBE),
    'Failure before Suppression creation must not fabricate a completed unsubscribe.');
  var stateAfter = getTestProspectByRow_(stateRow);
  assertEquals_(DNC_REASON.UNSUBSCRIBE, stateAfter.Do_Not_Contact_Reason,
    'A state-write failure after intent persistence must retain the fail-closed unsubscribe marker.');
  assertEquals_(false, canSend_(stateAfter, 1, getConfig(), new Date()),
    'The retained intent marker must prevent a send even though the full state transition failed.');

  assertEquals_(gmailBefore, JSON.stringify(GmailApp._callCounts),
    'Every administrative unsubscribe failure path must avoid Gmail completely.');
  assertEquals_(ledgerBefore, readAllLedgerRows_().length,
    'Every administrative unsubscribe failure path must leave SendLedger unchanged.');
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
  // P4 (Codex re-audit): capture the real implementation so it can be put
  // back before teardown. A permanently poisoned getId() makes the
  // framework's own ownership-verified cleanup unable to delete this
  // draft, which is exactly how two real drafts leaked out of the suite
  // while it still reported "isolation clean".
  var originalGetId = ctx.message.getId;
  ctx.message.getId = function () { throw new Error('Simulated Gmail error reading message id.'); };

  var second;
  try {
    second = previewStep(ctx.p.Prospect_ID, 1);
  } finally {
    ctx.message.getId = originalGetId;
  }
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
  // P4: same restoration requirement as the getId case above.
  var originalGetPlainBody = ctx.message.getPlainBody;
  var originalGetBody = ctx.message.getBody;
  ctx.message.getPlainBody = function () { throw new Error('Simulated Gmail error reading draft body.'); };
  ctx.message.getBody = ctx.message.getPlainBody;

  var second;
  try {
    second = previewStep(ctx.p.Prospect_ID, 1);
  } finally {
    ctx.message.getPlainBody = originalGetPlainBody;
    ctx.message.getBody = originalGetBody;
  }
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
  assertEquals_(false, outcome.compensated, 'Compensation must be reported as failed (the delete itself threw).');

  // N3 final round (CASO C): the durable barrier is now the pre-claim row
  // itself, transitioned to PREVIEW_AMBIGUOUS — NOT an appended "recovery
  // row" written after the fact (which could itself fail to write).
  var keyRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.DRY_RUN;
  });
  assertEquals_(1, keyRows.length, 'Exactly one ledger row must exist for this key — the pre-claim, transitioned in place.');
  assertEquals_(LEDGER_STATE.PREVIEW_AMBIGUOUS, keyRows[0].values.State,
    'An uncompensable post-create failure must leave the claim PREVIEW_AMBIGUOUS (durably blocking).');
  assert_(keyRows[0].values.Error.indexOf('PREVIEW_AMBIGUOUS') !== -1, 'The row must be clearly marked for manual ADMIN review.');

  if (capturedMessage && originalGetSubject) capturedMessage.getSubject = originalGetSubject;

  // The critical safety proof: the NEXT run must create ZERO additional
  // drafts — the ambiguous claim blocks it outright.
  var draftCountBeforeNextRun = GmailApp.getDrafts().length;
  var nextRun = previewStep(p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', nextRun.status, 'A PREVIEW_AMBIGUOUS key must block the next Preview entirely.');
  assertEquals_('preview_ambiguous', nextRun.reason, 'The block reason must identify the ambiguous claim.');
  assertEquals_(draftCountBeforeNextRun, GmailApp.getDrafts().length, 'ZERO additional drafts must have been created.');

  // Test cleanup: this key is deliberately left blocked (that IS the
  // behavior under test), so the orphaned draft is not tracked by any
  // DRAFTED row and the framework's teardown cannot find it — remove it
  // here so the suite's isolation check stays honest.
  if (capturedDraft) { try { capturedDraft.deleteDraft(); } catch (e) { /* already restored above */ } }
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
/**
 * N3 final round, CASOS C/D (uncompensable variants): for EACH
 * post-creation read that can fail, if the compensating delete ALSO
 * fails, the pre-claim must end PREVIEW_AMBIGUOUS and the next Preview
 * must create ZERO additional drafts — proven with a real
 * GmailApp.createDraft call counter, not just by inspecting state.
 */
function n3_assertUncompensableFailureBlocksDurably_(emailTag, corruptMessageFn) {
  var row = addTestProspectRow_({ Email: testUniqueEmail_(emailTag), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var originalCreateDraft = GmailApp.createDraft;
  var capturedDraft = null;
  var originalDeleteDraft = null;
  GmailApp._resetCallCounts();
  GmailApp.createDraft = function (to, subject, body, opts) {
    var draft = originalCreateDraft(to, subject, body, opts);
    corruptMessageFn(draft);
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
    if (capturedDraft && originalDeleteDraft) capturedDraft.deleteDraft = originalDeleteDraft;
  }

  assertEquals_('ERROR_DRAFT_METADATA_CAPTURE_FAILED', outcome.status, 'A post-create read failure must fail closed.');
  assertEquals_(false, outcome.compensated, 'The compensating delete failed, so compensation must be reported false.');
  assertEquals_(1, GmailApp._callCounts.createDraft, 'Exactly one draft-creating call so far.');

  var keyRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.DRY_RUN;
  });
  assertEquals_(1, keyRows.length, 'Exactly one ledger row (the pre-claim) must exist for this key.');
  assertEquals_(LEDGER_STATE.PREVIEW_AMBIGUOUS, keyRows[0].values.State,
    'An uncompensable failure must leave the claim PREVIEW_AMBIGUOUS — durably blocking.');

  var nextRun = previewStep(p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', nextRun.status, 'The next Preview must be blocked outright.');
  assertEquals_('preview_ambiguous', nextRun.reason, 'The block reason must identify the ambiguous claim.');
  assertEquals_(1, GmailApp._callCounts.createDraft,
    'CASO C/D: total GmailApp.createDraft call count across BOTH runs must still be EXACTLY 1 — zero duplicates.');

  if (capturedDraft) { try { capturedDraft.deleteDraft(); } catch (e) { /* restored above */ } }
}

/** N3 item 4: draft.getId() throws AND the delete also fails. */
function test_N3v3_uncompensable_draftGetIdThrows_() {
  n3_assertUncompensableFailureBlocksDurably_('n3uncdraftid', function (draft) {
    draft.getId = function () { throw new Error('Simulated draft.getId() failure.'); };
  });
}

/** N3 item 5: getMessage() throws AND the delete also fails. */
function test_N3v3_uncompensable_getMessageThrows_() {
  n3_assertUncompensableFailureBlocksDurably_('n3uncgetmessage', function (draft) {
    draft.getMessage = function () { throw new Error('Simulated draft.getMessage() failure.'); };
  });
}

/** N3 item 6: message.getThread() throws AND the delete also fails. */
function test_N3v3_uncompensable_getThreadThrows_() {
  n3_assertUncompensableFailureBlocksDurably_('n3uncgetthread', function (draft) {
    draft.getMessage().getThread = function () { throw new Error('Simulated message.getThread() failure.'); };
  });
}

/** N3 item 7: thread.getId() throws AND the delete also fails. */
function test_N3v3_uncompensable_threadGetIdThrows_() {
  n3_assertUncompensableFailureBlocksDurably_('n3uncthreadid', function (draft) {
    var msg = draft.getMessage();
    msg.getThread = function () { return { getId: function () { throw new Error('Simulated thread.getId() failure.'); } }; };
  });
}

/** N3 item 8: content/fingerprint read throws AND the delete also fails. */
function test_N3v3_uncompensable_contentReadThrows_() {
  n3_assertUncompensableFailureBlocksDurably_('n3unccontent', function (draft) {
    var msg = draft.getMessage();
    msg.getPlainBody = function () { throw new Error('Simulated body read failure.'); };
    msg.getBody = msg.getPlainBody;
  });
}

/**
 * N3 item 2: GmailApp.createDraft() itself throws. Its outcome is
 * unresolvable (Gmail may have created a draft we have no handle on), so
 * the claim must stay blocking and the next run must not call createDraft
 * a second time.
 */
function test_N3v3_createDraftThrowsBlocksKeyDurably_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3createthrows'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var originalCreateDraft = GmailApp.createDraft;
  GmailApp._resetCallCounts();
  GmailApp.createDraft = function () {
    GmailApp._callCounts.createDraft++;
    throw new Error('Simulated GmailApp.createDraft() failure with unresolvable outcome.');
  };

  var outcome;
  try {
    outcome = previewStep(p.Prospect_ID, 1);
  } finally {
    GmailApp.createDraft = originalCreateDraft;
  }

  assertEquals_('ERROR_PREVIEW_CREATE_AMBIGUOUS', outcome.status, 'CASO B: a throwing createDraft must fail closed as ambiguous.');
  var keyRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.DRY_RUN;
  });
  assertEquals_(1, keyRows.length, 'Exactly one ledger row (the pre-claim) must exist.');
  assertEquals_(LEDGER_STATE.PREVIEW_AMBIGUOUS, keyRows[0].values.State,
    'CASO B: createDraft throwing must leave the claim PREVIEW_AMBIGUOUS — we cannot prove no draft was created.');

  var nextRun = previewStep(p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', nextRun.status, 'The next run must be blocked.');
  assertEquals_(1, GmailApp._callCounts.createDraft,
    'CASO B: total createDraft call count across BOTH runs must be EXACTLY 1 — never retried automatically.');
}

/**
 * N3 item 12: the normal path — exactly one draft-creating call, and the
 * pre-claim resolves in place to a healthy DRAFTED row (never two rows,
 * never zero).
 */
function test_N3v3_normalPreviewClaimResolvesToDraftedExactlyOnce_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3claimhappy'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  GmailApp._resetCallCounts();
  var outcome = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', outcome.status, 'A normal preview must draft.');
  assertEquals_(1, GmailApp._callCounts.createDraft, 'Exactly one GmailApp.createDraft call.');

  var keyRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.DRY_RUN;
  });
  assertEquals_(1, keyRows.length, 'The claim row must have been transitioned IN PLACE — exactly one row, never two.');
  assertEquals_(LEDGER_STATE.DRAFTED, keyRows[0].values.State, 'The claim must resolve to DRAFTED.');
  assertEquals_(outcome.draftId, keyRows[0].values.Draft_ID, 'The row must carry the real Draft_ID.');
  assert_(!!keyRows[0].values.Draft_Fingerprint, 'The row must carry a real fingerprint.');
}

/**
 * N3 item 10: an unrelated draft throwing during a compensation-path
 * enumeration must never erase the durable protection. Here the ADMIN
 * bulk-cleanup path (deletePreviewDraftIfOwned_, the only remaining
 * enumeration-based caller) hits a poisoned draft — the tracked row must
 * survive untouched rather than being superseded on a failed lookup.
 */
function test_N3v3_enumerationErrorDoesNotEraseDurableProtection_() {
  var poisoned = GmailApp.createDraft('poison-enum@example-corp-test.com', 'Unrelated', 'Unrelated body.');
  poisoned.getId = function () { throw new Error('Simulated poisoned draft during enumeration.'); };

  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3enumprotect'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);
  var first = previewStep(p.Prospect_ID, 1);
  assertEquals_('DRAFTED', first.status, 'First preview must draft.');

  var result;
  try {
    result = deleteKlinnerPreviewDrafts(); // ADMIN bulk path — enumerates all drafts.
  } finally {
    poisoned.deleteDraft();
  }

  var keyRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.DRY_RUN;
  });
  assertEquals_(1, keyRows.length, 'The tracked row must still exist.');
  assertEquals_(LEDGER_STATE.DRAFTED, keyRows[0].values.State,
    'An enumeration failure must NOT supersede the row — durable protection must survive a failed lookup.');
  assert_(GmailApp.getDrafts().some(function (d) {
    try { return d.getId() === first.draftId; } catch (e) { return false; }
  }), 'The tracked draft itself must still exist (never deleted on an unverifiable lookup).');
}

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
 * N3 final round, CASO E (worst case): the draft exists, its metadata was
 * captured fine, but the FINAL transition of the claim row to DRAFTED
 * fails — AND the compensating delete fails — AND the attempt to mark the
 * claim PREVIEW_AMBIGUOUS fails too (all three use the same broken
 * updateLedgerRow_). The pre-claim row simply stays PREVIEW_CLAIMED,
 * which is itself a blocking state, so the key remains closed and the
 * next run creates ZERO additional drafts. previewStep must also never
 * throw uncaught (previewQueue's forEach has no try/catch around it).
 */
function test_N3v3_finalTransitionFailureLeavesClaimBlockingAndNoDuplicate_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3v3finaltransition'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var originalCreateDraft = GmailApp.createDraft;
  var capturedDraft = null;
  var originalDeleteDraft = null;
  var createDraftCalls = 0;
  GmailApp.createDraft = function (to, subject, body, opts) {
    createDraftCalls++;
    var draft = originalCreateDraft(to, subject, body, opts);
    capturedDraft = draft;
    originalDeleteDraft = draft.deleteDraft;
    draft.deleteDraft = function () { throw new Error('Simulated compensation delete failure.'); };
    return draft;
  };
  // Every ledger-update path is broken: the state-last finalizer AND the
  // generic per-cell updater the ambiguous/release fallbacks use.
  var originalUpdateLedgerRow = updateLedgerRow_;
  var originalWriteMetadataThenState = writeLedgerMetadataThenState_;
  updateLedgerRow_ = function () { throw new Error('Simulated final DRAFTED transition failure.'); };
  writeLedgerMetadataThenState_ = function () { throw new Error('Simulated final DRAFTED transition failure.'); };

  var outcome;
  var threw = false;
  try {
    outcome = previewStep(p.Prospect_ID, 1);
  } catch (e) {
    threw = true;
  } finally {
    GmailApp.createDraft = originalCreateDraft;
    updateLedgerRow_ = originalUpdateLedgerRow;
    writeLedgerMetadataThenState_ = originalWriteMetadataThenState;
    if (capturedDraft && originalDeleteDraft) capturedDraft.deleteDraft = originalDeleteDraft;
  }

  assert_(!threw, 'previewStep must never throw uncaught, even when the transition, the delete, AND the claim update all fail.');
  assertEquals_('ERROR_LEDGER_WRITE_FAILED', outcome.status, 'CASO E: the final transition failure must be reported explicitly.');
  assertEquals_(false, outcome.compensated, 'The compensating delete failed, so compensation must be reported false.');
  assertEquals_(1, createDraftCalls, 'Exactly one draft-creating call must have happened so far.');

  var keyRows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.DRY_RUN;
  });
  assertEquals_(1, keyRows.length, 'Exactly one ledger row must exist for this key.');
  assertEquals_(LEDGER_STATE.PREVIEW_CLAIMED, keyRows[0].values.State,
    'With every ledger update broken, the pre-claim must simply REMAIN PREVIEW_CLAIMED — still blocking.');

  // The safety proof: the next run must create ZERO additional drafts.
  var nextRun = previewStep(p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', nextRun.status, 'An unresolved PREVIEW_CLAIMED key must block the next Preview.');
  assertEquals_('preview_claim_unresolved', nextRun.reason, 'The block reason must identify the unresolved claim.');
  assertEquals_(1, createDraftCalls, 'CASO E: total createDraft call count across BOTH runs must still be exactly 1.');

  if (capturedDraft) { try { capturedDraft.deleteDraft(); } catch (e) { /* restored above */ } }
}

/**
 * N3 ATOMICITY ROUND — shared harness for the partial-write regression.
 *
 * Replaces getLedgerSheet_ with a delegating proxy whose getRange() throws
 * for the cells `shouldFail(row, col, numRows, numCols)` selects, so a test
 * can fail ONE specific write inside writeLedgerMetadataThenState_ while
 * every other ledger operation keeps working normally. That is the only
 * way to reproduce Codex's exact scenario: not "the ledger is broken", but
 * "the finalization got HALFWAY through".
 */
function n3atomic_withPoisonedLedgerCell_(shouldFail, body) {
  var realSheet = getLedgerSheet_();
  var proxy = {};
  for (var k in realSheet) {
    proxy[k] = (typeof realSheet[k] === 'function') ? realSheet[k].bind(realSheet) : realSheet[k];
  }
  proxy.getRange = function (row, col, numRows, numCols) {
    if (shouldFail(row, col, numRows, numCols)) {
      throw new Error('Simulated partial-write failure at column ' + col + '.');
    }
    return realSheet.getRange(row, col, numRows, numCols);
  };
  var originalGetLedgerSheet = getLedgerSheet_;
  getLedgerSheet_ = function () { return proxy; };
  try {
    return body();
  } finally {
    getLedgerSheet_ = originalGetLedgerSheet;
  }
}

function n3atomic_dryRunRowsFor_(prospectId, step) {
  return readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === prospectId && r.values.Step === step && r.values.Mode === LEDGER_MODE.DRY_RUN;
  });
}

/**
 * N3 ATOMICITY ROUND, P2 — the exact failure Codex reported, in both of
 * its halves. The claim is persisted, the Gmail draft IS created, and then
 * the finalization is interrupted PARTWAY. Cleanup (deleteDraft) fails and
 * marking the claim PREVIEW_AMBIGUOUS fails too, so the ledger row is the
 * only barrier left — which is the whole point: cleanup is best-effort,
 * the durable ledger row is the real protection.
 *
 * Case 1 — the FINAL State write fails.
 *   The metadata (Draft_ID etc.) must ALREADY be durable, and State must
 *   still read PREVIEW_CLAIMED. This is the positive proof of ordering:
 *   if State were written first, Draft_ID would be blank here.
 *
 * Case 2 — a METADATA write fails.
 *   State must still read PREVIEW_CLAIMED. This is the negative proof:
 *   the forbidden row (State=DRAFTED + Draft_ID="") must not exist, since
 *   that is precisely what the next run would misread as "the draft
 *   disappeared" and duplicate.
 *
 * In BOTH cases the second Preview must create ZERO additional drafts and
 * total createDraft calls must be EXACTLY 1.
 */
function n3atomic_runPartialFinalizationCase_(slug, shouldFail, assertAfterFailure) {
  var row = addTestProspectRow_({ Email: testUniqueEmail_(slug), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var originalCreateDraft = GmailApp.createDraft;
  var capturedDraft = null;
  var originalDeleteDraft = null;
  var createDraftCalls = 0;
  GmailApp.createDraft = function (to, subject, body, opts) {
    createDraftCalls++;
    var draft = originalCreateDraft(to, subject, body, opts);
    capturedDraft = draft;
    originalDeleteDraft = draft.deleteDraft;
    draft.deleteDraft = function () { throw new Error('Simulated compensating delete failure.'); };
    return draft;
  };
  // markPreviewClaimAmbiguous_/releasePreviewClaim_ both go through this —
  // broken, so the ONLY thing standing between us and a duplicate is the
  // durable PREVIEW_CLAIMED row itself.
  var originalUpdateLedgerRow = updateLedgerRow_;
  updateLedgerRow_ = function () { throw new Error('Simulated claim-resolution failure.'); };

  var outcome;
  var threw = false;
  try {
    outcome = n3atomic_withPoisonedLedgerCell_(shouldFail, function () {
      return previewStep(p.Prospect_ID, 1);
    });
  } catch (e) {
    threw = true;
  } finally {
    GmailApp.createDraft = originalCreateDraft;
    updateLedgerRow_ = originalUpdateLedgerRow;
    if (capturedDraft && originalDeleteDraft) capturedDraft.deleteDraft = originalDeleteDraft;
  }

  assert_(!threw, slug + ': previewStep must never throw uncaught out of a partial finalization.');
  assertEquals_('ERROR_LEDGER_WRITE_FAILED', outcome.status, slug + ': a partial finalization must be reported, never silently succeed.');
  assertEquals_(false, outcome.compensated, slug + ': the compensating delete failed, so compensation must be reported false.');
  assertEquals_(1, createDraftCalls, slug + ': exactly one draft-creating call so far.');

  // The draft really does still exist in Gmail — cleanup failed on purpose.
  var stillThere = GmailApp.getDrafts().filter(function (d) { return d === capturedDraft; });
  assertEquals_(1, stillThere.length, slug + ': the orphan draft must still exist (the delete was made to fail) — this is what the ledger barrier is protecting against.');

  var rows = n3atomic_dryRunRowsFor_(p.Prospect_ID, 1);
  assertEquals_(1, rows.length, slug + ': exactly one ledger row must exist for this key.');
  assertAfterFailure(rows[0], slug);

  // THE forbidden row, stated directly.
  assert_(!(rows[0].values.State === LEDGER_STATE.DRAFTED && !rows[0].values.Draft_ID),
    slug + ': a DRAFTED row with a blank Draft_ID must never exist — that is the exact corruption that produces a duplicate draft.');

  // Second run: no new draft, key still blocked, never auto-superseded.
  var second = previewStep(p.Prospect_ID, 1);
  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', second.status, slug + ': the second Preview must be blocked, not allowed to create anything.');
  assertEquals_(1, createDraftCalls, slug + ': total createDraft calls across BOTH runs must still be EXACTLY 1.');
  assertEquals_(0, GmailApp.getDrafts().filter(function (d) { return d !== capturedDraft && d._klinnerExtra; }).length,
    slug + ': no extra draft may have been created.');

  var after = n3atomic_dryRunRowsFor_(p.Prospect_ID, 1);
  assertEquals_(1, after.length, slug + ': the second run must not append another row for this key.');
  assert_(after[0].values.State !== LEDGER_STATE.SUPERSEDED,
    slug + ': the row must never be auto-superseded as "gone" — the draft is provably still there.');

  if (capturedDraft) { try { capturedDraft.deleteDraft(); } catch (e) { /* restored above */ } }
}

/** Case 1: the final State write fails — metadata must already be durable. */
function test_N3atomic_finalStateWriteFailureLeavesMetadataDurableAndClaimBlocking_() {
  n3atomic_runPartialFinalizationCase_(
    'n3atomicstatewrite',
    function (row, col, numRows, numCols) {
      // Single-cell write of the State column = the last durable step.
      return col === SEND_LEDGER_COLUMNS.State && numCols === undefined;
    },
    function (ledgerRow, slug) {
      assertEquals_(LEDGER_STATE.PREVIEW_CLAIMED, ledgerRow.values.State,
        slug + ': with the State write failed, the row must still read PREVIEW_CLAIMED — still blocking.');
      assert_(!!ledgerRow.values.Draft_ID,
        slug + ': ORDERING PROOF — the metadata must have been durably written BEFORE the State write was even attempted.');
    });
}

/** Case 2: a metadata write fails — State must never have moved. */
function test_N3atomic_metadataWriteFailureNeverPublishesDraftedState_() {
  n3atomic_runPartialFinalizationCase_(
    'n3atomicmetawrite',
    function (row, col, numRows, numCols) {
      // The contiguous metadata range write starts at Thread_ID.
      return col === SEND_LEDGER_COLUMNS.Thread_ID && numCols !== undefined;
    },
    function (ledgerRow, slug) {
      assertEquals_(LEDGER_STATE.PREVIEW_CLAIMED, ledgerRow.values.State,
        slug + ': ORDERING PROOF — a metadata failure must leave State untouched at PREVIEW_CLAIMED, never DRAFTED.');
      assertEquals_('', ledgerRow.values.Draft_ID,
        slug + ': the metadata write failed, so Draft_ID must still be blank.');
    });
}

/**
 * N3 ATOMICITY ROUND, P2 (defensive read safety) — a pre-existing DRAFTED
 * row with a blank Draft_ID, which the code above can no longer produce
 * but history, a manual edit or an unimagined failure still could.
 * It must NEVER be read as "the draft is already gone" and must NEVER
 * authorize CREATE_NEW; it is corrupt, and corrupt means fail-closed.
 */
function test_N3atomic_incompleteDraftedRowNeverAuthorizesCreateNew_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n3atomicincomplete'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  appendLedgerRow_({
    Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: p.Prospect_ID, Email_Normalized: p.Email_Normalized,
    Step: 1, Idempotency_Key: getIdempotencyKey_(p.Prospect_ID, 1), Mode: LEDGER_MODE.DRY_RUN,
    State: LEDGER_STATE.DRAFTED, Thread_ID: '', Message_ID: '', Draft_ID: '', // <- the corrupt row
    Confirmed_At: new Date(), Error: '', Draft_Fingerprint: '', Human_Edit_Preserved: false, Human_Edit_Detected_At: ''
  });

  var createDraftCalls = 0;
  var originalCreateDraft = GmailApp.createDraft;
  GmailApp.createDraft = function (to, subject, body, opts) {
    createDraftCalls++;
    return originalCreateDraft(to, subject, body, opts);
  };

  var outcome;
  try {
    outcome = previewStep(p.Prospect_ID, 1);
  } finally {
    GmailApp.createDraft = originalCreateDraft;
  }

  assertEquals_('SKIPPED_DRAFT_NEEDS_REVIEW', outcome.status,
    'A DRAFTED row with no Draft_ID is corrupt/ambiguous — it must fail closed, not fall through to CREATE_NEW.');
  assertEquals_('drafted_row_missing_draft_id', outcome.reason, 'The block reason must name the corruption explicitly.');
  assertEquals_(0, createDraftCalls, 'ZERO drafts may be created while an incomplete DRAFTED row exists for this key.');

  var rows = n3atomic_dryRunRowsFor_(p.Prospect_ID, 1);
  assertEquals_(1, rows.length, 'No additional row may be appended for this key.');
  assertEquals_(LEDGER_STATE.DRAFTED, rows[0].values.State,
    'The corrupt row must be left EXACTLY as found for a human to resolve — never auto-superseded as "gone".');
}

/**
 * P1 (Codex test-infra round), case 1 — baseline null.
 * The suite starts with nothing cached. A test that calls getConfig()
 * populates the shared cache; teardown must put it back to null, not
 * merely to "some cache".
 */
function test_configCache_baselineNullIsRestoredToNull_() {
  var outerBaseline = captureConfigCache_();
  try {
    resetConfigCache_();
    var baseline = captureConfigCache_();
    assertEquals_('NULL', baseline.signature, 'Precondition: the baseline for this case must be an empty cache.');

    getConfig(); // populates the shared cache
    assert_(captureConfigCache_().signature !== 'NULL', 'getConfig() must actually populate the shared cache.');

    restoreConfigCache_(baseline);
    assertEquals_('NULL', captureConfigCache_().signature,
      'Teardown must return the cache to null — "populated" is not the same baseline as "empty".');
  } finally {
    restoreConfigCache_(outerBaseline);
  }
}

/**
 * P1, case 2 — baseline object. The restore must reproduce the EXACT
 * values that were cached before the test, never a hardcoded set and
 * never the test's own mutation. Mutating in place is the important part:
 * restoring the captured object REFERENCE would silently "restore" the
 * mutation, so the capture has to be a deep copy.
 */
function test_configCache_baselineObjectIsRestoredExactly_() {
  var outerBaseline = captureConfigCache_();
  try {
    resetConfigCache_();
    getConfig();
    var baseline = captureConfigCache_();
    assert_(baseline.signature !== 'NULL', 'Precondition: the baseline for this case must be a populated cache.');
    var originalMaxPerDay = _configCache.MAX_PER_DAY;

    _configCache.MAX_PER_DAY = 999; // in-place mutation of the SHARED object
    assert_(captureConfigCache_().signature !== baseline.signature, 'The mutation must be visible in the signature.');

    restoreConfigCache_(baseline);
    assertEquals_(baseline.signature, captureConfigCache_().signature,
      'Teardown must restore the exact pre-test cache content.');
    assertEquals_(originalMaxPerDay, _configCache.MAX_PER_DAY,
      'MAX_PER_DAY must be back to whatever it actually was — never a hardcoded value.');
  } finally {
    restoreConfigCache_(outerBaseline);
  }
}

/**
 * P1, case 3 — the exact false negative Codex reproduced: the Config
 * SHEET is untouched and every functional assertion still holds, but the
 * shared cache says MAX_PER_DAY=999. Sheet-content comparison is blind to
 * it by construction. Both isolation detectors must fire, and
 * verifyCleanTestState_ must report it as a problem.
 */
function test_configCache_divergentCacheIsDetectedAsContamination_() {
  var outerBaseline = captureConfigCache_();
  try {
    resetConfigCache_();
    getConfig();
    var baseline = snapshotSandboxState_();
    var sheetMaxPerDay = readConfigFromSheetIgnoringCache_().MAX_PER_DAY;

    _configCache.MAX_PER_DAY = 999;

    assertEquals_(sheetMaxPerDay, readConfigFromSheetIgnoringCache_().MAX_PER_DAY,
      'Precondition: the Config SHEET must be untouched — the divergence exists only in memory.');
    assert_(sheetMaxPerDay !== 999, 'Precondition: 999 must not be the real configured value.');

    // Detector 1: the cache changed and was not put back.
    assert_(captureConfigCache_().signature !== baseline.configCache.signature,
      'Detector 1: a mutated cache must differ from the captured baseline signature.');

    // Detector 2: the cache no longer agrees with the sheet — independent
    // of the baseline, so it fires even if the baseline was already wrong.
    var coherence = configCacheCoherenceProblem_();
    assert_(!!coherence, 'Detector 2: a cache diverging from the Config sheet must be reported.');

    // End to end: this is what the runner actually calls.
    var verdict = verifyCleanTestState_(getRunId_(), baseline);
    assert_(!verdict.clean, 'verifyCleanTestState_ must NOT report clean while the shared cache is contaminated.');
    assert_(verdict.detail.indexOf('_configCache') !== -1 || verdict.detail.indexOf('cached Config') !== -1,
      'The isolation detail must name the Config cache. Got: ' + verdict.detail);
  } finally {
    restoreConfigCache_(outerBaseline);
  }
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

/**
 * Finding #6, superseded by the N3 final-round pre-claim architecture
 * (CASO A): a ledger write failure no longer needs COMPENSATION at all,
 * because the ledger barrier is now written BEFORE Gmail is touched. If
 * appendLedgerRow_ fails, the PREVIEW_CLAIMED barrier could not be
 * persisted, so GmailApp.createDraft() is never called and there is
 * nothing to compensate — a strictly stronger property than the original
 * "create then compensate" behavior this test used to assert.
 */
function test_finding6_ledgerFailureMeansNoDraftIsEverCreated_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('finding6'), Problem_Found: 'x' });
  validateAllRows();
  var p = getTestProspectByRow_(row);

  var originalAppendLedgerRow = appendLedgerRow_;
  var originalCreateDraft = GmailApp.createDraft;
  var createDraftCalls = 0;
  var draftCountBefore = GmailApp.getDrafts().length;
  GmailApp.createDraft = function (to, subject, body, opts) {
    createDraftCalls++;
    return originalCreateDraft(to, subject, body, opts);
  };
  appendLedgerRow_ = function () { throw new Error('Simulated ledger write failure for finding #6 test.'); };

  var outcome;
  try {
    outcome = previewStep(p.Prospect_ID, 1);
  } finally {
    appendLedgerRow_ = originalAppendLedgerRow;
    GmailApp.createDraft = originalCreateDraft;
  }

  assertEquals_('ERROR_PREVIEW_CLAIM_FAILED', outcome.status,
    'CASO A: if the durable PREVIEW_CLAIMED barrier cannot be persisted, previewStep must fail closed.');
  assertEquals_(0, createDraftCalls,
    'CASO A: GmailApp.createDraft() must NEVER be called when the pre-claim write failed — call count must be exactly 0.');
  assertEquals_(draftCountBefore, GmailApp.getDrafts().length, 'No draft must exist in Gmail at all.');
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
function withLiveModeEnabledForTest_(fn, extraOverrides) {
  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var rowByKey = {};
  for (var i = 0; i < values.length; i++) rowByKey[values[i][0]] = i + 2;

  var overrides = { DRY_RUN: 'FALSE', SEND_START_HOUR: '0', SEND_END_HOUR: '24', SEND_DAYS: 'MON,TUE,WED,THU,FRI,SAT,SUN' };
  // Optional per-test Config overrides (e.g. MAX_PER_RUN for batch tests).
  // Restored by the same finally block as everything else below.
  if (extraOverrides) {
    for (var k in extraOverrides) {
      if (extraOverrides.hasOwnProperty(k)) overrides[k] = extraOverrides[k];
    }
  }
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
  var priorMessageId = thread.getMessages()[0].getId();
  _testCreatedThreadIds_.push(thread.getId()); // P4: tracked for teardown.
  var past = new Date(); past.setDate(past.getDate() - 3);
  var row = addTestProspectRow_({
    Prospect_ID: Utilities.getUuid(), Email: email, Email_Normalized: emailNormalized,
    Domain: extractDomain_(emailNormalized), Domain_Type: DOMAIN_TYPE.CORPORATE,
    Problem_Found: 'x', Status: STATUS.IN_SEQUENCE, Sequence_Step: 1,
    Step1_Sent_At: past, Last_Contacted: past, Next_Action_Date: past,
    Thread_ID: thread.getId(), Last_Message_ID: priorMessageId
  });
  return { p: getTestProspectByRow_(row), thread: thread, priorMessageId: priorMessageId };
}

/**
 * N5 final coverage gap: proves that an internally inconsistent ledger
 * containing MORE THAN ONE blocking LIVE row for the exact same
 * Idempotency_Key still fails closed before any Gmail primitive is
 * invoked. `states` deliberately contains only states that
 * isLiveKeyBlocked_ treats as terminal/blocking.
 */
function n5_assertMultipleBlockingLiveRowsPreventSend_(emailTag, states) {
  withLiveModeEnabledForTest_(function () {
    var p = n5_setupReadyProspect_(emailTag);
    var key = getIdempotencyKey_(p.Prospect_ID, 1);

    states.forEach(function (state, index) {
      appendLedgerRow_({
        Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: p.Prospect_ID,
        Email_Normalized: p.Email_Normalized, Step: 1, Idempotency_Key: key,
        Mode: LEDGER_MODE.LIVE, State: state, Thread_ID: '', Message_ID: '', Draft_ID: '',
        Confirmed_At: state === LEDGER_STATE.SENT ? new Date() : '',
        Error: 'N5 duplicate-active fixture row ' + (index + 1)
      });
    });

    var ledgerSheet = getLedgerSheet_();
    var ledgerBefore = JSON.stringify(ledgerSheet.getRange(
      1, 1, ledgerSheet.getLastRow(), SEND_LEDGER_COLUMN_ORDER.length).getValues());
    var prospectBefore = findRowById_(p.Prospect_ID).values;
    var draftCountBefore = GmailApp.getDrafts().length;
    GmailApp._resetCallCounts();

    var outcome = sendStep1(p.Prospect_ID);

    assertEquals_('SKIPPED_ALREADY_CLAIMED', outcome.status,
      'Multiple blocking LIVE rows for one Idempotency_Key must fail closed.');
    assertEquals_(0, GmailApp._callCounts.createDraft,
      'No GmailApp.createDraft() call is allowed for a multiply-blocked LIVE key.');
    assertEquals_(0, GmailApp._callCounts.send,
      'No draft.send() call is allowed for a multiply-blocked LIVE key.');
    assertEquals_(0, GmailApp._callCounts.reply,
      'No thread.reply() call is allowed for a multiply-blocked LIVE key.');
    assertEquals_(draftCountBefore, GmailApp.getDrafts().length,
      'A blocked attempt must not create or remove a Gmail draft.');

    var ledgerAfter = JSON.stringify(ledgerSheet.getRange(
      1, 1, ledgerSheet.getLastRow(), SEND_LEDGER_COLUMN_ORDER.length).getValues());
    assertEquals_(ledgerBefore, ledgerAfter,
      'The blocked attempt must not append, repair, supersede, or otherwise mutate SendLedger.');

    var keyRows = readAllLedgerRows_().filter(function (r) {
      return r.values.Idempotency_Key === key && r.values.Mode === LEDGER_MODE.LIVE;
    });
    assertEquals_(states.length, keyRows.length,
      'No additional LIVE claim may be created for the multiply-blocked key.');
    assertEquals_(states.join('|'), keyRows.map(function (r) { return r.values.State; }).join('|'),
      'Every pre-existing blocking state must remain intact and in place.');

    var prospectAfter = findRowById_(p.Prospect_ID).values;
    assertEquals_(prospectBefore.Status, prospectAfter.Status,
      'The prospect must not advance or change Status when the ledger blocks the send.');
    assertEquals_(prospectBefore.Sequence_Step, prospectAfter.Sequence_Step,
      'Sequence_Step must not advance when the ledger blocks the send.');
    assertEquals_(prospectBefore.Step1_Sent_At, prospectAfter.Step1_Sent_At,
      'Step1_Sent_At must remain untouched when no send occurs.');
    assertEquals_(prospectBefore.Last_Contacted, prospectAfter.Last_Contacted,
      'Last_Contacted must remain untouched when no send occurs.');
    assertEquals_(prospectBefore.Thread_ID, prospectAfter.Thread_ID,
      'Thread_ID must remain untouched when no send occurs.');
    assertEquals_(prospectBefore.Last_Message_ID, prospectAfter.Last_Message_ID,
      'Last_Message_ID must remain untouched when no send occurs.');
  });
}

/** Exact blocker scenario: CLAIMED + AMBIGUOUS for one LIVE key. */
function test_N5_multipleLiveClaimedAndAmbiguousRowsBlockWithoutSend_() {
  n5_assertMultipleBlockingLiveRowsPreventSend_('n5dupeclaimedambiguous', [
    LEDGER_STATE.CLAIMED,
    LEDGER_STATE.AMBIGUOUS
  ]);
}

/** Second meaningful inconsistent variant: CLAIMED + SENT for one key. */
function test_N5_multipleLiveClaimedAndSentRowsBlockWithoutSend_() {
  n5_assertMultipleBlockingLiveRowsPreventSend_('n5dupeclaimedsent', [
    LEDGER_STATE.CLAIMED,
    LEDGER_STATE.SENT
  ]);
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
    GmailApp._resetCallCounts();

    var originalCreateDraft = GmailApp.createDraft;
    GmailApp.createDraft = function (to, subject, body, opts) {
      var draft = originalCreateDraft(to, subject, body, opts);
      draft.send = function () {
        GmailApp._callCounts.send++; // count the INVOCATION — the point is that Gmail was reached.
        throw new Error('Simulated Gmail send() failure — ambiguous outcome.');
      };
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
    assertEquals_(1, GmailApp._callCounts.send, 'Exactly one draft.send() call so far.');

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
    assertEquals_(1, GmailApp._callCounts.send,
      'P2-A: total draft.send() call count across BOTH executions must be EXACTLY 1, even though the Prospects write also failed.');
  });
}

/** N5 item 11: the normal, unedited confirmed path — exactly one real send. */
function test_N5_normalConfirmedStep1SendsExactlyOnce_() {
  withLiveModeEnabledForTest_(function () {
    var p = n5_setupReadyProspect_('n5step1normal');
    GmailApp._resetCallCounts();
    var outcome = sendStep1(p.Prospect_ID);
    assertEquals_('SENT', outcome.status, 'A normal step-1 send must succeed.');
    assertEquals_(1, GmailApp._callCounts.send, 'P2-D: a normal confirmed step-1 must call draft.send() EXACTLY once.');

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
 * N6 (post-LIVE incident, 2026-09-08 — Acme Plumbing LLC, Prospect_ID
 * 2f4d0c6c-ccd7-420b-8dd3-22c915a792f4): reproduces the exact failure —
 * Gmail send CONFIRMED, ledger reaches SENT, and the Prospects write
 * throws. Two variants: the minimal NEEDS_REVIEW fallback write succeeds
 * (this test), or it ALSO fails, an exact reproduction of the real
 * incident (the next test below). Both must show: the ledger is the
 * durable, authoritative record; the same idempotency key stays blocked;
 * exactly one real Gmail send ever happens, even across a retry; and the
 * failure is observable in the log — never silently indistinguishable
 * from "not sent yet".
 */
function test_N6_postSendPersistenceFailureFallbackSucceeds_() {
  withLiveModeEnabledForTest_(function () {
    var p = n5_setupReadyProspect_('n6persistfallback');
    var prospectBefore = findRowById_(p.Prospect_ID).values;
    assertEquals_(STATUS.READY, prospectBefore.Status, 'Precondition: a freshly-validated prospect must start READY.');

    GmailApp._resetCallCounts();
    var originalWriteRowById = writeRowById_;
    var fullWriteAttempts = 0;
    writeRowById_ = function (prospectId, fields, options) {
      if (fields.hasOwnProperty('Sequence_Step')) {
        // The full post-send field set — this is the exact write that
        // failed in the real incident.
        fullWriteAttempts++;
        throw new Error('N6 simulated: Prospects write failed (e.g. transient Sheets API error).');
      }
      return originalWriteRowById(prospectId, fields, options); // The minimal NEEDS_REVIEW fallback — allowed through.
    };

    var outcome;
    try {
      outcome = sendStep1(p.Prospect_ID);
    } finally {
      writeRowById_ = originalWriteRowById;
    }

    assertEquals_(1, fullWriteAttempts, 'The full post-send write must have been attempted exactly once.');
    assertEquals_('SENT_PERSISTENCE_FAILED', outcome.status,
      'A CONFIRMED Gmail send whose Prospects write fails must be reported distinctly from a normal SENT.');
    assert_(!!outcome.threadId && !!outcome.messageId, 'The confirmed Thread_ID/Message_ID must be reported back to the caller for reconciliation.');

    // The ledger is the durable, authoritative record — Gmail send + SENT
    // confirmation are NOT contingent on Prospects persistence succeeding.
    var ledgerRows = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.LIVE;
    });
    assertEquals_(1, ledgerRows.length, 'Exactly one LIVE ledger row must exist.');
    assertEquals_(LEDGER_STATE.SENT, ledgerRows[0].values.State, 'The ledger row must be durably SENT — this is the authoritative record of a real send.');
    assert_(!!ledgerRows[0].values.Thread_ID && !!ledgerRows[0].values.Message_ID, 'Thread_ID/Message_ID must be recorded in the ledger regardless of the Prospects failure.');

    // The minimal fallback got through: Status flips to NEEDS_REVIEW (a
    // human will notice), but nothing else — this is NOT a substitute for
    // full reconciliation, only a visibility signal.
    var prospectAfter = findRowById_(p.Prospect_ID).values;
    assertEquals_(STATUS.NEEDS_REVIEW, prospectAfter.Status, 'The minimal fallback write must flip Status to NEEDS_REVIEW so a human notices.');
    assertEquals_(prospectBefore.Sequence_Step, prospectAfter.Sequence_Step, 'The fallback write must NOT fabricate Sequence_Step — only full reconciliation from the ledger may.');
    assertEquals_(prospectBefore.Step1_Sent_At, prospectAfter.Step1_Sent_At, 'The fallback write must NOT fabricate Step1_Sent_At.');
    assertEquals_(prospectBefore.Thread_ID, prospectAfter.Thread_ID, 'The fallback write must NOT fabricate Thread_ID — the ledger, not a guess, is authoritative for that.');

    assertEquals_(1, GmailApp._callCounts.send, 'Exactly one real Gmail send must have occurred.');

    var loggedFailure = _logBuffer.some(function (row) {
      return row[5] === p.Prospect_ID && String(row[8]).indexOf('POST_SEND_PERSISTENCE_FAILURE') !== -1;
    });
    assert_(loggedFailure, 'The persistence failure must be observable in the log, not silently swallowed.');

    // The ledger-level guard must independently hold regardless of which
    // Prospects state resulted from the fallback.
    assert_(isLiveKeyBlocked_(p.Prospect_ID, 1), 'The ledger-level block must hold independent of Prospects state.');

    // Retry: NEEDS_REVIEW status means canSend_'s own eligibility check
    // now short-circuits BEFORE the ledger check ever runs (a second,
    // independent reason the key can't resend) — either SKIPPED reason is
    // an acceptable exit as long as nothing was actually sent again.
    var draftCountBefore = GmailApp.getDrafts().length;
    var second = sendStep1(p.Prospect_ID);
    assert_(second.status === 'SKIPPED_ALREADY_CLAIMED' || second.status === 'SKIPPED_NOT_ELIGIBLE',
      'A retry must be blocked one way or another, not resend. Got: ' + second.status);
    assertEquals_(draftCountBefore, GmailApp.getDrafts().length, 'A blocked retry must not create any new draft.');
    assertEquals_(1, GmailApp._callCounts.send, 'Total real Gmail sends across the original attempt AND the retry must be EXACTLY 1.');
  });
}

/**
 * N6: exact reproduction of the real incident — BOTH the full write and
 * the minimal fallback write fail (total Prospects persistence outage).
 * Prospects must show ZERO change from its pre-send state — exactly what
 * was observed on 2026-09-08 (Status=READY, Sequence_Step/Step1_Sent_At/
 * Last_Contacted/Next_Action_Date all blank) — while the ledger alone
 * still proves the send happened and still blocks any retry.
 */
function test_N6_postSendPersistenceFailureFallbackAlsoFailsExactIncidentReproduction_() {
  withLiveModeEnabledForTest_(function () {
    var p = n5_setupReadyProspect_('n6persistdouble');
    var prospectBefore = findRowById_(p.Prospect_ID).values;

    GmailApp._resetCallCounts();
    var originalWriteRowById = writeRowById_;
    var writeAttempts = 0;
    writeRowById_ = function () {
      writeAttempts++;
      throw new Error('N6 simulated: total Prospects persistence outage (full write AND fallback both fail).');
    };

    var outcome;
    try {
      outcome = sendStep1(p.Prospect_ID);
    } finally {
      writeRowById_ = originalWriteRowById;
    }

    assertEquals_(2, writeAttempts, 'Both the full write and the minimal fallback write must have been attempted.');
    assertEquals_('SENT_PERSISTENCE_FAILED', outcome.status);

    var ledgerRows = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.LIVE;
    });
    assertEquals_(1, ledgerRows.length);
    assertEquals_(LEDGER_STATE.SENT, ledgerRows[0].values.State,
      'EXACT incident reproduction: the ledger reaches SENT even though Prospects persistence totally failed.');

    // EXACT incident reproduction: Prospects shows NO change whatsoever —
    // indistinguishable from "never sent" if the ledger were not consulted.
    var prospectAfter = findRowById_(p.Prospect_ID).values;
    assertEquals_(prospectBefore.Status, prospectAfter.Status, 'EXACT incident symptom: Status must remain unchanged (READY) when persistence totally fails.');
    assertEquals_(prospectBefore.Sequence_Step, prospectAfter.Sequence_Step, 'EXACT incident symptom: Sequence_Step must remain unchanged.');
    assertEquals_(prospectBefore.Step1_Sent_At, prospectAfter.Step1_Sent_At, 'EXACT incident symptom: Step1_Sent_At must remain unchanged.');
    assertEquals_(prospectBefore.Last_Contacted, prospectAfter.Last_Contacted, 'EXACT incident symptom: Last_Contacted must remain unchanged.');
    assertEquals_(prospectBefore.Thread_ID, prospectAfter.Thread_ID, 'EXACT incident symptom: Thread_ID must remain unchanged.');
    assertEquals_(prospectBefore.Next_Action_Date, prospectAfter.Next_Action_Date, 'EXACT incident symptom: Next_Action_Date must remain unchanged.');

    // The failure must still be fully traceable from the log even though
    // Prospects shows nothing — this is what makes reconciliation possible
    // without ever reopening the send key.
    var sawPrimaryFailure = false, sawFallbackFailure = false;
    _logBuffer.forEach(function (row) {
      if (row[5] !== p.Prospect_ID) return;
      var detail = String(row[8]);
      if (detail.indexOf('POST_SEND_PERSISTENCE_FAILURE') !== -1 && detail.indexOf('Attempting a minimal fallback') !== -1) sawPrimaryFailure = true;
      if (detail.indexOf('fallback write ALSO failed') !== -1) sawFallbackFailure = true;
    });
    assert_(sawPrimaryFailure, 'The primary persistence failure must be logged with enough detail to reconcile from SendLedger.');
    assert_(sawFallbackFailure, 'The fallback failure must ALSO be logged — this is the worst case and must be the loudest.');

    // N5 cross-check (explicitly required): the durable ledger-level
    // block must hold regardless of Prospects being completely untouched.
    assert_(isLiveKeyBlocked_(p.Prospect_ID, 1),
      'N5 guarantee must still hold here: isLiveKeyBlocked_ blocks on the ledger SENT state alone, independent of Prospects.');

    var draftCountBefore = GmailApp.getDrafts().length;
    var second = sendStep1(p.Prospect_ID);
    assertEquals_('SKIPPED_ALREADY_CLAIMED', second.status,
      'A retry must be blocked at the ledger level even when Prospects looks exactly like a never-sent prospect.');
    assertEquals_(draftCountBefore, GmailApp.getDrafts().length);
    assertEquals_(1, GmailApp._callCounts.send,
      'CRITICAL: total real Gmail sends must be EXACTLY 1 — a total Prospects persistence outage must never cause a duplicate LIVE email.');
  });
}

/**
 * N6 BATCH (independent adversarial review of 4a0f8fd): the single-prospect
 * tests above prove doStep1Send_ handles its own persistence failure. They
 * say NOTHING about what sendBatch does NEXT.
 *
 * The forbidden sequence this test exists to make impossible:
 *   A Gmail sent -> A ledger SENT -> A Prospects persistence fails
 *   -> sendBatch continues -> B Gmail sent
 *
 * A post-send persistence failure means the mechanism that RECORDS sends is
 * broken. Continuing the batch compounds unrecorded real emails, one per
 * remaining candidate. It must be a HARD STOP for the whole batch.
 *
 * Deliberately ordering-independent: whichever prospect the queue happens to
 * process first becomes the "victim"; the other must be provably untouched.
 * The victim's fallback write is ALSO made to fail, because the batch stop
 * must NOT depend on the best-effort fallback succeeding.
 */
function test_N6_batchHardStopsAfterPostSendPersistenceFailure_() {
  withLiveModeEnabledForTest_(function () {
    var a = n5_setupReadyProspect_('n6batcha');
    var b = n5_setupReadyProspect_('n6batchb');
    var ids = [a.Prospect_ID, b.Prospect_ID];

    GmailApp._resetCallCounts();
    // Confine the batch to exactly these two prospects. Without this the
    // batch would also pick up any other eligible row in the sandbox, making
    // the test depend on queue ordering, MAX_PER_RUN and the daily budget —
    // and orderQueue_ sorts a blank Date_Added to the epoch, so leftover
    // fixtures (present whenever cleanup is deliberately disabled by
    // verify-isolation-enforcement.js) would always sort ahead of these two.
    var originalIsEligible = isEligibleForNextStep_;
    isEligibleForNextStep_ = function (prospectValues, config, now) {
      if (ids.indexOf(prospectValues.Prospect_ID) === -1) return false;
      return originalIsEligible(prospectValues, config, now);
    };

    var originalWriteRowById = writeRowById_;
    var victimId = null;
    var sendsAtVictimFailure = null;
    writeRowById_ = function (prospectId, fields, options) {
      if (victimId === null && fields.hasOwnProperty('Sequence_Step') && ids.indexOf(prospectId) !== -1) {
        victimId = prospectId; // First prospect to reach its post-send write.
        // Snapshot the send counter at the exact moment of the failure. The
        // assertion below is a DELTA from here, which makes this test immune
        // to any unrelated prospect the queue may have processed earlier
        // (e.g. leftover fixtures when cleanup is deliberately disabled by
        // verify-isolation-enforcement.js).
        sendsAtVictimFailure = GmailApp._callCounts.send;
      }
      if (prospectId === victimId) {
        // Both the full write AND the NEEDS_REVIEW fallback fail — the
        // batch stop must hold without any fallback assistance.
        throw new Error('N6 simulated: Prospects persistence outage during a batch.');
      }
      return originalWriteRowById(prospectId, fields, options);
    };

    try {
      sendBatch();
    } finally {
      writeRowById_ = originalWriteRowById;
      isEligibleForNextStep_ = originalIsEligible;
    }

    assert_(victimId !== null, 'Precondition: the batch must have actually attempted a post-send write for one of the two prospects.');
    var otherId = ids[0] === victimId ? ids[1] : ids[0];

    // THE core assertion: ZERO further Gmail sends after the persistence
    // failure. Expressed as a delta from the moment of failure, so it proves
    // exactly the property under test regardless of what preceded it.
    assertEquals_(sendsAtVictimFailure, GmailApp._callCounts.send,
      'CRITICAL: after a post-send persistence failure the batch MUST hard-stop — not one further Gmail send is allowed.');

    // The victim: real send, durable ledger SENT, still blocked.
    var victimLedger = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === victimId && r.values.Mode === LEDGER_MODE.LIVE;
    });
    assertEquals_(1, victimLedger.length, 'The victim must have exactly one LIVE ledger row.');
    assertEquals_(LEDGER_STATE.SENT, victimLedger[0].values.State, 'The victim ledger row must be durably SENT.');
    assert_(isLiveKeyBlocked_(victimId, 1), 'The victim key must remain blocked against any duplicate send.');
    // The DURABLE marker: the Log sheet is trimmed by trimLog_, so the
    // authoritative ledger row itself must carry the incident permanently.
    assert_(String(victimLedger[0].values.Error).indexOf('POST_SEND_PERSISTENCE_FAILURE') !== -1,
      'The ledger row must permanently record the persistence failure in its Error column. Got: ' + victimLedger[0].values.Error);

    // The other prospect: provably untouched at EVERY layer.
    var otherLedger = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === otherId && r.values.Mode === LEDGER_MODE.LIVE;
    });
    assertEquals_(0, otherLedger.length,
      'The second prospect must have NO LIVE ledger row at all — the batch must stop before it is even claimed.');
    var otherAfter = findRowById_(otherId).values;
    assertEquals_(STATUS.READY, otherAfter.Status, 'The second prospect must remain READY, completely untouched.');
    assertEquals_('', otherAfter.Thread_ID, 'The second prospect must have no Thread_ID.');
    assertEquals_('', otherAfter.Step1_Sent_At, 'The second prospect must have no Step1_Sent_At.');

    // The abort must be explicitly observable, not inferred from absence.
    // Read the Log SHEET, not _logBuffer: sendBatch() ends with flushLog_(),
    // which empties the buffer into the sheet.
    var logSheet = getSheet_(SHEET_NAMES.LOG);
    var loggedAbort = false;
    if (logSheet.getLastRow() >= 2) {
      logSheet.getRange(2, LOG_COLUMNS.Detail, logSheet.getLastRow() - 1, 1).getValues().forEach(function (row) {
        if (String(row[0]).indexOf('BATCH ABORTED') !== -1) loggedAbort = true;
      });
    }
    assert_(loggedAbort, 'The batch abort must be explicitly logged, not silent.');
  }, { MAX_PER_RUN: '2', MAX_PER_DAY: '5' });
}

/**
 * N6 BATCH: the hard stop must NOT fire on an ordinary skip. A batch where
 * the first candidate is simply ineligible must still process the rest —
 * otherwise the stop would silently throttle normal operation to one
 * prospect per run.
 */
function test_N6_batchDoesNotStopOnOrdinaryOutcomes_() {
  withLiveModeEnabledForTest_(function () {
    var a = n5_setupReadyProspect_('n6batchnorma');
    var b = n5_setupReadyProspect_('n6batchnormb');
    var ids = [a.Prospect_ID, b.Prospect_ID];
    GmailApp._resetCallCounts();

    // Confine the batch to these two — see the sibling test's comment.
    var originalIsEligible = isEligibleForNextStep_;
    isEligibleForNextStep_ = function (prospectValues, config, now) {
      if (ids.indexOf(prospectValues.Prospect_ID) === -1) return false;
      return originalIsEligible(prospectValues, config, now);
    };
    try {
      sendBatch();
    } finally {
      isEligibleForNextStep_ = originalIsEligible;
    }

    // Asserted per-prospect (not on a global counter) so the test is immune
    // to unrelated eligible rows — see the sibling test's comment.
    [a.Prospect_ID, b.Prospect_ID].forEach(function (id) {
      var after = findRowById_(id).values;
      assertEquals_(STATUS.IN_SEQUENCE, after.Status,
        'BOTH prospects must advance normally — the hard stop must not fire on ordinary outcomes.');
      var rows = readAllLedgerRows_().filter(function (r) {
        return r.values.Prospect_ID === id && r.values.Mode === LEDGER_MODE.LIVE;
      });
      assertEquals_(1, rows.length, 'Each prospect must have exactly one LIVE ledger row.');
      assertEquals_(LEDGER_STATE.SENT, rows[0].values.State, 'Each prospect must be durably SENT.');
      assertEquals_('', String(rows[0].values.Error), 'A healthy send must leave no error marker on the ledger row.');
    });
  }, { MAX_PER_RUN: '2', MAX_PER_DAY: '5' });
}

/**
 * N8 (controlled-fixture LIVE targeting): sendControlledFixtureLive
 * (Mailer.gs) — exact-target LIVE for ONE explicitly controlled test
 * fixture, never a real prospect, delegating unchanged to sendStep1 once
 * its own pre-Gmail guards pass. Tests A-U below (task's own lettering).
 *
 * IMPORTANT FIXTURE-ISOLATION NOTE: cleanupTestRows_ sweeps Prospects rows
 * by Source===TEST_SOURCE_MARKER — a controlled-fixture-Source row would
 * NOT be swept by that mechanism (correctly: production cleanup must never
 * accidentally match a real controlled-fixture Source). So every test
 * below creates its own row directly with addTestProspectRow_ and deletes
 * it explicitly in a finally block via n8_deleteFixtureRow_ — never
 * relying on the normal per-test sweep for this specific Source value.
 */
function n8_setupControlledFixture_(emailTag, overrides) {
  var merged = Object.assign({
    Source: CONTROLLED_FIXTURE_SOURCES[0], Email: testUniqueEmail_(emailTag), Problem_Found: 'x'
  }, overrides || {});
  var row = addTestProspectRow_(merged);
  validateAllRows();
  return getTestProspectByRow_(row);
}

/** Explicit, index-independent cleanup — re-finds by Prospect_ID, never a stale row index. */
function n8_deleteFixtureRow_(prospectId) {
  var found = findRowById_(prospectId);
  if (found) getSheet_(SHEET_NAMES.PROSPECTS).deleteRow(found.rowIndex);
}

/** Test A + Q: the accept path reaches the real primitive and performs a normal, complete LIVE send. */
function test_N8_approvedControlledFixtureReachesRealPrimitiveAndSendsNormally_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8accept');
    try {
      GmailApp._resetCallCounts();
      var beforeLedgerRows = readAllLedgerRows_().length;

      var result = sendControlledFixtureLive(p.Prospect_ID);

      assertEquals_('SENT', result.status, 'An approved controlled fixture, fully eligible, must reach a normal SENT.');
      assertEquals_(1, GmailApp._callCounts.send, 'Exactly one real Gmail send must occur.');

      var ledgerRows = readAllLedgerRows_().filter(function (r) {
        return r.values.Prospect_ID === p.Prospect_ID && r.values.Mode === LEDGER_MODE.LIVE;
      });
      assertEquals_(1, ledgerRows.length, 'Exactly one LIVE ledger row — the SAME row transitions CLAIMED -> SENT, never two rows.');
      assertEquals_(LEDGER_STATE.SENT, ledgerRows[0].values.State, 'The ledger row must be durably SENT — the same production ledger primitive, unchanged.');
      assertEquals_(beforeLedgerRows + 1, readAllLedgerRows_().length, 'Exactly one new ledger row total (the CLAIMED->SENT transition, not two appends).');

      var after = findRowById_(p.Prospect_ID).values;
      assertEquals_(STATUS.IN_SEQUENCE, after.Status, 'Normal Prospects persistence must occur — same as any other LIVE send.');
      assertEquals_(1, Number(after.Sequence_Step));
      assert_(!!after.Thread_ID && !!after.Last_Message_ID, 'Thread_ID/Last_Message_ID must be recorded normally.');
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test B: a normal real prospect (default test Source) must be refused before any Gmail call. */
function test_N8_normalRealProspectRejectedBeforeGmail_() {
  withLiveModeEnabledForTest_(function () {
    var p = n5_setupReadyProspect_('n8realprospect'); // default Source = TEST_SOURCE_MARKER, i.e. NOT controlled.
    GmailApp._resetCallCounts();

    var result = sendControlledFixtureLive(p.Prospect_ID);

    assertEquals_('REJECTED_SOURCE_NOT_CONTROLLED', result.status, 'A real prospect must be refused on the Source allowlist alone.');
    assertEquals_(0, GmailApp._callCounts.createDraft, 'No Gmail call of any kind may occur.');
    assertEquals_(0, GmailApp._callCounts.send, 'No Gmail call of any kind may occur.');
    assertEquals_(0, readAllLedgerRows_().filter(function (r) { return r.values.Prospect_ID === p.Prospect_ID; }).length,
      'No ledger row — not even a claim — may be written for a rejected real prospect.');
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test C: a similarly-named but NOT-exactly-allowlisted controlled source must also be refused. */
function test_N8_similarButNotAllowlistedSourceRejected_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8wrongsource', { Source: 'CONTROLLED_INTERNAL_STEP2_RETEST_V2' });
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(p.Prospect_ID);
      assertEquals_('REJECTED_SOURCE_NOT_CONTROLLED', result.status, 'The allowlist match must be exact, not a prefix/substring match.');
      assertEquals_(0, GmailApp._callCounts.send);
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test D: Stop_Contact rejected before Gmail. */
function test_N8_stopContactFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8stop', { Stop_Contact: true });
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(p.Prospect_ID);
      assertEquals_('REJECTED_STOP_CONTACT', result.status);
      assertEquals_(0, GmailApp._callCounts.send);
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test E: Do_Not_Contact_Reason rejected before Gmail. */
function test_N8_dncFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8dnc', { Do_Not_Contact_Reason: DNC_REASON.MANUAL });
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(p.Prospect_ID);
      assertEquals_('REJECTED_DNC', result.status);
      assertEquals_(0, GmailApp._callCounts.send);
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test F: Replied=TRUE rejected before Gmail. */
function test_N8_repliedFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8replied', { Replied: true });
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(p.Prospect_ID);
      assertEquals_('REJECTED_REPLIED', result.status);
      assertEquals_(0, GmailApp._callCounts.send);
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test G: a suppressed email is rejected before Gmail — real addSuppression_, not a stub. */
function test_N8_suppressedFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8suppressed');
    addSuppression_(p.Email_Normalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.MANUAL, 'test');
    _testCreatedSuppressionValues.push(p.Email_Normalized);
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(p.Prospect_ID);
      assertEquals_('REJECTED_SUPPRESSED', result.status);
      assertEquals_(0, GmailApp._callCounts.send);
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test H: malformed email rejected before Gmail. */
function test_N8_malformedEmailFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var row = addTestProspectRow_({
      Source: CONTROLLED_FIXTURE_SOURCES[0], Email: 'not-an-email', Problem_Found: 'x'
    });
    validateAllRows(); // A malformed email classifies as INVALID_EMAIL, not READY — proves the guard fires regardless.
    var p = getTestProspectByRow_(row);
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(p.Prospect_ID);
      assert_(result.status === 'REJECTED_INVALID_EMAIL' || result.status === 'REJECTED_NOT_READY',
        'A malformed email must be refused — either directly (REJECTED_INVALID_EMAIL) or because validateAllRows never let it reach READY (REJECTED_NOT_READY). Got: ' + result.status);
      assertEquals_(0, GmailApp._callCounts.send);
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test I: Email/Email_Normalized inconsistency rejected before Gmail — simulates a corrupted row bypassing validateAllRows. */
function test_N8_emailNormalizationMismatchFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8mismatch');
    try {
      // Corrupt Email_Normalized directly on the sheet — validateAllRows
      // would never produce this; the guard must catch it anyway (defense
      // in depth against a corrupted/hand-edited row).
      setRawCellForTest_(findRowById_(p.Prospect_ID).rowIndex, 'Email_Normalized', 'someone-else@example.com');
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(p.Prospect_ID);
      assertEquals_('REJECTED_EMAIL_NORMALIZATION_MISMATCH', result.status);
      assertEquals_(0, GmailApp._callCounts.send);
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test J: an existing LIVE CLAIMED row blocks — delegated unchanged to isLiveKeyBlocked_ via sendStep1. */
function test_N8_existingLiveClaimedRowBlocksFixture_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8claimed');
    try {
      appendLedgerRow_({
        Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: p.Prospect_ID, Email_Normalized: p.Email_Normalized,
        Step: 1, Idempotency_Key: getIdempotencyKey_(p.Prospect_ID, 1), Mode: LEDGER_MODE.LIVE, State: LEDGER_STATE.CLAIMED,
        Thread_ID: '', Message_ID: '', Draft_ID: '', Confirmed_At: '', Error: ''
      });
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(p.Prospect_ID);
      assertEquals_('SKIPPED_ALREADY_CLAIMED', result.status, 'A pre-existing CLAIMED row must block via the SAME isLiveKeyBlocked_ sendStep1 already uses.');
      assertEquals_(0, GmailApp._callCounts.send);
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test K: an existing LIVE SENT row blocks — same mechanism. */
function test_N8_existingLiveSentRowBlocksFixture_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8sent');
    try {
      appendLedgerRow_({
        Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: p.Prospect_ID, Email_Normalized: p.Email_Normalized,
        Step: 1, Idempotency_Key: getIdempotencyKey_(p.Prospect_ID, 1), Mode: LEDGER_MODE.LIVE, State: LEDGER_STATE.SENT,
        Thread_ID: 'preexisting-thread', Message_ID: 'preexisting-msg', Draft_ID: '', Confirmed_At: new Date(), Error: ''
      });
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(p.Prospect_ID);
      assertEquals_('SKIPPED_ALREADY_CLAIMED', result.status, 'A pre-existing SENT row must ALSO block — never a second send for the same key.');
      assertEquals_(0, GmailApp._callCounts.send);
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test L: an existing LIVE AMBIGUOUS row blocks — same mechanism. */
function test_N8_existingLiveAmbiguousRowBlocksFixture_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8ambiguous');
    try {
      appendLedgerRow_({
        Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: p.Prospect_ID, Email_Normalized: p.Email_Normalized,
        Step: 1, Idempotency_Key: getIdempotencyKey_(p.Prospect_ID, 1), Mode: LEDGER_MODE.LIVE, State: LEDGER_STATE.AMBIGUOUS,
        Thread_ID: '', Message_ID: '', Draft_ID: '', Confirmed_At: '', Error: 'pre-existing ambiguous outcome'
      });
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(p.Prospect_ID);
      assertEquals_('SKIPPED_ALREADY_CLAIMED', result.status, 'An unresolved AMBIGUOUS row must block, never auto-retried.');
      assertEquals_(0, GmailApp._callCounts.send);
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test M: Config not armed (DRY_RUN=TRUE) — the SAME performLiveSend_ throw sendStep1 itself produces, unmodified. */
function test_N8_configNotArmedFixtureRejected_() {
  // Deliberately NOT withLiveModeEnabledForTest_ (which sets DRY_RUN=FALSE)
  // — this test needs DRY_RUN=TRUE, the real safe default, to reach
  // performLiveSend_'s own guard. Only MAX_PER_RUN is set to 1 (this
  // mechanism's own guard 15 would otherwise fire first and mask what
  // this test is actually proving).
  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var maxPerRunRow = null;
  for (var i = 0; i < values.length; i++) { if (values[i][0] === 'MAX_PER_RUN') maxPerRunRow = i + 2; }
  if (!maxPerRunRow) throw new Error('MAX_PER_RUN not found in Config.');
  var originalMaxPerRun = sheet.getRange(maxPerRunRow, 2).getValue();

  var p = n8_setupControlledFixture_('n8notarmed');
  try {
    sheet.getRange(maxPerRunRow, 2).setValue('1');
    resetConfigCache_();
    assertEquals_(true, getConfig().DRY_RUN, 'Precondition: DRY_RUN must genuinely still be TRUE for this test.');

    GmailApp._resetCallCounts();
    var threw = false;
    try {
      sendControlledFixtureLive(p.Prospect_ID);
    } catch (e) {
      threw = true;
      assert_(String(e).indexOf('DRY_RUN') !== -1, 'The propagated error must be performLiveSend_\'s own DRY_RUN guard, unmodified.');
    }
    assert_(threw, 'With DRY_RUN=TRUE, sendControlledFixtureLive must throw — exactly like sendStep1 would — never silently no-op or send.');
    assertEquals_(0, GmailApp._callCounts.send);
  } finally {
    n8_deleteFixtureRow_(p.Prospect_ID);
    sheet.getRange(maxPerRunRow, 2).setValue(originalMaxPerRun);
    resetConfigCache_();
  }
}

/** Test N: outside the configured send window — delegated unchanged to isWithinSendWindow_ via sendStep1. */
function test_N8_outsideSendWindowFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8window');
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(p.Prospect_ID);
      assertEquals_('SKIPPED_OUTSIDE_WINDOW', result.status);
      assertEquals_(0, GmailApp._callCounts.send);
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
    // SEND_START_HOUR=SEND_END_HOUR closes the window entirely regardless of real time-of-day.
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5', SEND_START_HOUR: '9', SEND_END_HOUR: '9' });
}

/** Test O: daily quota exhausted — delegated unchanged to computeLiveSendBudget_ via sendStep1. */
function test_N8_dailyQuotaExhaustedFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8quota');
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(p.Prospect_ID);
      assertEquals_('QUOTA_ABORT', result.status);
      assertEquals_(0, GmailApp._callCounts.send);
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '0' }); // Zero remaining budget today.
}

/** Test P: MAX_PER_RUN != 1 refuses this mechanism outright — never delegates. */
function test_N8_maxPerRunNotOneFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8maxperrun');
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(p.Prospect_ID);
      assertEquals_('REJECTED_MAX_PER_RUN_NOT_ONE', result.status,
        'This mechanism is for single-target use only — it must refuse to run at all while MAX_PER_RUN != 1.');
      assertEquals_(0, GmailApp._callCounts.send);
      assertEquals_(0, readAllLedgerRows_().filter(function (r) { return r.values.Prospect_ID === p.Prospect_ID; }).length,
        'No claim of any kind — the guard fires before sendStep1 is ever called.');
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '2', MAX_PER_DAY: '5' });
}

/** Test R: post-send persistence failure retains EXACT N6 semantics through this new entry point. */
function test_N8_postSendPersistenceFailureRetainsN6SemanticsViaFixturePath_() {
  withLiveModeEnabledForTest_(function () {
    var p = n8_setupControlledFixture_('n8n6semantics');
    try {
      GmailApp._resetCallCounts();
      var originalWriteRowById = writeRowById_;
      writeRowById_ = function () { throw new Error('N8 simulated: total Prospects persistence outage.'); };

      var result;
      try {
        result = sendControlledFixtureLive(p.Prospect_ID);
      } finally {
        writeRowById_ = originalWriteRowById;
      }

      assertEquals_('SENT_PERSISTENCE_FAILED', result.status, 'N6 semantics must be identical through this entry point — no divergent behavior introduced.');
      var ledgerRows = readAllLedgerRows_().filter(function (r) { return r.values.Prospect_ID === p.Prospect_ID && r.values.Mode === LEDGER_MODE.LIVE; });
      assertEquals_(1, ledgerRows.length);
      assertEquals_(LEDGER_STATE.SENT, ledgerRows[0].values.State, 'Ledger must still reach durable SENT.');
      assert_(String(ledgerRows[0].values.Error).indexOf('POST_SEND_PERSISTENCE_FAILURE') !== -1,
        'The durable N6 ledger marker must still be stamped.');
      assert_(isLiveKeyBlocked_(p.Prospect_ID, 1), 'The key must still be durably blocked.');

      var retry = sendControlledFixtureLive(p.Prospect_ID);
      assert_(retry.status === 'SKIPPED_ALREADY_CLAIMED' || retry.status === 'REJECTED_NOT_READY' || retry.status === 'SKIPPED_NOT_ELIGIBLE',
        'A retry through this same entry point must not resend. Got: ' + retry.status);
      assertEquals_(1, GmailApp._callCounts.send, 'Total real Gmail sends, including the retry attempt, must be EXACTLY 1.');
    } finally {
      n8_deleteFixtureRow_(p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test S: the fixture path never reads or touches the normal queue — unrelated real prospects are provably untouched. */
function test_N8_fixturePathDoesNotDisturbNormalQueueOrdering_() {
  withLiveModeEnabledForTest_(function () {
    var real1 = n5_setupReadyProspect_('n8queuereal1');
    var real2 = n5_setupReadyProspect_('n8queuereal2');
    var fixture = n8_setupControlledFixture_('n8queuefixture');
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureLive(fixture.Prospect_ID);
      assertEquals_('SENT', result.status);
      assertEquals_(1, GmailApp._callCounts.send, 'Only the fixture may be sent — never a real prospect, regardless of queue position.');

      [real1.Prospect_ID, real2.Prospect_ID].forEach(function (id) {
        var after = findRowById_(id).values;
        assertEquals_(STATUS.READY, after.Status, 'Real prospects must remain untouched — Status unchanged.');
        assertEquals_('', String(after.Sequence_Step || ''), 'Real prospects must remain untouched — Sequence_Step unchanged.');
        assertEquals_(0, readAllLedgerRows_().filter(function (r) { return r.values.Prospect_ID === id; }).length,
          'Real prospects must have NO ledger row — not even claimed — the fixture path never enumerates the queue.');
      });
    } finally {
      n8_deleteFixtureRow_(fixture.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/**
 * Tests T and U (task's own lettering) are deliberately NOT new tests:
 * T — "Step-1 normal production behavior remains unchanged" is exactly
 *     what test_N5_normalConfirmedStep1SendsExactlyOnce_ already proves,
 *     calling sendStep1 directly (never through sendControlledFixtureLive).
 * U — "corrected Step-2 Gmail API behavior [Codex finding #7] remains
 *     unchanged" is exactly what the existing N5 follow-up tests
 *     (test_N5_normalConfirmedFollowUpRepliesExactlyOnce_ etc.) already
 *     prove — this change never touches doFollowUpSend_.
 * Both are re-confirmed simply by the full existing suite staying green
 * alongside these new tests (see the full regression results). Adding
 * duplicate tests here would test nothing this change could have broken.
 */

/**
 * N9 (controlled-fixture Step-2 due override): makeControlledFixtureDueNow
 * (StateMachine.gs) — makes ONE controlled fixture due for Step 2
 * immediately, changing ONLY Next_Action_Date, never bypassing canSend_,
 * idempotency, or any eligibility check.
 */

/** Builds an IN_SEQUENCE/step-1-done controlled fixture, Next_Action_Date deliberately in the FUTURE. */
function n9_setupControlledStep2Fixture_(emailTag, overrides) {
  var email = testUniqueEmail_(emailTag);
  var emailNormalized = normalizeEmail_(email);
  var thread = GmailApp._seedLiveThread(email, 'outreach-test@example.com');
  _testCreatedThreadIds_.push(thread.getId());
  var future = new Date(); future.setDate(future.getDate() + 7); // NOT due — this is what the override must change.
  var pastSent = new Date(); pastSent.setDate(pastSent.getDate() - 3);
  var base = {
    Prospect_ID: Utilities.getUuid(), Source: CONTROLLED_FIXTURE_SOURCES[0],
    Email: email, Email_Normalized: emailNormalized,
    Domain: extractDomain_(emailNormalized), Domain_Type: DOMAIN_TYPE.CORPORATE,
    Problem_Found: 'x', Status: STATUS.IN_SEQUENCE, Sequence_Step: 1,
    Step1_Sent_At: pastSent, Last_Contacted: pastSent, Next_Action_Date: future,
    Thread_ID: thread.getId(), Last_Message_ID: thread.getMessages()[0].getId()
  };
  var merged = Object.assign({}, base, overrides || {});
  var row = addTestProspectRow_(merged);
  return { p: getTestProspectByRow_(row), thread: thread };
}

/** Test 1: approved controlled fixture succeeds; the ordinary canSend_ path picks it up afterward — never bypassed. */
function test_N9_approvedFixtureSucceedsAndBecomesEligibleViaCanSend_() {
  var setup = n9_setupControlledStep2Fixture_('n9accept');
  try {
    var config = getConfig();
    assert_(!canSend_(setup.p, 2, config, new Date()), 'Precondition: NOT yet due for step 2 (Next_Action_Date is 7 days out).');

    var result = makeControlledFixtureDueNow(setup.p.Prospect_ID);

    assertEquals_('DUE_NOW', result.status);
    var after = findRowById_(setup.p.Prospect_ID).values;
    assert_(new Date(after.Next_Action_Date).getTime() <= Date.now(), 'Next_Action_Date must now be due (<= now).');
    // THE key proof this never bypasses canSend_: the SAME production
    // eligibility function, completely untouched, now says yes.
    assert_(canSend_(after, 2, config, new Date()), 'canSend_ itself (unmodified) must now agree this fixture is eligible for step 2.');
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

/** Test 2: a normal real prospect (default Source) is rejected before any write. */
function test_N9_realProspectRejectedBeforeWrite_() {
  var config = getConfig();
  var setup = n5_setupFollowUpDueProspect_('n9realprospect', config); // default Source = TEST_SOURCE_MARKER.
  var before = findRowById_(setup.p.Prospect_ID).values;

  var result = makeControlledFixtureDueNow(setup.p.Prospect_ID);

  assertEquals_('REJECTED_SOURCE_NOT_CONTROLLED', result.status, 'A real prospect must be refused on the Source allowlist alone.');
  var after = findRowById_(setup.p.Prospect_ID).values;
  assertEquals_(before.Next_Action_Date instanceof Date ? before.Next_Action_Date.getTime() : before.Next_Action_Date,
    after.Next_Action_Date instanceof Date ? after.Next_Action_Date.getTime() : after.Next_Action_Date,
    'A rejected real prospect must have NO field changed, not even Next_Action_Date.');
}

/** Test 3: a similarly-named but not-exactly-allowlisted Source is also rejected. */
function test_N9_wrongSourceRejected_() {
  var setup = n9_setupControlledStep2Fixture_('n9wrongsource', { Source: 'CONTROLLED_INTERNAL_STEP2_RETEST_OLD' });
  try {
    var result = makeControlledFixtureDueNow(setup.p.Prospect_ID);
    assertEquals_('REJECTED_SOURCE_NOT_CONTROLLED', result.status);
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

/** Test 4: wrong Status (e.g. still READY, step 1 never actually sent) rejected. */
function test_N9_wrongStatusRejected_() {
  var setup = n9_setupControlledStep2Fixture_('n9wrongstatus', { Status: STATUS.READY });
  try {
    var result = makeControlledFixtureDueNow(setup.p.Prospect_ID);
    assertEquals_('REJECTED_WRONG_STATUS', result.status);
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

/** Test 5: wrong Sequence_Step (already past step 1) rejected. */
function test_N9_wrongSequenceStepRejected_() {
  var setup = n9_setupControlledStep2Fixture_('n9wrongstep', { Sequence_Step: 2 });
  try {
    var result = makeControlledFixtureDueNow(setup.p.Prospect_ID);
    assertEquals_('REJECTED_WRONG_SEQUENCE_STEP', result.status);
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

/** Test: missing Step1_Sent_At rejected — never manufacture a due date for a step that was never verifiably sent. */
function test_N9_missingStep1SentAtRejected_() {
  var setup = n9_setupControlledStep2Fixture_('n9missingsent', { Step1_Sent_At: '' });
  try {
    var result = makeControlledFixtureDueNow(setup.p.Prospect_ID);
    assertEquals_('REJECTED_MISSING_STEP1_SENT_AT', result.status);
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

/** Test: missing Thread_ID rejected. */
function test_N9_missingThreadIdRejected_() {
  var setup = n9_setupControlledStep2Fixture_('n9missingthread', { Thread_ID: '' });
  try {
    var result = makeControlledFixtureDueNow(setup.p.Prospect_ID);
    assertEquals_('REJECTED_MISSING_THREAD_ID', result.status);
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

/** Test: missing Last_Message_ID rejected. */
function test_N9_missingLastMessageIdRejected_() {
  var setup = n9_setupControlledStep2Fixture_('n9missingmsgid', { Last_Message_ID: '' });
  try {
    var result = makeControlledFixtureDueNow(setup.p.Prospect_ID);
    assertEquals_('REJECTED_MISSING_LAST_MESSAGE_ID', result.status);
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

/** Test 6a: Replied=TRUE rejected. */
function test_N9_repliedFixtureRejected_() {
  var setup = n9_setupControlledStep2Fixture_('n9replied', { Replied: true });
  try {
    var result = makeControlledFixtureDueNow(setup.p.Prospect_ID);
    assertEquals_('REJECTED_REPLIED', result.status);
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

/** Test 6b: Stop_Contact rejected. */
function test_N9_stopContactFixtureRejected_() {
  var setup = n9_setupControlledStep2Fixture_('n9stop', { Stop_Contact: true });
  try {
    var result = makeControlledFixtureDueNow(setup.p.Prospect_ID);
    assertEquals_('REJECTED_STOP_CONTACT', result.status);
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

/** Test 6c: DNC rejected. */
function test_N9_dncFixtureRejected_() {
  var setup = n9_setupControlledStep2Fixture_('n9dnc', { Do_Not_Contact_Reason: DNC_REASON.MANUAL });
  try {
    var result = makeControlledFixtureDueNow(setup.p.Prospect_ID);
    assertEquals_('REJECTED_DNC', result.status);
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

/** Test 6d: Suppression rejected — real addSuppression_, not a stub. */
function test_N9_suppressedFixtureRejected_() {
  var setup = n9_setupControlledStep2Fixture_('n9suppressed');
  addSuppression_(setup.p.Email_Normalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.MANUAL, 'test');
  _testCreatedSuppressionValues.push(setup.p.Email_Normalized);
  try {
    var result = makeControlledFixtureDueNow(setup.p.Prospect_ID);
    assertEquals_('REJECTED_SUPPRESSED', result.status);
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

/** Test 7: a blocking LIVE Step-2 CLAIMED/SENT/AMBIGUOUS row rejects — same isLiveKeyBlocked_ normal sending uses. */
function test_N9_blockingLiveStep2RowRejected_() {
  [LEDGER_STATE.CLAIMED, LEDGER_STATE.SENT, LEDGER_STATE.AMBIGUOUS].forEach(function (state) {
    var setup = n9_setupControlledStep2Fixture_('n9blocked' + state.toLowerCase());
    try {
      appendLedgerRow_({
        Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: setup.p.Prospect_ID, Email_Normalized: setup.p.Email_Normalized,
        Step: 2, Idempotency_Key: getIdempotencyKey_(setup.p.Prospect_ID, 2), Mode: LEDGER_MODE.LIVE, State: state,
        Thread_ID: setup.p.Thread_ID, Message_ID: '', Draft_ID: '',
        Confirmed_At: state === LEDGER_STATE.SENT ? new Date() : '', Error: ''
      });
      var result = makeControlledFixtureDueNow(setup.p.Prospect_ID);
      assertEquals_('REJECTED_LIVE_STEP2_BLOCKED', result.status, 'A pre-existing ' + state + ' LIVE Step-2 row must block the override.');
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  });
}

/** Test 8: the accept path changes ONLY Next_Action_Date — every other field byte-identical before/after. */
function test_N9_onlyNextActionDateFieldChanges_() {
  var setup = n9_setupControlledStep2Fixture_('n9onlyfield');
  try {
    var before = findRowById_(setup.p.Prospect_ID).values;
    makeControlledFixtureDueNow(setup.p.Prospect_ID);
    var after = findRowById_(setup.p.Prospect_ID).values;

    Object.keys(before).forEach(function (col) {
      if (col === 'Next_Action_Date') return;
      var b = before[col] instanceof Date ? before[col].getTime() : before[col];
      var a = after[col] instanceof Date ? after[col].getTime() : after[col];
      assertEquals_(b, a, 'Column "' + col + '" must be completely unchanged by the due override.');
    });
    assert_(new Date(after.Next_Action_Date).getTime() !== new Date(before.Next_Action_Date).getTime(),
      'Next_Action_Date itself must actually have changed.');
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

/** Test 9: real prospects (any status) remain completely untouched by a call targeting the controlled fixture. */
function test_N9_realProspectsRemainUntouched_() {
  var config = getConfig();
  var real1 = n5_setupReadyProspect_('n9real1');
  var real2 = n5_setupFollowUpDueProspect_('n9real2', config);
  var fixture = n9_setupControlledStep2Fixture_('n9realuntouched');
  try {
    var real1Before = findRowById_(real1.Prospect_ID).values;
    var real2Before = findRowById_(real2.p.Prospect_ID).values;

    var result = makeControlledFixtureDueNow(fixture.p.Prospect_ID);
    assertEquals_('DUE_NOW', result.status);

    var real1After = findRowById_(real1.Prospect_ID).values;
    var real2After = findRowById_(real2.p.Prospect_ID).values;
    assertEquals_(real1Before.Status, real1After.Status, 'Unrelated real prospect 1 must be untouched.');
    assertEquals_(real2Before.Status, real2After.Status, 'Unrelated real prospect 2 must be untouched.');
    assertEquals_(String(real2Before.Next_Action_Date), String(real2After.Next_Action_Date),
      'Unrelated real prospect 2 Next_Action_Date must be untouched.');
  } finally {
    n8_deleteFixtureRow_(fixture.p.Prospect_ID);
  }
}

/**
 * Normal cadence logic / corrected Step-2 Gmail API path unchanged: not
 * duplicated as new tests — makeControlledFixtureDueNow never calls
 * computeNextActionDate_ or doFollowUpSend_ at all (grep confirms it),
 * and the existing N4/N7/timezone/N5-follow-up suites staying green
 * alongside these new tests is the actual proof nothing in that logic
 * was touched.
 */

/**
 * N10 (exact-target controlled Step-2 LIVE): sendControlledFixtureStep2Live
 * (Mailer.gs) — the Step-2 sibling of N8's sendControlledFixtureLive.
 * Same architecture, same delegation model, this time to
 * sendFollowUp(prospectId, 2) — the SAME primitive sendBatch() itself
 * uses for every real Step-2+ send.
 */

/** A due, IN_SEQUENCE/step-1-done controlled fixture — same shape n9_setupControlledStep2Fixture_ builds, made due by default here. */
function n10_setupDueControlledStep2Fixture_(emailTag, overrides) {
  var past = new Date(); past.setDate(past.getDate() - 3);
  var merged = Object.assign({ Next_Action_Date: past }, overrides || {});
  return n9_setupControlledStep2Fixture_(emailTag, merged);
}

/** Test 1 + 20: the accept path reaches sendFollowUp(id, 2) and performs a normal, complete Step-2 LIVE send; no other row changes. */
function test_N10_approvedFixtureStep2SucceedsThroughNormalPrimitive_() {
  withLiveModeEnabledForTest_(function () {
    var real1 = n5_setupReadyProspect_('n10queuereal1');
    var setup = n10_setupDueControlledStep2Fixture_('n10accept');
    try {
      var real1Before = findRowById_(real1.Prospect_ID).values;
      GmailApp._resetCallCounts();
      var beforeLedgerRows = readAllLedgerRows_().length;

      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);

      assertEquals_('SENT', result.status, 'An approved, due controlled fixture must reach a normal SENT.');
      assertEquals_(1, GmailApp._callCounts.apiSend, 'Exactly one real Gmail.Users.Messages.send() call must occur — the SAME Step-2 primitive normal sending uses.');
      assertEquals_(0, GmailApp._callCounts.send, 'No draft.send() — Step 2 replies on the existing thread, never sends a fresh message.');

      var ledgerRows = readAllLedgerRows_().filter(function (r) {
        return r.values.Prospect_ID === setup.p.Prospect_ID && r.values.Mode === LEDGER_MODE.LIVE && r.values.Step === 2;
      });
      assertEquals_(1, ledgerRows.length, 'Exactly one LIVE Step-2 ledger row — CLAIMED -> SENT, never two rows.');
      assertEquals_(LEDGER_STATE.SENT, ledgerRows[0].values.State);
      assertEquals_(beforeLedgerRows + 1, readAllLedgerRows_().length, 'Exactly one new ledger row total.');

      var after = findRowById_(setup.p.Prospect_ID).values;
      assertEquals_(2, Number(after.Sequence_Step), 'Prospects persistence must occur normally — Sequence_Step advances to 2.');
      assert_(!!after.Last_Message_ID, 'Last_Message_ID must be recorded normally.');

      // Test 20: exact fixture only — an unrelated real prospect untouched.
      var real1After = findRowById_(real1.Prospect_ID).values;
      assertEquals_(real1Before.Status, real1After.Status, 'An unrelated real prospect must be completely untouched.');
      assertEquals_(0, readAllLedgerRows_().filter(function (r) { return r.values.Prospect_ID === real1.Prospect_ID; }).length,
        'An unrelated real prospect must have NO ledger row — the fixture path never enumerates the queue.');
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test 2: a normal real prospect (default Source), otherwise perfectly eligible for Step 2, is rejected before any Gmail call. */
function test_N10_realProspectRejectedBeforeGmail_() {
  withLiveModeEnabledForTest_(function () {
    var config = getConfig();
    var setup = n5_setupFollowUpDueProspect_('n10realprospect', config); // default Source, due, IN_SEQUENCE step 1.
    GmailApp._resetCallCounts();

    var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);

    assertEquals_('REJECTED_SOURCE_NOT_CONTROLLED', result.status);
    assertEquals_(0, GmailApp._callCounts.apiSend);
    assertEquals_(0, readAllLedgerRows_().filter(function (r) { return r.values.Prospect_ID === setup.p.Prospect_ID; }).length,
      'No ledger row — not even a claim — for a rejected real prospect.');
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test 3: a similarly-named but not-exactly-allowlisted Source is also rejected. */
function test_N10_wrongSourceRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10wrongsource', { Source: 'CONTROLLED_INTERNAL_STEP2_RETEST_OLD' });
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('REJECTED_SOURCE_NOT_CONTROLLED', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test 4: Status=READY (step 1 never actually sent, or already reset) rejected. */
function test_N10_readyStatusRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10ready', { Status: STATUS.READY });
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('REJECTED_WRONG_STATUS', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test 5: wrong Sequence_Step (already past step 1) rejected. */
function test_N10_wrongSequenceStepRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10wrongstep', { Sequence_Step: 2 });
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('REJECTED_WRONG_SEQUENCE_STEP', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test 6: missing Step1_Sent_At rejected. */
function test_N10_missingStep1SentAtRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10missingsent', { Step1_Sent_At: '' });
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('REJECTED_MISSING_STEP1_SENT_AT', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test 7: missing Thread_ID rejected. */
function test_N10_missingThreadIdRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10missingthread', { Thread_ID: '' });
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('REJECTED_MISSING_THREAD_ID', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test 8: missing Last_Message_ID rejected. */
function test_N10_missingLastMessageIdRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10missingmsgid', { Last_Message_ID: '' });
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('REJECTED_MISSING_LAST_MESSAGE_ID', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test 9: NOT yet due (Next_Action_Date in the future — n9's own default shape) rejected. */
function test_N10_notDueFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n9_setupControlledStep2Fixture_('n10notdue'); // default: 7 days in the future.
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('REJECTED_NOT_DUE', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test 10: Replied=TRUE rejected. */
function test_N10_repliedFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10replied', { Replied: true });
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('REJECTED_REPLIED', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test 11: Stop_Contact rejected. */
function test_N10_stopContactFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10stop', { Stop_Contact: true });
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('REJECTED_STOP_CONTACT', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test 12: DNC rejected. */
function test_N10_dncFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10dnc', { Do_Not_Contact_Reason: DNC_REASON.MANUAL });
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('REJECTED_DNC', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test 13: Suppression rejected — real addSuppression_. */
function test_N10_suppressedFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10suppressed');
    addSuppression_(setup.p.Email_Normalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.MANUAL, 'test');
    _testCreatedSuppressionValues.push(setup.p.Email_Normalized);
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('REJECTED_SUPPRESSED', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Tests 14/15/16: an existing blocking Step-2 LIVE row (CLAIMED/SENT/AMBIGUOUS) blocks — delegated unchanged to isLiveKeyBlocked_ via sendFollowUp. */
function test_N10_existingBlockingLiveStep2RowBlocksFixture_() {
  withLiveModeEnabledForTest_(function () {
    [LEDGER_STATE.CLAIMED, LEDGER_STATE.SENT, LEDGER_STATE.AMBIGUOUS].forEach(function (state) {
      var setup = n10_setupDueControlledStep2Fixture_('n10blocked' + state.toLowerCase());
      try {
        appendLedgerRow_({
          Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: setup.p.Prospect_ID, Email_Normalized: setup.p.Email_Normalized,
          Step: 2, Idempotency_Key: getIdempotencyKey_(setup.p.Prospect_ID, 2), Mode: LEDGER_MODE.LIVE, State: state,
          Thread_ID: setup.p.Thread_ID, Message_ID: '', Draft_ID: '',
          Confirmed_At: state === LEDGER_STATE.SENT ? new Date() : '', Error: ''
        });
        GmailApp._resetCallCounts();
        var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
        assertEquals_('SKIPPED_ALREADY_CLAIMED', result.status,
          'A pre-existing ' + state + ' LIVE Step-2 row must block via the SAME isLiveKeyBlocked_ sendFollowUp already uses.');
        assertEquals_(0, GmailApp._callCounts.apiSend);
      } finally {
        n8_deleteFixtureRow_(setup.p.Prospect_ID);
      }
    });
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

/** Test 17: Config not armed (DRY_RUN=TRUE) — the SAME performLiveSend_ throw sendFollowUp itself produces, unmodified. */
function test_N10_configNotArmedFixtureRejected_() {
  // Deliberately NOT withLiveModeEnabledForTest_ — DRY_RUN stays TRUE, the
  // real safe default. Only MAX_PER_RUN is set to 1 so this mechanism's
  // OWN guard 16 does not mask what this test is actually proving.
  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var maxPerRunRow = null;
  for (var i = 0; i < values.length; i++) { if (values[i][0] === 'MAX_PER_RUN') maxPerRunRow = i + 2; }
  if (!maxPerRunRow) throw new Error('MAX_PER_RUN not found in Config.');
  var originalMaxPerRun = sheet.getRange(maxPerRunRow, 2).getValue();

  var setup = n10_setupDueControlledStep2Fixture_('n10notarmed');
  try {
    sheet.getRange(maxPerRunRow, 2).setValue('1');
    resetConfigCache_();
    assertEquals_(true, getConfig().DRY_RUN, 'Precondition: DRY_RUN must genuinely still be TRUE.');

    GmailApp._resetCallCounts();
    var threw = false;
    try {
      sendControlledFixtureStep2Live(setup.p.Prospect_ID);
    } catch (e) {
      threw = true;
      assert_(String(e).indexOf('DRY_RUN') !== -1, 'The propagated error must be performLiveSend_\\u2019s own DRY_RUN guard, unmodified.');
    }
    assert_(threw, 'With DRY_RUN=TRUE, sendControlledFixtureStep2Live must throw — exactly like sendFollowUp would.');
    assertEquals_(0, GmailApp._callCounts.apiSend);
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
    sheet.getRange(maxPerRunRow, 2).setValue(originalMaxPerRun);
    resetConfigCache_();
  }
}

/** Test 18: outside the configured send window — delegated unchanged to isWithinSendWindow_ via sendFollowUp. */
function test_N10_outsideSendWindowFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10window');
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('SKIPPED_OUTSIDE_WINDOW', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5', SEND_START_HOUR: '9', SEND_END_HOUR: '9' });
}

/** Test 19: daily quota exhausted — delegated unchanged to computeLiveSendBudget_ via sendFollowUp. */
function test_N10_dailyQuotaExhaustedFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10quota');
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('QUOTA_ABORT', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '0' });
}

/** Test: MAX_PER_RUN != 1 refuses this mechanism outright — never delegates. */
function test_N10_maxPerRunNotOneFixtureRejected_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10maxperrun');
    try {
      GmailApp._resetCallCounts();
      var result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      assertEquals_('REJECTED_MAX_PER_RUN_NOT_ONE', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend);
      assertEquals_(0, readAllLedgerRows_().filter(function (r) { return r.values.Prospect_ID === setup.p.Prospect_ID; }).length,
        'No claim of any kind — the guard fires before sendFollowUp is ever called.');
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '2', MAX_PER_DAY: '5' });
}

/** Test 24: N6 post-send persistence protection is unchanged through this new entry point. */
function test_N10_postSendPersistenceFailureRetainsN6SemanticsViaStep2FixturePath_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n10_setupDueControlledStep2Fixture_('n10n6semantics');
    try {
      GmailApp._resetCallCounts();
      var originalWriteRowById = writeRowById_;
      writeRowById_ = function () { throw new Error('N10 simulated: total Prospects persistence outage.'); };

      var result;
      try {
        result = sendControlledFixtureStep2Live(setup.p.Prospect_ID);
      } finally {
        writeRowById_ = originalWriteRowById;
      }

      assertEquals_('SENT_PERSISTENCE_FAILED', result.status, 'N6 semantics must be identical through this entry point.');
      var ledgerRows = readAllLedgerRows_().filter(function (r) {
        return r.values.Prospect_ID === setup.p.Prospect_ID && r.values.Mode === LEDGER_MODE.LIVE && r.values.Step === 2;
      });
      assertEquals_(1, ledgerRows.length);
      assertEquals_(LEDGER_STATE.SENT, ledgerRows[0].values.State, 'Ledger must still reach durable SENT.');
      assert_(String(ledgerRows[0].values.Error).indexOf('POST_SEND_PERSISTENCE_FAILURE') !== -1,
        'The durable N6 ledger marker must still be stamped.');
      assert_(isLiveKeyBlocked_(setup.p.Prospect_ID, 2), 'The key must still be durably blocked.');
      assertEquals_(1, GmailApp._callCounts.apiSend, 'Exactly one real Gmail.Users.Messages.send() call must have occurred.');
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  }, { MAX_PER_RUN: '1', MAX_PER_DAY: '5' });
}

// N11 — one exact controlled fixture recovery after the Google-real
// userinfo.email pre-CLAIM failure. The fixture ID is deliberately the same
// literal production constant; every test removes its own row immediately.
function n11_setupRecoveryFixture_(emailTag, overrides) {
  var past = new Date(); past.setDate(past.getDate() - 3);
  var base = {
    Prospect_ID: CONTROLLED_STEP2_RECOVERY_PROSPECT_ID,
    Status: STATUS.NEEDS_REVIEW,
    Sequence_Step: 1,
    Next_Action_Date: past
  };
  return n9_setupControlledStep2Fixture_(emailTag, Object.assign(base, overrides || {}));
}

function test_N11_validControlledPreSendFailureRecoversOnlyStatus_() {
  var setup = n11_setupRecoveryFixture_('n11accept');
  try {
    var before = findRowById_(setup.p.Prospect_ID).values;
    GmailApp._resetCallCounts();
    var ledgerBefore = readAllLedgerRows_().length;
    var result = recoverControlledFixtureStep2PreSendFailure(setup.p.Prospect_ID);
    assertEquals_('RECOVERED_PRE_SEND_FAILURE', result.status);
    var after = findRowById_(setup.p.Prospect_ID).values;
    assertEquals_(STATUS.IN_SEQUENCE, after.Status);
    ['Sequence_Step', 'Step1_Sent_At', 'Step2_Sent_At', 'Thread_ID', 'Last_Message_ID', 'Next_Action_Date', 'Email', 'Source', 'Error_Count', 'Last_Error'].forEach(function (field) {
      assertEquals_(String(before[field]), String(after[field]), 'Recovery must preserve ' + field + '.');
    });
    assertEquals_(ledgerBefore, readAllLedgerRows_().length, 'Recovery must not create a ledger row.');
    assertEquals_(0, GmailApp._callCounts.apiSend, 'Recovery must never invoke Gmail API send.');
    assertEquals_(0, GmailApp._callCounts.send, 'Recovery must never invoke draft.send.');
    assert_(canSend_(after, 2, getConfig(), new Date()), 'The normal canSend_ guard must see the recovered fixture as eligible for due Step 2.');
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

function test_N11_realProspectAndWrongSourceRejected_() {
  var real = n5_setupFollowUpDueProspect_('n11real', getConfig());
  assertEquals_('REJECTED_RECOVERY_TARGET', recoverControlledFixtureStep2PreSendFailure(real.p.Prospect_ID).status);
  var setup = n11_setupRecoveryFixture_('n11source', { Source: 'CONTROLLED_INTERNAL_STEP2_RETEST_OLD' });
  try {
    assertEquals_('REJECTED_SOURCE_NOT_CONTROLLED', recoverControlledFixtureStep2PreSendFailure(setup.p.Prospect_ID).status);
  } finally {
    n8_deleteFixtureRow_(setup.p.Prospect_ID);
  }
}

function test_N11_recoveryRejectsInvalidFixtureState_() {
  var cases = [
    [{ Status: STATUS.IN_SEQUENCE }, 'REJECTED_WRONG_STATUS'],
    [{ Sequence_Step: 2 }, 'REJECTED_WRONG_SEQUENCE_STEP'],
    [{ Step1_Sent_At: '' }, 'REJECTED_MISSING_STEP1_SENT_AT'],
    [{ Step2_Sent_At: new Date() }, 'REJECTED_STEP2_ALREADY_SENT'],
    [{ Thread_ID: '' }, 'REJECTED_MISSING_THREAD_ID'],
    [{ Last_Message_ID: '' }, 'REJECTED_MISSING_LAST_MESSAGE_ID'],
    [{ Next_Action_Date: new Date(Date.now() + 60000) }, 'REJECTED_NOT_DUE'],
    [{ Replied: true }, 'REJECTED_REPLIED'],
    [{ Stop_Contact: true }, 'REJECTED_STOP_CONTACT'],
    [{ Do_Not_Contact_Reason: DNC_REASON.MANUAL }, 'REJECTED_DNC']
  ];
  cases.forEach(function (entry, i) {
    var setup = n11_setupRecoveryFixture_('n11state' + i, entry[0]);
    try {
      assertEquals_(entry[1], recoverControlledFixtureStep2PreSendFailure(setup.p.Prospect_ID).status);
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  });
}

function test_N11_suppressionAndEveryLiveHistoryBlockRecovery_() {
  var suppressed = n11_setupRecoveryFixture_('n11suppressed');
  addSuppression_(suppressed.p.Email_Normalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.MANUAL, 'test');
  _testCreatedSuppressionValues.push(suppressed.p.Email_Normalized);
  try {
    assertEquals_('REJECTED_SUPPRESSED', recoverControlledFixtureStep2PreSendFailure(suppressed.p.Prospect_ID).status);
  } finally {
    n8_deleteFixtureRow_(suppressed.p.Prospect_ID);
  }

  [LEDGER_STATE.CLAIMED, LEDGER_STATE.SENT, LEDGER_STATE.AMBIGUOUS, LEDGER_STATE.FAILED].forEach(function (state, i) {
    var setup = n11_setupRecoveryFixture_('n11ledger' + i);
    try {
      appendLedgerRow_({
        Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: setup.p.Prospect_ID,
        Email_Normalized: setup.p.Email_Normalized, Step: 2,
        Idempotency_Key: getIdempotencyKey_(setup.p.Prospect_ID, 2), Mode: LEDGER_MODE.LIVE,
        State: state, Thread_ID: setup.p.Thread_ID, Message_ID: '', Draft_ID: '', Confirmed_At: '', Error: ''
      });
      assertEquals_('REJECTED_STEP2_LIVE_HISTORY', recoverControlledFixtureStep2PreSendFailure(setup.p.Prospect_ID).status,
        'Any LIVE Step-2 history, including FAILED, must reject this known pre-CLAIM-only recovery.');
    } finally {
      n8_deleteFixtureRow_(setup.p.Prospect_ID);
    }
  });
}

// N12 — Google-real post-send decode incident and exact, read-only-Gmail
// reconciliation of the one immutable controlled Step-2 AMBIGUOUS row.

function n12_expectThrow_(fn, expectedText) {
  var threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (expectedText) assert_(String(e.message || e).indexOf(expectedText) !== -1,
      'Expected thrown error to contain "' + expectedText + '", got: ' + e);
  }
  assert_(threw, 'Expected operation to fail closed.');
}

function n12_textPlainResource_(encoded) {
  return { payload: { mimeType: 'text/plain', filename: '', body: { data: encoded }, headers: [] } };
}

function test_N12_realAppsScriptGmailByteArrayBody_() {
  // Captured shape, length and digest from Gmail Advanced Service under the
  // actual Jhessyca Apps Script runtime for message 1a0a6999b8bf445f.
  // Messages.get and Threads.get both returned this signed Byte[] shape.
  var body = [
    'Hi Test Contact,',
    '',
    'Following up on my note about Klinner Step2 Verification Fixture — happy to send over what I found if useful.',
    '',
    'Best,',
    'Klinner Cleaning & Maintenance',
    'klinnercleaning.com',
    '',
    '526 Grove Creek Ave, Nashville, TN 37214',
    'If you\'d prefer not to receive further emails from Klinner, reply "unsubscribe" and we\'ll remove you from future outreach.'
  ].join('\n');
  var bytes = Utilities.newBlob(body).getBytes();
  assertEquals_(352, bytes.length, 'Real Gmail body.data had exactly 352 signed bytes.');
  assertEquals_('e9830d57eab74074b5a1574e3d3fd9612c450971cd47096f5abde4a266433e7c',
    bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, body, Utilities.Charset.UTF_8)),
    'Regression text must match the real Gmail payload digest.');
  assert_(bytes.some(function (value) { return value < 0; }), 'Real payload includes signed UTF-8 bytes.');
  assert_(String(bytes).indexOf(',') !== -1, 'Old String(byteArray) conversion created invalid commas.');
  assertEquals_(body, decodeGmailApiMessageBodyUtf8_(n12_textPlainResource_(bytes)),
    'Exact real Apps Script Byte[] payload must decode without changing the body.');
  assertEquals_(body, decodeGmailApiMessageBodyUtf8_(n12_textPlainResource_(bytes.map(function (value) {
    return value < 0 ? value + 256 : value;
  }))), 'Equivalent unsigned byte arrays must also decode exactly.');
}

function test_N12_gmailBase64UrlDecoderHandlesRealPayloadShapes_() {
  var text = 'Hi \u083e \u2713\r\nline 2\nline 3';
  var padded = Utilities.base64EncodeWebSafe(text, Utilities.Charset.UTF_8);
  var unpadded = padded.replace(/=+$/, '');
  assert_(unpadded.indexOf('-') !== -1, 'Fixture must exercise the URL-safe "-" alphabet, not only ordinary base64.');
  assert_(padded.length > unpadded.length, 'Fixture must exercise Gmail\'s omitted padding shape.');

  // Emulate the strict Apps Script decoder behavior that exposed the real
  // incident. The production helper must add valid omitted padding BEFORE
  // calling it; Node Buffer's permissive decoder would otherwise hide this.
  var originalDecode = Utilities.base64DecodeWebSafe;
  Utilities.base64DecodeWebSafe = function (value) {
    if (String(value).length % 4 !== 0) throw new Error('No se pudo descifrar la cadena.');
    return originalDecode(value);
  };
  try {
    assertEquals_(text, decodeGmailApiMessageBodyUtf8_(n12_textPlainResource_(unpadded)),
      'Unpadded real Gmail base64url must decode exactly, preserving UTF-8, CRLF and multiline text.');
    assertEquals_(text, decodeGmailApiMessageBodyUtf8_(n12_textPlainResource_(padded)),
      'Padded Gmail base64url must continue to decode exactly.');

    var nested = { payload: { mimeType: 'multipart/alternative', body: {}, parts: [
      { mimeType: 'text/plain', filename: '', body: { data: unpadded } },
      { mimeType: 'text/html', filename: '', body: { data: Utilities.base64EncodeWebSafe('<p>ignored</p>').replace(/=+$/, '') } }
    ] } };
    assertEquals_(text, decodeGmailApiMessageBodyUtf8_(nested),
      'The verifier must select the one inline text/plain part from a realistic multipart payload.');
  } finally {
    Utilities.base64DecodeWebSafe = originalDecode;
  }
}

function test_N12_gmailBase64UrlDecoderRejectsMalformedOrAmbiguousPayloads_() {
  [n12_textPlainResource_('abc$'), n12_textPlainResource_('abcde'), n12_textPlainResource_('_w'),
    n12_textPlainResource_([]), n12_textPlainResource_([256]), n12_textPlainResource_([-129]),
    n12_textPlainResource_([72, 1.5]), n12_textPlainResource_([72, '105']),
    n12_textPlainResource_([-1]), n12_textPlainResource_({ 0: 72, length: 1 })]
    .forEach(function (resource) {
      n12_expectThrow_(function () { decodeGmailApiMessageBodyUtf8_(resource); }, 'Gmail verification failed');
    });
  n12_expectThrow_(function () {
    decodeGmailApiMessageBodyUtf8_({ payload: { mimeType: 'multipart/alternative', parts: [] } });
  }, 'exactly one inline text/plain body');
  n12_expectThrow_(function () {
    decodeGmailApiMessageBodyUtf8_({ payload: { mimeType: 'multipart/mixed', parts: [
      { mimeType: 'text/plain', body: { data: 'QQ==' } },
      { mimeType: 'text/plain', body: { data: 'Qg==' } }
    ] } });
  }, 'exactly one inline text/plain body');
}

function n12_assertPostSendMismatchBecomesAmbiguous_(tag, mutateResource) {
  withLiveModeEnabledForTest_(function () {
    var setup = n5_setupFollowUpDueProspect_('n12-' + tag, getConfig());
    GmailApp._resetCallCounts();
    var originalGet = Gmail.Users.Messages.get;
    Gmail.Users.Messages.get = function (userId, messageId, options) {
      var resource = originalGet(userId, messageId, options);
      if (messageId !== setup.priorMessageId) mutateResource(resource);
      return resource;
    };
    var threw = false;
    try { sendFollowUp(setup.p.Prospect_ID, 2); } catch (e) { threw = true; }
    finally { Gmail.Users.Messages.get = originalGet; }
    assert_(threw, tag + ' mismatch must make the post-send outcome ambiguous.');
    var row = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === setup.p.Prospect_ID && Number(r.values.Step) === 2 && r.values.Mode === LEDGER_MODE.LIVE;
    })[0];
    assert_(!!row, 'The durable LIVE row must exist.');
    assertEquals_(LEDGER_STATE.AMBIGUOUS, row.values.State);
    assertEquals_(1, GmailApp._callCounts.apiSend, 'A verification failure must never retry Gmail SEND.');
    var replay = sendFollowUp(setup.p.Prospect_ID, 2);
    assert_(replay.status !== 'SENT', 'The AMBIGUOUS key must block replay.');
    assertEquals_(1, GmailApp._callCounts.apiSend, 'Replay must make zero additional SEND calls.');
  });
}

function test_N12_followUpVerificationRejectsSenderAndReplyHeaderMismatches_() {
  n12_assertPostSendMismatchBecomesAmbiguous_('sender', function (resource) {
    resource.payload.headers.forEach(function (h) { if (h.name === 'From') h.value = 'wrong-sender@example.net'; });
  });
  n12_assertPostSendMismatchBecomesAmbiguous_('in-reply-to', function (resource) {
    resource.payload.headers.forEach(function (h) { if (h.name === 'In-Reply-To') h.value = '<wrong@example.net>'; });
  });
  n12_assertPostSendMismatchBecomesAmbiguous_('references', function (resource) {
    resource.payload.headers.forEach(function (h) { if (h.name === 'References') h.value = '<wrong@example.net>'; });
  });
}

function test_N12_followUpVerificationRejectsBodyMismatch_() {
  n12_assertPostSendMismatchBecomesAmbiguous_('body', function (resource) {
    resource.payload.body.data = Utilities.base64EncodeWebSafe('different body').replace(/=+$/, '');
  });
}

function n12_withIncidentConfig_(fn) {
  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  var rowByKey = {};
  values.forEach(function (row, i) { rowByKey[row[0]] = i + 2; });
  var overrides = {
    DRY_RUN: 'TRUE', PAUSE_ALL: 'TRUE', MAX_PER_RUN: '1',
    SENDER_EMAIL: CONTROLLED_STEP2_AMBIGUOUS_INCIDENT.Sender_Email,
    REPLY_TO: CONTROLLED_STEP2_AMBIGUOUS_INCIDENT.Sender_Email,
    PHYSICAL_ADDRESS: '526 Grove Creek Ave, Nashville, TN 37214',
    UNSUBSCRIBE_LINE: 'If you would prefer not to receive further emails, reply unsubscribe.'
  };
  var originals = {};
  Object.keys(overrides).forEach(function (key) {
    originals[key] = sheet.getRange(rowByKey[key], 2).getValue();
    sheet.getRange(rowByKey[key], 2).setValue(overrides[key]);
  });
  var originalEffectiveUser = Session.getEffectiveUser;
  Session.getEffectiveUser = function () {
    return { getEmail: function () { return CONTROLLED_STEP2_AMBIGUOUS_INCIDENT.Sender_Email; } };
  };
  resetConfigCache_();
  try { return fn(); }
  finally {
    Session.getEffectiveUser = originalEffectiveUser;
    Object.keys(overrides).forEach(function (key) { sheet.getRange(rowByKey[key], 2).setValue(originals[key]); });
    resetConfigCache_();
  }
}

function n12_setupAmbiguousIncident_() {
  var incident = CONTROLLED_STEP2_AMBIGUOUS_INCIDENT;
  var config = getConfig();
  var past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  var confirmedAt = new Date(Date.now() - 60 * 1000);
  var subject = 'A quick note about Klinner Step2 Verification Fixture';
  var thread = GmailApp._seedLiveThread(incident.Email_Normalized, incident.Sender_Email, {
    threadId: incident.Thread_ID, messageId: incident.Prior_Message_ID,
    rfcMessageId: incident.Prior_Rfc_Message_ID, internalDate: past.getTime(),
    subject: subject, body: 'Controlled Step-1 body.'
  });
  _testCreatedThreadIds_.push(thread.getId());
  var row = addTestProspectRow_({
    Prospect_ID: incident.Prospect_ID, Source: incident.Source,
    Business_Name: 'Klinner Step2 Verification Fixture', Contact_Name: 'Test Contact',
    Email: incident.Email_Normalized, Email_Normalized: incident.Email_Normalized,
    Domain: 'gmail.com', Domain_Type: DOMAIN_TYPE.PUBLIC,
    Problem_Found: 'controlled Step-2 verification fixture',
    Personalization_Line: 'This is a controlled internal verification of the follow-up workflow.',
    Status: STATUS.NEEDS_REVIEW, Sequence_Step: 1,
    Step1_Sent_At: past, Last_Contacted: past, Next_Action_Date: past,
    Thread_ID: incident.Thread_ID, Last_Message_ID: incident.Prior_Message_ID
  });
  var p = getTestProspectByRow_(row);
  var rendered = renderTemplateForStep_(2, p, config);
  var bodyHash = computeDraftFingerprint_(incident.Email_Normalized, subject, rendered.body);
  GmailApp._makeApiSentMessage({
    From: config.SENDER_NAME + ' <' + incident.Sender_Email + '>', To: incident.Email_Normalized, Subject: subject,
    'In-Reply-To': incident.Prior_Rfc_Message_ID, References: incident.Prior_Rfc_Message_ID,
    'X-Klinner-Body-SHA256': bodyHash, body: rendered.body
  }, incident.Thread_ID, {
    messageId: incident.Message_ID, rfcMessageId: incident.Rfc_Message_ID, internalDate: confirmedAt.getTime()
  });
  appendLedgerRow_({
    Run_ID: incident.Run_ID, Claimed_At: past, Prospect_ID: incident.Prospect_ID,
    Email_Normalized: incident.Email_Normalized, Step: 2,
    Idempotency_Key: getIdempotencyKey_(incident.Prospect_ID, 2), Mode: LEDGER_MODE.LIVE,
    State: LEDGER_STATE.AMBIGUOUS, Thread_ID: incident.Thread_ID, Message_ID: '', Draft_ID: '', Confirmed_At: '',
    Error: 'Exception: No se pudo descifrar la cadena. (ambiguous outcome after Gmail API send invocation — durably blocked; SEND is never retried)'
  });
  return { p: p, confirmedAt: confirmedAt, rendered: rendered };
}

function n12_cleanupIncident_() {
  var incident = CONTROLLED_STEP2_AMBIGUOUS_INCIDENT;
  n8_deleteFixtureRow_(incident.Prospect_ID);
  var sheet = getLedgerSheet_();
  var rows = readAllLedgerRows_();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i].values.Prospect_ID === incident.Prospect_ID) sheet.deleteRow(rows[i].rowIndex);
  }
}

function test_N12_exactAmbiguousIncidentReconcilesWithoutSendAndIsIdempotent_() {
  n12_withIncidentConfig_(function () {
    var setup = n12_setupAmbiguousIncident_();
    try {
      var before = findRowById_(setup.p.Prospect_ID).values;
      var ledgerCountBefore = readAllLedgerRows_().length;
      GmailApp._resetCallCounts();
      var result = reconcileControlledFixtureStep2Ambiguous(setup.p.Prospect_ID);
      assertEquals_('RECONCILED_SENT', result.status);
      assertEquals_(0, GmailApp._callCounts.apiSend, 'Reconciliation must have no Gmail SEND primitive.');
      assertEquals_(0, GmailApp._callCounts.send, 'Reconciliation must never invoke draft.send().');
      assertEquals_(0, GmailApp._callCounts.reply, 'Reconciliation must never invoke thread.reply().');
      assertEquals_(ledgerCountBefore, readAllLedgerRows_().length, 'Reconciliation must update the same ledger row, not append one.');
      var ledger = readAllLedgerRows_().filter(function (r) { return r.values.Prospect_ID === setup.p.Prospect_ID; });
      assertEquals_(1, ledger.length);
      assertEquals_(LEDGER_STATE.SENT, ledger[0].values.State);
      assertEquals_(CONTROLLED_STEP2_AMBIGUOUS_INCIDENT.Message_ID, ledger[0].values.Message_ID);
      assert_(!!ledger[0].values.Confirmed_At, 'Confirmed_At must come from the exact Gmail message internalDate.');
      assert_(String(ledger[0].values.Error).indexOf('RECONCILED_FROM_AMBIGUOUS:') === 0,
        'The original ambiguity must remain preserved in the same row audit marker.');
      assert_(String(ledger[0].values.Error).indexOf('No se pudo descifrar la cadena') !== -1,
        'The original decoder incident must not be erased.');
      var after = findRowById_(setup.p.Prospect_ID).values;
      assertEquals_(STATUS.IN_SEQUENCE, after.Status);
      assertEquals_(2, Number(after.Sequence_Step));
      assertEquals_(setup.confirmedAt.getTime(), new Date(after.Step2_Sent_At).getTime());
      assertEquals_(setup.confirmedAt.getTime(), new Date(after.Last_Contacted).getTime());
      assertEquals_(CONTROLLED_STEP2_AMBIGUOUS_INCIDENT.Message_ID, after.Last_Message_ID);
      assertEquals_(before.Thread_ID, after.Thread_ID);
      assertEquals_(new Date(before.Step1_Sent_At).getTime(), new Date(after.Step1_Sent_At).getTime());
      assert_(!!after.Next_Action_Date, 'Normal Step-3 cadence must be calculated.');
      var authorizedChanges = {
        Status: true, Sequence_Step: true, Next_Action_Date: true,
        Last_Contacted: true, Step2_Sent_At: true, Last_Message_ID: true
      };
      Object.keys(before).forEach(function (field) {
        if (authorizedChanges[field]) return;
        var b = before[field] instanceof Date ? before[field].getTime() : before[field];
        var a = after[field] instanceof Date ? after[field].getTime() : after[field];
        assertEquals_(b, a, 'Reconciliation must preserve unauthorized Prospect field ' + field + '.');
      });
      var firstStep2Time = new Date(after.Step2_Sent_At).getTime();
      var nextDate = new Date(after.Next_Action_Date).getTime();
      var second = reconcileControlledFixtureStep2Ambiguous(setup.p.Prospect_ID);
      assertEquals_('ALREADY_RECONCILED', second.status);
      var afterSecond = findRowById_(setup.p.Prospect_ID).values;
      assertEquals_(firstStep2Time, new Date(afterSecond.Step2_Sent_At).getTime(), 'Replay must not change Step2_Sent_At.');
      assertEquals_(nextDate, new Date(afterSecond.Next_Action_Date).getTime(), 'Replay must not advance cadence again.');
      assertEquals_(ledgerCountBefore, readAllLedgerRows_().length, 'Replay must not add a ledger row.');
      assertEquals_(0, GmailApp._callCounts.apiSend, 'Replay must still make zero SEND calls.');
    } finally { n12_cleanupIncident_(); }
  });
}

function test_N12_reconciliationResumesAfterLedgerCommitWithoutSending_() {
  n12_withIncidentConfig_(function () {
    var setup = n12_setupAmbiguousIncident_();
    var originalWrite = writeRowById_;
    var blockedOnce = false;
    try {
      GmailApp._resetCallCounts();
      writeRowById_ = function () {
        if (!blockedOnce) {
          blockedOnce = true;
          throw new Error('simulated crash after the durable ledger commit');
        }
        return originalWrite.apply(this, arguments);
      };
      n12_expectThrow_(function () {
        reconcileControlledFixtureStep2Ambiguous(setup.p.Prospect_ID);
      }, 'simulated crash');
      writeRowById_ = originalWrite;

      var midLedger = readAllLedgerRows_().filter(function (r) {
        return r.values.Prospect_ID === setup.p.Prospect_ID;
      })[0];
      assertEquals_(LEDGER_STATE.SENT, midLedger.values.State,
        'A crash after exact Gmail verification must leave the idempotency key durably SENT.');
      assertEquals_(STATUS.NEEDS_REVIEW, findRowById_(setup.p.Prospect_ID).values.Status,
        'Precondition for resume: CRM is still at its pre-reconciliation state.');

      var resumed = reconcileControlledFixtureStep2Ambiguous(setup.p.Prospect_ID);
      assertEquals_('RECONCILED_SENT', resumed.status,
        'A second operator invocation must finish CRM persistence without another send.');
      assertEquals_(2, Number(findRowById_(setup.p.Prospect_ID).values.Sequence_Step));
      assertEquals_(0, GmailApp._callCounts.apiSend, 'Neither failed nor resumed reconciliation may invoke Gmail SEND.');
      assertEquals_(1, readAllLedgerRows_().filter(function (r) {
        return r.values.Prospect_ID === setup.p.Prospect_ID;
      }).length, 'Resume must still update the original row only.');
    } finally {
      writeRowById_ = originalWrite;
      n12_cleanupIncident_();
    }
  });
}

function test_N12_reconciliationRejectsWrongTargetAndUnsafeEvidence_() {
  n12_withIncidentConfig_(function () {
    assertEquals_('REJECTED_RECONCILIATION_TARGET', reconcileControlledFixtureStep2Ambiguous('real-prospect-id').status);
    var setup = n12_setupAmbiguousIncident_();
    try {
      GmailApp._resetCallCounts();
      var found = findRowById_(setup.p.Prospect_ID);
      setRawCellForTest_(found.rowIndex, 'Source', 'REAL_PROSPECT');
      assertEquals_('REJECTED_SOURCE_NOT_CONTROLLED', reconcileControlledFixtureStep2Ambiguous(setup.p.Prospect_ID).status);
      setRawCellForTest_(found.rowIndex, 'Source', CONTROLLED_STEP2_AMBIGUOUS_INCIDENT.Source);
      var ledger = readAllLedgerRows_().filter(function (r) { return r.values.Prospect_ID === setup.p.Prospect_ID; })[0];
      updateLedgerRow_(ledger.rowIndex, { Run_ID: 'wrong-run-id' });
      assertEquals_('REJECTED_STEP2_LEDGER_EVIDENCE', reconcileControlledFixtureStep2Ambiguous(setup.p.Prospect_ID).status);
      assertEquals_(0, GmailApp._callCounts.apiSend, 'Every rejected reconciliation must have zero Gmail SEND calls.');
      assertEquals_(LEDGER_STATE.AMBIGUOUS, readAllLedgerRows_().filter(function (r) {
        return r.values.Prospect_ID === setup.p.Prospect_ID;
      })[0].values.State, 'Rejected evidence must leave AMBIGUOUS untouched.');
    } finally { n12_cleanupIncident_(); }
  });
}

function test_N12_reconciliationRejectsGmailMismatchOrDuplicate_() {
  n12_withIncidentConfig_(function () {
    var setup = n12_setupAmbiguousIncident_();
    try {
      GmailApp._resetCallCounts();
      var message = GmailApp._messagesById[CONTROLLED_STEP2_AMBIGUOUS_INCIDENT.Message_ID];
      var originalRfc = message._headers['Message-ID'];
      message._headers['Message-ID'] = '<wrong@example.test>';
      assertEquals_('REJECTED_RFC_MESSAGE_ID', reconcileControlledFixtureStep2Ambiguous(setup.p.Prospect_ID).status);
      message._headers['Message-ID'] = originalRfc;
      var preparedBody = setup.rendered.body;
      GmailApp._makeApiSentMessage({
        From: getConfig().SENDER_NAME + ' <' + CONTROLLED_STEP2_AMBIGUOUS_INCIDENT.Sender_Email + '>',
        To: CONTROLLED_STEP2_AMBIGUOUS_INCIDENT.Email_Normalized,
        Subject: 'A quick note about Klinner Step2 Verification Fixture',
        'In-Reply-To': CONTROLLED_STEP2_AMBIGUOUS_INCIDENT.Prior_Rfc_Message_ID,
        References: CONTROLLED_STEP2_AMBIGUOUS_INCIDENT.Prior_Rfc_Message_ID,
        'X-Klinner-Body-SHA256': computeDraftFingerprint_(CONTROLLED_STEP2_AMBIGUOUS_INCIDENT.Email_Normalized,
          'A quick note about Klinner Step2 Verification Fixture', preparedBody),
        body: preparedBody
      }, CONTROLLED_STEP2_AMBIGUOUS_INCIDENT.Thread_ID);
      assertEquals_('REJECTED_DUPLICATE_OR_MISSING_MESSAGE', reconcileControlledFixtureStep2Ambiguous(setup.p.Prospect_ID).status);
      assertEquals_(0, GmailApp._callCounts.apiSend, 'Gmail mismatch/duplicate checks are read-only and must never SEND.');
    } finally { n12_cleanupIncident_(); }
  });
}

/**
 * N13 (automatic unsubscribe from inbound reply): processThreadForReplies_
 * now detects unsubscribe intent in the NEW, isolated portion of an inbound
 * reply and routes it through the SAME proven applyUnsubscribeEffects_
 * primitive the manual admin path uses (Recon.gs) — via the new, narrowly-
 * scoped OPERATION.SYSTEM_AUTO_UNSUBSCRIBE (Constants.gs), which is
 * structurally no wider than ADMIN_UNSUBSCRIBE's own grant.
 *
 * Fake thread/message objects are used throughout — deliberately NOT built
 * from GmailApp._seedLiveThread — so these tests touch none of the shared
 * Gmail mock's internal state (_threads/_drafts/_callCounts/_sentIndex),
 * which is the simplest possible guarantee of zero isolation leakage.
 */
function n13_makeFakeMessage_(fromEmail, subject, plainBody) {
  return {
    getFrom: function () { return fromEmail; },
    getSubject: function () { return subject || ''; },
    getPlainBody: function () { return plainBody; },
    getBody: function () { return plainBody; },
    getRawContent: function () {
      return 'From: ' + fromEmail + '\r\nSubject: ' + (subject || '') + '\r\n\r\n' + plainBody;
    }
  };
}

function n13_makeFakeThread_(messages) {
  var id = 'n13-fake-thread-' + Utilities.getUuid();
  return {
    getId: function () { return id; },
    getMessages: function () { return messages; },
    getLabels: function () { return []; },
    addLabel: function () {}
  };
}

/** A READY prospect — passes processThreadForReplies_'s top guard (Replied!=true, Status not BOUNCED/STOPPED). */
function n13_setupReplyProspect_(emailTag) {
  return n5_setupReadyProspect_(emailTag);
}

var KLINNER_FOOTER_TEXT_ = 'Best,\nKlinner Cleaning & Maintenance\nklinnercleaning.com\n\n' +
  '526 Grove Creek Ave, Nashville, TN 37214\n' +
  'If you\'d prefer not to receive further emails from Klinner, reply "unsubscribe" and we\'ll remove you from future outreach.';

function n13_quotedOutboundBody_(newTopText) {
  return newTopText + '\n\nOn Mon, Sep 14, 2026 at 2:30 PM Klinner Cleaning & Maintenance <outreach@klinnerpro.com> wrote:\n' +
    '> Hi there,\n> \n> ' + KLINNER_FOOTER_TEXT_.split('\n').join('\n> ');
}

// ---------------------------------------------------------------------
// Part 6, items 1-10 — positive phrase detection (pure, unit-level).
// ---------------------------------------------------------------------
function test_N13_positivePhrasesDetected_() {
  var cases = [
    'unsubscribe',
    'UNSUBSCRIBE',
    'UnSubScRiBe',
    'please unsubscribe me',
    'stop',
    'stop emailing me',
    'remove me',
    'remove me from your list',
    'do not contact me',
    "don't contact me"
  ];
  cases.forEach(function (text) {
    assert_(detectUnsubscribeIntent_(text), 'Must detect unsubscribe intent in: "' + text + '"');
  });
}

// ---------------------------------------------------------------------
// Part 6, items 11-15 — false-positive prevention.
// ---------------------------------------------------------------------
function test_N13_ordinaryReplyTextDoesNotSuppress_() {
  assert_(!detectUnsubscribeIntent_("Sounds good, let's talk Tuesday!"), 'An ordinary reply must not trigger detection.');
  assert_(!detectUnsubscribeIntent_('Thanks, I stopped by your shop and it looks great.'),
    '"stopped" (not a bare whole-word "stop") must not trigger detection.');
  assert_(!detectUnsubscribeIntent_('We run a nonstop operation here.'), '"nonstop" must not trigger detection.');
}

function test_N13_quotedKlinnerFooterDoesNotSuppress_() {
  var fullBody = n13_quotedOutboundBody_("Sounds good, let's talk Tuesday!");
  assert_(fullBody.indexOf('unsubscribe') !== -1, 'Precondition: the full quoted body must actually contain the word "unsubscribe".');
  var msg = n13_makeFakeMessage_('prospect@example-corp-test.com', 'Re: A quick note', fullBody);
  var isolated = extractNewReplyText_(msg);
  assertEquals_("Sounds good, let's talk Tuesday!", isolated, 'Isolation must cut at the quote boundary.');
  assert_(!detectUnsubscribeIntent_(isolated), 'The quoted Klinner footer must NEVER cause a false unsubscribe detection.');
}

function test_N13_quotedPriorEmailDoesNotFalsePositive_() {
  var fullBody = 'No thanks, not interested right now.\n\n' +
    '> On Mon, Sep 14, 2026, Prospect <prospect@example-corp-test.com> wrote:\n' +
    '> please unsubscribe me from this list\n' +
    '> (this was an OLDER quoted message in the thread, not the new reply)';
  var msg = n13_makeFakeMessage_('prospect@example-corp-test.com', 'Re: A quick note', fullBody);
  var isolated = extractNewReplyText_(msg);
  assertEquals_('No thanks, not interested right now.', isolated);
  assert_(!detectUnsubscribeIntent_(isolated), 'A quoted PRIOR message containing unsubscribe language must not false-positive on the current reply.');
}

function test_N13_quotedLineStartingWithAngleBracketExcluded_() {
  var fullBody = 'Please stop.\n> unsubscribe unsubscribe unsubscribe (quoted spam-like content)';
  var msg = n13_makeFakeMessage_('prospect@example-corp-test.com', '', fullBody);
  var isolated = extractNewReplyText_(msg);
  assertEquals_('Please stop.', isolated, 'The ">"-quoted line and everything after it must be excluded.');
  assert_(detectUnsubscribeIntent_(isolated), 'The genuine new-text "stop" must still be detected once isolated.');
}

function test_N13_signatureOutsideIsolatedTextDoesNotTrigger_() {
  var fullBody = "Let's connect next week.\n\n" +
    'On Tue, Sep 15, 2026 at 9:00 AM Someone <someone@example.com> wrote:\n' +
    '> --\n> Sent from a mailing list. To unsubscribe from THIS unrelated list, click here.';
  var msg = n13_makeFakeMessage_('prospect@example-corp-test.com', '', fullBody);
  var isolated = extractNewReplyText_(msg);
  assertEquals_("Let's connect next week.", isolated);
  assert_(!detectUnsubscribeIntent_(isolated), 'Quoted disclaimer/signature text outside the isolated new reply must not trigger.');
}

// ---------------------------------------------------------------------
// Part 6, items 16-21 — state guarantees on a genuine auto-detected unsubscribe.
// ---------------------------------------------------------------------
function test_N13_autoUnsubscribeSetsAllFourGuarantees_() {
  var p = n13_setupReplyProspect_('n13autostate');
  var config = getConfig();
  var senderEmail = config.SENDER_EMAIL || 'outreach-test@example.com';
  var outbound = n13_makeFakeMessage_(senderEmail, 'A quick note', 'Hi, following up.');
  var inbound = n13_makeFakeMessage_(p.Email, 'Re: A quick note', 'unsubscribe');
  var thread = n13_makeFakeThread_([outbound, inbound]);

  processThreadForReplies_(thread, p, config);

  var after = findRowById_(p.Prospect_ID).values;
  assertEquals_(DNC_REASON.UNSUBSCRIBE, after.Do_Not_Contact_Reason, 'Do_Not_Contact_Reason must be "unsubscribe".');
  assertEquals_(true, after.Stop_Contact, 'Stop_Contact must be true.');
  assertEquals_(STATUS.STOPPED, after.Status, 'Status must be STOPPED (never REPLIED) for an unsubscribe.');
  assertEquals_('', String(after.Next_Action_Date || ''), 'Next_Action_Date must be blank.');
  assertEquals_(false, after.Replied === true, 'Replied must not be forced true by this path (unchanged from setup).');

  var suppressionRow = findSuppressionEntry_(after.Email_Normalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.UNSUBSCRIBE);
  assert_(!!suppressionRow, 'An exact EMAIL-scope Suppression(reason=unsubscribe) row must exist.');
  _testCreatedSuppressionValues.push(after.Email_Normalized);
}

// ---------------------------------------------------------------------
// Part 6, item 22 — duplicate processing is idempotent.
// ---------------------------------------------------------------------
function test_N13_duplicateProcessingIsIdempotent_() {
  var p = n13_setupReplyProspect_('n13dupe');
  var config = getConfig();
  var senderEmail = config.SENDER_EMAIL || 'outreach-test@example.com';
  var outbound = n13_makeFakeMessage_(senderEmail, 'A quick note', 'Hi, following up.');
  var inbound = n13_makeFakeMessage_(p.Email, 'Re: A quick note', 'STOP');
  var thread = n13_makeFakeThread_([outbound, inbound]);

  processThreadForReplies_(thread, p, config);
  var afterFirst = findRowById_(p.Prospect_ID).values;
  _testCreatedSuppressionValues.push(afterFirst.Email_Normalized);

  var countBefore = readAllSuppression_().filter(function (r) {
    return r.Value === afterFirst.Email_Normalized && r.Scope === SUPPRESSION_SCOPE.EMAIL && r.Reason === DNC_REASON.UNSUBSCRIBE;
  }).length;
  assertEquals_(1, countBefore, 'Exactly one Suppression row after the first processing.');

  // Re-process the SAME thread (as a real sweep would if it ran again
  // before the label/window advanced). processThreadForReplies_'s own top
  // guard (Status===STOPPED) must short-circuit before any further write.
  processThreadForReplies_(thread, afterFirst, config);

  var countAfter = readAllSuppression_().filter(function (r) {
    return r.Value === afterFirst.Email_Normalized && r.Scope === SUPPRESSION_SCOPE.EMAIL && r.Reason === DNC_REASON.UNSUBSCRIBE;
  }).length;
  assertEquals_(1, countAfter, 'Reprocessing the same thread must NOT create a second Suppression row.');

  var afterSecond = findRowById_(p.Prospect_ID).values;
  assertEquals_(STATUS.STOPPED, afterSecond.Status);
  assertEquals_(DNC_REASON.UNSUBSCRIBE, afterSecond.Do_Not_Contact_Reason);
}

// ---------------------------------------------------------------------
// Part 6, item 23 — ordinary reply behavior preserved, unchanged.
// ---------------------------------------------------------------------
function test_N13_ordinaryReplyBehaviorUnchanged_() {
  var p = n13_setupReplyProspect_('n13ordinary');
  var config = getConfig();
  var senderEmail = config.SENDER_EMAIL || 'outreach-test@example.com';
  var outbound = n13_makeFakeMessage_(senderEmail, 'A quick note', 'Hi, following up.');
  var inbound = n13_makeFakeMessage_(p.Email, 'Re: A quick note', "Sounds good, let's talk Tuesday!");
  var thread = n13_makeFakeThread_([outbound, inbound]);

  processThreadForReplies_(thread, p, config);

  var after = findRowById_(p.Prospect_ID).values;
  assertEquals_(STATUS.REPLIED, after.Status, 'An ordinary reply must still set Status=REPLIED, unchanged.');
  assertEquals_(true, after.Replied, 'Replied must still be set true, unchanged.');
  assert_(!!after.Replied_At, 'Replied_At must still be populated, unchanged.');
  assertEquals_('', String(after.Next_Action_Date || ''), 'Next_Action_Date still cleared, unchanged.');
  assertEquals_('', String(after.Do_Not_Contact_Reason || ''), 'An ordinary reply must NOT set Do_Not_Contact_Reason.');
  assertEquals_(false, after.Stop_Contact === true, 'An ordinary reply must NOT set Stop_Contact.');
  assert_(!findSuppressionEntry_(after.Email_Normalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.UNSUBSCRIBE),
    'An ordinary reply must NOT create an unsubscribe Suppression row.');
}

// ---------------------------------------------------------------------
// Part 6, items 24-25 — durability: reset cannot reopen; canSend_/eligibility stay blocked.
// ---------------------------------------------------------------------
function test_N13_resetCannotReopenAutoUnsubscribe_() {
  var p = n13_setupReplyProspect_('n13resetblock');
  var config = getConfig();
  var senderEmail = config.SENDER_EMAIL || 'outreach-test@example.com';
  var thread = n13_makeFakeThread_([
    n13_makeFakeMessage_(senderEmail, 'A quick note', 'Hi, following up.'),
    n13_makeFakeMessage_(p.Email, 'Re: A quick note', 'remove me from your list')
  ]);
  processThreadForReplies_(thread, p, config);
  _testCreatedSuppressionValues.push(findRowById_(p.Prospect_ID).values.Email_Normalized);

  var result = resetProspect(p.Prospect_ID);
  assertEquals_(false, result.success, 'resetProspect must refuse a Stop_Contact-blocked, auto-unsubscribed prospect.');

  var after = findRowById_(p.Prospect_ID).values;
  assertEquals_(STATUS.STOPPED, after.Status, 'Status must remain STOPPED after a refused reset attempt.');
  assertEquals_(DNC_REASON.UNSUBSCRIBE, after.Do_Not_Contact_Reason);
}

function test_N13_canSendRemainsBlockedAfterAutoUnsubscribe_() {
  var p = n13_setupReplyProspect_('n13cansendblock');
  var config = getConfig();
  var senderEmail = config.SENDER_EMAIL || 'outreach-test@example.com';
  var thread = n13_makeFakeThread_([
    n13_makeFakeMessage_(senderEmail, 'A quick note', 'Hi, following up.'),
    n13_makeFakeMessage_(p.Email, 'Re: A quick note', 'do not contact me')
  ]);
  processThreadForReplies_(thread, p, config);
  var after = findRowById_(p.Prospect_ID).values;
  _testCreatedSuppressionValues.push(after.Email_Normalized);

  assert_(!canSend_(after, 1, config, new Date()), 'canSend_ must refuse step 1 for an auto-unsubscribed prospect.');
  assert_(!isEligibleForNextStep_(after, config, new Date()), 'isEligibleForNextStep_ must exclude it from any future queue.');
}

// ---------------------------------------------------------------------
// Part 6, item 26 — public-domain email stays EMAIL-scoped, never domain-wide.
// ---------------------------------------------------------------------
function test_N13_publicDomainAutoUnsubscribeStaysEmailScoped_() {
  var uid = Utilities.getUuid().substring(0, 8);
  var email = 'klinner-test-n13publicdomain-' + uid + '@gmail.com';
  var emailNormalized = normalizeEmail_(email);
  var row = addTestProspectRow_({
    Email: email, Email_Normalized: emailNormalized, Domain: 'gmail.com',
    Domain_Type: DOMAIN_TYPE.PUBLIC, Problem_Found: 'x', Status: STATUS.READY
  });
  var id = Utilities.getUuid();
  assignNewProspectIdAndFields_(row, { Prospect_ID: id, Date_Added: new Date(), Status: STATUS.READY },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });
  var p = getTestProspectByRow_(row);

  var config = getConfig();
  var senderEmail = config.SENDER_EMAIL || 'outreach-test@example.com';
  var thread = n13_makeFakeThread_([
    n13_makeFakeMessage_(senderEmail, 'A quick note', 'Hi, following up.'),
    n13_makeFakeMessage_(email, 'Re: A quick note', 'unsubscribe')
  ]);
  processThreadForReplies_(thread, p, config);
  _testCreatedSuppressionValues.push(emailNormalized);

  assert_(!!findSuppressionEntry_(emailNormalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.UNSUBSCRIBE),
    'The exact gmail.com address must have its own EMAIL-scope Suppression row.');
  assert_(!findSuppressionEntry_('gmail.com', SUPPRESSION_SCOPE.DOMAIN),
    'gmail.com itself must NEVER be suppressed at domain scope — every other gmail.com prospect must remain reachable.');
}

// ---------------------------------------------------------------------
// Part 6, items 27-30 — permission surface.
// ---------------------------------------------------------------------
function test_N13_autoUnsubscribeOperationOnlyPermitsApprovedValue_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n13perm1'), Problem_Found: 'x' });
  var id = Utilities.getUuid();
  assignNewProspectIdAndFields_(row, { Prospect_ID: id, Date_Added: new Date(), Status: STATUS.READY },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });

  // Positive: the one value production actually writes.
  writeRowById_(id, { Do_Not_Contact_Reason: DNC_REASON.UNSUBSCRIBE },
    { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_AUTO_UNSUBSCRIBE });
  assertEquals_(DNC_REASON.UNSUBSCRIBE, getTestProspectByRow_(row).Do_Not_Contact_Reason);

  // Negative: no other DNC reason is permitted through this operation.
  var otherReasons = DNC_REASON_VALUES.filter(function (r) { return r !== DNC_REASON.UNSUBSCRIBE; });
  otherReasons.forEach(function (reason) {
    var threw = false;
    try {
      writeRowById_(id, { Do_Not_Contact_Reason: reason }, { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_AUTO_UNSUBSCRIBE });
    } catch (e) { threw = true; }
    assert_(threw, 'SYSTEM_AUTO_UNSUBSCRIBE must reject Do_Not_Contact_Reason="' + reason + '".');
  });

  // Negative: no column outside the approved set (mirrors ADMIN_UNSUBSCRIBE exactly).
  var threwOnColumn = false;
  try {
    writeRowById_(id, { Sequence_Step: 1 }, { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_AUTO_UNSUBSCRIBE });
  } catch (e) { threwOnColumn = true; }
  assert_(threwOnColumn, 'SYSTEM_AUTO_UNSUBSCRIBE must reject a column outside {Stop_Contact, Do_Not_Contact_Reason, Status, Next_Action_Date}.');

  // Negative: no Status outside STOPPED.
  var threwOnStatus = false;
  try {
    writeRowById_(id, { Status: STATUS.IN_SEQUENCE }, { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_AUTO_UNSUBSCRIBE });
  } catch (e) { threwOnStatus = true; }
  assert_(threwOnStatus, 'SYSTEM_AUTO_UNSUBSCRIBE must reject any Status other than STOPPED.');
}

function test_N13_existingSystemOperationsStillCannotWriteUnsubscribe_() {
  var row = addTestProspectRow_({ Email: testUniqueEmail_('n13perm2'), Problem_Found: 'x' });
  var id = Utilities.getUuid();
  assignNewProspectIdAndFields_(row, { Prospect_ID: id, Date_Added: new Date(), Status: STATUS.READY },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE });

  [OPERATION.SYSTEM_REPLY_SYNC, OPERATION.SYSTEM_NIGHTLY_RECON].forEach(function (op) {
    var threw = false;
    try {
      writeRowById_(id, { Do_Not_Contact_Reason: DNC_REASON.UNSUBSCRIBE }, { origin: ORIGIN.SYSTEM, operation: op });
    } catch (e) { threw = true; }
    assert_(threw, 'N13 regression: ' + op + ' must remain structurally forbidden from writing DNC="unsubscribe" — the new operation must not have weakened this.');
  });
}

function test_N13_unrelatedSystemOperationPermissionsUnchanged_() {
  // "No drift" check: the exact shape of the two pre-existing SYSTEM
  // operations' grants, byte-for-byte, must be untouched by this feature.
  var replySync = OPERATION_PERMISSIONS[OPERATION.SYSTEM_REPLY_SYNC];
  assertEquals_(
    JSON.stringify(['Stop_Contact', 'Do_Not_Contact_Reason', 'Status', 'Next_Action_Date', 'Replied', 'Replied_At']),
    JSON.stringify(replySync.columns), 'SYSTEM_REPLY_SYNC columns must be byte-for-byte unchanged.');
  assertEquals_(JSON.stringify([STATUS.REPLIED, STATUS.BOUNCED, STATUS.STOPPED]), JSON.stringify(replySync.statuses),
    'SYSTEM_REPLY_SYNC statuses must be unchanged.');

  var nightlyRecon = OPERATION_PERMISSIONS[OPERATION.SYSTEM_NIGHTLY_RECON];
  assertEquals_(
    JSON.stringify(['Stop_Contact', 'Do_Not_Contact_Reason', 'Status', 'Sequence_Step', 'Next_Action_Date', 'Error_Count', 'Last_Error']),
    JSON.stringify(nightlyRecon.columns), 'SYSTEM_NIGHTLY_RECON columns must be byte-for-byte unchanged.');

  // The new operation's grant must be exactly as wide as ADMIN_UNSUBSCRIBE's (same shape, different origin only).
  var adminUnsub = OPERATION_PERMISSIONS[OPERATION.ADMIN_UNSUBSCRIBE];
  var autoUnsub = OPERATION_PERMISSIONS[OPERATION.SYSTEM_AUTO_UNSUBSCRIBE];
  assertEquals_(JSON.stringify(adminUnsub.columns), JSON.stringify(autoUnsub.columns),
    'SYSTEM_AUTO_UNSUBSCRIBE must have the EXACT SAME column grant as ADMIN_UNSUBSCRIBE — no wider.');
  assertEquals_(JSON.stringify(adminUnsub.statuses), JSON.stringify(autoUnsub.statuses));
  assertEquals_(JSON.stringify(adminUnsub.restrictedValues), JSON.stringify(autoUnsub.restrictedValues));
}

/**
 * N14 (Google-real ReplySync discovery failure, controlled Thread_ID
 * 1a0a125e8dde9823): syncReplies()'s old combined
 * `label:"X" newer_than:3d` query required a SINGLE message to carry both
 * properties, but applyOutreachLabel_ (Mailer.gs) labels only the
 * messages present in a thread at the moment it's called — a later
 * inbound reply never inherits it. Once the labeled outbound message ages
 * past the window, no message satisfies both clauses and the whole
 * thread silently vanishes from discovery, even though the reply is
 * sitting right there. Fixed by decoupling: `label:"X"` alone finds the
 * thread; recency is now checked in code via getLastMessageDate().
 *
 * These tests exercise the FULL syncReplies() -> processThreadForReplies_
 * pipeline (discovery included) — distinct from N13's tests, which called
 * processThreadForReplies_ directly and never touched discovery at all.
 */

/** Forces the reply-sync operational window open, regardless of real time-of-day/timezone — restored in finally. */
function n14_withReplySyncWindowForced_(fn) {
  var original = isWithinReplySyncWindow_;
  isWithinReplySyncWindow_ = function () { return true; };
  try {
    return fn();
  } finally {
    isWithinReplySyncWindow_ = original;
  }
}

/**
 * Builds the EXACT Google-real shape: a thread with one OLD outbound
 * message that already carries the KLINNER/Outreach label (simulating
 * applyOutreachLabel_ having been called days ago), and a prospect row
 * pointing at it. No inbound message yet — callers add one via
 * thread._appendMessageForTest to control its own sender/age/body.
 */
function n14_setupLabeledOldThreadProspect_(emailTag, config, overrides) {
  var email = testUniqueEmail_(emailTag);
  var emailNormalized = normalizeEmail_(email);
  var senderEmail = config.SENDER_EMAIL || 'outreach-test@example.com';
  var labelName = config.GMAIL_LABEL || DEFAULT_GMAIL_LABEL;
  var oldDate = new Date(); oldDate.setDate(oldDate.getDate() - 5); // Older than the 3-day recency window.
  var dueDate = new Date(); dueDate.setDate(dueDate.getDate() - 1); // Already due for step 2 — see canSend_ discriminator note below.

  var thread = GmailApp._seedLiveThread(email, senderEmail, { internalDate: oldDate.getTime() });
  _testCreatedThreadIds_.push(thread.getId());
  var label = GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);
  thread.addLabel(label); // Only the OLD outbound message existed at this point — the real Gmail behavior.

  // Next_Action_Date is deliberately DUE (not blank) by default: this makes
  // canSend_(_, 2, ...) a genuine discriminator in
  // test_N14_canSendProtectionsUnchangedViaFullPipeline_ — if auto-
  // unsubscribe protection were silently skipped (e.g. discovery still
  // broken), this prospect would otherwise be immediately eligible for a
  // real step-2 send. A blank Next_Action_Date would block canSend_ for an
  // unrelated reason (I6) regardless of whether protection actually fired,
  // which would make that test pass even when it shouldn't.
  var base = {
    Prospect_ID: Utilities.getUuid(), Email: email, Email_Normalized: emailNormalized,
    Domain: extractDomain_(emailNormalized), Domain_Type: DOMAIN_TYPE.CORPORATE,
    Problem_Found: 'x', Status: STATUS.IN_SEQUENCE, Sequence_Step: 1,
    Step1_Sent_At: oldDate, Last_Contacted: oldDate, Next_Action_Date: dueDate, Thread_ID: thread.getId()
  };
  var merged = Object.assign({}, base, overrides || {});
  var row = addTestProspectRow_(merged);
  return { p: getTestProspectByRow_(row), thread: thread, email: email, emailNormalized: emailNormalized, senderEmail: senderEmail };
}

// ---------------------------------------------------------------------
// Item 1 — the exact reproduction: old labeled outbound + recent
// UNLABELED inbound reply is discovered and processed.
// ---------------------------------------------------------------------
function test_N14_oldLabeledThreadWithRecentUnlabeledReplyIsDiscovered_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var setup = n14_setupLabeledOldThreadProspect_('n14discover', config);
    setup.thread._appendMessageForTest(setup.email, 'Re: A quick note', "Thanks, I'll take a look.", Date.now());

    syncReplies();

    var after = findRowById_(setup.p.Prospect_ID).values;
    assertEquals_(STATUS.REPLIED, after.Status,
      'A recent inbound reply on an old-labeled thread must be discovered and processed, despite carrying no label itself.');
  });
}

// ---------------------------------------------------------------------
// Item 2 — label-only old thread, no recent inbound activity: skipped.
// ---------------------------------------------------------------------
function test_N14_labelOnlyOldThreadWithNoRecentReplyNotProcessed_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var setup = n14_setupLabeledOldThreadProspect_('n14stale', config);
    // No inbound message appended — the thread's only message is the old outbound one.

    syncReplies();

    var after = findRowById_(setup.p.Prospect_ID).values;
    assertEquals_(STATUS.IN_SEQUENCE, after.Status, 'An old, inactive labeled thread must be skipped — never processed.');
    assertEquals_(false, after.Replied === true);
  });
}

// ---------------------------------------------------------------------
// Item 3 — a thread not mapped to any known prospect Thread_ID is ignored,
// even if labeled and recent.
// ---------------------------------------------------------------------
function test_N14_unmappedThreadIgnoredEvenIfLabeledAndRecent_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var labelName = config.GMAIL_LABEL || DEFAULT_GMAIL_LABEL;
    var senderEmail = config.SENDER_EMAIL || 'outreach-test@example.com';
    var thread = GmailApp._seedLiveThread('unmapped-' + Utilities.getUuid() + '@example-corp-test.com', senderEmail, {});
    _testCreatedThreadIds_.push(thread.getId());
    var label = GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);
    thread.addLabel(label);
    thread._appendMessageForTest('someone-unrelated@example-corp-test.com', 'Re: A quick note', 'unsubscribe', Date.now());
    // Deliberately NO prospect row points at this Thread_ID.

    var before = readAllProspects().length;
    syncReplies(); // Must not throw, must not write anything for an unrecognized thread.
    var after = readAllProspects().length;
    assertEquals_(before, after, 'No prospect row may be created or altered by an unrecognized Gmail thread.');
  });
}

// ---------------------------------------------------------------------
// Item 4 — boundary: a reply just inside the recency window is processed.
// ---------------------------------------------------------------------
function test_N14_replyJustInsideRecencyWindowIsProcessed_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var setup = n14_setupLabeledOldThreadProspect_('n14boundary', config);
    var justInside = new Date(); justInside.setDate(justInside.getDate() - 2); // Inside the default 3-day window.
    setup.thread._appendMessageForTest(setup.email, 'Re: A quick note', 'Yes, interested — send details.', justInside.getTime());

    syncReplies();

    var after = findRowById_(setup.p.Prospect_ID).values;
    assertEquals_(STATUS.REPLIED, after.Status, 'A reply within the recency window (2 of 3 days) must be processed.');
  });
}

// ---------------------------------------------------------------------
// Item 5 — ordinary reply still becomes REPLIED, through the FULL pipeline.
// ---------------------------------------------------------------------
function test_N14_ordinaryReplyBecomesRepliedViaFullPipeline_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var setup = n14_setupLabeledOldThreadProspect_('n14normal', config);
    setup.thread._appendMessageForTest(setup.email, 'Re: A quick note', "Sounds good, let's talk Tuesday!", Date.now());

    syncReplies();

    var after = findRowById_(setup.p.Prospect_ID).values;
    assertEquals_(STATUS.REPLIED, after.Status);
    assertEquals_(true, after.Replied);
    assert_(!!after.Replied_At);
    assertEquals_('', String(after.Do_Not_Contact_Reason || ''));
  });
}

// ---------------------------------------------------------------------
// Item 6 — auto-unsubscribe reply becomes STOPPED + DNC + Suppression,
// through the FULL pipeline (discovery included, not bypassed).
// ---------------------------------------------------------------------
function test_N14_autoUnsubscribeViaFullPipeline_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var setup = n14_setupLabeledOldThreadProspect_('n14fullunsub', config);
    setup.thread._appendMessageForTest(setup.email, 'Re: A quick note', 'unsubscribe', Date.now());

    syncReplies();
    _testCreatedSuppressionValues.push(setup.emailNormalized);

    var after = findRowById_(setup.p.Prospect_ID).values;
    assertEquals_(STATUS.STOPPED, after.Status, 'Must be STOPPED, not REPLIED, once discovery is fixed.');
    assertEquals_(true, after.Stop_Contact);
    assertEquals_(DNC_REASON.UNSUBSCRIBE, after.Do_Not_Contact_Reason);
    assertEquals_('', String(after.Next_Action_Date || ''));
    assert_(!!findSuppressionEntry_(setup.emailNormalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.UNSUBSCRIBE),
      'The auto-unsubscribe Suppression row must exist once the reply is actually discovered.');
  });
}

// ---------------------------------------------------------------------
// Item 7 — quoted Klinner footer does not false-positive, through the
// FULL pipeline.
// ---------------------------------------------------------------------
function test_N14_quotedFooterNoFalsePositiveViaFullPipeline_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var setup = n14_setupLabeledOldThreadProspect_('n14footer', config);
    var fullBody = n13_quotedOutboundBody_("Sounds good, let's talk Tuesday!");
    setup.thread._appendMessageForTest(setup.email, 'Re: A quick note', fullBody, Date.now());

    syncReplies();

    var after = findRowById_(setup.p.Prospect_ID).values;
    assertEquals_(STATUS.REPLIED, after.Status, 'The quoted Klinner footer ("unsubscribe") must NOT trigger auto-unsubscribe once discovery actually finds the message.');
    assertEquals_('', String(after.Do_Not_Contact_Reason || ''));
  });
}

// ---------------------------------------------------------------------
// Item 8 — bounce behavior preserved.
// ---------------------------------------------------------------------
function test_N14_bounceBehaviorPreservedViaFullPipeline_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var setup = n14_setupLabeledOldThreadProspect_('n14bounce', config);
    setup.thread._appendMessageForTest('mailer-daemon@googlemail.com', 'Delivery Status Notification (Failure)',
      'Address not found.', Date.now());

    syncReplies();
    _testCreatedSuppressionValues.push(setup.emailNormalized);

    var after = findRowById_(setup.p.Prospect_ID).values;
    assertEquals_(STATUS.BOUNCED, after.Status);
    assertEquals_(DNC_REASON.BOUNCE, after.Do_Not_Contact_Reason);
    assert_(!!findSuppressionEntry_(setup.emailNormalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.BOUNCE));
  });
}

// ---------------------------------------------------------------------
// Item 9 — autoreply behavior preserved.
// ---------------------------------------------------------------------
function test_N14_autoreplyBehaviorPreservedViaFullPipeline_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var setup = n14_setupLabeledOldThreadProspect_('n14autoreply', config);
    var before = findRowById_(setup.p.Prospect_ID).values;
    setup.thread._appendMessageForTest(setup.email, 'Automatic reply: A quick note', 'I am out of office.', Date.now());

    syncReplies();

    var after = findRowById_(setup.p.Prospect_ID).values;
    assertEquals_(STATUS.IN_SEQUENCE, after.Status, 'An autoreply must not terminate the sequence.');
    assertEquals_(false, after.Replied === true);
    assert_(String(after.Next_Action_Date || '') !== String(before.Next_Action_Date || ''),
      'An autoreply must push Next_Action_Date forward.');
  });
}

// ---------------------------------------------------------------------
// Item 10 — duplicate processing across two full syncReplies() runs stays idempotent.
// ---------------------------------------------------------------------
function test_N14_duplicateSyncRunsRemainIdempotent_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var setup = n14_setupLabeledOldThreadProspect_('n14fulldupe', config);
    setup.thread._appendMessageForTest(setup.email, 'Re: A quick note', 'stop', Date.now());

    syncReplies();
    _testCreatedSuppressionValues.push(setup.emailNormalized);
    var countAfterFirst = readAllSuppression_().filter(function (r) {
      return r.Value === setup.emailNormalized && r.Scope === SUPPRESSION_SCOPE.EMAIL && r.Reason === DNC_REASON.UNSUBSCRIBE;
    }).length;
    assertEquals_(1, countAfterFirst);

    syncReplies(); // Second full run over the exact same Gmail/Sheet state.

    var countAfterSecond = readAllSuppression_().filter(function (r) {
      return r.Value === setup.emailNormalized && r.Scope === SUPPRESSION_SCOPE.EMAIL && r.Reason === DNC_REASON.UNSUBSCRIBE;
    }).length;
    assertEquals_(1, countAfterSecond, 'A second full syncReplies() run must not create a duplicate Suppression row.');
  });
}

// ---------------------------------------------------------------------
// Item 11 — unknown Thread_ID cannot modify a prospect (complementary to
// item 3: here the Gmail thread IS unmapped, checked against a REAL
// concurrently-existing prospect to prove no cross-contamination).
// ---------------------------------------------------------------------
function test_N14_unknownThreadCannotModifyAnyProspect_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var real = n14_setupLabeledOldThreadProspect_('n14realprotected', config);
    // A second, completely unrelated labeled+recent thread with no prospect mapping.
    var labelName = config.GMAIL_LABEL || DEFAULT_GMAIL_LABEL;
    var senderEmail = config.SENDER_EMAIL || 'outreach-test@example.com';
    var strayThread = GmailApp._seedLiveThread('stray-' + Utilities.getUuid() + '@example-corp-test.com', senderEmail, {});
    _testCreatedThreadIds_.push(strayThread.getId());
    var label = GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);
    strayThread.addLabel(label);
    strayThread._appendMessageForTest('stray-prospect@example-corp-test.com', 'Re: A quick note', 'unsubscribe', Date.now());

    var realBefore = findRowById_(real.p.Prospect_ID).values;
    syncReplies();
    var realAfter = findRowById_(real.p.Prospect_ID).values;

    assertEquals_(realBefore.Status, realAfter.Status, 'A real, protected prospect must be untouched by an unrelated unmapped thread.');
    assertEquals_(0, readAllLedgerRows_().filter(function (r) { return r.values.Prospect_ID === real.p.Prospect_ID; }).length);
  });
}

// ---------------------------------------------------------------------
// Item 12 — real/protected prospect isolation: two known prospects, only
// the one with genuinely recent activity changes.
// ---------------------------------------------------------------------
function test_N14_onlyGenuinelyActiveProspectChangesAmongMultiple_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var active = n14_setupLabeledOldThreadProspect_('n14multiactive', config);
    var quiet = n14_setupLabeledOldThreadProspect_('n14multiquiet', config); // No inbound message appended at all.
    active.thread._appendMessageForTest(active.email, 'Re: A quick note', 'Sounds great!', Date.now());

    syncReplies();

    var activeAfter = findRowById_(active.p.Prospect_ID).values;
    var quietAfter = findRowById_(quiet.p.Prospect_ID).values;
    assertEquals_(STATUS.REPLIED, activeAfter.Status);
    assertEquals_(STATUS.IN_SEQUENCE, quietAfter.Status, 'A prospect with no recent activity must remain completely untouched.');
  });
}

// ---------------------------------------------------------------------
// Item 13 — public-domain (gmail.com) suppression stays EMAIL-scoped.
// ---------------------------------------------------------------------
function test_N14_publicDomainSuppressionStaysEmailScopedViaFullPipeline_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var uid = Utilities.getUuid().substring(0, 8);
    var email = 'klinner-test-n14publicdomain-' + uid + '@gmail.com';
    var emailNormalized = normalizeEmail_(email);
    // Prospect row fields override to the real gmail.com address; the
    // inbound message below is explicitly sent From that same address
    // (independent of whatever placeholder recipient the helper used to
    // seed the underlying Gmail thread) — what processThreadForReplies_
    // actually keys on is Thread_ID, not the seed thread's own recipient.
    var setup = n14_setupLabeledOldThreadProspect_('n14publicdomainbase', config, {
      Email: email, Email_Normalized: emailNormalized, Domain: 'gmail.com', Domain_Type: DOMAIN_TYPE.PUBLIC
    });
    setup.thread._appendMessageForTest(email, 'Re: A quick note', 'unsubscribe', Date.now());

    syncReplies();
    _testCreatedSuppressionValues.push(emailNormalized);

    assert_(!!findSuppressionEntry_(emailNormalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.UNSUBSCRIBE));
    assert_(!findSuppressionEntry_('gmail.com', SUPPRESSION_SCOPE.DOMAIN),
      'gmail.com must never be suppressed at domain scope through the full discovery pipeline either.');
  });
}

// ---------------------------------------------------------------------
// Item 14 — canSend_/eligibility protections unchanged, through the FULL pipeline.
// ---------------------------------------------------------------------
function test_N14_canSendProtectionsUnchangedViaFullPipeline_() {
  n14_withReplySyncWindowForced_(function () {
    var config = getConfig();
    var setup = n14_setupLabeledOldThreadProspect_('n14cansend', config);
    // Precondition: absent any protection, this fixture (IN_SEQUENCE, step
    // 1 done, Next_Action_Date already due) would be immediately eligible
    // for a real step-2 send — the genuine discriminator this test needs.
    var before = findRowById_(setup.p.Prospect_ID).values;
    assert_(canSend_(before, 2, config, new Date()), 'Precondition: this fixture must start genuinely eligible for step 2.');

    setup.thread._appendMessageForTest(setup.email, 'Re: A quick note', 'do not contact me', Date.now());
    syncReplies();
    _testCreatedSuppressionValues.push(setup.emailNormalized);

    var after = findRowById_(setup.p.Prospect_ID).values;
    assert_(!canSend_(after, 2, config, new Date()), 'canSend_ must refuse step 2 once auto-unsubscribe protection has actually fired.');
    assert_(!isEligibleForNextStep_(after, config, new Date()));
  });
}

/**
 * Tests 21/22/23 (task's own numbering) are deliberately NOT new tests:
 * 21 — "Step-1 controlled action remains unchanged" is exactly what the
 *      existing N8 suite already proves; sendControlledFixtureStep2Live
 *      never touches sendControlledFixtureLive or doStep1Send_.
 * 22 — "normal sendBatch behavior remains unchanged" is exactly what the
 *      existing N6 batch-hard-stop suite already proves; this change
 *      never touches sendBatch() at all (grep confirms it).
 * 23 — "corrected Gmail API follow-up architecture [explicit-recipient
 *      Gmail.Users.Messages.send/get, MIME, In-Reply-To/References] remains
 *      unchanged" is exactly what the CURRENT, registered follow-up suite
 *      already proves: test_followUpApiSendExceptionIsAmbiguousAndNeverRetried_,
 *      test_followUpApiOutboundOnlyThreadUsesExplicitProspectRecipient_,
 *      test_followUpApiExplicitRecipientMismatchFailsBeforeSend_,
 *      test_followUpApiWrongReturnedRecipientBecomesAmbiguous_,
 *      test_followUpApiReturnedThreadMismatchBecomesAmbiguous_,
 *      test_followUpApiMetadataReadRetriesWithoutResending_,
 *      test_followUpApiExistingAmbiguousKeyBlocksAllGmailCalls_ (all
 *      registered under the N5_followUp* keys below). This change never
 *      touches doFollowUpSend_ — it only calls the unmodified public
 *      sendFollowUp(id, 2).
 *
 *      NOTE (discovered while writing these tests, not introduced by this
 *      change, and deliberately left untouched — out of scope for this
 *      round): four OLDER thread.reply()-based follow-up tests
 *      (test_N5_followUpReplyThrowsDurablyBlocksLedger_,
 *      test_N5_followUpReplyThrowsAndProspectsWriteThrowsStillBlocksAtLedger_,
 *      test_N5_followUpMessageCountMismatchDurablyBlocksEvenIfProspectsWriteFails_,
 *      test_N5_normalConfirmedFollowUpRepliesExactlyOnce_) are still defined
 *      in this file but are no longer referenced by F1_TEST_FUNCTIONS —
 *      an earlier commit that rewrote doFollowUpSend_ onto the explicit-
 *      recipient Gmail API replaced their registry entries with the
 *      test_followUpApi* functions above but left the orphaned originals
 *      in place. They currently execute as dead code. Confirmed by
 *      `grep -c "<name>\]" Tests.gs` returning 0 for each. Flagged here for
 *      whoever next touches Tests.gs; not fixed in this round because it is
 *      unrelated to exact-target controlled Step-2 LIVE.
 * All three are re-confirmed by the full existing suite staying green
 * alongside these new tests.
 */

/**
 * N6: computeNextActionDate_ itself throwing (cadence math failure) after
 * a CONFIRMED send is a distinct path from the Prospects-write failure
 * above — the write would otherwise SUCCEED, but must be forced to
 * NEEDS_REVIEW rather than silently entering IN_SEQUENCE with a blank
 * Next_Action_Date (which would strand the prospect with no future
 * eligibility, a different but equally silent failure mode).
 */
function test_N6_cadenceThrowAfterConfirmedSendForcesNeedsReview_() {
  withLiveModeEnabledForTest_(function () {
    var p = n5_setupReadyProspect_('n6cadencethrow');
    GmailApp._resetCallCounts();

    var originalComputeNextActionDate = computeNextActionDate_;
    computeNextActionDate_ = function () {
      throw new Error('N6 simulated: cadence math failure (e.g. dateFromWallClock_ non-convergence).');
    };

    var outcome;
    try {
      outcome = sendStep1(p.Prospect_ID);
    } finally {
      computeNextActionDate_ = originalComputeNextActionDate;
    }

    assertEquals_('SENT', outcome.status, 'A cadence-math failure must NOT be reported as a persistence failure — the Prospects write itself still succeeds.');

    var ledgerRows = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 1 && r.values.Mode === LEDGER_MODE.LIVE;
    });
    assertEquals_(LEDGER_STATE.SENT, ledgerRows[0].values.State);

    var prospectAfter = findRowById_(p.Prospect_ID).values;
    assertEquals_(STATUS.NEEDS_REVIEW, prospectAfter.Status,
      'A thrown cadence calculation must force NEEDS_REVIEW, never a silent IN_SEQUENCE with no Next_Action_Date.');
    assertEquals_('', prospectAfter.Next_Action_Date, 'Next_Action_Date must be blank, not a guessed/partial value.');
    assertEquals_(1, Number(prospectAfter.Sequence_Step), 'Sequence_Step must still advance — the send itself is real and confirmed.');

    var loggedFailure = _logBuffer.some(function (row) {
      return row[5] === p.Prospect_ID && String(row[8]).indexOf('computeNextActionDate_ threw') !== -1;
    });
    assert_(loggedFailure, 'The cadence failure must be observable in the log.');
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
    GmailApp._resetCallCounts();

    var originalReply = setup.thread.reply;
    setup.thread.reply = function () {
      GmailApp._callCounts.reply++;
      throw new Error('Simulated Gmail reply() failure — ambiguous outcome.');
    };

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
    assertEquals_(1, GmailApp._callCounts.reply,
      'P2-B: total thread.reply() call count across BOTH executions must be EXACTLY 1.');
  });
}

/**
 * N5 ATOMICITY ROUND, P4 — the exact scenario the audit probed by hand,
 * made permanent. This is deliberately the HARDEST version of the
 * follow-up ambiguity, and the one where the two guards disagree:
 *
 *   - thread.reply() IS invoked and throws (outcome ambiguous: the reply
 *     may or may not have gone out),
 *   - the secondary writeRowById_(Prospects -> NEEDS_REVIEW) ALSO throws,
 *     so Prospects is left reading IN_SEQUENCE / Sequence_Step 1 — i.e.
 *     the state machine still considers this prospect perfectly eligible
 *     for step 2,
 *   - the script lock is nevertheless released,
 *   - the very same step is then executed again.
 *
 * Because Prospects still says "eligible", anything that passes here is
 * proof that the block comes from the LEDGER and from nothing else. The
 * test asserts that explicitly: Prospects is verified to be unchanged
 * BEFORE the second attempt, so a green result cannot be explained by
 * canSend_'s state-machine logic having quietly done the work.
 *
 * Total thread.reply() invocations across both executions: EXACTLY 1.
 */
function test_N5_followUpReplyThrowsAndProspectsWriteThrowsStillBlocksAtLedger_() {
  withLiveModeEnabledForTest_(function () {
    var config = getConfig();
    var setup = n5_setupFollowUpDueProspect_('n5followupbothfail', config);
    var p = setup.p;
    GmailApp._resetCallCounts();

    var originalReply = setup.thread.reply;
    setup.thread.reply = function () {
      GmailApp._callCounts.reply++; // count the INVOCATION — Gmail was reached.
      throw new Error('Simulated Gmail reply() failure — ambiguous outcome.');
    };
    var originalWriteRowById = writeRowById_;
    writeRowById_ = function () { throw new Error('Simulated Prospects NEEDS_REVIEW write failure.'); };

    var threw = false;
    try {
      sendFollowUp(p.Prospect_ID, 2);
    } catch (e) {
      threw = true;
    } finally {
      setup.thread.reply = originalReply;
      writeRowById_ = originalWriteRowById;
    }

    assert_(threw, 'sendFollowUp must propagate the ambiguous reply() failure.');
    assert_(!LockService.getScriptLock().hasLock(),
      'The script lock must be released even though both the Gmail call and the Prospects write failed.');
    assertEquals_(1, GmailApp._callCounts.reply, 'Exactly one thread.reply() invocation so far.');

    var ledgerRows = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === p.Prospect_ID && r.values.Step === 2 && r.values.Mode === LEDGER_MODE.LIVE;
    });
    assertEquals_(1, ledgerRows.length, 'Exactly one LIVE ledger row must exist for step 2.');
    assertEquals_(LEDGER_STATE.AMBIGUOUS, ledgerRows[0].values.State,
      'The ledger row must be durably AMBIGUOUS even though the secondary Prospects write ALSO failed.');

    // The crux: Prospects was NOT updated, so it still looks eligible.
    var freshRow = findRowById_(p.Prospect_ID);
    assertEquals_(STATUS.IN_SEQUENCE, freshRow.values.Status,
      'Precondition for this test: the Prospects write failed, so Status must still read IN_SEQUENCE (still "eligible").');
    assertEquals_(1, Number(freshRow.values.Sequence_Step),
      'Precondition for this test: Sequence_Step must be untouched, so the state machine still considers step 2 due.');
    assert_(isLiveKeyBlocked_(p.Prospect_ID, 2),
      'The LEDGER — not Prospects.Status — must be what blocks this key.');

    var messagesBefore = setup.thread.getMessages().length;
    var second = sendFollowUp(p.Prospect_ID, 2);
    assert_(second.status !== 'SENT',
      'A second execution must never send, even with Prospects still reading IN_SEQUENCE.');
    assertEquals_(messagesBefore, setup.thread.getMessages().length,
      'No new message may have been appended to the thread.');
    assertEquals_(1, GmailApp._callCounts.reply,
      'P4: total thread.reply() invocations across BOTH executions must be EXACTLY 1.');
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
    GmailApp._resetCallCounts();

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
    assertEquals_(1, GmailApp._callCounts.reply,
      'P2-C: total thread.reply() call count across BOTH executions must be EXACTLY 1 after an ambiguous message-count outcome.');
  });
}

/** N5 item 12: the normal, unedited confirmed follow-up path — exactly one real reply. */
function test_N5_normalConfirmedFollowUpRepliesExactlyOnce_() {
  withLiveModeEnabledForTest_(function () {
    var config = getConfig();
    var setup = n5_setupFollowUpDueProspect_('n5followupnormal', config);
    var p = setup.p;
    GmailApp._resetCallCounts();

    var messagesBefore = setup.thread.getMessages().length;
    var outcome = sendFollowUp(p.Prospect_ID, 2);
    assertEquals_('SENT', outcome.status, 'A normal follow-up send must succeed.');
    assertEquals_(1, GmailApp._callCounts.reply, 'P2-E: a normal confirmed follow-up must call thread.reply() EXACTLY once.');
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

/** Follow-up API: an outbound-only thread must explicitly target the Prospect, never its sender. */
function test_followUpApiOutboundOnlyThreadUsesExplicitProspectRecipient_() {
  withLiveModeEnabledForTest_(function () {
    var config = getConfig();
    var setup = n5_setupFollowUpDueProspect_('api-explicit-to', config);
    GmailApp._resetCallCounts();

    var outcome = sendFollowUp(setup.p.Prospect_ID, 2);
    assertEquals_('SENT', outcome.status);
    assertEquals_(1, GmailApp._callCounts.apiSend, 'Advanced Gmail messages.send must be invoked exactly once.');
    assertEquals_(0, GmailApp._callCounts.reply, 'GmailThread.reply must never be invoked.');

    var messages = setup.thread.getMessages();
    assertEquals_(2, messages.length, 'Exactly one follow-up message must be added.');
    var sent = messages[1];
    assertEquals_(setup.p.Email_Normalized, normalizeEmail_(sent.getTo()), 'To must be the prospect, never the executing sender.');
    assertEquals_(config.SENDER_EMAIL, extractEmailForFingerprint_(sent.getFrom()));
    assertEquals_(setup.thread.getId(), sent._threadId, 'The existing Gmail threadId must be preserved.');
    assertEquals_('<mock-' + setup.priorMessageId + '@example.test>', sent._headers['In-Reply-To']);
    assert_(sent._headers.References.indexOf(sent._headers['In-Reply-To']) !== -1,
      'References must include the previous RFC Message-ID.');
  });
}

/** A mismatch between raw Email and Email_Normalized must fail before claim and before Gmail. */
function test_followUpApiExplicitRecipientMismatchFailsBeforeSend_() {
  withLiveModeEnabledForTest_(function () {
    var config = getConfig();
    var setup = n5_setupFollowUpDueProspect_('api-to-mismatch', config);
    var found = findRowById_(setup.p.Prospect_ID);
    getSheet_(SHEET_NAMES.PROSPECTS).getRange(found.rowIndex, PROSPECTS_COLUMNS.Email).setValue('different-recipient@example.net');
    GmailApp._resetCallCounts();

    var outcome = sendFollowUp(setup.p.Prospect_ID, 2);
    assertEquals_('NEEDS_REVIEW_FOLLOWUP_METADATA', outcome.status);
    assertEquals_(0, GmailApp._callCounts.apiSend, 'Recipient mismatch must block before Gmail messages.send.');
    var rows = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === setup.p.Prospect_ID && r.values.Step === 2 && r.values.Mode === LEDGER_MODE.LIVE;
    });
    assertEquals_(0, rows.length, 'A pre-send validation failure must not create a LIVE claim.');
  });
}

function test_followUpApiSendExceptionIsAmbiguousAndNeverRetried_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n5_setupFollowUpDueProspect_('api-send-throws', getConfig());
    GmailApp._resetCallCounts();
    var originalSend = Gmail.Users.Messages.send;
    Gmail.Users.Messages.send = function () {
      GmailApp._callCounts.apiSend++;
      throw new Error('Simulated uncertain Gmail API messages.send failure.');
    };
    var threw = false;
    try { sendFollowUp(setup.p.Prospect_ID, 2); } catch (e) { threw = true; }
    finally { Gmail.Users.Messages.send = originalSend; }
    assert_(threw, 'The uncertain send exception must be surfaced.');

    var row = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === setup.p.Prospect_ID && r.values.Step === 2 && r.values.Mode === LEDGER_MODE.LIVE;
    })[0];
    assertEquals_(LEDGER_STATE.AMBIGUOUS, row.values.State);
    assertEquals_(1, GmailApp._callCounts.apiSend);
    var replay = sendFollowUp(setup.p.Prospect_ID, 2);
    assert_(replay.status !== 'SENT');
    assertEquals_(1, GmailApp._callCounts.apiSend, 'Replay of an AMBIGUOUS key must make zero additional send calls.');
  });
}

function test_followUpApiWrongReturnedRecipientBecomesAmbiguous_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n5_setupFollowUpDueProspect_('api-wrong-to', getConfig());
    GmailApp._resetCallCounts();
    var originalGet = Gmail.Users.Messages.get;
    Gmail.Users.Messages.get = function (userId, messageId, options) {
      var resource = originalGet(userId, messageId, options);
      if (messageId !== setup.priorMessageId) {
        resource.payload.headers.forEach(function (h) { if (h.name === 'To') h.value = 'jhessyca@example.test'; });
      }
      return resource;
    };
    var threw = false;
    try { sendFollowUp(setup.p.Prospect_ID, 2); } catch (e) { threw = true; }
    finally { Gmail.Users.Messages.get = originalGet; }
    assert_(threw, 'A returned message with the wrong To must be ambiguous.');
    var row = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === setup.p.Prospect_ID && r.values.Step === 2 && r.values.Mode === LEDGER_MODE.LIVE;
    })[0];
    assertEquals_(LEDGER_STATE.AMBIGUOUS, row.values.State);
    assertEquals_(1, GmailApp._callCounts.apiSend, 'Verification failure must never retry SEND.');
  });
}

function test_followUpApiReturnedThreadMismatchBecomesAmbiguous_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n5_setupFollowUpDueProspect_('api-wrong-thread', getConfig());
    GmailApp._resetCallCounts();
    var originalSend = Gmail.Users.Messages.send;
    Gmail.Users.Messages.send = function (resource, userId) {
      var result = originalSend(resource, userId);
      result.threadId = 'wrong-thread-id';
      return result;
    };
    var threw = false;
    try { sendFollowUp(setup.p.Prospect_ID, 2); } catch (e) { threw = true; }
    finally { Gmail.Users.Messages.send = originalSend; }
    assert_(threw, 'A returned threadId mismatch must be ambiguous.');
    var row = readAllLedgerRows_().filter(function (r) {
      return r.values.Prospect_ID === setup.p.Prospect_ID && r.values.Step === 2 && r.values.Mode === LEDGER_MODE.LIVE;
    })[0];
    assertEquals_(LEDGER_STATE.AMBIGUOUS, row.values.State);
    assertEquals_(1, GmailApp._callCounts.apiSend);
  });
}

function test_followUpApiMetadataReadRetriesWithoutResending_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n5_setupFollowUpDueProspect_('api-read-retry', getConfig());
    GmailApp._resetCallCounts();
    var originalGet = Gmail.Users.Messages.get;
    var transientFailures = 0;
    Gmail.Users.Messages.get = function (userId, messageId, options) {
      if (messageId !== setup.priorMessageId && transientFailures < 2) {
        transientFailures++;
        GmailApp._callCounts.apiGet++;
        throw new Error('Simulated eventual-consistency read miss.');
      }
      return originalGet(userId, messageId, options);
    };
    var outcome;
    try { outcome = sendFollowUp(setup.p.Prospect_ID, 2); }
    finally { Gmail.Users.Messages.get = originalGet; }
    assertEquals_('SENT', outcome.status);
    assertEquals_(2, transientFailures, 'Two bounded read failures must be tolerated.');
    assertEquals_(1, GmailApp._callCounts.apiSend, 'Read retries must never retry the SEND.');
  });
}

function test_followUpApiExistingAmbiguousKeyBlocksAllGmailCalls_() {
  withLiveModeEnabledForTest_(function () {
    var setup = n5_setupFollowUpDueProspect_('api-existing-ambiguous', getConfig());
    appendLedgerRow_({
      Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: setup.p.Prospect_ID,
      Email_Normalized: setup.p.Email_Normalized, Step: 2,
      Idempotency_Key: getIdempotencyKey_(setup.p.Prospect_ID, 2), Mode: LEDGER_MODE.LIVE,
      State: LEDGER_STATE.AMBIGUOUS, Thread_ID: setup.thread.getId(), Message_ID: '', Draft_ID: '',
      Confirmed_At: '', Error: 'controlled ambiguity'
    });
    GmailApp._resetCallCounts();
    var outcome = sendFollowUp(setup.p.Prospect_ID, 2);
    assertEquals_('SKIPPED_ALREADY_CLAIMED', outcome.status);
    assertEquals_(0, GmailApp._callCounts.apiGet, 'Ledger guard must run before Gmail metadata reads.');
    assertEquals_(0, GmailApp._callCounts.apiSend, 'AMBIGUOUS must block Gmail send.');
  });
}

function test_step2TemplateIncludesWebsite_() {
  var template = getActiveTemplateForStep_(2);
  assert_(template && template.Active === true);
  assert_(String(template.Body || '').indexOf('klinnercleaning.com') !== -1,
    'The reusable Step-2 template must include the Klinner website.');
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

/**
 * P3 (Codex re-audit): Recon must NEVER infer SENT from a generic
 * recipient search — "in:sent to:<email>" matches any message ever sent
 * to that address, including a previous step or an unrelated manual
 * email. Every stale CLAIMED outcome must be AMBIGUOUS regardless of how
 * many matches the search returns, and the counters must describe what
 * actually happened.
 */
function n5_seedStaleClaim_(emailTag, config) {
  var row = addTestProspectRow_({ Email: testUniqueEmail_(emailTag), Problem_Found: 'x' });
  var p = getTestProspectByRow_(row);
  var staleClaimedAt = new Date();
  staleClaimedAt.setMinutes(staleClaimedAt.getMinutes() - (config.CLAIM_STALE_MINUTES + 30));
  appendLedgerRow_({
    Run_ID: getRunId_(), Claimed_At: staleClaimedAt, Prospect_ID: p.Prospect_ID, Email_Normalized: normalizeEmail_(p.Email),
    Step: 1, Idempotency_Key: getIdempotencyKey_(p.Prospect_ID, 1), Mode: LEDGER_MODE.LIVE, State: LEDGER_STATE.CLAIMED,
    Thread_ID: '', Message_ID: '', Draft_ID: '', Confirmed_At: '', Error: ''
  });
  return p;
}

function n5_ledgerStateFor_(prospectId, step) {
  var rows = readAllLedgerRows_().filter(function (r) {
    return r.values.Prospect_ID === prospectId && r.values.Step === step && r.values.Mode === LEDGER_MODE.LIVE;
  });
  return rows.length === 1 ? rows[0].values.State : ('UNEXPECTED_ROW_COUNT_' + rows.length);
}

/** P3 case 2: exactly ONE unrelated match must still be AMBIGUOUS, never SENT. */
function test_N5_reconSingleUnrelatedMatchIsStillAmbiguous_() {
  var config = getConfig();
  var p = n5_seedStaleClaim_('n5reconone', config);

  var originalSearch = GmailApp.search;
  GmailApp.search = function () {
    return [{ getId: function () { return 'unrelated-thread'; }, getMessages: function () { return []; } }];
  };
  var counters;
  try {
    counters = reconcileStaleLiveClaims_(config);
  } finally {
    GmailApp.search = originalSearch;
  }

  assertEquals_(LEDGER_STATE.AMBIGUOUS, n5_ledgerStateFor_(p.Prospect_ID, 1),
    'P3: exactly one search match must NOT be treated as proof of SENT — a generic recipient search cannot identify THIS step.');
  assert_(isLiveKeyBlocked_(p.Prospect_ID, 1), 'The key must remain blocked.');
  assertEquals_(1, counters.ambiguous, 'Counters must report one ambiguous outcome.');
  assertEquals_(0, counters.searchErrors, 'No search error occurred.');
}

/** P3 case 3: multiple matches must also be AMBIGUOUS. */
function test_N5_reconMultipleMatchesAreAmbiguous_() {
  var config = getConfig();
  var p = n5_seedStaleClaim_('n5reconmany', config);

  var originalSearch = GmailApp.search;
  GmailApp.search = function () {
    return [
      { getId: function () { return 't1'; }, getMessages: function () { return []; } },
      { getId: function () { return 't2'; }, getMessages: function () { return []; } }
    ];
  };
  try {
    reconcileStaleLiveClaims_(config);
  } finally {
    GmailApp.search = originalSearch;
  }

  assertEquals_(LEDGER_STATE.AMBIGUOUS, n5_ledgerStateFor_(p.Prospect_ID, 1), 'Multiple matches must be AMBIGUOUS.');
  assert_(isLiveKeyBlocked_(p.Prospect_ID, 1), 'The key must remain blocked.');
}

/** P3 case 7: counters must honestly describe outcomes, including on a search error. */
function test_N5_reconCountersAreHonest_() {
  var config = getConfig();
  var p = n5_seedStaleClaim_('n5reconcounters', config);

  var originalSearch = GmailApp.search;
  GmailApp.search = function () { throw new Error('Simulated search failure.'); };
  var counters;
  try {
    counters = reconcileStaleLiveClaims_(config);
  } finally {
    GmailApp.search = originalSearch;
  }

  assertEquals_(1, counters.examined, 'One stale row was examined.');
  assertEquals_(1, counters.searchErrors, 'The search error must be counted as an error...');
  assertEquals_(1, counters.unchanged, '...and as unchanged...');
  assertEquals_(0, counters.ambiguous, '...and must NOT be counted as an ambiguous resolution.');
  assert_(!counters.hasOwnProperty('resolved'), 'There must be no "resolved" counter — nothing is ever auto-resolved under this policy.');
  assertEquals_(LEDGER_STATE.CLAIMED, n5_ledgerStateFor_(p.Prospect_ID, 1), 'A search error must leave the row untouched (still CLAIMED).');
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

/** Step-1 production copy: reusable merge fields, website, CTA and F0 footer all render exactly. */
function test_step1WebsiteAndApprovedManageCopy_() {
  var config = Object.assign({}, getConfig(), {
    SENDER_NAME: 'Klinner Cleaning & Maintenance',
    PHYSICAL_ADDRESS: '526 Grove Creek Ave, Nashville, TN 37214',
    UNSUBSCRIBE_LINE: 'If you\'d prefer not to receive further emails from Klinner, reply "unsubscribe" and we\'ll remove you from future outreach.'
  });
  var prospect = {
    Business_Name: 'Manage My Nashville Property',
    Contact_Name: '',
    City: 'Nashville',
    State: 'TN',
    Problem_Found: 'your team manages short-term rentals and includes professional cleaning as part of the operation',
    Personalization_Line: 'Klinner Cleaning & Maintenance provides local cleaning support in Nashville, including turnover cleaning and flexible backup when your regular team needs extra capacity.'
  };
  var rendered = renderTemplateForStep_(1, prospect, config);
  var expectedBody = 'Hi there,\n\n' +
    'I was looking at Manage My Nashville Property and noticed your team manages short-term rentals and includes professional cleaning as part of the operation.\n\n' +
    'Klinner Cleaning & Maintenance provides local cleaning support in Nashville, including turnover cleaning and flexible backup when your regular team needs extra capacity.\n\n' +
    'Would you be open to a quick conversation to see if we could be useful when you need additional coverage?\n\n' +
    'Best,\nKlinner Cleaning & Maintenance\nklinnercleaning.com\n\n' +
    '526 Grove Creek Ave, Nashville, TN 37214\n' +
    'If you\'d prefer not to receive further emails from Klinner, reply "unsubscribe" and we\'ll remove you from future outreach.';

  assertEquals_('A quick note about Manage My Nashville Property', rendered.subject,
    'Step-1 subject must preserve the reusable Business_Name merge field.');
  assertEquals_(expectedBody, rendered.body,
    'Step-1 must render the approved Manage copy, website, clear CTA and compliance footer exactly.');
  assert_(rendered.body.indexOf('{{') === -1 && rendered.body.indexOf('PENDING_F0') === -1 &&
    rendered.body.indexOf('TEST EDIT') === -1 && rendered.body.indexOf('KLINNER PREVIEW') === -1,
    'Rendered production copy must contain no broken variables, F0 placeholders or test/preview markers.');
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

function captureLiveControlRawForTest_() {
  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  var out = {};
  for (var i = 0; i < LIVE_CONTROL_KEYS_.length; i++) {
    var key = LIVE_CONTROL_KEYS_[i];
    out[key] = sheet.getRange(findUniqueConfigRow_(key), 2).getValue();
  }
  return out;
}

function restoreLiveControlRawForTest_(snapshot) {
  var sheet = getSheet_(SHEET_NAMES.CONFIG);
  for (var i = 0; i < LIVE_CONTROL_KEYS_.length; i++) {
    var key = LIVE_CONTROL_KEYS_[i];
    sheet.getRange(findUniqueConfigRow_(key), 2).setValue(snapshot[key]);
  }
  resetConfigCache_();
}

function test_liveConfigControlExactArmAndSafeRestoreNoSideEffects_() {
  var baseline = captureLiveControlRawForTest_();
  var originalWrite = writeLiveControlValueExact_;
  var gmailBefore = JSON.stringify(GmailApp._callCounts);
  var sentBefore = MailApp._sent.length;
  var prospectsBefore = JSON.stringify(getSheet_(SHEET_NAMES.PROSPECTS).data);
  var ledgerBefore = JSON.stringify(getSheet_(SHEET_NAMES.SEND_LEDGER).data);
  try {
    restoreSafeLiveConfig();
    var armOrder = [];
    writeLiveControlValueExact_ = function (key, value) {
      armOrder.push(key + '=' + value);
      return originalWrite(key, value);
    };
    var armed = armLiveConfig(3);
    writeLiveControlValueExact_ = originalWrite;
    assertEquals_(false, armed.PAUSE_ALL, 'ARMED must disable PAUSE_ALL last.');
    assertEquals_(false, armed.DRY_RUN, 'ARMED must set DRY_RUN=FALSE.');
    assertEquals_(3, armed.MAX_PER_DAY, 'ARMED must use the exact approved daily cap.');
    assertEquals_(1, armed.MAX_PER_RUN, 'ARMED must force MAX_PER_RUN=1.');
    assertEquals_('PAUSE_ALL=true|MAX_PER_RUN=1|MAX_PER_DAY=3|DRY_RUN=false|PAUSE_ALL=false', armOrder.join('|'),
      'ARMED write order must keep PAUSE_ALL TRUE until the final write.');

    var restoreOrder = [];
    writeLiveControlValueExact_ = function (key, value) {
      restoreOrder.push(key + '=' + value);
      return originalWrite(key, value);
    };
    var safe = restoreSafeLiveConfig();
    writeLiveControlValueExact_ = originalWrite;
    assertEquals_(true, safe.PAUSE_ALL, 'SAFE must restore PAUSE_ALL=TRUE.');
    assertEquals_(true, safe.DRY_RUN, 'SAFE must restore DRY_RUN=TRUE.');
    assertEquals_(1, safe.MAX_PER_DAY, 'SAFE must restore MAX_PER_DAY=1.');
    assertEquals_(1, safe.MAX_PER_RUN, 'SAFE must preserve MAX_PER_RUN=1.');
    assertEquals_('PAUSE_ALL=true|DRY_RUN=true|MAX_PER_DAY=1|MAX_PER_RUN=1', restoreOrder.join('|'),
      'SAFE restoration must write PAUSE_ALL=TRUE first.');
    assertEquals_(gmailBefore, JSON.stringify(GmailApp._callCounts), 'Config controls must invoke no Gmail primitive.');
    assertEquals_(sentBefore, MailApp._sent.length, 'Config controls must send no MailApp email.');
    assertEquals_(prospectsBefore, JSON.stringify(getSheet_(SHEET_NAMES.PROSPECTS).data), 'Config controls must not mutate Prospects.');
    assertEquals_(ledgerBefore, JSON.stringify(getSheet_(SHEET_NAMES.SEND_LEDGER).data), 'Config controls must not mutate SendLedger.');
  } finally {
    writeLiveControlValueExact_ = originalWrite;
    restoreLiveControlRawForTest_(baseline);
  }
}

function test_liveConfigControlRejectsMalformedValuesWithoutWrites_() {
  var baseline = captureLiveControlRawForTest_();
  var boolRejected = false;
  var intRejected = false;
  try {
    try { normalizeLiveControlValue_('PAUSE_ALL', 'FALSEFALSE'); } catch (e) { boolRejected = true; }
    try { armLiveConfig('3x'); } catch (e2) { intRejected = true; }
    assert_(boolRejected, 'Malformed boolean input must be rejected.');
    assert_(intRejected, 'Malformed integer input must be rejected before any write.');
    assertEquals_(JSON.stringify(baseline), JSON.stringify(captureLiveControlRawForTest_()),
      'Malformed input must leave every LIVE control cell unchanged.');
  } finally {
    restoreLiveControlRawForTest_(baseline);
  }
}

function test_liveConfigControlPartialArmAndReadBackFailureFailClosed_() {
  var baseline = captureLiveControlRawForTest_();
  var originalWrite = writeLiveControlValueExact_;
  try {
    restoreSafeLiveConfig();
    var corruptedOnce = false;
    writeLiveControlValueExact_ = function (key, value) {
      var result = originalWrite(key, value);
      if (!corruptedOnce && key === 'MAX_PER_DAY' && value === 3) {
        corruptedOnce = true;
        getSheet_(SHEET_NAMES.CONFIG).getRange(findUniqueConfigRow_(key), 2).setValue('3oops');
        resetConfigCache_();
      }
      return result;
    };
    var threw = false;
    try { armLiveConfig(3); } catch (e) { threw = true; }
    assert_(threw, 'A corrupted read-back must abort arming.');
    assertLiveControlStateExact_({ PAUSE_ALL: true, DRY_RUN: true, MAX_PER_DAY: 1, MAX_PER_RUN: 1 },
      'Partial-arm recovery');
  } finally {
    writeLiveControlValueExact_ = originalWrite;
    restoreLiveControlRawForTest_(baseline);
  }
}

function test_liveConfigControlRestorationFailureIsLoudAndPaused_() {
  var baseline = captureLiveControlRawForTest_();
  var originalWrite = writeLiveControlValueExact_;
  try {
    restoreSafeLiveConfig();
    armLiveConfig(3);
    writeLiveControlValueExact_ = function (key, value) {
      if (key === 'DRY_RUN' && value === true) throw new Error('Simulated SAFE restoration write failure.');
      return originalWrite(key, value);
    };
    var message = '';
    try { restoreSafeLiveConfig(); } catch (e) { message = String(e.message || e); }
    assert_(message.indexOf('SAFE Config restoration FAILED') !== -1,
      'Restoration failure must be surfaced loudly, not reported as success.');
    assertEquals_(true, readLiveControlValueExact_('PAUSE_ALL').value,
      'PAUSE_ALL must already be TRUE before any later restoration step can fail.');
  } finally {
    writeLiveControlValueExact_ = originalWrite;
    try { restoreSafeLiveConfig(); } catch (ignored) {}
    restoreLiveControlRawForTest_(baseline);
  }
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
  var expected = ['Draft_Fingerprint', 'Human_Edit_Preserved', 'Human_Edit_Detected_At'];
  var originalHeader = sheet.getRange(1, startCol, 1, expected.length).getValues();
  var lastRow = Math.max(sheet.getLastRow(), 1);
  var originalCoreColumns = sheet.getRange(1, 1, lastRow, startCol - 1).getValues();

  try {
    // Case 1: all three headers missing (a pre-fix sheet).
    sheet.getRange(1, startCol, 1, expected.length).clearContent();
    var result = repairSendLedgerColumns_();
    assert_(result.indexOf('Repaired') === 0, 'It must report which headers it repaired.');
    assertEquals_(JSON.stringify(expected), JSON.stringify(sheet.getRange(1, startCol, 1, expected.length).getValues()[0]),
      'All three headers must be written exactly.');

    // Case 2: idempotent — a second call is a no-op.
    var second = repairSendLedgerColumns_();
    assert_(second.indexOf('already has all three') !== -1, 'A second call must be a no-op.');

    // Case 3 (P6, Codex re-audit): N correct but O/P wrong. The old
    // version only checked N1, so it reported "nothing to repair" and
    // left a half-migrated sheet in place.
    sheet.getRange(1, startCol + 1).setValue('WRONG_HEADER');
    sheet.getRange(1, startCol + 2).clearContent();
    var partial = repairSendLedgerColumns_();
    assert_(partial.indexOf('Repaired') === 0, 'A partially-correct header row must still be repaired, not reported as done.');
    assertEquals_(JSON.stringify(expected), JSON.stringify(sheet.getRange(1, startCol, 1, expected.length).getValues()[0]),
      'All three headers must be correct after repairing a partial migration.');

    // Case 4: columns A-M and every data row are untouched throughout.
    assertEquals_(JSON.stringify(originalCoreColumns), JSON.stringify(sheet.getRange(1, 1, lastRow, startCol - 1).getValues()),
      'Columns A-M (headers AND data rows) must be byte-identical.');

    // Case 5: the grid is wide enough for column P.
    if (typeof sheet.getMaxColumns === 'function') {
      assert_(sheet.getMaxColumns() >= startCol + expected.length - 1, 'The sheet grid must be wide enough to hold column P.');
    }
  } finally {
    sheet.getRange(1, startCol, 1, expected.length).setValues(originalHeader); // guarantee restoration
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
  ['dstAudit_validWallClocks', test_dstAudit_validWallClocksNearTransitions_],
  ['dstAudit_addCalendarDaysAcrossTransitions', test_dstAudit_addCalendarDaysAcrossTransitions_],
  ['dstAudit_nonexistentAndAmbiguousPolicy', test_dstAudit_nonexistentAndAmbiguousWallClocksFollowDocumentedPolicy_],
  ['dstAudit_sendReplyWindows', test_dstAudit_sendAndReplyWindowsCorrectAcrossTransitions_],
  ['dstAudit_businessDayCadenceWeekend', test_dstAudit_businessDayCadenceAcrossTransitionWeekend_],
  ['T18', test_T18_pauseAllBlocksPreview_],
  ['T19', test_T19_dryRunNeverWritesProspects_],
  ['T21', test_T21_blankNextActionDateIgnored_],
  ['T23', test_T23_followUpsPrioritizedOverNewProspects_],
  ['T25', test_T25_draftRegenerationLeavesOnlyOneLiveDraft_NEEDS_LIVE_GMAIL_],
  ['T28', test_T28_liveBlockedWhilePendingF0_],
  ['checkLiveReadiness', test_checkLiveReadinessIsReadOnlyAndMatchesAssertLiveAllowed_],
  ['T29_T30_T31_T32', test_T29_T30_T31_T32_unsubscribeAndResetGuards_],
  ['T33', test_T33_validateAllRowsPersistsUnderDryRun_],
  ['T34', test_T34_originSeparation_],
  ['adminUnsubscribeCompleteAndIdempotent', test_adminUnsubscribeCompletesFromBlankReasonAndIsIdempotent_],
  ['adminUnsubscribeFailuresFailClosed', test_adminUnsubscribeFailuresAreVisibleAndFailClosed_],
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
  ['N3v3_orphanGap_draftGetId', test_N3v3_creationFailure_draftGetIdThrows_],
  ['N3v3_orphanGap_getMessage', test_N3v3_creationFailure_getMessageThrows_],
  ['N3v3_orphanGap_getThread', test_N3v3_creationFailure_getThreadThrows_],
  ['N3v3_orphanGap_threadGetId', test_N3v3_creationFailure_threadGetIdThrows_],
  ['N3v3_orphanGap_unrelatedEnumError', test_N3v3_unrelatedDraftEnumerationErrorFailsClosedOnLaterRun_],
  ['N3v3_orphanGap_finalTransitionFail', test_N3v3_finalTransitionFailureLeavesClaimBlockingAndNoDuplicate_],
  ['N3atomic_stateWriteFailsMetadataDurable', test_N3atomic_finalStateWriteFailureLeavesMetadataDurableAndClaimBlocking_],
  ['N3atomic_metadataWriteFailsNoDraftedState', test_N3atomic_metadataWriteFailureNeverPublishesDraftedState_],
  ['N3atomic_incompleteDraftedBlocksCreateNew', test_N3atomic_incompleteDraftedRowNeverAuthorizesCreateNew_],
  ['configCache_baselineNullRestored', test_configCache_baselineNullIsRestoredToNull_],
  ['configCache_baselineObjectRestoredExactly', test_configCache_baselineObjectIsRestoredExactly_],
  ['configCache_divergenceDetected', test_configCache_divergentCacheIsDetectedAsContamination_],
  ['N3v3_unc_draftGetId', test_N3v3_uncompensable_draftGetIdThrows_],
  ['N3v3_unc_getMessage', test_N3v3_uncompensable_getMessageThrows_],
  ['N3v3_unc_getThread', test_N3v3_uncompensable_getThreadThrows_],
  ['N3v3_unc_threadGetId', test_N3v3_uncompensable_threadGetIdThrows_],
  ['N3v3_unc_contentRead', test_N3v3_uncompensable_contentReadThrows_],
  ['N3v3_createDraftThrows', test_N3v3_createDraftThrowsBlocksKeyDurably_],
  ['N3v3_claimResolvesToDrafted', test_N3v3_normalPreviewClaimResolvesToDraftedExactlyOnce_],
  ['N3v3_enumErrorKeepsProtection', test_N3v3_enumerationErrorDoesNotEraseDurableProtection_],
  ['N3v3_recipientWrapperNoFalsePositive', test_N3v3_recipientDisplayNameWrapperDoesNotFalsePositive_],
  ['finding5_previewLocking', test_finding5_previewLocksCriticalSection_],
  ['finding6_ledgerFailureNoDraft', test_finding6_ledgerFailureMeansNoDraftIsEverCreated_],
  ['finding8_liveEntryPoint', test_finding8_liveHelpersAreNotGlobalEntryPoints_],
  ['N5_step1ThrowsDurableBlock', test_N5_step1SendThrowsDurablyBlocksLedgerEvenIfProspectsWriteFails_],
  ['N5_step1NormalExactlyOnce', test_N5_normalConfirmedStep1SendsExactlyOnce_],
  ['N5_followUpThrowsDurableBlock', test_followUpApiSendExceptionIsAmbiguousAndNeverRetried_],
  ['N5_followUpExplicitRecipient', test_followUpApiOutboundOnlyThreadUsesExplicitProspectRecipient_],
  ['N5_followUpRecipientMismatchPreSend', test_followUpApiExplicitRecipientMismatchFailsBeforeSend_],
  ['N5_followUpWrongReturnedRecipient', test_followUpApiWrongReturnedRecipientBecomesAmbiguous_],
  ['N5_followUpReturnedThreadMismatch', test_followUpApiReturnedThreadMismatchBecomesAmbiguous_],
  ['N5_followUpMetadataReadRetries', test_followUpApiMetadataReadRetriesWithoutResending_],
  ['N5_followUpExistingAmbiguousBlocks', test_followUpApiExistingAmbiguousKeyBlocksAllGmailCalls_],
  ['N5_multipleLiveClaimedAmbiguousBlocks', test_N5_multipleLiveClaimedAndAmbiguousRowsBlockWithoutSend_],
  ['N5_multipleLiveClaimedSentBlocks', test_N5_multipleLiveClaimedAndSentRowsBlockWithoutSend_],
  ['N6_postSendPersistenceFallbackSucceeds', test_N6_postSendPersistenceFailureFallbackSucceeds_],
  ['N6_postSendPersistenceExactIncidentReproduction', test_N6_postSendPersistenceFailureFallbackAlsoFailsExactIncidentReproduction_],
  ['N6_cadenceThrowForcesNeedsReview', test_N6_cadenceThrowAfterConfirmedSendForcesNeedsReview_],
  ['N6_batchHardStopsAfterPersistenceFailure', test_N6_batchHardStopsAfterPostSendPersistenceFailure_],
  ['N6_batchDoesNotStopOnOrdinaryOutcomes', test_N6_batchDoesNotStopOnOrdinaryOutcomes_],
  ['N8_acceptedFixtureReachesPrimitive', test_N8_approvedControlledFixtureReachesRealPrimitiveAndSendsNormally_],
  ['N8_realProspectRejected', test_N8_normalRealProspectRejectedBeforeGmail_],
  ['N8_similarSourceRejected', test_N8_similarButNotAllowlistedSourceRejected_],
  ['N8_stopContactRejected', test_N8_stopContactFixtureRejected_],
  ['N8_dncRejected', test_N8_dncFixtureRejected_],
  ['N8_repliedRejected', test_N8_repliedFixtureRejected_],
  ['N8_suppressedRejected', test_N8_suppressedFixtureRejected_],
  ['N8_malformedEmailRejected', test_N8_malformedEmailFixtureRejected_],
  ['N8_emailMismatchRejected', test_N8_emailNormalizationMismatchFixtureRejected_],
  ['N8_liveClaimedBlocks', test_N8_existingLiveClaimedRowBlocksFixture_],
  ['N8_liveSentBlocks', test_N8_existingLiveSentRowBlocksFixture_],
  ['N8_liveAmbiguousBlocks', test_N8_existingLiveAmbiguousRowBlocksFixture_],
  ['N8_configNotArmedRejected', test_N8_configNotArmedFixtureRejected_],
  ['N8_outsideWindowRejected', test_N8_outsideSendWindowFixtureRejected_],
  ['N8_quotaExhaustedRejected', test_N8_dailyQuotaExhaustedFixtureRejected_],
  ['N8_maxPerRunNotOneRejected', test_N8_maxPerRunNotOneFixtureRejected_],
  ['N8_postSendPersistenceN6Semantics', test_N8_postSendPersistenceFailureRetainsN6SemanticsViaFixturePath_],
  ['N8_doesNotDisturbQueueOrdering', test_N8_fixturePathDoesNotDisturbNormalQueueOrdering_],
  ['N9_acceptedFixtureBecomesEligible', test_N9_approvedFixtureSucceedsAndBecomesEligibleViaCanSend_],
  ['N9_realProspectRejected', test_N9_realProspectRejectedBeforeWrite_],
  ['N9_wrongSourceRejected', test_N9_wrongSourceRejected_],
  ['N9_wrongStatusRejected', test_N9_wrongStatusRejected_],
  ['N9_wrongSequenceStepRejected', test_N9_wrongSequenceStepRejected_],
  ['N9_missingStep1SentAtRejected', test_N9_missingStep1SentAtRejected_],
  ['N9_missingThreadIdRejected', test_N9_missingThreadIdRejected_],
  ['N9_missingLastMessageIdRejected', test_N9_missingLastMessageIdRejected_],
  ['N9_repliedRejected', test_N9_repliedFixtureRejected_],
  ['N9_stopContactRejected', test_N9_stopContactFixtureRejected_],
  ['N9_dncRejected', test_N9_dncFixtureRejected_],
  ['N9_suppressedRejected', test_N9_suppressedFixtureRejected_],
  ['N9_blockingLiveStep2Rejected', test_N9_blockingLiveStep2RowRejected_],
  ['N9_onlyNextActionDateChanges', test_N9_onlyNextActionDateFieldChanges_],
  ['N9_realProspectsUntouched', test_N9_realProspectsRemainUntouched_],
  ['N10_acceptedFixtureStep2Succeeds', test_N10_approvedFixtureStep2SucceedsThroughNormalPrimitive_],
  ['N10_realProspectRejected', test_N10_realProspectRejectedBeforeGmail_],
  ['N10_wrongSourceRejected', test_N10_wrongSourceRejected_],
  ['N10_readyStatusRejected', test_N10_readyStatusRejected_],
  ['N10_wrongSequenceStepRejected', test_N10_wrongSequenceStepRejected_],
  ['N10_missingStep1SentAtRejected', test_N10_missingStep1SentAtRejected_],
  ['N10_missingThreadIdRejected', test_N10_missingThreadIdRejected_],
  ['N10_missingLastMessageIdRejected', test_N10_missingLastMessageIdRejected_],
  ['N10_notDueRejected', test_N10_notDueFixtureRejected_],
  ['N10_repliedRejected', test_N10_repliedFixtureRejected_],
  ['N10_stopContactRejected', test_N10_stopContactFixtureRejected_],
  ['N10_dncRejected', test_N10_dncFixtureRejected_],
  ['N10_suppressedRejected', test_N10_suppressedFixtureRejected_],
  ['N10_blockingLiveStep2Rejected', test_N10_existingBlockingLiveStep2RowBlocksFixture_],
  ['N10_configNotArmedRejected', test_N10_configNotArmedFixtureRejected_],
  ['N10_outsideWindowRejected', test_N10_outsideSendWindowFixtureRejected_],
  ['N10_quotaExhaustedRejected', test_N10_dailyQuotaExhaustedFixtureRejected_],
  ['N10_maxPerRunNotOneRejected', test_N10_maxPerRunNotOneFixtureRejected_],
  ['N10_postSendPersistenceN6Semantics', test_N10_postSendPersistenceFailureRetainsN6SemanticsViaStep2FixturePath_],
  ['N11_validPreSendRecoveryOnlyStatus', test_N11_validControlledPreSendFailureRecoversOnlyStatus_],
  ['N11_realAndWrongSourceRejected', test_N11_realProspectAndWrongSourceRejected_],
  ['N11_invalidFixtureStateRejected', test_N11_recoveryRejectsInvalidFixtureState_],
  ['N11_suppressionAndLiveHistoryRejected', test_N11_suppressionAndEveryLiveHistoryBlockRecovery_],
  ['N12_realAppsScriptGmailByteArray', test_N12_realAppsScriptGmailByteArrayBody_],
  ['N12_gmailBase64UrlRealShapes', test_N12_gmailBase64UrlDecoderHandlesRealPayloadShapes_],
  ['N12_gmailBase64UrlMalformedFailsClosed', test_N12_gmailBase64UrlDecoderRejectsMalformedOrAmbiguousPayloads_],
  ['N12_followUpSenderAndReplyHeadersVerified', test_N12_followUpVerificationRejectsSenderAndReplyHeaderMismatches_],
  ['N12_followUpBodyVerified', test_N12_followUpVerificationRejectsBodyMismatch_],
  ['N12_exactAmbiguousReconciliation', test_N12_exactAmbiguousIncidentReconcilesWithoutSendAndIsIdempotent_],
  ['N12_reconciliationResumesAfterLedgerCommit', test_N12_reconciliationResumesAfterLedgerCommitWithoutSending_],
  ['N12_reconciliationGuards', test_N12_reconciliationRejectsWrongTargetAndUnsafeEvidence_],
  ['N12_reconciliationGmailEvidence', test_N12_reconciliationRejectsGmailMismatchOrDuplicate_],
  ['N13_positivePhrasesDetected', test_N13_positivePhrasesDetected_],
  ['N13_ordinaryReplyTextNoSuppress', test_N13_ordinaryReplyTextDoesNotSuppress_],
  ['N13_quotedKlinnerFooterNoSuppress', test_N13_quotedKlinnerFooterDoesNotSuppress_],
  ['N13_quotedPriorEmailNoFalsePositive', test_N13_quotedPriorEmailDoesNotFalsePositive_],
  ['N13_quotedAngleBracketExcluded', test_N13_quotedLineStartingWithAngleBracketExcluded_],
  ['N13_signatureOutsideIsolatedTextNoTrigger', test_N13_signatureOutsideIsolatedTextDoesNotTrigger_],
  ['N13_autoUnsubscribeSetsGuarantees', test_N13_autoUnsubscribeSetsAllFourGuarantees_],
  ['N13_duplicateProcessingIdempotent', test_N13_duplicateProcessingIsIdempotent_],
  ['N13_ordinaryReplyBehaviorUnchanged', test_N13_ordinaryReplyBehaviorUnchanged_],
  ['N13_resetCannotReopen', test_N13_resetCannotReopenAutoUnsubscribe_],
  ['N13_canSendRemainsBlocked', test_N13_canSendRemainsBlockedAfterAutoUnsubscribe_],
  ['N13_publicDomainStaysEmailScoped', test_N13_publicDomainAutoUnsubscribeStaysEmailScoped_],
  ['N13_operationOnlyPermitsApprovedValue', test_N13_autoUnsubscribeOperationOnlyPermitsApprovedValue_],
  ['N13_existingSystemOpsStillCannotUnsubscribe', test_N13_existingSystemOperationsStillCannotWriteUnsubscribe_],
  ['N13_unrelatedPermissionsUnchanged', test_N13_unrelatedSystemOperationPermissionsUnchanged_],
  ['N14_oldLabeledRecentUnlabeledReplyDiscovered', test_N14_oldLabeledThreadWithRecentUnlabeledReplyIsDiscovered_],
  ['N14_labelOnlyOldThreadNotProcessed', test_N14_labelOnlyOldThreadWithNoRecentReplyNotProcessed_],
  ['N14_unmappedThreadIgnored', test_N14_unmappedThreadIgnoredEvenIfLabeledAndRecent_],
  ['N14_replyJustInsideWindowProcessed', test_N14_replyJustInsideRecencyWindowIsProcessed_],
  ['N14_ordinaryReplyRepliedFullPipeline', test_N14_ordinaryReplyBecomesRepliedViaFullPipeline_],
  ['N14_autoUnsubscribeFullPipeline', test_N14_autoUnsubscribeViaFullPipeline_],
  ['N14_quotedFooterNoFalsePositiveFullPipeline', test_N14_quotedFooterNoFalsePositiveViaFullPipeline_],
  ['N14_bounceBehaviorPreservedFullPipeline', test_N14_bounceBehaviorPreservedViaFullPipeline_],
  ['N14_autoreplyBehaviorPreservedFullPipeline', test_N14_autoreplyBehaviorPreservedViaFullPipeline_],
  ['N14_duplicateSyncRunsIdempotent', test_N14_duplicateSyncRunsRemainIdempotent_],
  ['N14_unknownThreadCannotModifyProspect', test_N14_unknownThreadCannotModifyAnyProspect_],
  ['N14_onlyActiveProspectChangesAmongMultiple', test_N14_onlyGenuinelyActiveProspectChangesAmongMultiple_],
  ['N14_publicDomainStaysEmailScopedFullPipeline', test_N14_publicDomainSuppressionStaysEmailScopedViaFullPipeline_],
  ['N14_canSendProtectionsUnchangedFullPipeline', test_N14_canSendProtectionsUnchangedViaFullPipeline_],
  ['N5_reconZeroSearchNeverRetryable', test_N5_reconStaleClaimZeroSearchResultsNeverBecomesRetryable_],
  ['N5_reconSearchErrorFailsClosed', test_N5_reconStaleClaimSearchErrorFailsClosed_],
  ['N5_reconSingleMatchAmbiguous', test_N5_reconSingleUnrelatedMatchIsStillAmbiguous_],
  ['N5_reconMultipleMatchesAmbiguous', test_N5_reconMultipleMatchesAreAmbiguous_],
  ['N5_reconCountersHonest', test_N5_reconCountersAreHonest_],
  ['N5_reconDigestNeverConvertAmbiguous', test_N5_reconAndDigestNeverConvertAmbiguousKeyToRetryable_],
  ['finding9_quotaBudget', test_finding9_quotaBudgetRespectsAllFourFactors_],
  ['finding10_canSendSequence', test_finding10_canSendEnforcesStepSequence_],
  ['finding11_brokenThreadPreview', test_finding11_previewSkipsOnBrokenThreadReference_],
  ['finding12_protectionPolicy', test_finding12_protectionEditorPolicyNeverThrows_],
  ['finding13_publicDomainToggle', test_finding13_publicDomainPolicyToggleIsConsulted_],
  ['finding14_whitespaceBlank', test_finding14_whitespaceOnlyFieldsCountAsBlank_],
  ['step1WebsiteApprovedManageCopy', test_step1WebsiteAndApprovedManageCopy_],
  ['step2Website', test_step2TemplateIncludesWebsite_],
  ['configValuePlainTextFormat', test_configValueColumnIsPlainTextFormatted_],
  ['liveConfigExactArmSafeRestore', test_liveConfigControlExactArmAndSafeRestoreNoSideEffects_],
  ['liveConfigRejectsMalformed', test_liveConfigControlRejectsMalformedValuesWithoutWrites_],
  ['liveConfigPartialArmFailsClosed', test_liveConfigControlPartialArmAndReadBackFailureFailClosed_],
  ['liveConfigRestoreFailureLoud', test_liveConfigControlRestorationFailureIsLoudAndPaused_],
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

    // P4 (Codex re-audit): the isolation check used to look ONLY at sheet
    // rows, so a test that left a Gmail draft, a seeded thread, a held
    // lock, or a monkey-patched mock method behind still reported
    // "clean". Snapshot the whole shared sandbox before the test so
    // verifyCleanTestState_ can diff it afterwards.
    var sandboxBefore = snapshotSandboxState_();

    var testError = null;
    try {
      fn();
    } catch (e) {
      testError = String(e.message || e);
    }

    var cleanupError = null;
    try {
      cleanupTestArtifacts_(testRunId, sandboxBefore);
    } catch (e) {
      cleanupError = String(e.message || e);
    }

    var isolation = { clean: false, detail: 'not checked' };
    try {
      isolation = verifyCleanTestState_(testRunId, sandboxBefore);
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
function cleanupTestArtifacts_(testRunId, sandboxBefore) {
  flushLog_(); // Force out anything still buffered so it's actually in the sheet to clean.

  var ledgerRows = readAllLedgerRows_().filter(function (r) { return r.values.Run_ID === testRunId; });
  ledgerRows.forEach(function (r) {
    if (r.values.Mode === LEDGER_MODE.DRY_RUN && r.values.State === LEDGER_STATE.DRAFTED && r.values.Draft_ID) {
      deletePreviewDraftIfOwned_(r.values.Draft_ID, r.values); // Best-effort; already-gone or unverifiable is fine here.
    }
  });

  // P4: shared Gmail mock state — threads this test seeded, plus any
  // thread a real (mock) send created and recorded on one of its ledger
  // rows. Only the mock exposes _removeThreadForTest; against real Apps
  // Script this is a no-op, which is correct (we never delete real threads).
  if (typeof GmailApp._removeThreadForTest === 'function') {
    ledgerRows.forEach(function (r) {
      if (r.values.Thread_ID) _testCreatedThreadIds_.push(r.values.Thread_ID);
    });
    _testCreatedThreadIds_.forEach(function (threadId) {
      try { GmailApp._removeThreadForTest(threadId); } catch (e) { /* best effort */ }
    });
  }
  _testCreatedThreadIds_ = [];

  // P3 (Codex atomicity round): the rest of the shared Gmail mock state.
  // Call counters and labels are genuinely shared and genuinely mutated by
  // tests, so teardown restores them to the baseline this test STARTED
  // from. That is what makes a residual counter or a stray label a real,
  // detectable leak in verifyCleanTestState_ rather than business as usual.
  if (sandboxBefore) {
    if (sandboxBefore.callCounts && typeof GmailApp._setCallCounts === 'function') {
      try { GmailApp._setCallCounts(sandboxBefore.callCounts); } catch (e) { /* best effort */ }
    }
    if (sandboxBefore.labelNames && typeof GmailApp._removeLabelForTest === 'function') {
      try {
        var baselineLabels = {};
        sandboxBefore.labelNames.forEach(function (n) { baselineLabels[n] = true; });
        GmailApp._labelNames().forEach(function (n) {
          if (!baselineLabels[n]) GmailApp._removeLabelForTest(n);
        });
      } catch (e) { /* best effort */ }
    }
  }

  cleanupTestLedgerAndLog_(testRunId);
  cleanupTestRows_(); // Prospects fixtures + tracked Suppression rows for this test.

  // P1: put the shared Config cache back exactly as this test found it.
  // Restoring the captured baseline (rather than just nulling the cache)
  // is what makes the check in verifyCleanTestState_ meaningful for a test
  // that legitimately started with a populated cache.
  if (sandboxBefore && sandboxBefore.configCache) {
    try { restoreConfigCache_(sandboxBefore.configCache); } catch (e) { /* best effort */ }
  }

  // Anything the teardown steps above logged is still buffered; flush and
  // sweep again so no Log row escapes into the NEXT test's baseline.
  flushLog_();
  cleanupTestLedgerAndLog_(testRunId);
}

/**
 * N6: a positive check that teardown actually worked, not just an
 * assumption. Only checks what THIS test could have touched — pre-existing
 * production data (on a non-dedicated test spreadsheet) is untouched by
 * design and must not trip this.
 */
/**
 * P4 (Codex re-audit): captures every piece of SHARED sandbox state a
 * test could leave dirty, so verifyCleanTestState_ can diff it after
 * teardown. Codex found the previous isolation check reported 77/77
 * "clean" while two Gmail drafts were actually left behind — it only
 * looked at sheet rows. Gmail drafts, seeded threads, the script lock,
 * and monkey-patched mock/global functions are all real cross-test
 * contamination vectors and are all captured here.
 */
/**
 * P1 (Codex test-infra round): _configCache (Config.gs) is shared mutable
 * state and was invisible to the isolation gate. A suite could start with
 * the cache null, end with it populated, and still report clean; worse, a
 * test could leave `_configCache.MAX_PER_DAY = 999` while the Config sheet
 * still read 5, and every later test would silently run against a
 * configuration that exists nowhere on the sheet. Sheet-content comparison
 * cannot see this at all — the sheet is untouched; the divergence lives
 * entirely in memory.
 *
 * The baseline model has to distinguish three states, not two:
 *   - null            nothing cached yet (the suite's own starting state)
 *   - object, value V cached, agreeing with the sheet
 *   - object, value W cached, DIVERGING from the sheet
 * so the signature encodes null-ness and the full key/value content.
 * Values are strings, numbers, booleans and string arrays (see
 * coerceConfigValue_), so JSON with sorted keys is a faithful, comparable
 * rendering.
 */
function configCacheSignature_(cache) {
  if (cache === null || cache === undefined) return 'NULL';
  var keys = [];
  for (var k in cache) { if (cache.hasOwnProperty(k)) keys.push(k); }
  keys.sort();
  return JSON.stringify(keys.map(function (key) { return [key, cache[key]]; }));
}

/**
 * Captures the cache as both a comparable signature and a deep copy, so
 * teardown can put back EXACTLY what was there — never a hardcoded set of
 * values, and never the same object reference (a test that mutated the
 * cache in place would otherwise be "restored" to its own mutation).
 */
function captureConfigCache_() {
  var cache = (typeof _configCache === 'undefined') ? null : _configCache;
  return {
    signature: configCacheSignature_(cache),
    deep: (cache === null || cache === undefined) ? null : JSON.parse(JSON.stringify(cache))
  };
}

function restoreConfigCache_(captured) {
  if (!captured || captured.deep === null) {
    resetConfigCache_();
    return;
  }
  _configCache = JSON.parse(JSON.stringify(captured.deep));
}

/**
 * Reads the Config sheet ignoring whatever is cached, then puts the cache
 * back exactly as it was. Used for the COHERENCE check below, which is
 * deliberately independent of the baseline comparison: it catches a cache
 * that disagrees with the sheet even when the baseline was already
 * divergent, which a before/after signature diff would happily call
 * "unchanged".
 */
function readConfigFromSheetIgnoringCache_() {
  var saved = (typeof _configCache === 'undefined') ? null : _configCache;
  _configCache = null;
  var fresh;
  try {
    fresh = getConfig();
  } finally {
    _configCache = saved;
  }
  return fresh;
}

/** @return {string|null} a description of the divergence, or null if coherent. */
function configCacheCoherenceProblem_() {
  var cache = (typeof _configCache === 'undefined') ? null : _configCache;
  if (cache === null || cache === undefined) return null; // nothing cached: nothing to diverge.
  var cachedSig = configCacheSignature_(cache);
  var sheetSig = configCacheSignature_(readConfigFromSheetIgnoringCache_());
  if (cachedSig === sheetSig) return null;
  return 'cached Config diverges from the Config sheet';
}

/**
 * P3 (Codex atomicity round): the real content of a shared sheet, as one
 * comparable string. Row-count and marker-based checks let a test leak
 * anything it wrote under a foreign Run_ID or without the test marker —
 * an untracked Suppression row being the case Codex named. Comparing the
 * actual cell content before and after closes that whole class at once.
 */
function sheetContentSignature_(sheetName) {
  try {
    var sheet = getSheet_(sheetName);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return '';
    var width = sheet.getMaxColumns();
    var values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
    return values.map(function (row) {
      return row.map(function (cell) {
        return (cell instanceof Date) ? ('D' + cell.getTime()) : String(cell);
      }).join('~|~');
    }).join('~//~');
  } catch (e) {
    return 'SIGNATURE_FAILED:' + e;
  }
}

function snapshotSandboxState_() {
  var draftIds = [];
  try {
    GmailApp.getDrafts().forEach(function (d) {
      try { draftIds.push(d.getId()); } catch (e) { draftIds.push('UNREADABLE_DRAFT'); }
    });
  } catch (e) { draftIds = ['DRAFT_ENUMERATION_FAILED']; }

  var threadIds = [];
  try {
    if (GmailApp._threads) { for (var tid in GmailApp._threads) { if (GmailApp._threads.hasOwnProperty(tid)) threadIds.push(tid); } }
  } catch (e) { threadIds = ['THREAD_ENUMERATION_FAILED']; }

  // P3: the FULL Gmail mock signature — drafts (with subjects), threads
  // WITH their message lists, labels, the sent index, and the call
  // counters. The id lists above stay because they give a precise "which
  // ones" message; this catches everything they cannot see.
  var gmailState = null;
  var callCounts = null;
  try {
    if (typeof GmailApp._stateSignature === 'function') gmailState = GmailApp._stateSignature();
    if (GmailApp._callCounts) {
      callCounts = {
        createDraft: GmailApp._callCounts.createDraft, createDraftReply: GmailApp._callCounts.createDraftReply,
        send: GmailApp._callCounts.send, reply: GmailApp._callCounts.reply,
        apiSend: GmailApp._callCounts.apiSend, apiGet: GmailApp._callCounts.apiGet,
        apiThreadGet: GmailApp._callCounts.apiThreadGet
      };
    }
  } catch (e) { gmailState = { drafts: 'GMAIL_STATE_FAILED', threads: '', labels: '', sentIndex: '', callCounts: '' }; }

  var labelNames = [];
  try {
    if (typeof GmailApp._labelNames === 'function') labelNames = GmailApp._labelNames();
  } catch (e) { labelNames = ['LABEL_ENUMERATION_FAILED']; }

  // Identity of the shared functions tests monkey-patch. Comparing the
  // references (not calling them) catches any override left installed.
  var patchables = {
    'GmailApp.createDraft': GmailApp.createDraft,
    'GmailApp.getDrafts': GmailApp.getDrafts,
    'GmailApp.search': GmailApp.search,
    'GmailApp.getThreadById': GmailApp.getThreadById,
    'Gmail.Users.Messages.send': Gmail.Users.Messages.send,
    'Gmail.Users.Messages.get': Gmail.Users.Messages.get,
    'Gmail.Users.Threads.get': Gmail.Users.Threads.get,
    'Session.getEffectiveUser': Session.getEffectiveUser,
    'appendLedgerRow_': appendLedgerRow_,
    'updateLedgerRow_': updateLedgerRow_,
    'writeLedgerMetadataThenState_': writeLedgerMetadataThenState_,
    'getLedgerSheet_': getLedgerSheet_,
    'writeRowById_': writeRowById_
  };

  // P1: shared in-memory Config cache — see configCacheSignature_.
  var configCache = captureConfigCache_();

  // P3: real sheet CONTENT, not row counts or markers.
  var sheets = {
    Prospects: sheetContentSignature_(SHEET_NAMES.PROSPECTS),
    SendLedger: sheetContentSignature_(SHEET_NAMES.SEND_LEDGER),
    Log: sheetContentSignature_(SHEET_NAMES.LOG),
    Suppression: sheetContentSignature_(SHEET_NAMES.SUPPRESSION)
  };

  return {
    draftIds: draftIds, threadIds: threadIds, patchables: patchables,
    gmailState: gmailState, callCounts: callCounts, labelNames: labelNames, sheets: sheets,
    configCache: configCache
  };
}

function diffIdList_(before, after) {
  var beforeCounts = {};
  before.forEach(function (id) { beforeCounts[id] = (beforeCounts[id] || 0) + 1; });
  var extra = [];
  after.forEach(function (id) {
    if (beforeCounts[id]) beforeCounts[id]--;
    else extra.push(id);
  });
  return extra;
}

function verifyCleanTestState_(testRunId, sandboxBefore) {
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

  // P4: the shared Gmail/mock sandbox, not just the sheets.
  if (sandboxBefore) {
    var after = snapshotSandboxState_();

    var extraDrafts = diffIdList_(sandboxBefore.draftIds, after.draftIds);
    if (extraDrafts.length > 0) problems.push(extraDrafts.length + ' Gmail draft(s) left behind (' + extraDrafts.join(', ') + ')');

    var extraThreads = diffIdList_(sandboxBefore.threadIds, after.threadIds);
    if (extraThreads.length > 0) problems.push(extraThreads.length + ' Gmail thread(s) left behind (' + extraThreads.join(', ') + ')');

    var patched = [];
    for (var name in sandboxBefore.patchables) {
      if (!sandboxBefore.patchables.hasOwnProperty(name)) continue;
      if (after.patchables[name] !== sandboxBefore.patchables[name]) patched.push(name);
    }
    if (patched.length > 0) problems.push('mock/global override(s) not restored: ' + patched.join(', '));

    // P3: the rest of the shared Gmail mock — labels, call counters, the
    // sent index, and thread CONTENT (a reply appended to a pre-existing
    // thread leaves both id lists above identical, so only this catches it).
    if (sandboxBefore.gmailState && after.gmailState) {
      ['labels', 'sentIndex', 'callCounts', 'threads', 'drafts'].forEach(function (field) {
        if (after.gmailState[field] !== sandboxBefore.gmailState[field]) {
          problems.push('Gmail mock ' + field + ' not restored (before="' + sandboxBefore.gmailState[field] +
            '" after="' + after.gmailState[field] + '")');
        }
      });
    }

    // P1: the shared in-memory Config cache. Two independent checks,
    // because they fail on different things: the first catches "this test
    // changed the cache and did not put it back", the second catches "the
    // cache no longer agrees with the sheet" even if it was already wrong
    // before this test ran.
    if (sandboxBefore.configCache) {
      if (after.configCache.signature !== sandboxBefore.configCache.signature) {
        problems.push('_configCache not restored (before=' + sandboxBefore.configCache.signature.slice(0, 120) +
          ' after=' + after.configCache.signature.slice(0, 120) + ')');
      }
    }
    var coherence = configCacheCoherenceProblem_();
    if (coherence) problems.push(coherence);

    // P3: real sheet CONTENT, so a row written under a foreign Run_ID or
    // without the test marker cannot slip past the checks above.
    if (sandboxBefore.sheets && after.sheets) {
      for (var sheetName in sandboxBefore.sheets) {
        if (!sandboxBefore.sheets.hasOwnProperty(sheetName)) continue;
        if (after.sheets[sheetName] !== sandboxBefore.sheets[sheetName]) {
          problems.push(sheetName + ' sheet content changed (untracked row(s) left behind)');
        }
      }
    }
  }

  try {
    var lock = LockService.getScriptLock();
    if (typeof lock.hasLock === 'function' && lock.hasLock()) problems.push('script lock still held');
  } catch (e) { /* real Apps Script has no hasLock() — skip */ }

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
