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

/**
 * ADMIN menu action: "Process unsubscribe for selected row".
 *
 * The menu is the operator's explicit unsubscribe intent.  It must be a
 * complete operation: requiring the operator to pre-edit
 * Do_Not_Contact_Reason="unsubscribe" made this entry point unusable for a
 * normal READY/REPLIED row, because applyUnsubscribeEffects_ deliberately
 * rejects calls that do not already carry that intent marker.
 *
 * Establish the marker through the existing ADMIN_UNSUBSCRIBE write boundary
 * first, then delegate the permanent stop + Suppression guarantee to the
 * shared helper.  The ordering is fail-closed in either partial-failure case:
 * once the intent write succeeds, Do_Not_Contact_Reason itself blocks every
 * eligibility/send path; once Suppression exists, it independently blocks
 * every future send.  Errors still propagate to the menu wrapper, so a
 * partial failure is never reported as success and nightly reconciliation can
 * complete any row left with the durable unsubscribe intent marker.
 */
function processUnsubscribeForSelectedRow(prospectId) {
  var found = findRowById_(prospectId);
  if (!found) throw new Error('processUnsubscribeForSelectedRow: Prospect_ID not found: ' + prospectId);

  // Validate that a durable email-scope Suppression can actually be created
  // before changing the row.  This avoids recording an unsubscribe intent
  // that can never be completed because the prospect has no usable address.
  var emailNormalized = found.values.Email_Normalized || normalizeEmail_(found.values.Email);
  if (!emailNormalized) {
    throw new Error('processUnsubscribeForSelectedRow: prospect ' + prospectId + ' has no usable email to suppress.');
  }

  var intentWrite = writeRowById_(prospectId, { Do_Not_Contact_Reason: DNC_REASON.UNSUBSCRIBE },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_UNSUBSCRIBE });
  if (!intentWrite || intentWrite.success !== true) {
    throw new Error('processUnsubscribeForSelectedRow: failed to persist administrative unsubscribe intent for ' + prospectId + '.');
  }

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
 *
 * N5 (Codex re-audit, final round): a stale CLAIMED row means normal
 * execution did NOT complete, so this step's real Gmail outcome is
 * unknown. This function NEVER infers SENT from a Gmail search: the only
 * query available ("in:sent to:<recipient>") matches ANY message ever
 * sent to that address — a previous step, a manual email, an unrelated
 * thread — so "exactly one match" is not proof that THIS step was sent.
 * Treating it as proof produced false SENT accounting and, worse, a
 * confident-looking terminal state built on a guess.
 *
 * Policy, deliberately blunt: EVERY stale CLAIMED row becomes AMBIGUOUS
 * (durably blocking, never auto-retried), regardless of what the search
 * returns. The search is still run, but ONLY as diagnostic evidence
 * recorded in the Error column for whoever reconciles the row by hand. A
 * search failure changes nothing at all — the row stays CLAIMED, which is
 * already blocking. If a provider-level identifier that structurally
 * proves an exact send is ever available, THAT could justify an automatic
 * SENT transition; a recipient-scoped text search never can.
 *
 * Counters returned describe exactly what happened — examined, ambiguous,
 * searchErrors, unchanged — with no "resolved" metric, because under this
 * policy nothing is ever automatically resolved.
 */
function reconcileStaleLiveClaims_(config) {
  var stale = findStaleLiveClaims_(config);
  var counters = { examined: 0, ambiguous: 0, searchErrors: 0, unchanged: 0 };

  stale.forEach(function (row) {
    var v = row.values;
    counters.examined++;

    // Diagnostic only — the result NEVER decides the ledger state, it is
    // recorded verbatim in the Error column so a human reconciling this
    // row later starts with whatever evidence we could gather.
    var evidence;
    try {
      var threads = GmailApp.search('in:sent to:' + v.Email_Normalized + ' newer_than:30d');
      evidence = threads.length + ' message(s) to this recipient found in Sent (diagnostic only — a generic ' +
        'recipient search cannot prove THIS specific step was or was not sent)';
    } catch (searchError) {
      // Fail closed and change NOTHING: the row is already CLAIMED, which
      // isLiveKeyBlocked_ already treats as blocking.
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, v.Prospect_ID, v.Email_Normalized, v.Step,
        'reconcileStaleLiveClaims_: GmailApp.search() failed for a stale CLAIMED row — left untouched ' +
        '(still durably blocked as CLAIMED). error=' + searchError);
      counters.searchErrors++;
      counters.unchanged++;
      return;
    }

    updateLedgerRow_(row.rowIndex, {
      State: LEDGER_STATE.AMBIGUOUS,
      Error: 'Stale CLAIMED: normal execution did not complete, so this step\'s real outcome is unknown. ' +
        evidence + '. Durably blocked — needs manual reconciliation.'
    });
    counters.ambiguous++;

    try {
      writeRowById_(v.Prospect_ID, { Status: STATUS.NEEDS_REVIEW },
        { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_NIGHTLY_RECON });
    } catch (writeError) {
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, v.Prospect_ID, v.Email_Normalized, v.Step,
        'reconcileStaleLiveClaims_: the Prospects NEEDS_REVIEW write ALSO failed — secondary signal only; ' +
        'the ledger AMBIGUOUS state (already written above) still blocks retry regardless. error=' + writeError);
    }

    logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, v.Prospect_ID, v.Email_Normalized, v.Step,
      'Stale claim durably blocked (AMBIGUOUS). ' + evidence + '.');
  });

  return counters;
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
  var staleClaims = reconcileStaleLiveClaims_(config);
  var sequencesClosed = closeFinishedSequences_(config);
  var dncSynced = syncDncToStopContact_();
  var unsubscribesProcessed = sweepPendingUnsubscribes_();
  trimLog_();

  var summary = {
    validation: validation,
    staleClaims: staleClaims, // { examined, ambiguous, searchErrors, unchanged } — never "resolved"; see reconcileStaleLiveClaims_.
    sequencesClosed: sequencesClosed,
    dncSynced: dncSynced,
    unsubscribesProcessed: unsubscribesProcessed
  };
  logEvent_(LOG_LEVEL.INFO, LOG_EVENT.RUN_END, '', '', '', 'nightlyRecon ' + JSON.stringify(summary));
  flushLog_();
  return summary;
}
