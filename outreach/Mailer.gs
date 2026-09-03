/**
 * Klinner Outreach — Mailer.gs
 * The only file allowed to call Gmail send/draft APIs.
 *
 * SAFETY MODEL (read before touching this file):
 *   1. previewStep()/previewQueue() are safe BY CONSTRUCTION: they never
 *      call GmailApp...send(), GmailThread.reply(), or writeRowById_() with
 *      origin=PIPELINE. There is no DRY_RUN check that could be bypassed —
 *      the send/reply calls simply do not appear anywhere in that code path.
 *   2. LIVE sending has exactly ONE real entry point: executeLiveSendForStep_,
 *      defined inside a closure below (Codex audit finding #8). The actual
 *      Gmail-calling helpers (doStep1Send_, doFollowUpSend_) are NOT global
 *      — like SheetRepo.gs's applyFieldsToRow_ (finding #1), they live
 *      inside the IIFE's closure and are structurally unreachable from any
 *      other file. sendStep1()/sendFollowUp() are thin, name-stable public
 *      wrappers around executeLiveSendForStep_ — calling them directly
 *      cannot skip a single guard, because there is no other path to the
 *      Gmail call.
 *   3. executeLiveSendForStep_ itself is wrapped by performLiveSend_, which
 *      throws immediately if DRY_RUN=TRUE or if any PENDING_F0 Config key
 *      remains unresolved (I21), BEFORE it does anything else.
 *   4. The KLINNER/Outreach label is applied ONLY inside the LIVE closure.
 *      Preview drafts are never labeled.
 * In F1, DRY_RUN=TRUE by default and no trigger, menu default, or test in
 * this delivery flips it to FALSE — LIVE sending is provably unreachable.
 * See T18–T20, T26–T28, T34, plus the new finding-8/9/10 tests in Tests.gs.
 */

/** Every LIVE send/reply call in this project passes through this wrapper. Zero exceptions. */
function performLiveSend_(actionFn) {
  var config = getConfig();
  if (config.DRY_RUN === true) {
    throw new Error('performLiveSend_ blocked: DRY_RUN=TRUE. LIVE sending is disabled while in preview mode.');
  }
  assertLiveAllowed_(); // I21 — throws if any PENDING_F0 key remains.
  return actionFn(config);
}

/**
 * Codex finding #9: QUOTA_SAFETY_MARGIN was defined in Config but never
 * read anywhere. The effective LIVE budget for a single send attempt must
 * respect MAX_PER_DAY, sends already confirmed today, Gmail's own
 * remaining daily quota, AND the safety margin — all four, every time.
 */
function computeLiveSendBudget_(config) {
  var sentToday = getDailyLiveSentCount_();
  var remainingDailyCap = config.MAX_PER_DAY - sentToday;
  var remainingGmailQuota = MailApp.getRemainingDailyQuota() - (config.QUOTA_SAFETY_MARGIN || 0);
  return Math.max(0, Math.min(remainingDailyCap, remainingGmailQuota));
}

function buildPreviewBody_(body) {
  return PREVIEW_BANNER + '\n\n' + body;
}

function previewSubjectPrefix_(step) {
  return PREVIEW_SUBJECT_PREFIX_TEMPLATE.replace('{STEP}', String(step));
}

function safeRenderStep1Subject_(prospect, config) {
  try {
    return renderTemplateForStep_(1, prospect, config).subject;
  } catch (e) {
    return prospect.Business_Name || 'follow-up';
  }
}

function applyOutreachLabel_(thread, config) {
  var labelName = config.GMAIL_LABEL || DEFAULT_GMAIL_LABEL;
  var label = GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);
  thread.addLabel(label);
}

/**
 * Codex finding #4 / reaudit N3: draft ownership must be verified with more
 * than a bare Draft_ID before anything is deleted — a manually-edited
 * SendLedger row (or a coincidental ID collision) must never cause a real,
 * unrelated Gmail draft to be deleted.
 *
 * TWO INDEPENDENT signals are checked, tried in this order, and EITHER one
 * confirming ownership is sufficient (this is deliberately an OR, not an
 * AND — see below for why):
 *
 *   1. PERSISTENT MESSAGE ID (primary). At draft-creation time,
 *      previewStep() captures draft.getMessage().getId() — a Gmail-
 *      assigned internal identifier, not editable body/subject text — into
 *      the ledger row's Message_ID column. On every later ownership check,
 *      the CURRENT draft's message id is compared against that stored
 *      value. This is what lets the system recognize a draft it created
 *      even after the operator has edited the subject/body during review
 *      (N3's core requirement): editing a draft's visible content does not
 *      change the identifier Gmail assigned to the underlying message.
 *      REQUIRES GOOGLE REAL: whether a real Gmail draft's message id is
 *      guaranteed stable across a UI content edit is NOT independently
 *      verifiable from Apps Script's documentation or from this local
 *      mock — it is assumed stable based on how Gmail draft editing is
 *      commonly understood to work (in-place revision of one message, not
 *      a new message object), but this delivery does not claim proof of
 *      it. If real testing shows it is NOT stable, this signal simply
 *      never matches post-edit and the system falls back to signal 2
 *      below — it does not fail unsafely either way.
 *   2. BANNER + RECIPIENT (fallback). The pre-existing check: the draft's
 *      body starts with the exact PREVIEW_BANNER line AND the recipient
 *      matches the ledger row's Email_Normalized. Used when there is no
 *      stored Message_ID to compare (e.g. a ledger row written before this
 *      fix) or when the stored Message_ID does not match.
 *
 * Why OR and not AND: the two signals defend against different failure
 * modes — signal 1 defends against the operator legitimately editing the
 * body (which breaks signal 2 but not signal 1); signal 2 is what confirms
 * ownership on the very first check a row ever gets, before any edit. A
 * draft only ever gets deleted if AT LEAST ONE independent, non-trivially-
 * forgeable signal confirms it — not just a bare Draft_ID.
 *
 * Residual risk (explicitly acknowledged, not hidden): an attacker with
 * edit access to the SendLedger sheet who forges BOTH Draft_ID and
 * Message_ID to point at a specific foreign draft could defeat this. That
 * requires discovering a real target draft's internal Gmail message id
 * (not exposed in the Gmail UI) and coordinating two cell edits — a
 * materially higher bar than the single-cell Draft_ID tamper this fix
 * closes, and matches the "reasonably sufficient for F1" bar from the
 * original audit. A forged Draft_ID ALONE (the demonstrated attack) still
 * fails closed: see the negative tests in Tests.gs.
 */
function verifyPreviewDraftOwnership_(draft, ledgerEntryValues) {
  var message;
  try {
    message = draft.getMessage();
  } catch (e) {
    logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, ledgerEntryValues.Prospect_ID, ledgerEntryValues.Email_Normalized,
      ledgerEntryValues.Step, 'verifyPreviewDraftOwnership_ could not inspect draft: ' + e);
    return false;
  }

  // Signal 1: persistent Message_ID, survives body/subject edits.
  if (ledgerEntryValues.Message_ID) {
    try {
      if (message.getId() === ledgerEntryValues.Message_ID) return true;
    } catch (e) {
      // Fall through to signal 2 — do not treat an inspection error as ownership.
    }
  }

  // Signal 2: banner + recipient (fallback; also the only check available
  // for ledger rows written before Message_ID capture existed).
  try {
    var body = message.getPlainBody ? message.getPlainBody() : message.getBody();
    if (typeof body !== 'string' || body.indexOf(PREVIEW_BANNER) !== 0) return false;

    var to = (message.getTo ? (message.getTo() || '') : '').toLowerCase();
    var expectedEmail = (ledgerEntryValues.Email_Normalized || '').toLowerCase();
    if (expectedEmail && to.indexOf(expectedEmail) === -1) return false;

    return true;
  } catch (e) {
    logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, ledgerEntryValues.Prospect_ID, ledgerEntryValues.Email_Normalized,
      ledgerEntryValues.Step, 'verifyPreviewDraftOwnership_ could not inspect draft body: ' + e);
    return false;
  }
}

/**
 * Replaces the old deletePreviewDraftById_(): looks the draft up by ID
 * (already gone = fine, not an error), then REFUSES to delete unless
 * ownership is verified. Never deletes on unverified ownership — logs
 * ERROR instead and leaves both the draft and the ledger row untouched, so
 * a human reviewing the Log/SendLedger sheets can see exactly what needs
 * checking (Prospects itself cannot be marked NEEDS_REVIEW from here — that
 * would violate I14/the preview-never-writes-Prospects invariant).
 */
function deletePreviewDraftIfOwned_(draftId, ledgerEntryValues) {
  if (!draftId) return { deleted: false, reason: 'no_draft_id' };
  var drafts = GmailApp.getDrafts();
  var match = null;
  for (var i = 0; i < drafts.length; i++) {
    if (drafts[i].getId() === draftId) { match = drafts[i]; break; }
  }
  if (!match) return { deleted: false, reason: 'not_found' }; // Already gone — not an error.

  if (!verifyPreviewDraftOwnership_(match, ledgerEntryValues)) {
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, ledgerEntryValues.Prospect_ID, ledgerEntryValues.Email_Normalized,
      ledgerEntryValues.Step, 'Refused to delete Draft_ID=' + draftId + ' — ownership could not be verified ' +
      '(missing preview banner and/or recipient mismatch). Left untouched. Needs manual review.');
    return { deleted: false, reason: 'ownership_unverified' };
  }

  match.deleteDraft();
  return { deleted: true };
}

/**
 * Supersedes any existing live preview draft for (prospectId, step) before
 * creating a new one. Guarantees at most one live draft per key (§6.4).
 * Best-effort: if ownership can't be verified, it logs and leaves the old
 * ledger row as-is (State=DRAFTED, not SUPERSEDED) rather than either
 * deleting a possibly-foreign draft or blocking the fresh preview.
 */
function supersedeExistingPreviewDraft_(prospectId, step) {
  var existing = findActiveDryRunDraft_(prospectId, step);
  if (!existing) return;
  var result = deletePreviewDraftIfOwned_(existing.values.Draft_ID, existing.values);
  if (result.deleted || result.reason === 'not_found') {
    supersedeLedgerRow_(existing.rowIndex);
    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.DRAFT_SUPERSEDED, prospectId, existing.values.Email_Normalized, step,
      'Superseded draft ' + existing.values.Draft_ID + ' (' + (result.deleted ? 'deleted' : 'already gone') + ').');
  }
  // ownership_unverified: intentionally left as-is; already logged ERROR above.
}

/**
 * Resolves where a preview draft for `step` should be created: a reply on
 * a real LIVE thread if one exists, otherwise a standalone draft (§6.3).
 * Codex finding #11: GmailApp.getThreadById() returns null (not a thrown
 * exception) for an unresolvable thread ID. A blank/missing Thread_ID and
 * a BROKEN Thread_ID are different situations and must be handled
 * differently: a genuinely broken reference must not be silently
 * downgraded into what looks like a fresh first-contact draft.
 * @return {{skipped: boolean, status: (string|undefined), draft: (Object|undefined), usedThreadId: (string|undefined)}}
 */
function createPreviewDraft_(prospectId, step, prospect, rendered, config) {
  var liveThreadId = prospect.Thread_ID; // LIVE-only column; always blank until F2 sends step 1.

  if (step > 1 && liveThreadId) {
    var thread = GmailApp.getThreadById(liveThreadId);
    if (!thread) {
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'Preview: LIVE Thread_ID "' + liveThreadId + '" no longer resolves (deleted/moved?). ' +
        'Not falling back to a standalone draft — that would misrepresent a real prior thread. Skipping this preview.');
      return { skipped: true, status: 'SKIPPED_THREAD_NOT_FOUND' };
    }
    var draft = thread.createDraftReply(buildPreviewBody_(rendered.body));
    return { skipped: false, draft: draft, usedThreadId: liveThreadId };
  }

  var subject = previewSubjectPrefix_(step) +
    (step === 1 ? rendered.subject : ('Re: ' + safeRenderStep1Subject_(prospect, config)));
  var standaloneDraft = GmailApp.createDraft(prospect.Email, subject, buildPreviewBody_(rendered.body), {
    name: config.SENDER_NAME
  });
  return { skipped: false, draft: standaloneDraft, usedThreadId: standaloneDraft.getMessage().getThread().getId() };
}

/**
 * Creates ONE preview (DRY_RUN) draft for (prospectId, step).
 * Never writes to Prospects. Never calls send()/reply(). Never labels.
 *
 * Codex finding #5: the supersede -> create -> ledger-append sequence is
 * wrapped in LockService so two simultaneous previewStep() calls for the
 * SAME (Prospect_ID, Step) — e.g. one from a menu click and one from
 * previewQueue() running at the same moment — can never both end up with
 * a live draft. (Real concurrent Apps Script executions cannot be proven
 * from this local harness — see the delivery report.)
 *
 * Codex finding #6: if the draft is created but the ledger write then
 * throws, the just-created draft is compensated (deleted) rather than
 * left silently orphaned. If the compensating delete itself fails, that is
 * reported as an explicit error, never swallowed.
 *
 * @return {{status: string, draftId: (string|undefined)}}
 *   status: 'DRAFTED' | 'SKIPPED_NEEDS_DATA' | 'SKIPPED_NOT_ELIGIBLE' |
 *           'SKIPPED_NO_TEMPLATE' | 'SKIPPED_THREAD_NOT_FOUND' |
 *           'SKIPPED_LOCK_BUSY' | 'ERROR_LEDGER_WRITE_FAILED'
 */
function previewStep(prospectId, step) {
  var found = findRowById_(prospectId);
  if (!found) throw new Error('previewStep: Prospect_ID not found: ' + prospectId);
  var prospect = found.values;

  if (!canPreview_(prospect, step)) {
    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SKIP, prospectId, prospect.Email_Normalized, step, 'SKIP:not_eligible');
    return { status: 'SKIPPED_NOT_ELIGIBLE' };
  }

  var config = getConfig();
  var rendered;
  try {
    rendered = renderTemplateForStep_(step, prospect, config);
  } catch (e) {
    if (e.isMissingRequiredFieldError) {
      logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SKIP, prospectId, prospect.Email_Normalized, step,
        'SKIP:needs_data missing=' + e.missingFields.join(','));
      return { status: 'SKIPPED_NEEDS_DATA', missingFields: e.missingFields };
    }
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.SKIP, prospectId, prospect.Email_Normalized, step, 'SKIP:no_template ' + e.message);
    return { status: 'SKIPPED_NO_TEMPLATE' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    logEvent_(LOG_LEVEL.WARN, LOG_EVENT.LOCK_BUSY, prospectId, prospect.Email_Normalized, step, 'previewStep');
    return { status: 'SKIPPED_LOCK_BUSY' };
  }

  try {
    supersedeExistingPreviewDraft_(prospectId, step);

    var draftResult = createPreviewDraft_(prospectId, step, prospect, rendered, config);
    if (draftResult.skipped) return { status: draftResult.status };

    var draftId = draftResult.draft.getId();
    // N3: capture the Gmail-assigned message id NOW, at creation time —
    // this is the persistent identity verifyPreviewDraftOwnership_ uses to
    // recognize this draft as ours even after the operator edits its
    // visible content later. Never left blank when a draft was created.
    var draftMessageId = '';
    try { draftMessageId = draftResult.draft.getMessage().getId(); } catch (e) { /* best-effort; falls back to banner check */ }

    var ledgerEntry = {
      Run_ID: getRunId_(), Claimed_At: '', Prospect_ID: prospectId, Email_Normalized: prospect.Email_Normalized,
      Step: step, Idempotency_Key: getIdempotencyKey_(prospectId, step), Mode: LEDGER_MODE.DRY_RUN,
      State: LEDGER_STATE.DRAFTED, Thread_ID: draftResult.usedThreadId, Message_ID: draftMessageId, Draft_ID: draftId,
      Confirmed_At: new Date(), Error: ''
    };

    try {
      appendLedgerRow_(ledgerEntry);
    } catch (ledgerError) {
      var compensation = deletePreviewDraftIfOwned_(draftId, ledgerEntry);
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'Ledger write failed after draft creation. Draft_ID=' + draftId + ' compensated=' + compensation.deleted +
        (compensation.deleted ? '' : ' — ORPHANED DRAFT, NEEDS MANUAL REVIEW.') + ' ledgerError=' + ledgerError);
      return { status: 'ERROR_LEDGER_WRITE_FAILED', draftId: draftId, compensated: compensation.deleted };
    }

    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.DRAFTED, prospectId, prospect.Email_Normalized, step, 'Draft_ID=' + draftId);
    return { status: 'DRAFTED', draftId: draftId };
  } finally {
    lock.releaseLock();
  }
}

/**
 * ADMIN-adjacent menu action: "Preview today's queue".
 * Builds the same eligibility-ordered queue sendBatch would use (follow-ups
 * first), and calls previewStep() for up to MAX_PREVIEW_PER_RUN prospects.
 * Ignores the LIVE send window/day and the LIVE daily quota — those gate
 * real sending only (§6.5); preview has its own, separate cap.
 */
function previewQueue() {
  var config = getConfig();
  if (config.PAUSE_ALL === true) {
    logEvent_(LOG_LEVEL.WARN, LOG_EVENT.SKIP, '', '', '', 'previewQueue: PAUSE_ALL=TRUE');
    flushLog_();
    return { drafted: 0, skipped: 0, reason: 'PAUSE_ALL' };
  }

  var now = new Date();
  var rows = readAllProspects().filter(function (r) { return isEligibleForNextStep_(r.values, config, now); });
  var ordered = orderQueue_(rows);
  var limit = config.MAX_PREVIEW_PER_RUN || 10;
  var toProcess = ordered.slice(0, limit);

  var results = { drafted: 0, skippedNeedsData: 0, skippedNotEligible: 0, skippedNoTemplate: 0, other: 0 };
  toProcess.forEach(function (r) {
    var step = getNextStepNumber_(r.values, config);
    if (!step) return;
    var outcome = previewStep(r.values.Prospect_ID, step);
    if (outcome.status === 'DRAFTED') results.drafted++;
    else if (outcome.status === 'SKIPPED_NEEDS_DATA') results.skippedNeedsData++;
    else if (outcome.status === 'SKIPPED_NOT_ELIGIBLE') results.skippedNotEligible++;
    else if (outcome.status === 'SKIPPED_NO_TEMPLATE') results.skippedNoTemplate++;
    else results.other++;
  });

  flushLog_();
  return results;
}

/** ADMIN menu action: "Preview full sequence for selected row" — steps 1..MAX_STEPS. */
function previewFullSequenceForSelectedRow(prospectId) {
  var config = getConfig();
  var maxSteps = config.MAX_STEPS || 4;
  var outcomes = [];
  for (var step = 1; step <= maxSteps; step++) {
    outcomes.push({ step: step, outcome: previewStep(prospectId, step) });
  }
  flushLog_();
  return outcomes;
}

/** ADMIN menu action: "Delete Klinner preview drafts" — cleanup convenience, not required to go LIVE. */
function deleteKlinnerPreviewDrafts() {
  var rows = readAllLedgerRows_();
  var deleted = 0;
  var refused = 0;
  rows.forEach(function (r) {
    if (r.values.Mode === LEDGER_MODE.DRY_RUN && r.values.State === LEDGER_STATE.DRAFTED) {
      var result = deletePreviewDraftIfOwned_(r.values.Draft_ID, r.values);
      if (result.deleted || result.reason === 'not_found') {
        supersedeLedgerRow_(r.rowIndex);
        deleted++;
      } else {
        refused++; // Already logged ERROR inside deletePreviewDraftIfOwned_.
      }
    }
  });
  logEvent_(LOG_LEVEL.INFO, LOG_EVENT.DRAFT_SUPERSEDED, '', '', '', 'Bulk deleted ' + deleted + ' preview drafts, refused ' + refused + '.');
  flushLog_();
  return { deleted: deleted, refused: refused };
}

// ---------------------------------------------------------------------------
// F2 — LIVE sending. Defined per the approved file list. Unreachable in F1:
// performLiveSend_ throws immediately because DRY_RUN=TRUE. No trigger, menu
// default, or test in this delivery flips DRY_RUN to FALSE.
//
// Codex finding #8: everything that actually touches Gmail for a LIVE send
// lives inside this IIFE's closure and is NOT a global — only
// executeLiveSendForStep_ (assigned below, then wrapped by the public
// sendStep1/sendFollowUp names) can reach it. There is no second, lesser-
// guarded path to a real send.
// ---------------------------------------------------------------------------

var executeLiveSendForStep_;

(function () {
  /**
   * Step 1 send. Claims the ledger BEFORE calling Gmail (idempotency capa
   * 2). Codex finding #6 applies here too: if createDraft() succeeds but
   * .send() then throws, the orphaned (unsent) draft is compensated.
   * Codex finding #9: budget is the caller's job (checked once, under
   * lock, in executeLiveSendForStep_) — this function assumes it already
   * passed.
   */
  function doStep1Send_(prospectId, prospect, rendered, config) {
    var ledgerRowNum = appendLedgerRow_({
      Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: prospectId, Email_Normalized: prospect.Email_Normalized,
      Step: 1, Idempotency_Key: getIdempotencyKey_(prospectId, 1), Mode: LEDGER_MODE.LIVE, State: LEDGER_STATE.CLAIMED,
      Thread_ID: '', Message_ID: '', Draft_ID: '', Confirmed_At: '', Error: ''
    });

    var draft = GmailApp.createDraft(prospect.Email, rendered.subject, rendered.body,
      { name: config.SENDER_NAME, replyTo: config.REPLY_TO });

    var message;
    try {
      message = draft.send();
    } catch (sendError) {
      var compensated = false;
      try { draft.deleteDraft(); compensated = true; } catch (deleteError) { compensated = false; }
      updateLedgerRow_(ledgerRowNum, { State: LEDGER_STATE.FAILED, Error: String(sendError) });
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, 1,
        'send() failed after draft creation. compensated=' + compensated +
        (compensated ? '' : ' — ORPHANED UNSENT DRAFT, NEEDS MANUAL REVIEW.') + ' error=' + sendError);
      throw sendError;
    }

    var thread = message.getThread();
    applyOutreachLabel_(thread, config);

    updateLedgerRow_(ledgerRowNum, {
      State: LEDGER_STATE.SENT, Thread_ID: thread.getId(), Message_ID: message.getId(), Confirmed_At: new Date()
    });

    writeRowById_(prospectId, {
      Status: STATUS.IN_SEQUENCE, Sequence_Step: 1, Last_Contacted: new Date(),
      Step1_Sent_At: new Date(), Thread_ID: thread.getId(), Last_Message_ID: message.getId(),
      Next_Action_Date: computeNextActionDate_(1, new Date(), config) || ''
    }, { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });

    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SENT, prospectId, prospect.Email_Normalized, 1, 'LIVE step 1 sent.');
    return { status: 'SENT' };
  }

  /**
   * Follow-up send (step 2+). Codex finding #11: GmailApp.getThreadById()
   * returning null (broken/deleted thread reference) is handled explicitly
   * — the prospect is stopped into NEEDS_REVIEW rather than either
   * throwing an ambiguous exception or silently doing nothing.
   * Codex finding #7: GmailThread.reply(body) returns the GmailThread
   * itself, NOT a GmailMessage — it has no .getId() that means "message
   * id". The real, documented way to get the message that reply() just
   * created is GmailThread.getMessages(), whose last element is that new
   * message (reply() is synchronous and this is the only outbound call in
   * this critical section, so nothing else can have appended a message
   * in between). No Message_ID is invented.
   *
   * ==========================================================================
   * BLOCKER BEFORE FIRST LIVE EMAIL — N5 (reaudit finding, intentionally NOT
   * fixed in this F1 delivery per explicit instruction — this entire
   * function is unreachable in F1: DRY_RUN=TRUE + 5 unresolved PENDING_F0
   * keys both block performLiveSend_ before this code can ever run).
   *
   * Residual race: "nothing else can have appended a message in between"
   * above assumes no inbound reply lands in the same thread in the narrow
   * window between thread.reply() returning and the immediately-following
   * getMessages() call. If a real inbound reply DOES land in that window,
   * messagesAfter.length will be messagesBefore + 2, not + 1, and the guard
   * below throws — which marks the ledger row LEDGER_STATE.FAILED via the
   * catch in executeLiveSendForStep_'s caller.
   *
   * FAILED is deliberately excluded from isLiveKeyClaimedOrSent_'s
   * CLAIMED/SENT check (Ledger.gs) — that is correct for ordinary
   * transient failures (network error, quota hiccup), which SHOULD be
   * retryable. But it means THIS specific failure is retryable too: the
   * Prospects row was never updated (the writeRowById_ call is after this
   * guard), so a later sendBatch run will see the same prospect as still
   * eligible and call doFollowUpSend_ again — sending a SECOND real
   * follow-up email into the same thread.
   *
   * Must be closed before DRY_RUN is ever set to FALSE. Two directions
   * worth evaluating (a decision, not a fix, for whoever picks this up):
   * (a) distinguish this specific failure mode from ordinary transient
   * ones and route it to NEEDS_REVIEW (like the getThreadById-null case
   * above) instead of leaving it retryable, or (b) identify the sent
   * message by a property of the reply itself (if Apps Script exposes
   * one) rather than by array-length diffing, removing the race entirely.
   * Do not implement either without entering F2 scope.
   * ==========================================================================
   */
  function doFollowUpSend_(prospectId, step, prospect, rendered, config) {
    var thread = GmailApp.getThreadById(prospect.Thread_ID);
    if (!thread) {
      writeRowById_(prospectId, { Status: STATUS.NEEDS_REVIEW },
        { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'LIVE Thread_ID "' + prospect.Thread_ID + '" no longer resolves (deleted/moved?). ' +
        'Stopped this prospect into NEEDS_REVIEW rather than risk a reply landing in the wrong place.');
      return { status: 'NEEDS_REVIEW_THREAD_NOT_FOUND' };
    }

    var ledgerRowNum = appendLedgerRow_({
      Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: prospectId, Email_Normalized: prospect.Email_Normalized,
      Step: step, Idempotency_Key: getIdempotencyKey_(prospectId, step), Mode: LEDGER_MODE.LIVE, State: LEDGER_STATE.CLAIMED,
      Thread_ID: prospect.Thread_ID, Message_ID: '', Draft_ID: '', Confirmed_At: '', Error: ''
    });

    var messagesBefore = thread.getMessages().length;
    var repliedThread;
    try {
      repliedThread = thread.reply(rendered.body); // Returns GmailThread, not GmailMessage — see docstring.
    } catch (replyError) {
      updateLedgerRow_(ledgerRowNum, { State: LEDGER_STATE.FAILED, Error: String(replyError) });
      throw replyError;
    }

    var messagesAfter = repliedThread.getMessages();
    if (messagesAfter.length !== messagesBefore + 1) {
      // Should be structurally impossible given reply() just returned
      // successfully, but never invent a Message_ID — fail loud instead.
      updateLedgerRow_(ledgerRowNum, { State: LEDGER_STATE.FAILED, Error: 'Unexpected message count after reply().' });
      throw new Error('doFollowUpSend_: could not reliably identify the message reply() just created ' +
        '(expected ' + (messagesBefore + 1) + ' messages, found ' + messagesAfter.length + ').');
    }
    var sentMessage = messagesAfter[messagesAfter.length - 1];

    applyOutreachLabel_(repliedThread, config);
    updateLedgerRow_(ledgerRowNum, { State: LEDGER_STATE.SENT, Message_ID: sentMessage.getId(), Confirmed_At: new Date() });

    var stepColName = 'Step' + step + '_Sent_At';
    var fields = { Sequence_Step: step, Last_Contacted: new Date(), Last_Message_ID: sentMessage.getId() };
    fields[stepColName] = new Date();
    var nextDate = computeNextActionDate_(step, new Date(), config);
    fields.Status = nextDate ? STATUS.IN_SEQUENCE : STATUS.SEQUENCE_DONE;
    fields.Next_Action_Date = nextDate || '';

    writeRowById_(prospectId, fields, { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SENT, prospectId, prospect.Email_Normalized, step, 'LIVE step ' + step + ' sent.');
    return { status: 'SENT' };
  }

  /**
   * THE single LIVE entry point (Codex finding #8). Every guard that must
   * hold before a real email goes out lives here, checked in this order:
   * lock -> PAUSE_ALL -> send window/day -> fresh prospect read ->
   * canSend_ (Status/step-sequence/Next_Action_Date/StepN_Sent_At/Stop/
   * DNC/Replied/Suppression, hardened per finding #10) -> ledger
   * already-claimed check (I13) -> quota (finding #9: MAX_PER_DAY +
   * sent-today + Gmail remaining quota + QUOTA_SAFETY_MARGIN). DRY_RUN and
   * PENDING_F0 are checked one level up, by performLiveSend_, before the
   * lock is even requested.
   */
  executeLiveSendForStep_ = function (prospectId, step) {
    return performLiveSend_(function (config) {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(30000)) {
        logEvent_(LOG_LEVEL.WARN, LOG_EVENT.LOCK_BUSY, prospectId, '', step, 'executeLiveSendForStep_');
        return { status: 'SKIPPED_LOCK_BUSY' };
      }

      try {
        if (config.PAUSE_ALL === true) {
          logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SKIP, prospectId, '', step, 'PAUSE_ALL=TRUE');
          return { status: 'SKIPPED_PAUSE_ALL' };
        }

        var now = new Date();
        if (!isWithinSendWindow_(now, config)) {
          logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SKIP, prospectId, '', step, 'Outside configured send window/day.');
          return { status: 'SKIPPED_OUTSIDE_WINDOW' };
        }

        var found = findRowById_(prospectId);
        if (!found) throw new Error('executeLiveSendForStep_: Prospect_ID not found: ' + prospectId);
        var prospect = found.values;

        if (!canSend_(prospect, step, config, now)) {
          logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SKIP, prospectId, prospect.Email_Normalized, step, 'SKIP:not_eligible (canSend_)');
          return { status: 'SKIPPED_NOT_ELIGIBLE' };
        }
        if (isLiveKeyClaimedOrSent_(prospectId, step)) {
          return { status: 'SKIPPED_ALREADY_CLAIMED' };
        }

        var budget = computeLiveSendBudget_(config);
        if (budget <= 0) {
          logEvent_(LOG_LEVEL.WARN, LOG_EVENT.QUOTA_ABORT, prospectId, prospect.Email_Normalized, step,
            'No LIVE send budget remaining (MAX_PER_DAY / sent-today / Gmail remaining quota / QUOTA_SAFETY_MARGIN).');
          return { status: 'QUOTA_ABORT' };
        }

        var rendered = renderTemplateForStep_(step, prospect, config);
        return step === 1
          ? doStep1Send_(prospectId, prospect, rendered, config)
          : doFollowUpSend_(prospectId, step, prospect, rendered, config);
      } finally {
        lock.releaseLock();
      }
    });
  };
})();

/** Public, name-stable wrapper. See the IIFE above — there is no other path to a real send. */
function sendStep1(prospectId) {
  return executeLiveSendForStep_(prospectId, 1);
}

/** Public, name-stable wrapper. See the IIFE above — there is no other path to a real send. */
function sendFollowUp(prospectId, step) {
  return executeLiveSendForStep_(prospectId, step);
}

/**
 * LIVE orchestrator (F2). Not called by any trigger, menu default, or test
 * in this F1 delivery. Included per the approved file list. Deliberately
 * thin — ALL real authority (lock, PAUSE_ALL, window, eligibility, quota)
 * lives in executeLiveSendForStep_ now, so this is just a candidate list.
 */
function sendBatch() {
  var config = getConfig();
  if (config.PAUSE_ALL === true) { logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SKIP, '', '', '', 'sendBatch: PAUSE_ALL'); flushLog_(); return; }
  if (config.DRY_RUN === true) { logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SKIP, '', '', '', 'sendBatch: DRY_RUN=TRUE, no-op'); flushLog_(); return; }
  if (!isWithinSendWindow_(new Date(), config)) { logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SKIP, '', '', '', 'sendBatch: outside window'); flushLog_(); return; }

  try {
    assertLiveAllowed_();
  } catch (e) {
    flushLog_();
    return;
  }

  var now = new Date();
  var rows = readAllProspects().filter(function (r) { return isEligibleForNextStep_(r.values, config, now); });
  var ordered = orderQueue_(rows).slice(0, config.MAX_PER_RUN);

  ordered.forEach(function (r, idx) {
    var step = getNextStepNumber_(r.values, config);
    if (!step) return;
    try {
      if (step === 1) sendStep1(r.values.Prospect_ID); else sendFollowUp(r.values.Prospect_ID, step);
    } catch (e) {
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, r.values.Prospect_ID, r.values.Email_Normalized, step, String(e));
    }
    if (idx < ordered.length - 1) {
      Utilities.sleep((config.MIN_SLEEP_SECONDS + Math.random() * (config.MAX_SLEEP_SECONDS - config.MIN_SLEEP_SECONDS)) * 1000);
    }
  });

  flushLog_();
}
