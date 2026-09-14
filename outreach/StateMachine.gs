/**
 * Klinner Outreach — StateMachine.gs
 * Eligibility rules (I1–I6), canSend() as the single hard guard every send
 * route must pass through, and the two guarded operator actions that touch
 * a prospect's lifecycle outside the send pipeline: Reset and Stop.
 */

/** Which step number would be attempted next for this prospect, or null if none. */
function getNextStepNumber_(prospectValues, config) {
  var maxSteps = config.MAX_STEPS || 4;
  if (prospectValues.Status === STATUS.READY) return 1;
  if (prospectValues.Status === STATUS.IN_SEQUENCE) {
    var next = Number(prospectValues.Sequence_Step || 0) + 1;
    return next <= maxSteps ? next : null;
  }
  return null;
}

/**
 * Eligibility filter used to build the send/preview queue (I2, I3, I4, I6).
 * Does NOT check Step_N_Sent_At directly (that is canSend()'s job, capa 5) —
 * this function decides "should this prospect be considered at all".
 */
function isEligibleForNextStep_(prospectValues, config, now) {
  if (prospectValues.Stop_Contact === true) return false;
  if (prospectValues.Do_Not_Contact_Reason) return false;
  if (prospectValues.Replied === true) return false;
  if (isSuppressed_(prospectValues.Email_Normalized, prospectValues.Domain)) return false;

  var nextStep = getNextStepNumber_(prospectValues, config);
  if (!nextStep) return false;

  if (prospectValues.Status === STATUS.IN_SEQUENCE) {
    // I6: a blank Next_Action_Date means "ignore this row", always.
    if (!prospectValues.Next_Action_Date) return false;
    var due = new Date(prospectValues.Next_Action_Date);
    if (due.getTime() > (now || new Date()).getTime()) return false;
  }
  // READY (step 1) rows have no wait — eligible as soon as they exist.

  return true;
}

/**
 * The PREVIEW guard. Every preview route calls this immediately before
 * creating a draft, using a freshly-read prospect row (capa 3 re-read).
 * Deliberately LIGHTER than canSend_ (LIVE) below: preview is a read/review
 * tool that must be able to show all 4 steps for a row that has never
 * actually been sent (§6.3's standalone-draft fallback depends on this),
 * so it does NOT enforce step-sequence order or Next_Action_Date timing —
 * only the hard stop conditions that must never be silently ignored.
 */
function canPreview_(prospectValues, step) {
  var stepColName = 'Step' + step + '_Sent_At';
  if (prospectValues[stepColName]) return false; // I1 — already sent, never resend/re-preview as new.
  if (prospectValues.Stop_Contact === true) return false; // I2
  if (prospectValues.Do_Not_Contact_Reason) return false; // I2
  if (prospectValues.Replied === true) return false; // I3
  if (isSuppressed_(prospectValues.Email_Normalized, prospectValues.Domain)) return false; // I4
  return true;
}

/**
 * THE hard guard for LIVE sending (capa 5 / I1, hardened per Codex finding
 * #10). Every LIVE send route — with no exception, including a call made
 * directly and not through sendBatch() — must call this immediately before
 * sending, using a freshly-read prospect row (capa 3 re-read). Returns
 * false the instant ANY blocking condition holds.
 *
 * Stricter than canPreview_ on purpose: LIVE must never be able to send
 * step 2 if step 1 was never actually sent LIVE, and must never send a step
 * out of order or before its Next_Action_Date is due — a direct call like
 * sendFollowUp(id, 3) bypasses the queue-building eligibility filter
 * entirely, so this is the only remaining place that can catch it.
 */
function canSend_(prospectValues, step, config, now) {
  now = now || new Date();

  // The step requested must be EXACTLY the prospect's next expected step —
  // this alone blocks "run step 2 without step 1", "run step 4 first", etc.
  var expectedStep = getNextStepNumber_(prospectValues, config);
  if (expectedStep === null || expectedStep !== step) return false;

  var stepColName = 'Step' + step + '_Sent_At';
  if (prospectValues[stepColName]) return false; // I1 — already sent, never resend.

  if (step > 1) {
    var priorStepColName = 'Step' + (step - 1) + '_Sent_At';
    if (!prospectValues[priorStepColName]) return false; // defense in depth: prior step must have a real LIVE timestamp.
    if (!prospectValues.Next_Action_Date) return false; // I6 — blank means "ignore this row", always.
    if (new Date(prospectValues.Next_Action_Date).getTime() > now.getTime()) return false; // not due yet.
  }

  if (prospectValues.Stop_Contact === true) return false; // I2
  if (prospectValues.Do_Not_Contact_Reason) return false; // I2
  if (prospectValues.Replied === true) return false; // I3
  if (isSuppressed_(prospectValues.Email_Normalized, prospectValues.Domain)) return false; // I4
  return true;
}

/**
 * ADMIN operation: Reset Prospect.
 * PATCH FINAL V1.1, Patch (item 9/I17): REJECTED outright if the prospect
 * is currently blocked by Stop_Contact or any Do_Not_Contact_Reason —
 * including, and especially, "unsubscribe". A block must be resolved by an
 * explicit, separate human action; Reset can never lift it as a side effect.
 */
function resetProspect(prospectId) {
  var found = findRowById_(prospectId);
  if (!found) throw new Error('resetProspect: Prospect_ID not found: ' + prospectId);
  var v = found.values;

  if (v.Stop_Contact === true || v.Do_Not_Contact_Reason) {
    var reasonLabel = v.Do_Not_Contact_Reason || 'Stop_Contact';
    logEvent_(LOG_LEVEL.WARN, LOG_EVENT.RESET_REFUSED, prospectId, v.Email_Normalized, '', 'blocked_by=' + reasonLabel);
    flushLog_();
    return {
      success: false,
      reason: 'BLOCKED',
      message: 'This prospect is blocked (' + reasonLabel + '). The block must be reviewed and cleared ' +
        'explicitly and separately before it can be reset. Unsubscribes can never be reversed by Reset.'
    };
  }

  var fields = {
    Status: STATUS.READY,
    Sequence_Step: 0,
    Next_Action_Date: new Date(),
    Step1_Sent_At: '',
    Step2_Sent_At: '',
    Step3_Sent_At: '',
    Step4_Sent_At: '',
    Replied: false,
    Replied_At: '',
    Thread_ID: '',
    Last_Message_ID: '',
    Error_Count: 0,
    Last_Error: ''
  };
  writeRowById_(prospectId, fields, { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_RESET });
  logEvent_(LOG_LEVEL.INFO, LOG_EVENT.RESET, prospectId, v.Email_Normalized, '', 'Reset to READY.');
  flushLog_();
  return { success: true };
}

/** ADMIN operation: Stop Prospect (manual pause / exclusion). */
function stopProspect(prospectId, reason) {
  var found = findRowById_(prospectId);
  if (!found) throw new Error('stopProspect: Prospect_ID not found: ' + prospectId);
  var dncReason = reason || DNC_REASON.MANUAL;
  if (DNC_REASON_VALUES.indexOf(dncReason) === -1) throw new Error('stopProspect: invalid reason "' + dncReason + '".');

  // Codex finding #3: "unsubscribe" is never just a plain Stop — it carries
  // a mandatory, permanent Suppression(email) guarantee. Route it through
  // the dedicated procedure instead of writing DNC=unsubscribe directly;
  // OPERATION.ADMIN_STOP's restrictedValues (Constants.gs) structurally
  // reject "unsubscribe" now, so this redirect is not optional — a direct
  // ADMIN_STOP write of DNC=unsubscribe would throw.
  if (dncReason === DNC_REASON.UNSUBSCRIBE) {
    writeRowById_(prospectId, { Do_Not_Contact_Reason: DNC_REASON.UNSUBSCRIBE },
      { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_UNSUBSCRIBE });
    var unsubResult = applyUnsubscribeEffects_(prospectId, ORIGIN.ADMIN, OPERATION.ADMIN_UNSUBSCRIBE);
    flushLog_();
    return unsubResult;
  }

  var fields = {
    Stop_Contact: true,
    Do_Not_Contact_Reason: dncReason,
    Status: STATUS.STOPPED,
    Next_Action_Date: ''
  };
  writeRowById_(prospectId, fields, { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_STOP });
  logEvent_(LOG_LEVEL.INFO, LOG_EVENT.STOP, prospectId, found.values.Email_Normalized, '', 'reason=' + dncReason);
  flushLog_();
  return { success: true };
}

/**
 * N9 (controlled-fixture Step-2 due override): makes ONE explicitly
 * controlled test fixture due for Step 2 immediately, for a Google-real
 * retest — WITHOUT touching global cadence, Config, Date_Added, sequence
 * state, or any other field. The only write this can ever make is
 * Next_Action_Date, structurally enforced by OPERATION.ADMIN_FIXTURE_DUE_OVERRIDE's
 * permission grant (Constants.gs) — not merely by this function's own
 * discipline.
 *
 * ARCHITECTURE: read-only guards only, identical in spirit to
 * sendControlledFixtureLive (Mailer.gs, N8) — same CONTROLLED_FIXTURE_SOURCES
 * allowlist, same countProspectRowsById_ exact-match check, same
 * isSuppressed_/isLiveKeyBlocked_ reuse. Nothing here reimplements
 * cadence math, eligibility, or idempotency logic — canSend_/
 * isEligibleForNextStep_/computeNextActionDate_ are all completely
 * untouched by this function; it only sets the ONE field they already
 * read (Next_Action_Date) to a value that is already due, so the NEXT
 * normal eligibility check (canSend_, called by the normal send path)
 * picks the fixture up exactly as it would any other due prospect —
 * canSend_ itself is never bypassed.
 *
 * A real prospect's Source is never in CONTROLLED_FIXTURE_SOURCES, so
 * this is refused before any write, always.
 */
function makeControlledFixtureDueNow(prospectId) {
  // Guard 1: exactly one row for this id.
  var matchCount = countProspectRowsById_(prospectId);
  if (matchCount !== 1) {
    return { status: 'REJECTED_AMBIGUOUS_ID', matchCount: matchCount };
  }

  var found = findRowById_(prospectId);
  if (!found) return { status: 'REJECTED_NOT_FOUND' };
  var p = found.values;

  // Guard 2: THE core protection — Source allowlist (SAME allowlist N8's
  // sendControlledFixtureLive uses — a single source of truth for "what
  // counts as a controlled test fixture" in this project).
  if (CONTROLLED_FIXTURE_SOURCES.indexOf(p.Source) === -1) {
    return { status: 'REJECTED_SOURCE_NOT_CONTROLLED', source: p.Source };
  }

  // Guard 3/4: must genuinely be mid-sequence, exactly at step 1 done.
  if (p.Status !== STATUS.IN_SEQUENCE) {
    return { status: 'REJECTED_WRONG_STATUS', prospectStatus: p.Status };
  }
  if (Number(p.Sequence_Step) !== 1) {
    return { status: 'REJECTED_WRONG_SEQUENCE_STEP', sequenceStep: p.Sequence_Step };
  }

  // Guard 5/6/7: Step 1 must have genuinely, verifiably happened — never
  // manufacture a due date for a step that was never actually sent.
  if (!p.Step1_Sent_At) return { status: 'REJECTED_MISSING_STEP1_SENT_AT' };
  if (!p.Thread_ID) return { status: 'REJECTED_MISSING_THREAD_ID' };
  if (!p.Last_Message_ID) return { status: 'REJECTED_MISSING_LAST_MESSAGE_ID' };

  // Guards 8/9/10: the same eligibility fields canSend_ itself enforces,
  // re-checked here explicitly for a named, specific rejection reason.
  if (p.Replied === true) return { status: 'REJECTED_REPLIED' };
  if (p.Stop_Contact === true) return { status: 'REJECTED_STOP_CONTACT' };
  if (p.Do_Not_Contact_Reason) return { status: 'REJECTED_DNC', reason: p.Do_Not_Contact_Reason };

  // Guard 11: Suppression.
  if (isSuppressed_(p.Email_Normalized, p.Domain)) {
    return { status: 'REJECTED_SUPPRESSED' };
  }

  // Guard 12: no unresolved LIVE Step-2 ledger row — the SAME durable
  // block normal LIVE sending itself enforces (Ledger.gs). Blocks on
  // CLAIMED/SENT/AMBIGUOUS, exactly like isLiveKeyBlocked_ always does.
  if (isLiveKeyBlocked_(prospectId, 2)) {
    return { status: 'REJECTED_LIVE_STEP2_BLOCKED' };
  }

  // Every guard passed. The ONLY write: Next_Action_Date, already due.
  // One minute in the past, not "now" — avoids any exact-equality race
  // against the caller's own `now` a moment later. OPERATION.
  // ADMIN_FIXTURE_DUE_OVERRIDE's permission grant (Constants.gs) makes
  // this structurally the only column this call can ever touch.
  var dueDate = new Date(Date.now() - 60000);
  writeRowById_(prospectId, { Next_Action_Date: dueDate },
    { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_FIXTURE_DUE_OVERRIDE });
  logEvent_(LOG_LEVEL.INFO, LOG_EVENT.FIXTURE_DUE_OVERRIDE, prospectId, p.Email_Normalized, 2,
    'Controlled fixture made due now for Step 2 retest. Next_Action_Date=' + dueDate);
  flushLog_();
  return { status: 'DUE_NOW', prospectId: prospectId, nextActionDate: dueDate };
}
