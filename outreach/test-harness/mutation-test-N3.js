'use strict';
/**
 * N3 V3 (Codex final audit — durable Gmail preview ownership, hardened)
 * mutation test. Proves TEN independent protections are load-bearing,
 * each caught by a distinct, narrow test:
 *
 *   A. Removing the durable-preserve branch in resolveExistingPreviewDraft_
 *      must break N3_caso2_messageIdRotates.
 *   B. Neutering the fingerprint comparison in verifyPreviewDraftOwnership_
 *      must break N3_caso3_messageIdStable (the SAME-Message_ID edit case
 *      only a fingerprint check, not Message_ID, can catch).
 *   C. Turning a message.getId() read error into a permissive fallback
 *      must break N3_caso8_messageIdError.
 *   D. Reverting the legacy-blank-fingerprint handling back to the old
 *      "blank fingerprint = unedited" bug must break the legacy tests
 *      (Rosa/Acme).
 *   E. Reverting preserveDraftDurably_'s write order (append-then-
 *      supersede) back to supersede-then-append must break the
 *      partial-append-failure safety test.
 *   F. Disabling previewStep's fail-closed creation-metadata guard (so a
 *      "healthy" DRAFTED row with a blank fingerprint can be written
 *      again) must break the creation-failure tests.
 *   G. (round 2) Reintroducing the orphan-draft gap — a post-creation
 *      Gmail read moved back OUTSIDE previewStep()'s unified protected
 *      block — must break the getThread()-failure test (the exception
 *      would otherwise escape uncaught).
 *
 * Run: node test-harness/mutation-test-N3.js
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

/** mutators: optional { 'Mailer.gs': fn, 'Ledger.gs': fn, ... } */
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

// --- Mutation A: remove the durable-preserve branch entirely. ---
var EDITED_BLOCK =
  "  if (verification.edited) {\n" +
  "    // CASO 2 / CASO 3 / CASO 5 / CASO 9(legacy): durable preserve. Wrapped\n" +
  "    // in try/catch (blocker N3-4): if the transition itself throws partway,\n" +
  "    // fail closed rather than let an uncaught exception propagate with\n" +
  "    // unknown ledger state — the ambiguity guard above is what actually\n" +
  "    // protects a partially-applied transition on the NEXT run.\n" +
  "    var reasonTag = verification.legacy ? 'LEGACY_BASELINE_PRESERVED' : 'HUMAN_EDIT_PRESERVED';\n" +
  "    try {\n" +
  "      preserveDraftDurably_(existing.rowIndex, existing.values, verification, reasonTag);\n" +
  "    } catch (e) {\n" +
  "      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, existing.values.Email_Normalized, step,\n" +
  "        'preserveDraftDurably_ failed for Draft_ID=' + existing.values.Draft_ID + ': ' + e +\n" +
  "        '. Fail-closed: left untouched, no new draft created. Needs manual reconciliation.');\n" +
  "      return { action: 'BLOCKED_NEEDS_REVIEW', reason: 'preserve_transition_failed' };\n" +
  "    }\n" +
  "    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.DRAFT_SUPERSEDED, prospectId, existing.values.Email_Normalized, step,\n" +
  "      'Draft_ID=' + existing.values.Draft_ID + (verification.legacy\n" +
  "        ? ' has no baseline fingerprint (legacy row) — preserved conservatively without assuming it is intact.'\n" +
  "        : ' was edited by a human (content fingerprint changed). Durably preserved.') +\n" +
  "      ' Will never be auto-regenerated unless the Draft_ID itself disappears.');\n" +
  "    return { action: 'PRESERVE_EXISTING' };\n" +
  "  }\n";
function mutationA_removeDurablePreserveGuard(source) {
  return replaceOrThrow(source, 'A', EDITED_BLOCK, '');
}

// --- Mutation B: neuter the fingerprint comparison so "owned" always means "unedited". ---
function mutationB_neuterFingerprintComparison(source) {
  return replaceOrThrow(source, 'B',
    'var edited = currentFingerprint !== ledgerEntryValues.Draft_Fingerprint;',
    'var edited = false; // MUTATION B: fingerprint comparison neutered.');
}

// --- Mutation C: message.getId() error becomes a permissive fallback instead of fail-closed. ---
var GETID_BLOCK =
  "  var currentMessageId = '';\n" +
  "  try {\n" +
  "    currentMessageId = message.getId();\n" +
  "  } catch (e) {\n" +
  "    logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, ledgerEntryValues.Prospect_ID, ledgerEntryValues.Email_Normalized,\n" +
  "      ledgerEntryValues.Step, 'verifyPreviewDraftOwnership_: message.getId() failed: ' + e);\n" +
  "    return { owned: false, edited: false, legacy: false, fatal: true, reason: 'message_id_read_failed', currentMessageId: '', currentFingerprint: '' };\n" +
  "  }\n";
var GETID_PERMISSIVE =
  "  var currentMessageId = '';\n" +
  "  try {\n" +
  "    currentMessageId = message.getId();\n" +
  "  } catch (e) {\n" +
  "    currentMessageId = ''; // MUTATION C: swallow the error instead of failing closed.\n" +
  "  }\n";
function mutationC_permissiveGetIdFallback(source) {
  return replaceOrThrow(source, 'C', GETID_BLOCK, GETID_PERMISSIVE);
}

// --- Mutation D: revert legacy-blank-fingerprint handling to the old "blank = unedited" bug. ---
var LEGACY_AND_CHECK2B_BLOCK =
  "  var currentFingerprint = computeDraftFingerprint_(to, subject, body);\n" +
  "\n" +
  "  // Check 2a: legacy blank fingerprint (N3 V3, blocker N3-1). NEVER read as\n" +
  "  // \"unedited\" — see the long comment above. Always durable-preserved.\n" +
  "  if (!ledgerEntryValues.Draft_Fingerprint) {\n" +
  "    return {\n" +
  "      owned: true, edited: true, legacy: true, fatal: false, reason: 'legacy_blank_fingerprint',\n" +
  "      currentMessageId: currentMessageId, currentFingerprint: currentFingerprint\n" +
  "    };\n" +
  "  }\n" +
  "\n" +
  "  // Check 2b: content fingerprint — the ONLY authority on \"did it change\"\n" +
  "  // for a row that DOES have a baseline to compare against.\n" +
  "  var edited = currentFingerprint !== ledgerEntryValues.Draft_Fingerprint;\n";
var OLD_BUGGY_SHORT_CIRCUIT =
  "  var currentFingerprint = computeDraftFingerprint_(to, subject, body);\n" +
  "  // MUTATION D: old round-2/3 bug — a blank stored fingerprint short-circuits\n" +
  "  // the whole expression to false (\"unedited\"), instead of being its own\n" +
  "  // conservative durable-preserve outcome.\n" +
  "  var edited = !!(ledgerEntryValues.Draft_Fingerprint && currentFingerprint !== ledgerEntryValues.Draft_Fingerprint);\n";
function mutationD_blankFingerprintTreatedAsUnedited(source) {
  return replaceOrThrow(source, 'D', LEGACY_AND_CHECK2B_BLOCK, OLD_BUGGY_SHORT_CIRCUIT)
    // legacy is no longer computed at all under this mutation — always false.
    .replace('owned: true, edited: edited, legacy: false, fatal: false,', 'owned: true, edited: edited, legacy: false, fatal: false, /* MUTATION D */');
}

// --- Mutation E: revert preserveDraftDurably_'s write order (append-then-supersede -> supersede-then-append). ---
var APPEND_FIRST_BODY =
  "function preserveDraftDurably_(oldRowIndex, oldValues, verification, reasonTag) {\n" +
  "  var now = new Date();\n" +
  "  appendLedgerRow_({\n" +
  "    Run_ID: getRunId_(), Claimed_At: '', Prospect_ID: oldValues.Prospect_ID, Email_Normalized: oldValues.Email_Normalized,\n" +
  "    Step: oldValues.Step, Idempotency_Key: oldValues.Idempotency_Key, Mode: LEDGER_MODE.DRY_RUN,\n" +
  "    State: LEDGER_STATE.DRAFTED, Thread_ID: oldValues.Thread_ID, Message_ID: verification.currentMessageId,\n" +
  "    Draft_ID: oldValues.Draft_ID, Confirmed_At: now, Error: '',\n" +
  "    Draft_Fingerprint: verification.currentFingerprint, Human_Edit_Preserved: true, Human_Edit_Detected_At: now\n" +
  "  });\n" +
  "  updateLedgerRow_(oldRowIndex, {\n" +
  "    State: LEDGER_STATE.SUPERSEDED,\n" +
  "    Error: reasonTag + ': draft preserved; ' + (oldValues.Draft_Fingerprint\n" +
  "      ? 'content fingerprint changed from \"' + oldValues.Draft_Fingerprint + '\" to \"' + verification.currentFingerprint + '\".'\n" +
  "      : 'no baseline fingerprint existed (legacy row) — bootstrapped conservatively, not evidence it was ever unedited.')\n" +
  "  });\n" +
  "}";
var SUPERSEDE_FIRST_BODY =
  "function preserveDraftDurably_(oldRowIndex, oldValues, verification, reasonTag) {\n" +
  "  var now = new Date();\n" +
  "  // MUTATION E: old, unsafe ordering — supersede BEFORE append. If append\n" +
  "  // then throws, zero active rows remain for this key.\n" +
  "  updateLedgerRow_(oldRowIndex, {\n" +
  "    State: LEDGER_STATE.SUPERSEDED,\n" +
  "    Error: reasonTag + ': draft preserved; ' + (oldValues.Draft_Fingerprint\n" +
  "      ? 'content fingerprint changed from \"' + oldValues.Draft_Fingerprint + '\" to \"' + verification.currentFingerprint + '\".'\n" +
  "      : 'no baseline fingerprint existed (legacy row) — bootstrapped conservatively, not evidence it was ever unedited.')\n" +
  "  });\n" +
  "  appendLedgerRow_({\n" +
  "    Run_ID: getRunId_(), Claimed_At: '', Prospect_ID: oldValues.Prospect_ID, Email_Normalized: oldValues.Email_Normalized,\n" +
  "    Step: oldValues.Step, Idempotency_Key: oldValues.Idempotency_Key, Mode: LEDGER_MODE.DRY_RUN,\n" +
  "    State: LEDGER_STATE.DRAFTED, Thread_ID: oldValues.Thread_ID, Message_ID: verification.currentMessageId,\n" +
  "    Draft_ID: oldValues.Draft_ID, Confirmed_At: now, Error: '',\n" +
  "    Draft_Fingerprint: verification.currentFingerprint, Human_Edit_Preserved: true, Human_Edit_Detected_At: now\n" +
  "  });\n" +
  "}";
function mutationE_revertPartialFailureOrdering(source) {
  return replaceOrThrow(source, 'E', APPEND_FIRST_BODY, SUPERSEDE_FIRST_BODY);
}

// --- Mutation F: disable previewStep's fail-closed creation-metadata guard. ---
function mutationF_disableCreationFailClosedGuard(source) {
  return replaceOrThrow(source, 'F',
    'if (creationError || !draftFingerprint) {',
    'if (false) { // MUTATION F: fail-closed guard disabled — old best-effort-silent behavior.');
}

// --- Mutation G (round 2, orphan-draft gap): reintroduce the unprotected
// post-creation getThread().getId() read into createPreviewDraft_ itself,
// escaping previewStep()'s unified fail-closed block entirely. ---
function mutationG_reintroduceOrphanDraftGap(source) {
  var s = replaceOrThrow(source, 'G1',
    "  return { skipped: false, draft: standaloneDraft, usedThreadId: null }; // Resolved by previewStep(), fail-closed.",
    "  // MUTATION G: read reintroduced HERE — outside previewStep()'s protected block.\n" +
    "  return { skipped: false, draft: standaloneDraft, usedThreadId: standaloneDraft.getMessage().getThread().getId() };");
  return s;
}


// --- Mutation H (final round): move the PREVIEW claim to AFTER the Gmail
// draft-creating call — reintroducing the exact window where a draft can
// exist with no durable ledger barrier. ---
function mutationH_claimAfterCreateDraft(source) {
  var s2 = replaceOrThrow(source, 'H1',
    "    var claimRowNum;\n" +
    "    try {\n" +
    "      claimRowNum = appendPreviewClaim_(prospectId, step, prospect.Email_Normalized);\n" +
    "    } catch (claimError) {",
    "    var claimRowNum = null; // MUTATION H: claim deferred until after Gmail.\n" +
    "    try {\n" +
    "      if (false) claimRowNum = appendPreviewClaim_(prospectId, step, prospect.Email_Normalized);\n" +
    "    } catch (claimError) {");
  return replaceOrThrow(s2, 'H2',
    "    var draftId = '';\n" +
    "    var draftMessageId = '';",
    "    claimRowNum = appendPreviewClaim_(prospectId, step, prospect.Email_Normalized); // MUTATION H: too late.\n" +
    "    var draftId = '';\n" +
    "    var draftMessageId = '';");
}

// --- Mutation I: PREVIEW_AMBIGUOUS no longer blocks a later preview. ---
function mutationI_ambiguousNotBlocking(source) {
  return replaceOrThrow(source, 'I',
    "  return state === LEDGER_STATE.DRAFTED ||\n" +
    "    state === LEDGER_STATE.PREVIEW_CLAIMED ||\n" +
    "    state === LEDGER_STATE.PREVIEW_AMBIGUOUS;",
    "  return state === LEDGER_STATE.DRAFTED ||\n" +
    "    state === LEDGER_STATE.PREVIEW_CLAIMED; // MUTATION I: PREVIEW_AMBIGUOUS no longer blocks.");
}

// --- Mutation J: on a FAILED cleanup, release the claim anyway (treating
// an unproven cleanup as if it had succeeded). ---
function mutationJ_releaseClaimOnFailedCleanup(source) {
  return replaceOrThrow(source, 'J',
    "        if (compensated) {\n" +
    "          releasePreviewClaim_(claimRowNum,\n" +
    "            'Metadata capture failed (' + creationError + ') but the draft was CONFIRMED deleted.');\n" +
    "        } else {",
    "        if (true) { // MUTATION J: release regardless of whether cleanup actually worked.\n" +
    "          releasePreviewClaim_(claimRowNum,\n" +
    "            'Metadata capture failed (' + creationError + ') but the draft was CONFIRMED deleted.');\n" +
    "        } else {");
}

var MUTATIONS = [
  { label: 'A (remove durable-preserve guard)', file: 'Mailer.gs', mutate: mutationA_removeDurablePreserveGuard, mustBeCaughtBy: 'N3_caso2_messageIdRotates' },
  { label: 'B (neuter fingerprint comparison)', file: 'Mailer.gs', mutate: mutationB_neuterFingerprintComparison, mustBeCaughtBy: 'N3_caso3_messageIdStable' },
  { label: 'C (permissive getId() fallback)', file: 'Mailer.gs', mutate: mutationC_permissiveGetIdFallback, mustBeCaughtBy: 'N3_caso8_messageIdError' },
  { label: 'D (blank fingerprint = unedited)', file: 'Mailer.gs', mutate: mutationD_blankFingerprintTreatedAsUnedited, mustBeCaughtBy: 'N3v3_legacyRosaKnownEdit' },
  { label: 'E (partial-transition safety removed)', file: 'Ledger.gs', mutate: mutationE_revertPartialFailureOrdering, mustBeCaughtBy: 'N3v3_appendFailureLeavesOldRowIntact' },
  { label: 'F (healthy DRAFTED with blank fingerprint allowed)', file: 'Mailer.gs', mutate: mutationF_disableCreationFailClosedGuard, mustBeCaughtBy: 'N3v3_creationFailureCompensated' },
  { label: 'G (orphan-draft gap reintroduced)', file: 'Mailer.gs', mutate: mutationG_reintroduceOrphanDraftGap, mustBeCaughtBy: 'N3v3_orphanGap_getThread' },
  { label: 'H (preview claim moved after createDraft)', file: 'Mailer.gs', mutate: mutationH_claimAfterCreateDraft, mustBeCaughtBy: 'N3v3_createDraftThrows' },
  { label: 'I (PREVIEW_AMBIGUOUS not blocking)', file: 'Ledger.gs', mutate: mutationI_ambiguousNotBlocking, mustBeCaughtBy: 'N3v3_unc_draftGetId' },
  { label: 'J (claim released on a FAILED cleanup)', file: 'Mailer.gs', mutate: mutationJ_releaseClaimOnFailedCleanup, mustBeCaughtBy: 'N3v3_unc_draftGetId' }
];

var allPassed = true;
console.log('=== N3 V3 mutation test (hardened durable Gmail preview ownership) ===\n');

var baseline = runSuite(null);
console.log('Baseline (no mutation): ' + baseline.passed + '/' + baseline.total);
if (baseline.passed !== baseline.total) { console.log('FAIL — baseline suite is not green.'); allPassed = false; }

MUTATIONS.forEach(function (m) {
  var mutated;
  try {
    var mutators = {};
    mutators[m.file] = m.mutate;
    mutated = runSuite(mutators);
  } catch (e) {
    console.log('Mutation ' + m.label + ': THREW — ' + e.message);
    allPassed = false;
    return;
  }
  var failed = mutated.results.filter(function (r) { return !r.passed; }).map(function (r) { return r.name; });
  console.log('Mutation ' + m.label + ': ' + mutated.passed + '/' + mutated.total +
    (failed.length ? ' — caught by: ' + failed.join(', ') : ' — *** NOT CAUGHT ***'));
  if (failed.indexOf(m.mustBeCaughtBy) === -1) {
    console.log('FAIL — ' + m.mustBeCaughtBy + ' must catch this mutation.');
    allPassed = false;
  } else {
    console.log('PASS — ' + m.mustBeCaughtBy + ' caught the regression.');
  }
});

var restored = runSuite(null);
console.log('Restored (unmutated): ' + restored.passed + '/' + restored.total);
if (restored.passed !== restored.total) { console.log('FAIL — restoring the original source did not return the suite to green.'); allPassed = false; }

console.log('\n' + (allPassed ? 'N3 V3 MUTATION TEST: PASS' : 'N3 V3 MUTATION TEST: FAIL'));
if (!allPassed) process.exitCode = 1;
