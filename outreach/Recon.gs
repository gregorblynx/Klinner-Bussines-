/**
 * Klinner Outreach — Recon.gs
 * Unsubscribe processing (spec §9, active in F1), the generic DNC→
 * Stop_Contact sync, and nightlyRecon() — the nightly SYSTEM-origin sweep.
 *
 * F1 note: nightlyRecon's claim-reconciliation and thread-reconciliation
 * steps operate on Mode=LIVE ledger rows and IN_SEQUENCE prospects, neither
 * of which can exist yet in F1 (DRY_RUN=TRUE, zero LIVE sends). Those steps
 * are implemented per the approved file list but are true no-ops until F2.
 * The DNC-sync and unsubscribe steps ARE exercised by F1 tests (T8, T29–T32)
 * because they require no LIVE sending.
 */

/**
 * Applies the full unsubscribe procedure (§9) to one prospect. Idempotent
 * AND unconditional: it re-asserts all four guarantees below every time it
 * runs, regardless of which ones (if any) are already true — it does NOT
 * short-circuit on "Stop_Contact is already true", which was exactly the
 * bug in Codex finding #3 (a prior stopProspect() call, or a manual sheet
 * edit, could set Stop_Contact=TRUE while DNC="unsubscribe" WITHOUT ever
 * creating the Suppression row, and the old sweep then ignored it forever
 * because it only looked at rows where Stop_Contact was still FALSE).
 *
 * Guarantees before returning, every time, unconditionally:
 *   - Stop_Contact = TRUE
 *   - Status = STOPPED
 *   - Next_Action_Date = '' (empty)
 *   - Suppression(scope=email, reason=unsubscribe) exists — permanently.
 * Calling this N times produces the same end state and EXACTLY ONE
 * Suppression(email) row (addSuppression_ itself is idempotent).
 *
 * @param {string} prospectId
 * @param {string} origin ORIGIN.ADMIN (menu action / stopProspect redirect) or ORIGIN.SYSTEM (nightlyRecon sweep)
 * @param {string} operation OPERATION.ADMIN_UNSUBSCRIBE or OPERATION.SYSTEM_NIGHTLY_RECON
 */
function applyUnsubscribeEffects_(prospectId, origin, operation) {
  var found = findRowById_(prospectId);
  if (!found) throw new Error('applyUnsubscribeEffects_: Prospect_ID not found: ' + prospectId);
  var v = found.values;

  if (v.Do_Not_Contact_Reason !== DNC_REASON.UNSUBSCRIBE) {
    throw new Error('applyUnsubscribeEffects_: prospect ' + prospectId +
      ' does not have Do_Not_Contact_Reason="unsubscribe" (found "' + v.Do_Not_Contact_Reason + '").');
  }

  // Robustness: a row can reach DNC="unsubscribe" via a direct manual cell
  // edit, bypassing Validate — Email_Normalized may not be populated yet.
  var emailNormalized = v.Email_Normalized || normalizeEmail_(v.Email);
  if (!emailNormalized) {
    throw new Error('applyUnsubscribeEffects_: prospect ' + prospectId + ' has no usable email to suppress.');
  }

  // Unconditional — always re-write, even if these already hold. Writing
  // an already-correct value is a harmless no-op; SKIPPING the write
  // because Stop_Contact looked already TRUE is exactly what caused the
  // bug. writeRowById_/authorizeWrite_ tolerate redundant writes fine.
  writeRowById_(prospectId, {
    Stop_Contact: true,
    Status: STATUS.STOPPED,
    Next_Action_Date: ''
  }, { origin: origin, operation: operation });

  var suppressionResult = addSuppression_(emailNormalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.UNSUBSCRIBE,
    origin === ORIGIN.ADMIN ? 'operator' : 'system');

  logEvent_(LOG_LEVEL.INFO, LOG_EVENT.UNSUBSCRIBE, prospectId, emailNormalized, '',
    'suppression_added=' + suppressionResult.added);

  return { success: true, suppressionAdded: suppressionResult.added };
}

/** ADMIN menu action: "Process unsubscribe for selected row". */
function processUnsubscribeForSelectedRow(prospectId) {
  var result = applyUnsubscribeEffects_(prospectId, ORIGIN.ADMIN, OPERATION.ADMIN_UNSUBSCRIBE);
  flushLog_();
  return result;
}

/**
 * SYSTEM sweep: every row with Do_Not_Contact_Reason="unsubscribe" that is
 * not YET fully guaranteed (any of the 4 guarantees above missing — most
 * importantly, no Suppression(email) row yet) gets the full unsubscribe
 * procedure (re-)applied. Codex finding #3 fix: this NO LONGER depends on
 * Stop_Contact being FALSE — that was the exact condition that let a
 * missing Suppression row go undetected forever once Stop_Contact was set
 * by any other path (e.g. stopProspect(), or a manual sheet edit).
 */
function sweepPendingUnsubscribes_() {
  var rows = readAllProspects();
  var processed = 0;
  rows.forEach(function (r) {
    var v = r.values;
    if (v.Do_Not_Contact_Reason !== DNC_REASON.UNSUBSCRIBE) return;

    var emailNormalized = v.Email_Normalized || normalizeEmail_(v.Email);
    // Reaudit N2 (round 1): this must check for a SPECIFIC scope=email row
    // matching this exact address — NOT isSuppressed_(), which also
    // matches on scope=domain. A prospect whose whole company domain was
    // separately suppressed by a human must still get their OWN permanent
    // scope=email/unsubscribe record: the individual's unsubscribe is a
    // distinct, permanent fact, independent of whether a domain-level
    // block (which a human could reconsider later) happens to already be
    // blocking them today.
    //
    // Reaudit N2 (round 2): matching on scope=email alone is STILL not
    // enough — a pre-existing scope=email row for a DIFFERENT reason
    // (bounce, manual, wrong person, ...) would satisfy this check without
    // an unsubscribe ever having been recorded. The reason must be part of
    // the match: only a row whose Reason is specifically "unsubscribe"
    // proves the unsubscribe guarantee holds. findSuppressionEntry_'s
    // third argument narrows to that exact reason.
    var hasEmailScopeUnsubscribeRecord = !!findSuppressionEntry_(emailNormalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.UNSUBSCRIBE);
    var fullyGuaranteed = v.Stop_Contact === true && v.Status === STATUS.STOPPED && !v.Next_Action_Date &&
      hasEmailScopeUnsubscribeRecord;
    if (fullyGuaranteed) return;

    applyUnsubscribeEffects_(v.Prospect_ID, ORIGIN.SYSTEM, OPERATION.SYSTEM_NIGHTLY_RECON);
    processed++;
  });
  return processed;
}

/**
 * Generic DNC → Stop_Contact sync (spec §2.2): any row with a non-empty
 * Do_Not_Contact_Reason OTHER than "unsubscribe" (which gets the fuller
 * procedure above) whose Stop_Contact checkbox was left unmarked gets it
 * marked automatically. Does not alter Status — a more specific terminal
 * status (DUPLICATE, INVALID_EMAIL, BOUNCED) is left untouched.
 */
function syncDncToStopContact_() {
  var rows = readAllProspects();
  var synced = 0;
  rows.forEach(function (r) {
    var v = r.values;
    if (v.Do_Not_Contact_Reason && v.Do_Not_Contact_Reason !== DNC_REASON.UNSUBSCRIBE && v.Stop_Contact !== true) {
      writeRowById_(v.Prospect_ID, { Stop_Contact: true },
        { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_NIGHTLY_RECON });
      logEvent_(LOG_LEVEL.INFO, LOG_EVENT.DNC_SYNC, v.Prospect_ID, v.Email_Normalized, '',
        'Stop_Contact auto-synced from Do_Not_Contact_Reason=' + v.Do_Not_Contact_Reason);
      synced++;
    }
  });
  return synced;
}

/**
 * F2/F3 functionality, defined per the approved file list. In F1 these are
 * true no-ops: there are no Mode=LIVE CLAIMED rows and no IN_SEQUENCE
 * prospects for either step to act on. Left implemented (not stubbed) so
 * F2 does not require rewriting Recon.gs.
 */
function reconcileStaleLiveClaims_(config) {
  var stale = findStaleLiveClaims_(config);
  var resolved = 0;
  stale.forEach(function (row) {
    var v = row.values;
    var searchQuery = 'in:sent to:' + v.Email_Normalized + ' newer_than:2d';
    var threads = GmailApp.search(searchQuery);
    if (threads.length === 1) {
      updateLedgerRow_(row.rowIndex, { State: LEDGER_STATE.SENT, Confirmed_At: new Date() });
      logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SENT, v.Prospect_ID, v.Email_Normalized, v.Step, 'Reconciled from orphan claim.');
    } else if (threads.length === 0) {
      updateLedgerRow_(row.rowIndex, { State: LEDGER_STATE.ABANDONED });
      logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, v.Prospect_ID, v.Email_Normalized, v.Step, 'Orphan claim abandoned — no matching sent mail found.');
    } else {
      writeRowById_(v.Prospect_ID, { Status: STATUS.NEEDS_REVIEW },
        { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_NIGHTLY_RECON });
      logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, v.Prospect_ID, v.Email_Normalized, v.Step, 'Ambiguous orphan claim — NEEDS_REVIEW.');
    }
    resolved++;
  });
  return resolved;
}

function closeFinishedSequences_(config) {
  var rows = readAllProspects();
  var closed = 0;
  rows.forEach(function (r) {
    var v = r.values;
    if (v.Status === STATUS.IN_SEQUENCE && Number(v.Sequence_Step) >= (config.MAX_STEPS || 4) && !v.Next_Action_Date) {
      writeRowById_(v.Prospect_ID, { Status: STATUS.SEQUENCE_DONE },
        { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_NIGHTLY_RECON });
      closed++;
    }
  });
  return closed;
}

/**
 * The nightly SYSTEM sweep (02:00 America/Chicago once triggers are
 * installed in F2+). Safe to call manually at any time — every step is
 * idempotent. NOT installed as an automatic trigger during F1.
 */
function nightlyRecon() {
  var config = getConfig();
  logEvent_(LOG_LEVEL.INFO, LOG_EVENT.RUN_START, '', '', '', 'nightlyRecon');

  var validation = validateAllRows();
  var claimsResolved = reconcileStaleLiveClaims_(config);
  var sequencesClosed = closeFinishedSequences_(config);
  var dncSynced = syncDncToStopContact_();
  var unsubscribesProcessed = sweepPendingUnsubscribes_();
  trimLog_();

  var summary = {
    validation: validation,
    claimsResolved: claimsResolved,
    sequencesClosed: sequencesClosed,
    dncSynced: dncSynced,
    unsubscribesProcessed: unsubscribesProcessed
  };
  logEvent_(LOG_LEVEL.INFO, LOG_EVENT.RUN_END, '', '', '', 'nightlyRecon ' + JSON.stringify(summary));
  flushLog_();
  return summary;
}
