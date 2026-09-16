/**
 * Klinner Outreach — Mailer.gs
 * The only file allowed to call Gmail send/draft APIs.
 *
 * SAFETY MODEL (read before touching this file):
 *   1. previewStep()/previewQueue() are safe BY CONSTRUCTION: they never
 *      call GmailApp...send(), Gmail API messages.send, or writeRowById_() with
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
 * N3 V2 (Google-real reaudit, round 3): a deterministic content fingerprint
 * over exactly the parts of a draft that define its actual outreach
 * content. Computed once at creation time (stored in the ledger row) and
 * recomputed on every later check — a mismatch means a human (or anything
 * else) changed the recipient, subject, or body, FULL STOP, independent of
 * Message_ID. The round-2 design used "Message_ID unchanged" as a proxy
 * for "unedited"; the round-3 audit correctly rejected that: Draft_ID,
 * Thread_ID AND Message_ID can all stay identical while the recipient or
 * subject was silently changed underneath them. Content identity must be
 * checked directly.
 *
 * Canonicalization (deterministic, explicit — never silently reinterpreted
 * elsewhere):
 *   - recipient: N3 V3 — Gmail can represent the same single recipient
 *     either as a bare address ("a@b.com") or with a display name
 *     ("Name <a@b.com>") depending on how a draft was created/edited. This
 *     is a structural wrapper difference, not a content edit — extract the
 *     bare address out of an optional "<...>" wrapper (extractEmailForFingerprint_
 *     below), then trim/lowercase it. Outreach is single-recipient only —
 *     this deliberately does not attempt multi-recipient parsing.
 *   - subject: trimmed only. Case and internal spacing are real, operator-
 *     visible content and must count as an edit if changed.
 *   - body: CRLF normalized to LF (Gmail may round-trip line endings on
 *     save — that alone must never look like a human edit), then trimmed
 *     of leading/trailing whitespace only (a bare trailing newline Gmail
 *     adds on save must not register as an edit either). All internal
 *     content is preserved exactly, including the preview banner. This is
 *     deliberately NOT more aggressive than that: a false positive (an
 *     insignificant Gmail round-trip difference triggers "edited" and the
 *     draft gets preserved when it didn't strictly need to) is acceptable;
 *     a false negative (a real human edit gets canonicalized away and the
 *     draft is silently deleted/regenerated) is not.
 * Joined as recipient + "\n" + subject + "\n" + body, hashed with SHA-256.
 * Deliberately excludes every mutable, non-content field (Message_ID,
 * Draft_ID, Thread_ID, timestamps) — those can legitimately change without
 * the actual outreach content changing at all.
 */
function computeDraftFingerprint_(recipient, subject, body) {
  var canonicalRecipient = extractEmailForFingerprint_(recipient);
  var canonicalSubject = String(subject || '').trim();
  var canonicalBody = String(body || '').replace(/\r\n/g, '\n').trim();
  var input = canonicalRecipient + '\n' + canonicalSubject + '\n' + canonicalBody;
  var digestBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
  return bytesToHex_(digestBytes);
}

/**
 * Extracts the bare email address from a single recipient field that may
 * be either "a@b.com" or "Display Name <a@b.com>" — purely a structural
 * normalization (Gmail's own wrapper format), not a content interpretation.
 * A recipient with no "<...>" wrapper is used as-is. Single-recipient only.
 */
function extractEmailForFingerprint_(recipientField) {
  var s = String(recipientField || '').trim();
  var match = /<([^>]+)>/.exec(s);
  return (match ? match[1] : s).trim().toLowerCase();
}

/** Apps Script's computeDigest returns signed bytes (-128..127); real SHA-256 hex needs them unsigned. */
function bytesToHex_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var v = bytes[i];
    if (v < 0) v += 256;
    var h = v.toString(16);
    hex += (h.length === 1 ? '0' + h : h);
  }
  return hex;
}

/**
 * Codex finding #4 / N3 (three rounds — see the two Google-real findings
 * folded in below): draft ownership must be verified with more than a bare
 * Draft_ID before anything is deleted — a manually-edited SendLedger row
 * (or a coincidental ID collision) must never cause a real, unrelated
 * Gmail draft to be deleted.
 *
 * GOOGLE-REAL FINDING (round 2): a real Gmail draft's Message_ID is NOT
 * stable across a human content edit — Draft_ID and Thread_ID stay fixed,
 * but Message_ID rotates when the operator edits and Gmail re-saves.
 *
 * REAUDIT FINDING (round 3): Message_ID staying the SAME does not prove
 * the content stayed the same either — nothing gAPI-level forces Message_ID
 * to rotate on every edit; recipient/subject could change with Message_ID
 * untouched. Message_ID is therefore now IGNORED entirely as an ownership
 * or edit-detection signal — it is stored purely as informational metadata
 * for a human reviewing SendLedger. The ONLY authority on "did the content
 * change" is the content fingerprint (computeDraftFingerprint_ above),
 * compared directly against what was stored when the row was written.
 *
 * Every Gmail-facing call in this function is individually wrapped in
 * try/catch (round-3 finding #4: an inspection error must never be
 * silently treated as "fine, must be unedited" or "fine, must be gone" —
 * both would authorize an action that could destroy something real). Any
 * such failure sets `fatal: true` and the caller (resolveExistingPreviewDraft_)
 * is REQUIRED to fail closed on it — never delete, never create a
 * duplicate, never change ledger state.
 *
 * Checks, in order:
 *   0. THREAD_ID STABILITY. If the ledger row has a stored Thread_ID, the
 *      draft's current thread id must match it exactly — assigned once at
 *      creation, never changes for a legitimate edit. A mismatch is ALWAYS
 *      disqualifying (CASO 6), regardless of anything below.
 *   1. BANNER PRESENCE. The draft's body must start with the exact
 *      PREVIEW_BANNER line. This is the minimal, hard-to-forge anchor that
 *      the matched draft really is one WE created (only this code writes
 *      that literal string) — it does not depend on the recipient still
 *      matching, because recipient itself is now content the fingerprint
 *      protects, not an ownership gate. Missing banner -> not owned
 *      (protects CASO 3 — an unrelated/tampered draft).
 *   2. CONTENT FINGERPRINT. Recomputed from the draft's CURRENT recipient/
 *      subject/body and compared to the ledger row's stored
 *      Draft_Fingerprint. A mismatch means the content changed — recipient,
 *      subject, or body, any of them (CASO 2/3/5) — and `edited: true` is
 *      returned so the caller durably preserves the draft rather than
 *      silently regenerating or overwriting it.
 *
 *      N3 V3 — LEGACY BLANK FINGERPRINT (Codex final audit, blocker N3-1):
 *      a ledger row written before Draft_Fingerprint existed (or one whose
 *      capture failed at creation — see previewStep's fail-closed handling
 *      below) has NOTHING to compare against. Round-2/round-3-draft code
 *      would have read `ledgerEntryValues.Draft_Fingerprint` as falsy and
 *      computed `edited = false` — i.e. silently treated "we have no idea"
 *      as "definitely unedited", which is exactly backwards and is exactly
 *      how a real edited draft (Rosa's Bakery, TEST EDIT) could have been
 *      deleted after this column was added. A blank stored fingerprint is
 *      therefore its own outcome, `legacy: true`, always paired with
 *      `edited: true` — the caller treats it identically to a confirmed
 *      edit (durable preserve), NEVER as evidence of "unedited". This is
 *      deliberately conservative even for a draft that turns out to have
 *      been untouched (e.g. Acme) — preserving something that didn't
 *      strictly need it is an acceptable cost; auto-deleting something
 *      that did is not.
 *
 * Residual risk (explicitly acknowledged, not hidden): an attacker with
 * edit access to the SendLedger sheet who forges Draft_ID AND Thread_ID to
 * both point at one specific foreign draft that ALSO happens to already
 * contain the literal PREVIEW_BANNER string could defeat this. That
 * requires discovering a real target draft's internal Gmail draft id and
 * thread id (neither exposed in the Gmail UI) pointing at a draft that
 * independently contains Klinner's exact preview banner text — a
 * materially higher bar than the single-cell Draft_ID tamper this fix
 * closes, and matches the "reasonably sufficient for F1" bar from the
 * original audit. A forged Draft_ID ALONE (the demonstrated attack) still
 * fails closed: see the negative tests in Tests.gs.
 *
 * @return {{owned: boolean, edited: boolean, legacy: boolean, fatal: boolean,
 *           reason: string, currentMessageId: string, currentFingerprint: string}}
 */
function verifyPreviewDraftOwnership_(draft, ledgerEntryValues) {
  var message;
  try {
    message = draft.getMessage();
  } catch (e) {
    logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, ledgerEntryValues.Prospect_ID, ledgerEntryValues.Email_Normalized,
      ledgerEntryValues.Step, 'verifyPreviewDraftOwnership_: draft.getMessage() failed: ' + e);
    return { owned: false, edited: false, legacy: false, fatal: true, reason: 'get_message_failed', currentMessageId: '', currentFingerprint: '' };
  }

  var currentMessageId = '';
  try {
    currentMessageId = message.getId();
  } catch (e) {
    logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, ledgerEntryValues.Prospect_ID, ledgerEntryValues.Email_Normalized,
      ledgerEntryValues.Step, 'verifyPreviewDraftOwnership_: message.getId() failed: ' + e);
    return { owned: false, edited: false, legacy: false, fatal: true, reason: 'message_id_read_failed', currentMessageId: '', currentFingerprint: '' };
  }

  // Check 0: Thread_ID stability. A mismatch is ALWAYS disqualifying.
  if (ledgerEntryValues.Thread_ID) {
    var currentThreadId;
    try {
      currentThreadId = message.getThread().getId();
    } catch (e) {
      logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, ledgerEntryValues.Prospect_ID, ledgerEntryValues.Email_Normalized,
        ledgerEntryValues.Step, 'verifyPreviewDraftOwnership_: could not read draft thread: ' + e);
      return { owned: false, edited: false, legacy: false, fatal: true, reason: 'thread_read_failed', currentMessageId: currentMessageId, currentFingerprint: '' };
    }
    if (currentThreadId !== ledgerEntryValues.Thread_ID) {
      return { owned: false, edited: false, legacy: false, fatal: false, reason: 'thread_mismatch', currentMessageId: currentMessageId, currentFingerprint: '' };
    }
  }

  var to, subject, body;
  try {
    to = message.getTo ? (message.getTo() || '') : '';
    subject = message.getSubject ? (message.getSubject() || '') : '';
    body = message.getPlainBody ? message.getPlainBody() : message.getBody();
    if (typeof body !== 'string') throw new Error('draft body is not a string');
  } catch (e) {
    logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, ledgerEntryValues.Prospect_ID, ledgerEntryValues.Email_Normalized,
      ledgerEntryValues.Step, 'verifyPreviewDraftOwnership_: could not read draft content: ' + e);
    return { owned: false, edited: false, legacy: false, fatal: true, reason: 'content_read_failed', currentMessageId: currentMessageId, currentFingerprint: '' };
  }

  // Check 1: banner presence — minimal, hard-to-forge ownership anchor.
  if (body.indexOf(PREVIEW_BANNER) !== 0) {
    return { owned: false, edited: false, legacy: false, fatal: false, reason: 'banner_missing', currentMessageId: currentMessageId, currentFingerprint: '' };
  }

  var currentFingerprint = computeDraftFingerprint_(to, subject, body);

  // Check 2a: legacy blank fingerprint (N3 V3, blocker N3-1). NEVER read as
  // "unedited" — see the long comment above. Always durable-preserved.
  if (!ledgerEntryValues.Draft_Fingerprint) {
    return {
      owned: true, edited: true, legacy: true, fatal: false, reason: 'legacy_blank_fingerprint',
      currentMessageId: currentMessageId, currentFingerprint: currentFingerprint
    };
  }

  // Check 2b: content fingerprint — the ONLY authority on "did it change"
  // for a row that DOES have a baseline to compare against.
  var edited = currentFingerprint !== ledgerEntryValues.Draft_Fingerprint;

  return {
    owned: true, edited: edited, legacy: false, fatal: false,
    reason: edited ? 'fingerprint_changed' : 'fingerprint_match',
    currentMessageId: currentMessageId, currentFingerprint: currentFingerprint
  };
}

/**
 * N3 V3 (Codex final audit, round 2 — blocker: enumeration is not safe):
 * every "find this Draft_ID inside a GmailApp.getDrafts() array" loop in
 * this file used to compare `drafts[i].getId() === draftId` UNGUARDED.
 * Codex found that if ANY draft in the list — not necessarily the one
 * being searched for — throws on its OWN .getId() call, the entire loop
 * throws uncaught, escaping whatever fail-closed block the caller thought
 * was protecting it (previewStep()'s creation-metadata block, for
 * instance, never even gets a chance to run its compensation logic).
 * This is now the ONE place that enumeration happens; every caller below
 * goes through it, and NEVER conflates "could not safely enumerate" with
 * "confirmed not found" — those require opposite handling (fail-closed vs.
 * safe-to-treat-as-gone).
 * @return {{found: boolean, uncertain: boolean, draft: (Object|undefined)}}
 */
function findDraftInListSafely_(drafts, draftId) {
  try {
    for (var i = 0; i < drafts.length; i++) {
      if (drafts[i].getId() === draftId) return { found: true, uncertain: false, draft: drafts[i] };
    }
    return { found: false, uncertain: false };
  } catch (e) {
    return { found: false, uncertain: true };
  }
}

/**
 * N3 V3: deletes a draft the caller already holds a DIRECT OBJECT
 * REFERENCE to (not looked up by ID) — used ONLY for compensating a draft
 * previewStep() JUST created in this same synchronous execution, before
 * any ledger row exists and before any human could possibly have touched
 * it. Preferred over an ID-based lookup+enumeration wherever a direct
 * reference is already in hand (Codex's explicit guidance: "use the
 * direct draft object for deletion where safer if available") — it
 * removes the enumeration failure surface entirely for this call site, on
 * top of findDraftInListSafely_ already closing it for the callers below
 * that have no choice but to look up by ID (a fresh execution reading
 * Draft_ID back out of the ledger, with no live object reference).
 * @return {boolean} true only when the caller can be CONFIDENT no dangling
 *   Gmail resource remains (the delete call itself succeeded). false means
 *   genuine uncertainty (the delete call threw) — the draft may still
 *   physically exist.
 */
function attemptDeleteDraftDirectly_(draftObj) {
  try {
    draftObj.deleteDraft();
    return true;
  } catch (e) {
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
  var drafts;
  try {
    drafts = GmailApp.getDrafts();
  } catch (e) {
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, ledgerEntryValues.Prospect_ID, ledgerEntryValues.Email_Normalized,
      ledgerEntryValues.Step, 'deletePreviewDraftIfOwned_: GmailApp.getDrafts() failed: ' + e + '. Fail-closed: nothing deleted.');
    return { deleted: false, reason: 'gmail_read_error' };
  }
  var findResult = findDraftInListSafely_(drafts, draftId);
  if (findResult.uncertain) {
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, ledgerEntryValues.Prospect_ID, ledgerEntryValues.Email_Normalized,
      ledgerEntryValues.Step, 'deletePreviewDraftIfOwned_: could not safely enumerate drafts (a listed draft threw on getId()). Fail-closed: nothing deleted.');
    return { deleted: false, reason: 'gmail_read_error' };
  }
  if (!findResult.found) return { deleted: false, reason: 'not_found' }; // Enumeration succeeded and confirmed absence — not an error.
  var match = findResult.draft;

  var verification = verifyPreviewDraftOwnership_(match, ledgerEntryValues);
  if (verification.fatal) {
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, ledgerEntryValues.Prospect_ID, ledgerEntryValues.Email_Normalized,
      ledgerEntryValues.Step, 'Refused to delete Draft_ID=' + draftId + ' — could not safely inspect it ' +
      '(reason=' + verification.reason + '). Fail-closed: left untouched.');
    return { deleted: false, reason: verification.reason, verification: verification };
  }
  if (!verification.owned) {
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, ledgerEntryValues.Prospect_ID, ledgerEntryValues.Email_Normalized,
      ledgerEntryValues.Step, 'Refused to delete Draft_ID=' + draftId + ' — ownership could not be verified ' +
      '(reason=' + verification.reason + '). Left untouched. Needs manual review.');
    return { deleted: false, reason: 'ownership_unverified', verification: verification };
  }

  match.deleteDraft();
  return { deleted: true, verification: verification };
}

/**
 * Decides what to do with any existing live (DRY_RUN, DRAFTED) preview
 * draft for (prospectId, step) BEFORE previewStep() would create a new one.
 * Guarantees at most one live draft per key (§6.4) while never destroying
 * a human's in-review edit — see the Google-real N3 findings on
 * verifyPreviewDraftOwnership_ above for why neither Message_ID nor
 * "Message_ID unchanged" can be trusted as proof of an untouched draft.
 *
 * N3 V2 (round 3 reaudit) adds DURABLE preservation: round 2's design
 * re-evaluated the draft's content on every single previewStep() call,
 * which meant a draft that was edited once, then reconciled (Message_ID
 * updated in the ledger to match), would look "unedited" again on the
 * VERY NEXT run — silently deleted and regenerated, destroying the human's
 * edit one run later than round 2 intended to protect against. The fix:
 * once a draft is recognized as human-edited, the ACTIVE ledger row itself
 * is durably marked (Human_Edit_Preserved=true) and every later run for
 * that key short-circuits straight to preserving it — content is never
 * re-compared, so it can never be "downgraded" back to unedited. The ONLY
 * way out of the preserved state is the Draft_ID itself genuinely no
 * longer resolving in Gmail (CASO 7) or an explicit admin action
 * (deleteKlinnerPreviewDrafts) — never an automatic reclassification.
 *
 * Cases:
 *   CASO 1 (untouched draft: Draft_ID/Thread_ID same, fingerprint same)
 *     -> CREATE_NEW. Old draft deleted, ledger row superseded, caller
 *     creates a fresh one — unchanged from round 1/2 behavior.
 *   CASO 2 (human edit rotates Message_ID) / CASO 3 (human edit does NOT
 *     rotate Message_ID) — both detected purely via a fingerprint mismatch,
 *     both handled IDENTICALLY -> PRESERVE_EXISTING, durable.
 *   CASO 4 (already durably preserved from a prior run) -> PRESERVE_EXISTING
 *     immediately, no content re-check, no ledger growth — see the
 *     short-circuit at the top of this function.
 *   CASO 5 (recipient or subject changed by a human) -> caught by the same
 *     fingerprint mismatch as CASO 2/3 -> PRESERVE_EXISTING, durable,
 *     fail-closed (never deleted, never adopts a different draft).
 *   CASO 6 (Draft_ID resolves but Thread_ID unexpectedly changed) ->
 *     BLOCKED_NEEDS_REVIEW (verifyPreviewDraftOwnership_'s Thread_ID check
 *     fails ownership outright). NOT durable — re-evaluated every run,
 *     since this is a stronger tamper/collision signal than an ordinary
 *     content edit and must never be quietly "adopted" into a preserved
 *     state.
 *   CASO 7 (Draft_ID no longer resolves) -> only reached after Gmail
 *     enumeration SUCCEEDED and genuinely found nothing -> CREATE_NEW
 *     (exits a preserved state too, if it was in one — nothing left to
 *     protect).
 *   CASO 8 (any Gmail read error — enumeration, message, thread, or
 *     content reads) -> BLOCKED_NEEDS_REVIEW, fail-closed. NEVER
 *     interpreted as "missing" (which would wrongly authorize CREATE_NEW)
 *     and never authorizes a delete.
 *   CASO 9 (N3 V3, Codex final audit blocker N3-1 — a legacy row with a
 *     blank Draft_Fingerprint, whether or not it was ever actually
 *     human-edited) -> PRESERVE_EXISTING, durable, via the SAME transition
 *     as CASO 2/3/5 (verifyPreviewDraftOwnership_ returns `legacy: true`
 *     paired with `edited: true` — see its docstring). Never treated as
 *     evidence of "unedited".
 *   CASO 10 (N3 V3, blocker N3-4 — more than one active DRY_RUN/DRAFTED
 *     ledger row exists for the same idempotency key, e.g. from a prior
 *     partially-applied preserve transition) -> BLOCKED_NEEDS_REVIEW,
 *     fail-closed. Never silently picks one row ("last one wins") — that
 *     could delete or duplicate a real Gmail draft based on a guess.
 *
 * @return {{action: string, reason: (string|undefined)}}
 *   action: 'CREATE_NEW' | 'PRESERVE_EXISTING' | 'BLOCKED_NEEDS_REVIEW'
 */
function resolveExistingPreviewDraft_(prospectId, step) {
  // CASO 11 (N3 final round): an unresolved PREVIEW claim blocks
  // everything, checked FIRST. A PREVIEW_CLAIMED row means a draft
  // creation was claimed and may be in flight or died mid-flight; a
  // PREVIEW_AMBIGUOUS row means a Gmail side effect that could have
  // created a draft had an outcome we could not resolve. In BOTH cases a
  // real Gmail draft may exist that we cannot identify — creating another
  // one would be exactly the duplicate this whole barrier exists to
  // prevent. Never auto-resolved: an ADMIN action is required.
  var activePreviewRows = findActivePreviewRows_(prospectId, step);
  var unresolvedClaims = activePreviewRows.filter(function (r) {
    return r.values.State === LEDGER_STATE.PREVIEW_CLAIMED || r.values.State === LEDGER_STATE.PREVIEW_AMBIGUOUS;
  });
  if (unresolvedClaims.length > 0) {
    var claimState = unresolvedClaims[0].values.State;
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, unresolvedClaims[0].values.Email_Normalized, step,
      'Preview blocked: an unresolved ' + claimState + ' ledger row exists for this key ' +
      '(row ' + unresolvedClaims[0].rowIndex + '). A Gmail draft may exist that this run cannot identify — ' +
      'refusing to create another. Needs manual ADMIN review.');
    return {
      action: 'BLOCKED_NEEDS_REVIEW',
      reason: claimState === LEDGER_STATE.PREVIEW_AMBIGUOUS ? 'preview_ambiguous' : 'preview_claim_unresolved'
    };
  }

  // CASO 10: ambiguity guard, before anything else touches Gmail or the
  // ledger. findActiveDryRunDraftRows_ (Ledger.gs) returns every
  // Mode=DRY_RUN/State=DRAFTED row for this key — normally exactly 0 or 1.
  var activeRows = findActiveDryRunDraftRows_(prospectId, step);
  if (activeRows.length > 1) {
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, activeRows[0].values.Email_Normalized, step,
      'AMBIGUOUS: ' + activeRows.length + ' active DRAFTED ledger rows found for the same idempotency key ' +
      '(Draft_IDs: ' + activeRows.map(function (r) { return r.values.Draft_ID; }).join(', ') + '). ' +
      'Fail-closed: nothing touched, no new draft created. Needs manual reconciliation.');
    return { action: 'BLOCKED_NEEDS_REVIEW', reason: 'ambiguous_multiple_active_rows' };
  }
  if (activeRows.length === 0) return { action: 'CREATE_NEW' };
  var existing = activeRows[0];

  // CASO 12 (N3 atomicity round): DEFENSIVE READ SAFETY. A DRAFTED row is
  // a claim that a real Gmail draft exists, and Draft_ID is the only
  // handle we have on it. A DRAFTED row with a blank Draft_ID therefore
  // means one of two things, and BOTH are dangerous to guess about:
  // corruption from a partially-applied write, or a legacy/hand-edited
  // row. Without this guard the code below would look the (blank) id up,
  // not find it, conclude "the draft is already gone", supersede the row
  // and authorize CREATE_NEW — creating a duplicate of a draft that may
  // well still be sitting in Gmail.
  //
  // This is deliberately a SECOND, independent protection: the write
  // ordering in writeLedgerMetadataThenState_ (Ledger.gs) means this code
  // path can no longer produce such a row, but construction safety only
  // covers rows THIS code wrote. Read safety covers everything else —
  // history, manual edits, and any failure mode not yet imagined.
  if (!existing.values.Draft_ID) {
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, existing.values.Email_Normalized, step,
      'CORRUPT LEDGER ROW: State=DRAFTED with a blank Draft_ID (row ' + existing.rowIndex + '). ' +
      'A Gmail draft may exist that this run cannot identify — refusing to treat it as "already gone" ' +
      'and refusing to create another. Needs manual ADMIN review.');
    return { action: 'BLOCKED_NEEDS_REVIEW', reason: 'drafted_row_missing_draft_id' };
  }

  var drafts;
  try {
    drafts = GmailApp.getDrafts();
  } catch (e) {
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, existing.values.Email_Normalized, step,
      'resolveExistingPreviewDraft_: GmailApp.getDrafts() failed: ' + e +
      '. Fail-closed: left untouched, no new draft created.');
    return { action: 'BLOCKED_NEEDS_REVIEW', reason: 'gmail_read_error' };
  }

  var findResult = findDraftInListSafely_(drafts, existing.values.Draft_ID);
  if (findResult.uncertain) {
    // N3 V3 round 2: an unrelated draft in the list threw on getId() during
    // enumeration — never conflate this with "not found" (CASO 7), which
    // would wrongly authorize CREATE_NEW. Fail closed, same as any other
    // Gmail read error (CASO 8).
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, existing.values.Email_Normalized, step,
      'resolveExistingPreviewDraft_: could not safely enumerate drafts (a listed draft threw on getId()). ' +
      'Fail-closed: left untouched, no new draft created.');
    return { action: 'BLOCKED_NEEDS_REVIEW', reason: 'gmail_read_error' };
  }
  var match = findResult.found ? findResult.draft : null;

  // CASO 4 short-circuit: already durably preserved. Never re-evaluate
  // content, never append another ledger row — only exit is Draft_ID gone.
  if (existing.values.Human_Edit_Preserved === true) {
    if (!match) {
      supersedeLedgerRow_(existing.rowIndex);
      logEvent_(LOG_LEVEL.INFO, LOG_EVENT.DRAFT_SUPERSEDED, prospectId, existing.values.Email_Normalized, step,
        'Preserved human-edited draft ' + existing.values.Draft_ID + ' no longer exists in Gmail. Exiting preserved state.');
      return { action: 'CREATE_NEW' };
    }
    return { action: 'PRESERVE_EXISTING' };
  }

  if (!match) {
    // CASO 7 (first time): nothing to protect.
    supersedeLedgerRow_(existing.rowIndex);
    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.DRAFT_SUPERSEDED, prospectId, existing.values.Email_Normalized, step,
      'Superseded draft ' + existing.values.Draft_ID + ' (already gone).');
    return { action: 'CREATE_NEW' };
  }

  var verification = verifyPreviewDraftOwnership_(match, existing.values);

  if (verification.fatal) {
    // CASO 8: a Gmail read error while inspecting the matched draft.
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, existing.values.Email_Normalized, step,
      'Could not safely inspect Draft_ID=' + existing.values.Draft_ID + ' (reason=' + verification.reason + '). ' +
      'Fail-closed: left untouched, no new draft created.');
    return { action: 'BLOCKED_NEEDS_REVIEW', reason: verification.reason };
  }

  if (!verification.owned) {
    // CASO 6 / CASO 3(unrelated draft): never touch, never duplicate. Not durable.
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, existing.values.Email_Normalized, step,
      'Refused to touch Draft_ID=' + existing.values.Draft_ID + ' — ownership could not be verified ' +
      '(reason=' + verification.reason + '). Left untouched. No new draft created this run. Needs manual review.');
    return { action: 'BLOCKED_NEEDS_REVIEW', reason: verification.reason };
  }

  if (verification.edited) {
    // CASO 2 / CASO 3 / CASO 5 / CASO 9(legacy): durable preserve. Wrapped
    // in try/catch (blocker N3-4): if the transition itself throws partway,
    // fail closed rather than let an uncaught exception propagate with
    // unknown ledger state — the ambiguity guard above is what actually
    // protects a partially-applied transition on the NEXT run.
    var reasonTag = verification.legacy ? 'LEGACY_BASELINE_PRESERVED' : 'HUMAN_EDIT_PRESERVED';
    try {
      preserveDraftDurably_(existing.rowIndex, existing.values, verification, reasonTag);
    } catch (e) {
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, existing.values.Email_Normalized, step,
        'preserveDraftDurably_ failed for Draft_ID=' + existing.values.Draft_ID + ': ' + e +
        '. Fail-closed: left untouched, no new draft created. Needs manual reconciliation.');
      return { action: 'BLOCKED_NEEDS_REVIEW', reason: 'preserve_transition_failed' };
    }
    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.DRAFT_SUPERSEDED, prospectId, existing.values.Email_Normalized, step,
      'Draft_ID=' + existing.values.Draft_ID + (verification.legacy
        ? ' has no baseline fingerprint (legacy row) — preserved conservatively without assuming it is intact.'
        : ' was edited by a human (content fingerprint changed). Durably preserved.') +
      ' Will never be auto-regenerated unless the Draft_ID itself disappears.');
    return { action: 'PRESERVE_EXISTING' };
  }

  // CASO 1: untouched. Normal supersede-and-recreate.
  match.deleteDraft();
  supersedeLedgerRow_(existing.rowIndex);
  logEvent_(LOG_LEVEL.INFO, LOG_EVENT.DRAFT_SUPERSEDED, prospectId, existing.values.Email_Normalized, step,
    'Superseded draft ' + existing.values.Draft_ID + ' (deleted, unedited).');
  return { action: 'CREATE_NEW' };
}

/**
 * Resolves where a preview draft for `step` should be created: a reply on
 * a real LIVE thread if one exists, otherwise a standalone draft (§6.3).
 * Codex finding #11: GmailApp.getThreadById() returns null (not a thrown
 * exception) for an unresolvable thread ID. A blank/missing Thread_ID and
 * a BROKEN Thread_ID are different situations and must be handled
 * differently: a genuinely broken reference must not be silently
 * downgraded into what looks like a fresh first-contact draft.
 *
 * N3 V3 (Codex final audit, round 2 — orphan draft gap): this function used
 * to also read `standaloneDraft.getMessage().getThread().getId()` right
 * here, AFTER GmailApp.createDraft() had already succeeded but BEFORE
 * returning to previewStep()'s protected metadata-capture block. If that
 * read threw, the draft already existed in Gmail while the exception
 * propagated straight out of createPreviewDraft_() UNCAUGHT — past
 * previewStep()'s fail-closed block entirely (it never got a chance to
 * run), and past previewQueue()'s forEach loop too (no try/catch there),
 * aborting the whole batch with a fully untracked orphan draft. Every read
 * of the just-created draft's own metadata must happen inside ONE
 * protected block — so this function now does the MINIMUM possible after
 * GmailApp.createDraft() succeeds: nothing. `usedThreadId` is left
 * unresolved (null) for the standalone case; previewStep() resolves it
 * itself, inside its own fail-closed block, from the SAME message object
 * it already fetches for Message_ID/fingerprint purposes — one extra field
 * read, zero extra risk surface, since it reuses a read that was already
 * happening under protection anyway. (The reply-draft branch below has no
 * such gap: usedThreadId there is `liveThreadId`, already known before any
 * Gmail call — never derived from a post-creation read.)
 * @return {{skipped: boolean, status: (string|undefined), draft: (Object|undefined), usedThreadId: (string|null|undefined)}}
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
    return { skipped: false, draft: draft, usedThreadId: liveThreadId }; // Already known — no post-creation Gmail read.
  }

  var subject = previewSubjectPrefix_(step) +
    (step === 1 ? rendered.subject : ('Re: ' + safeRenderStep1Subject_(prospect, config)));
  var standaloneDraft = GmailApp.createDraft(prospect.Email, subject, buildPreviewBody_(rendered.body), {
    name: config.SENDER_NAME
  });
  return { skipped: false, draft: standaloneDraft, usedThreadId: null }; // Resolved by previewStep(), fail-closed.
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
 *           'SKIPPED_LOCK_BUSY' | 'ERROR_LEDGER_WRITE_FAILED' |
 *           'SKIPPED_DRAFT_PRESERVED_HUMAN_EDIT' | 'SKIPPED_DRAFT_NEEDS_REVIEW' |
 *           'ERROR_DRAFT_METADATA_CAPTURE_FAILED' |
 *           'ERROR_PREVIEW_CLAIM_FAILED' | 'ERROR_PREVIEW_CREATE_AMBIGUOUS'
 *
 * MANUAL RECOVERY (N3 final round): a key left in PREVIEW_CLAIMED or
 * PREVIEW_AMBIGUOUS is blocked permanently and deliberately — no code
 * path auto-resolves it, because doing so safely would require proving a
 * negative about Gmail state that this architecture cannot prove. To
 * resolve one by hand: find the row in SendLedger (Mode=DRY_RUN, the
 * Error column explains what happened), check Gmail's Drafts folder for
 * a matching draft to that prospect/step, delete it if present, then set
 * that row's State to SUPERSEDED. The next Preview run will then create a
 * fresh draft normally. Blocking one prospect's preview until a human
 * looks is always preferable to creating a second real draft.
 *   (SKIPPED_DRAFT_PRESERVED_HUMAN_EDIT/SKIPPED_DRAFT_NEEDS_REVIEW are N3:
 *   an existing live draft was recognized as human-edited/legacy or as
 *   ownership-unverifiable — see resolveExistingPreviewDraft_.
 *   ERROR_DRAFT_METADATA_CAPTURE_FAILED is N3 V3: reading back the just-
 *   created draft's own metadata failed — fail-closed, see the creation
 *   block below.)
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
    var draftDecision = resolveExistingPreviewDraft_(prospectId, step);
    if (draftDecision.action === 'PRESERVE_EXISTING') {
      return { status: 'SKIPPED_DRAFT_PRESERVED_HUMAN_EDIT' };
    }
    if (draftDecision.action === 'BLOCKED_NEEDS_REVIEW') {
      return { status: 'SKIPPED_DRAFT_NEEDS_REVIEW', reason: draftDecision.reason };
    }

    // ------------------------------------------------------------------
    // N3 (Codex re-audit, final round): DURABLE PREVIEW CLAIM, written and
    // flushed BEFORE any Gmail call that could create a draft.
    //
    // Every previous round tried to close the orphan-draft hole with more
    // catches AFTER GmailApp.createDraft() — and every round Codex found
    // another ordering where a draft could exist in Gmail with no durable
    // ledger barrier (createDraft succeeds -> getId() throws ->
    // deleteDraft() also throws -> draft survives, untracked, and the next
    // Preview creates a second one). No amount of post-hoc compensation
    // fixes that, because the compensation itself can fail.
    //
    // The correct property is the same one LIVE sending already had:
    // claim the idempotency key DURABLY FIRST, then perform the side
    // effect. If the claim cannot be persisted, the side effect never
    // happens at all. From here on, a Gmail draft can only ever exist
    // while a blocking ledger row for its key also exists.
    // ------------------------------------------------------------------
    var claimRowNum;
    try {
      claimRowNum = appendPreviewClaim_(prospectId, step, prospect.Email_Normalized);
    } catch (claimError) {
      // CASO A: no barrier could be persisted -> do NOT call Gmail at all.
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'Could not persist the PREVIEW_CLAIMED barrier: ' + claimError +
        '. GmailApp.createDraft() was NOT called — no draft can exist without a durable ledger barrier.');
      return { status: 'ERROR_PREVIEW_CLAIM_FAILED' };
    }

    var draftResult;
    try {
      draftResult = createPreviewDraft_(prospectId, step, prospect, rendered, config);
    } catch (createError) {
      // CASO B: the draft-creating call itself threw. Its outcome is
      // UNRESOLVABLE — Gmail may or may not have created a draft, and if
      // it did we have no reference or id for it. The claim must stay
      // blocking, permanently, until a human resolves it.
      try {
        markPreviewClaimAmbiguous_(claimRowNum, 'GmailApp draft creation threw: ' + createError + ' — a draft may or may not exist.');
      } catch (markError) {
        logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
          'Could not mark the preview claim PREVIEW_AMBIGUOUS: ' + markError +
          ' — the row stays PREVIEW_CLAIMED, which is ALSO blocking, so the key remains closed either way.');
      }
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'Draft creation threw: ' + createError + '. Key durably blocked; no automatic retry. Needs manual ADMIN review.');
      return { status: 'ERROR_PREVIEW_CREATE_AMBIGUOUS' };
    }

    if (draftResult.skipped) {
      // createPreviewDraft_ returned before making ANY draft-creating call
      // (the broken-LIVE-Thread_ID path) — provably nothing was created,
      // so the claim can be released and the key re-opened.
      try {
        releasePreviewClaim_(claimRowNum, 'No Gmail draft was created (' + draftResult.status + ').');
      } catch (releaseError) {
        logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
          'Could not release the preview claim after a skipped creation: ' + releaseError +
          ' — the row stays PREVIEW_CLAIMED (blocking). Safe, but needs manual ADMIN release.');
      }
      return { status: draftResult.status };
    }

    // N3 V3 (Codex final audit, blocker N3-3): capturing the just-created
    // draft's own id, message id, and content fingerprint must be
    // fail-closed, not best-effort. A silent catch here used to let
    // previewStep() go on to write a perfectly normal-looking DRAFTED row
    // with Draft_Fingerprint="" — which (before the N3-1 legacy-blank-
    // fingerprint fix above) would have been misread as "unedited" and
    // auto-deleted later, and even after that fix is simply not a
    // trustworthy healthy row. Every read is in ONE try block; ANY failure
    // (including draft.getId() itself, which used to be entirely
    // unguarded and could crash previewStep() with an untracked orphan
    // draft already sitting in Gmail) takes the fail-closed path below
    // instead of writing anything that looks like a normal success.
    var draftId = '';
    var draftMessageId = '';
    var draftFingerprint = '';
    var usedThreadId = draftResult.usedThreadId || '';
    var creationError = null;
    try {
      draftId = draftResult.draft.getId();
      var createdMessage = draftResult.draft.getMessage();
      draftMessageId = createdMessage.getId();
      // N3 V3 round 2: resolved HERE, inside the protected block, for the
      // standalone-draft case (createPreviewDraft_ deliberately no longer
      // reads this itself — see its docstring). Reply-draft case already
      // has usedThreadId populated (liveThreadId, known before any Gmail
      // call), so this only runs when it's genuinely still unresolved.
      if (!usedThreadId) usedThreadId = createdMessage.getThread().getId();
      var createdTo = createdMessage.getTo ? createdMessage.getTo() : prospect.Email;
      var createdSubject = createdMessage.getSubject ? createdMessage.getSubject() : '';
      var createdBody = createdMessage.getPlainBody ? createdMessage.getPlainBody() : createdMessage.getBody();
      if (typeof createdBody !== 'string') throw new Error('created draft body is not a string');
      draftFingerprint = computeDraftFingerprint_(createdTo, createdSubject, createdBody);
    } catch (e) {
      creationError = e;
    }

    if (creationError || !draftFingerprint) {
      // CASO C/D: the draft EXISTS but its metadata could not be read.
      // Try to compensate via the DIRECT OBJECT REFERENCE we already hold
      // (never an enumeration lookup — that could itself throw on an
      // unrelated draft, see findDraftInListSafely_, and here we don't
      // even need an id). Then resolve the durable claim according to
      // what we can actually PROVE:
      //   - delete confirmed  -> release the claim (key re-opens; there is
      //                          provably no draft left).
      //   - delete failed     -> PREVIEW_AMBIGUOUS: the draft may still
      //                          exist and we may not even know its id.
      //                          The key stays closed forever until an
      //                          ADMIN resolves it. This is the case that
      //                          used to produce an untracked orphan plus
      //                          a duplicate on the next run.
      var compensated = attemptDeleteDraftDirectly_(draftResult.draft);
      try {
        if (compensated) {
          releasePreviewClaim_(claimRowNum,
            'Metadata capture failed (' + creationError + ') but the draft was CONFIRMED deleted.');
        } else {
          markPreviewClaimAmbiguous_(claimRowNum,
            'Metadata capture failed (' + creationError + ') AND the compensating delete also failed. ' +
            'Draft_ID=' + (draftId || 'UNKNOWN') + ' may still exist in Gmail.');
        }
      } catch (claimResolveError) {
        logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
          'Could not update the preview claim after a metadata-capture failure: ' + claimResolveError +
          ' — the row stays PREVIEW_CLAIMED, which is still blocking, so no duplicate can be created.');
      }
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'Draft creation metadata capture failed: ' + creationError + '. draftId=' + (draftId || 'UNKNOWN') +
        ' compensated=' + compensated + '. No healthy DRAFTED row written (fail-closed).');
      return { status: 'ERROR_DRAFT_METADATA_CAPTURE_FAILED', draftId: draftId || undefined, compensated: compensated };
    }

    try {
      // CASO E happy path: the claim row ITSELF becomes the DRAFTED row,
      // updated in place — so this key never has two active rows, and
      // never has zero.
      finalizePreviewClaimAsDrafted_(claimRowNum, {
        threadId: usedThreadId, messageId: draftMessageId, draftId: draftId, fingerprint: draftFingerprint
      });
    } catch (ledgerError) {
      // CASO E failure path: the draft exists but could not be recorded as
      // DRAFTED. The claim row is still PREVIEW_CLAIMED (blocking) — same
      // resolution rules as above.
      var compensation = attemptDeleteDraftDirectly_(draftResult.draft);
      try {
        if (compensation) {
          releasePreviewClaim_(claimRowNum,
            'Final DRAFTED transition failed (' + ledgerError + ') but the draft was CONFIRMED deleted.');
        } else {
          markPreviewClaimAmbiguous_(claimRowNum,
            'Final DRAFTED transition failed (' + ledgerError + ') AND the compensating delete also failed. ' +
            'Draft_ID=' + draftId + ' may still exist in Gmail.');
        }
      } catch (claimResolveError) {
        logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
          'Could not update the preview claim after a final-transition failure: ' + claimResolveError +
          ' — the row stays PREVIEW_CLAIMED, which is still blocking.');
      }
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'Ledger transition to DRAFTED failed after draft creation. Draft_ID=' + draftId +
        ' compensated=' + compensation + '. ledgerError=' + ledgerError);
      return { status: 'ERROR_LEDGER_WRITE_FAILED', draftId: draftId, compensated: compensation };
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

/**
 * ADMIN menu action: "Delete Klinner preview drafts" — cleanup convenience,
 * not required to go LIVE.
 *
 * N3 V3 (1F, Codex final audit): this is a deliberate, explicit, human-
 * initiated bulk wipe. It calls deletePreviewDraftIfOwned_, which checks
 * ONLY `.owned` (Thread_ID + banner) — it does NOT consult `.edited` or
 * `.legacy`, and does NOT check Human_Edit_Preserved. That means this
 * action WILL delete durably-preserved human-edited previews and legacy
 * rows too, same as any other owned draft. That is intentional: an
 * explicit "delete all preview drafts" click is a stronger, more
 * accountable signal than an automatic previewStep()/previewQueue() run,
 * and the whole point of durable preservation (resolveExistingPreviewDraft_)
 * is to protect against the AUTOMATIC path, not against a human explicitly
 * asking to wipe every preview. This semantic must never leak into
 * previewStep()'s automatic regeneration path — those two code paths use
 * deliberately different functions for exactly this reason.
 */
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
var reconcileControlledFixtureStep2Ambiguous;

/**
 * Gmail's REST body.data is base64url, but the Apps Script Advanced Service
 * can materialize the same field as a signed Byte[] (observed in both
 * Messages.get and Threads.get). Accept only those two representations.
 * Validate the bytes and their UTF-8 round trip so corrupt data cannot pass
 * exact body verification.
 */
function decodeGmailApiBodyBytesUtf8_(bytes) {
  if (!Array.isArray(bytes) || !bytes.length) {
    throw new Error('Gmail verification failed: malformed body byte array.');
  }
  var signed = [];
  for (var i = 0; i < bytes.length; i++) {
    var value = bytes[i];
    if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value || value < -128 || value > 255) {
      throw new Error('Gmail verification failed: malformed body byte array.');
    }
    signed.push(value > 127 ? value - 256 : value);
  }
  var decoded = Utilities.newBlob(signed).getDataAsString('UTF-8');
  var roundTrip = Utilities.newBlob(decoded).getBytes();
  if (roundTrip.length !== signed.length) {
    throw new Error('Gmail verification failed: decoded body is not valid canonical UTF-8.');
  }
  for (var j = 0; j < signed.length; j++) {
    if (roundTrip[j] !== signed[j]) {
      throw new Error('Gmail verification failed: decoded body is not valid canonical UTF-8.');
    }
  }
  return decoded;
}

function decodeGmailApiBase64UrlUtf8_(encoded) {
  if (Array.isArray(encoded)) return decodeGmailApiBodyBytesUtf8_(encoded);
  if (typeof encoded !== 'string') {
    throw new Error('Gmail verification failed: malformed body data type.');
  }
  var input = encoded;
  if (!input || !/^[A-Za-z0-9_-]+={0,2}$/.test(input) || /=/.test(input.replace(/={1,2}$/, ''))) {
    throw new Error('Gmail verification failed: malformed base64url body data.');
  }
  var unpadded = input.replace(/=+$/, '');
  var remainder = unpadded.length % 4;
  if (remainder === 1) {
    throw new Error('Gmail verification failed: malformed base64url body length.');
  }
  var padded = unpadded + (remainder === 2 ? '==' : (remainder === 3 ? '=' : ''));
  var bytes;
  try {
    bytes = Utilities.base64DecodeWebSafe(padded);
  } catch (e) {
    throw new Error('Gmail verification failed: base64url body decode error: ' + e);
  }
  var decoded = decodeGmailApiBodyBytesUtf8_(bytes);
  var roundTrip = Utilities.base64EncodeWebSafe(decoded, Utilities.Charset.UTF_8).replace(/=+$/, '');
  if (roundTrip !== unpadded) {
    throw new Error('Gmail verification failed: decoded body is not valid canonical UTF-8.');
  }
  return decoded;
}

/** Extract exactly one inline text/plain body and decode it fail-closed. */
function decodeGmailApiMessageBodyUtf8_(messageResource) {
  var payload = messageResource && messageResource.payload;
  if (!payload) throw new Error('Gmail verification failed: message payload is missing.');

  var candidates = [];
  function visit(part, isRoot) {
    if (!part) return;
    var data = part.body && part.body.data;
    var mimeType = String(part.mimeType || '').toLowerCase();
    var filename = String(part.filename || '');
    if (data && mimeType === 'text/plain' && !filename) candidates.push(data);
    var parts = part.parts || [];
    for (var i = 0; i < parts.length; i++) visit(parts[i], false);
  }
  visit(payload, true);
  if (candidates.length !== 1) {
    throw new Error('Gmail verification failed: expected exactly one inline text/plain body, found ' + candidates.length + '.');
  }
  return decodeGmailApiBase64UrlUtf8_(candidates[0]);
}

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
      // N5 (Codex final audit, round 2 — durable ledger blocking): draft.send()
      // throwing does NOT prove the email was never sent — there is no
      // distributed transaction between Apps Script and Gmail, so a thrown
      // exception here could still correspond to a real send having
      // completed server-side.
      //
      // THE PRINCIPLE: after invoking a Gmail operation that could have
      // sent, if the outcome is uncertain, the idempotency key must become
      // DURABLY BLOCKED — in the ledger itself, not merely via a second
      // write to Prospects. The ledger row is ALREADY State=CLAIMED at
      // this point (appended above, before send() was even called), and
      // CLAIMED is already one of the states isLiveKeyBlocked_ treats as
      // blocking — so simply NOT downgrading it away from a blocking state
      // would already be safe. We go further and mark it AMBIGUOUS
      // explicitly (still blocking, per Ledger.gs) purely for audit
      // clarity: a human reading SendLedger can tell "send() was invoked
      // and its outcome is unknown" apart from "still in flight" or a
      // stale abandoned claim. The OLD code marked this FAILED — a state
      // isLiveKeyBlocked_ deliberately does NOT block on, because FAILED
      // means "we KNOW nothing was sent" — which is false here. Marking
      // this row FAILED, as the old code did, silently discarded the
      // blocking protection CLAIMED already provided.
      //
      // The Prospects NEEDS_REVIEW write below is a SECONDARY, OPERATIONAL
      // signal only (for dashboards/human review) — its success or failure
      // has NO bearing on whether a retry is possible: the ledger AMBIGUOUS
      // state alone is what executeLiveSendForStep_'s isLiveKeyBlocked_
      // check enforces, unconditionally, on every future attempt.
      var compensated = false;
      try { draft.deleteDraft(); compensated = true; } catch (deleteError) { compensated = false; }
      updateLedgerRow_(ledgerRowNum, {
        State: LEDGER_STATE.AMBIGUOUS,
        Error: String(sendError) + ' (ambiguous outcome — durably blocked in the ledger, never automatically retryable)'
      });
      try {
        writeRowById_(prospectId, { Status: STATUS.NEEDS_REVIEW },
          { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
      } catch (writeError) {
        logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, 1,
          'doStep1Send_: the Prospects NEEDS_REVIEW write ALSO failed after an ambiguous send failure: ' + writeError +
          ' — this is a SECONDARY signal only; the ledger AMBIGUOUS state (already written above) still blocks retry regardless. NEEDS MANUAL REVIEW.');
      }
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, 1,
        'send() failed after draft creation. compensated=' + compensated +
        (compensated ? '' : ' — ORPHANED UNSENT DRAFT, NEEDS MANUAL REVIEW.') + ' error=' + sendError +
        '. Ambiguous outcome — durably blocked in SendLedger (AMBIGUOUS), never automatically retryable.');
      throw sendError;
    }

    var thread = message.getThread();
    applyOutreachLabel_(thread, config);

    // N6 (post-LIVE incident, 2026-09-08 — Acme Plumbing LLC): ONE captured
    // instant, reused everywhere below. The old code called `new Date()`
    // four separate times across Confirmed_At/Last_Contacted/Step1_Sent_At/
    // the cadence calculation — each a few milliseconds apart. Not the
    // incident's root cause, but a real inconsistency in what "the real
    // send time" (I15) means once there are four slightly different
    // timestamps claiming to be it.
    var confirmedAt = new Date();
    updateLedgerRow_(ledgerRowNum, {
      State: LEDGER_STATE.SENT, Thread_ID: thread.getId(), Message_ID: message.getId(), Confirmed_At: confirmedAt
    });

    // ------------------------------------------------------------------
    // N6: Gmail send is now CONFIRMED (message.getId() proves it) and the
    // ledger is already durably SENT above. From this point on, NOTHING
    // that happens next may ever be allowed to look like "this email was
    // never sent" — not to isLiveKeyBlocked_ (already fail-closed: SENT
    // blocks retry regardless of what follows), and not to a human reading
    // Prospects.
    //
    // The incident: computeNextActionDate_/writeRowById_ below can throw
    // (cadence math, a Prospects schema/authorization guard, a transient
    // Sheets error) — this used to be completely unprotected. The
    // exception propagated out of doStep1Send_, past executeLiveSendForStep_
    // (only a lock-release `finally`, no catch), past performLiveSend_,
    // past sendStep1, and was finally caught by sendBatch()'s generic
    // per-row `try/catch`, which logs it identically to an ordinary skip.
    // Net effect: a real email went out, SendLedger correctly recorded
    // SENT, and Prospects silently stayed at Status=READY forever — not
    // merely stale, but PERMANENTLY stuck, because canSend_/
    // isEligibleForNextStep_ gate on Prospects.Status and nothing ever
    // advances it again (correctly: isLiveKeyBlocked_ also permanently
    // refuses to let this key send again, so no duplicate — but no
    // progress either).
    //
    // Fix: catch the Prospects write specifically. The ledger SENT row
    // (already durable) remains the single source of truth — this block's
    // job is only to make the failure LOUD and to leave the prospect in a
    // state a human will actually notice (NEEDS_REVIEW), never silently
    // indistinguishable from "not sent yet".
    // ------------------------------------------------------------------
    // NOTE: computeNextActionDate_ legitimately returns null when step 1 IS
    // the last step (MAX_STEPS=1) — that is NOT an error. `cadenceThrew` is
    // tracked separately so that legitimate case still gets exactly the
    // pre-existing behavior (Status=IN_SEQUENCE, blank Next_Action_Date),
    // unchanged. Only an actual thrown exception forces NEEDS_REVIEW.
    var nextActionDate = null;
    var cadenceThrew = false;
    try {
      nextActionDate = computeNextActionDate_(1, confirmedAt, config);
    } catch (cadenceError) {
      cadenceThrew = true;
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, 1,
        'computeNextActionDate_ threw after a CONFIRMED send (Thread_ID=' + thread.getId() + ', Message_ID=' +
        message.getId() + '): ' + cadenceError + '. Falling back to blank Next_Action_Date; Status will be forced to NEEDS_REVIEW.');
    }

    try {
      writeRowById_(prospectId, {
        Status: cadenceThrew ? STATUS.NEEDS_REVIEW : STATUS.IN_SEQUENCE,
        Sequence_Step: 1, Last_Contacted: confirmedAt, Step1_Sent_At: confirmedAt,
        Thread_ID: thread.getId(), Last_Message_ID: message.getId(), Next_Action_Date: nextActionDate || ''
      }, { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
    } catch (persistError) {
      // N6 (independent review): stamp the DURABLE marker on the
      // authoritative ledger row FIRST. Without this the only record of the
      // failure is the Log sheet, which trimLog_ prunes to LOG_MAX_ROWS —
      // so an unreconciled incident would eventually become invisible. State
      // stays SENT (untouched): this annotates the row, it never reopens it.
      // Best-effort by necessity — the Sheets write path is what just failed.
      try {
        updateLedgerRow_(ledgerRowNum, {
          Error: 'POST_SEND_PERSISTENCE_FAILURE: send CONFIRMED, Prospects write failed (' + persistError +
            '). Prospects may still read its pre-send state. Reconcile Prospects FROM THIS ROW; never resend.'
        });
      } catch (markerError) {
        logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, 1,
          'POST_SEND_PERSISTENCE_FAILURE: could not even stamp the ledger Error marker: ' + markerError +
          '. The row is still durably SENT (blocking), but the Log is now the only record of the failure.');
      }
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, 1,
        'POST_SEND_PERSISTENCE_FAILURE: Gmail send is CONFIRMED (Thread_ID=' + thread.getId() + ', Message_ID=' +
        message.getId() + ', SendLedger row ' + ledgerRowNum + '=SENT) but the full Prospects write failed: ' +
        persistError + '. Attempting a minimal fallback write (Status=NEEDS_REVIEW only).');
      try {
        writeRowById_(prospectId, { Status: STATUS.NEEDS_REVIEW },
          { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
      } catch (fallbackError) {
        logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, 1,
          'POST_SEND_PERSISTENCE_FAILURE: the minimal NEEDS_REVIEW fallback write ALSO failed: ' + fallbackError +
          '. Prospects for ' + prospectId + ' may still read its PRE-SEND state despite a CONFIRMED LIVE send ' +
          '(SendLedger row ' + ledgerRowNum + ', Thread_ID=' + thread.getId() + ', Message_ID=' + message.getId() +
          '). NEEDS MANUAL RECONCILIATION FROM SENDLEDGER — never automatic retry; isLiveKeyBlocked_ already ' +
          'permanently blocks this key because the ledger row is SENT.');
      }
      logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SENT, prospectId, prospect.Email_Normalized, 1,
        'LIVE step 1 sent (Gmail + SendLedger CONFIRMED); Prospects persistence failed and needs manual ' +
        'reconciliation from SendLedger row ' + ledgerRowNum + '.');
      return { status: 'SENT_PERSISTENCE_FAILED', ledgerRowNum: ledgerRowNum, threadId: thread.getId(), messageId: message.getId() };
    }

    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SENT, prospectId, prospect.Email_Normalized, 1, 'LIVE step 1 sent.');
    return { status: 'SENT' };
  }

  /**
   * Google-real Step-2 incident (2026-09-11): GmailThread.reply() replies
   * to the sender of the last message. In an outbound-only thread that
   * sender was the executing Jhessyca account, so the controlled follow-up
   * went back to Jhessyca instead of to the Prospect. The old immediate
   * getMessages().length check also observed stale thread state and marked
   * the attempt AMBIGUOUS even though the message appeared later.
   *
   * The replacement below never asks Gmail to infer a recipient. It uses
   * Gmail API messages.send with explicit To/threadId/RFC reply headers,
   * then verifies the exact returned message by its Gmail internal id.
   * The SEND is never retried; bounded retries are limited to messages.get
   * reads needed to tolerate Gmail's eventual-consistency window.
   */
  function gmailApiHeader_(messageResource, name) {
    var headers = messageResource && messageResource.payload && messageResource.payload.headers || [];
    var target = String(name || '').toLowerCase();
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i].name || '').toLowerCase() === target) return String(headers[i].value || '').trim();
    }
    return '';
  }

  function safeMimeHeader_(value, label) {
    var s = String(value || '').trim();
    if (!s || /[\r\n]/.test(s)) throw new Error('Follow-up blocked: invalid ' + label + ' header.');
    return s;
  }

  function normalizedSingleAddress_(headerValue) {
    var s = String(headerValue || '').trim();
    if (!s || /[,;]/.test(s)) return '';
    var match = /<([^<>]+)>/.exec(s);
    return normalizeEmail_(match ? match[1] : s);
  }

  function decodedApiMessageBody_(messageResource) {
    return decodeGmailApiMessageBodyUtf8_(messageResource);
  }

  function buildExplicitFollowUpMessage_(prospect, rendered, config, priorMessage) {
    var recipient = normalizeEmail_(prospect.Email_Normalized);
    if (!isValidEmailSyntax_(recipient) || recipient !== normalizeEmail_(prospect.Email)) {
      throw new Error('Follow-up blocked: Email and Email_Normalized do not resolve to the same valid recipient.');
    }

    var sender = normalizeEmail_(config.SENDER_EMAIL);
    var effectiveSender = normalizeEmail_(Session.getEffectiveUser().getEmail());
    if (!isValidEmailSyntax_(sender) || effectiveSender !== sender) {
      throw new Error('Follow-up blocked: effective user (' + effectiveSender + ') does not match SENDER_EMAIL (' + sender + ').');
    }

    var subject = safeMimeHeader_(gmailApiHeader_(priorMessage, 'Subject'), 'Subject');
    var priorRfcMessageId = safeMimeHeader_(gmailApiHeader_(priorMessage, 'Message-ID'), 'previous Message-ID');
    var priorReferences = gmailApiHeader_(priorMessage, 'References');
    if (/[\r\n]/.test(priorReferences)) throw new Error('Follow-up blocked: invalid previous References header.');
    var references = (priorReferences ? priorReferences + ' ' : '') + priorRfcMessageId;
    var bodyHash = computeDraftFingerprint_(recipient, subject, rendered.body);
    var fromHeader = safeMimeHeader_(config.SENDER_NAME, 'sender name') + ' <' + sender + '>';
    var replyTo = normalizeEmail_(safeMimeHeader_(config.REPLY_TO, 'Reply-To'));
    if (!isValidEmailSyntax_(replyTo)) throw new Error('Follow-up blocked: invalid Reply-To address.');

    var mime = [
      'From: ' + fromHeader,
      'To: ' + recipient,
      'Reply-To: ' + replyTo,
      'Subject: ' + subject,
      'In-Reply-To: ' + priorRfcMessageId,
      'References: ' + references,
      'X-Klinner-Body-SHA256: ' + bodyHash,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      String(rendered.body || '')
    ].join('\r\n');

    return {
      resource: { raw: Utilities.base64EncodeWebSafe(mime, Utilities.Charset.UTF_8).replace(/=+$/, ''), threadId: prospect.Thread_ID },
      recipient: recipient, sender: sender, subject: subject, priorRfcMessageId: priorRfcMessageId,
      references: references, bodyHash: bodyHash, body: String(rendered.body || '')
    };
  }

  function verifyExplicitFollowUpMessage_(messageId, expected) {
    var lastError = null;
    for (var attempt = 1; attempt <= 3; attempt++) {
      try {
        var actual = Gmail.Users.Messages.get('me', messageId, { format: 'full' });
        var actualTo = normalizedSingleAddress_(gmailApiHeader_(actual, 'To'));
        var actualFrom = normalizedSingleAddress_(gmailApiHeader_(actual, 'From'));
        var actualBody = decodedApiMessageBody_(actual).replace(/\r\n/g, '\n');
        var expectedBody = expected.body.replace(/\r\n/g, '\n');
        if (actual.id === messageId && actual.threadId === expected.threadId &&
            actualTo === expected.recipient && actualFrom === expected.sender &&
            gmailApiHeader_(actual, 'Subject') === expected.subject &&
            gmailApiHeader_(actual, 'In-Reply-To') === expected.priorRfcMessageId &&
            gmailApiHeader_(actual, 'References') === expected.references &&
            gmailApiHeader_(actual, 'X-Klinner-Body-SHA256') === expected.bodyHash &&
            actualBody === expectedBody) {
          return actual;
        }
        lastError = new Error('returned Gmail message metadata/body did not match the explicitly authorized follow-up');
      } catch (readError) {
        lastError = readError;
      }
      if (attempt < 3) Utilities.sleep(attempt * 500);
    }
    throw lastError || new Error('follow-up verification failed');
  }

  function countExactFollowUpCopiesInThread_(threadResource, expected) {
    if (!threadResource || threadResource.id !== expected.threadId || !Array.isArray(threadResource.messages)) {
      throw new Error('Controlled reconciliation blocked: Gmail thread resource is missing or mismatched.');
    }
    var matches = 0;
    for (var i = 0; i < threadResource.messages.length; i++) {
      var message = threadResource.messages[i];
      if (normalizedSingleAddress_(gmailApiHeader_(message, 'To')) !== expected.recipient ||
          normalizedSingleAddress_(gmailApiHeader_(message, 'From')) !== expected.sender ||
          gmailApiHeader_(message, 'Subject') !== expected.subject ||
          gmailApiHeader_(message, 'In-Reply-To') !== expected.priorRfcMessageId ||
          gmailApiHeader_(message, 'References') !== expected.references ||
          gmailApiHeader_(message, 'X-Klinner-Body-SHA256') !== expected.bodyHash) {
        continue;
      }
      if (decodedApiMessageBody_(message).replace(/\r\n?/g, '\n') === expected.body.replace(/\r\n?/g, '\n')) {
        matches++;
      }
    }
    return matches;
  }

  /**
   * Reconciles one immutable, already-sent controlled Step-2 incident.
   * This function has no outbound Gmail primitive: it only reads the exact
   * prior/current message and thread, then persists the already-proven result.
   * Every identifier is pinned in CONTROLLED_STEP2_AMBIGUOUS_INCIDENT, so it
   * cannot be repurposed for a real prospect or another ambiguous row.
   */
  reconcileControlledFixtureStep2Ambiguous = function (prospectId) {
    var incident = CONTROLLED_STEP2_AMBIGUOUS_INCIDENT;
    if (prospectId !== incident.Prospect_ID) {
      return { status: 'REJECTED_RECONCILIATION_TARGET', prospectId: prospectId };
    }

    var config = getConfig();
    if (config.DRY_RUN !== true || config.PAUSE_ALL !== true || Number(config.MAX_PER_RUN) !== 1) {
      return { status: 'REJECTED_CONFIG_NOT_SAFE' };
    }
    if (normalizeEmail_(config.SENDER_EMAIL) !== incident.Sender_Email) {
      return { status: 'REJECTED_SENDER_CONFIG_MISMATCH' };
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) return { status: 'REJECTED_LOCK_BUSY' };
    try {
      if (countProspectRowsById_(prospectId) !== 1) return { status: 'REJECTED_AMBIGUOUS_ID' };
      var found = findRowById_(prospectId);
      if (!found) return { status: 'REJECTED_NOT_FOUND' };
      var p = found.values;
      if (p.Source !== incident.Source) return { status: 'REJECTED_SOURCE_NOT_CONTROLLED' };
      if (normalizeEmail_(p.Email_Normalized) !== incident.Email_Normalized ||
          normalizeEmail_(p.Email) !== incident.Email_Normalized) return { status: 'REJECTED_RECIPIENT_MISMATCH' };
      if (String(p.Thread_ID || '') !== incident.Thread_ID) return { status: 'REJECTED_PRIOR_MESSAGE_MISMATCH' };

      var stepRows = readAllLedgerRows_().filter(function (row) {
        return row.values.Prospect_ID === prospectId && Number(row.values.Step) === incident.Step &&
          row.values.Mode === LEDGER_MODE.LIVE;
      });

      if (stepRows.length === 1 && stepRows[0].values.State === LEDGER_STATE.SENT &&
          stepRows[0].values.Run_ID === incident.Run_ID && stepRows[0].values.Message_ID === incident.Message_ID &&
          Number(p.Sequence_Step) === incident.Step && p.Step2_Sent_At &&
          String(p.Last_Message_ID || '') === incident.Message_ID) {
        return { status: 'ALREADY_RECONCILED', prospectId: prospectId, messageId: incident.Message_ID };
      }

      if (String(p.Last_Message_ID || '') !== incident.Prior_Message_ID) {
        return { status: 'REJECTED_PRIOR_MESSAGE_MISMATCH' };
      }

      if (p.Status !== STATUS.NEEDS_REVIEW) return { status: 'REJECTED_WRONG_STATUS', prospectStatus: p.Status };
      if (Number(p.Sequence_Step) !== 1) return { status: 'REJECTED_WRONG_SEQUENCE_STEP', sequenceStep: p.Sequence_Step };
      if (!p.Step1_Sent_At || p.Step2_Sent_At) return { status: 'REJECTED_STEP_HISTORY' };
      if (!p.Next_Action_Date || new Date(p.Next_Action_Date).getTime() > Date.now()) return { status: 'REJECTED_NOT_DUE' };
      if (p.Replied === true) return { status: 'REJECTED_REPLIED' };
      if (p.Stop_Contact === true) return { status: 'REJECTED_STOP_CONTACT' };
      if (p.Do_Not_Contact_Reason) return { status: 'REJECTED_DNC' };
      if (isSuppressed_(p.Email_Normalized, p.Domain)) return { status: 'REJECTED_SUPPRESSED' };
      if (stepRows.length !== 1) return { status: 'REJECTED_STEP2_LEDGER_COUNT', count: stepRows.length };

      var ledgerRow = stepRows[0];
      var lv = ledgerRow.values;
      var isOriginalAmbiguous = lv.State === LEDGER_STATE.AMBIGUOUS && !lv.Message_ID;
      var isResumeAfterLedgerCommit = lv.State === LEDGER_STATE.SENT && lv.Message_ID === incident.Message_ID &&
        String(lv.Error || '').indexOf('RECONCILED_FROM_AMBIGUOUS:') === 0;
      if (lv.Run_ID !== incident.Run_ID || (!isOriginalAmbiguous && !isResumeAfterLedgerCommit) ||
          lv.Idempotency_Key !== getIdempotencyKey_(prospectId, incident.Step) ||
          String(lv.Thread_ID || '') !== incident.Thread_ID) {
        return { status: 'REJECTED_STEP2_LEDGER_EVIDENCE' };
      }
      var originalAmbiguity = String(lv.Error || '');
      if (originalAmbiguity.indexOf('No se pudo descifrar la cadena') === -1) {
        return { status: 'REJECTED_AMBIGUITY_REASON' };
      }

      var priorMessage = Gmail.Users.Messages.get('me', incident.Prior_Message_ID, { format: 'metadata' });
      if (!priorMessage || priorMessage.threadId !== incident.Thread_ID ||
          gmailApiHeader_(priorMessage, 'Message-ID') !== incident.Prior_Rfc_Message_ID) {
        return { status: 'REJECTED_PRIOR_GMAIL_EVIDENCE' };
      }

      var rendered = renderTemplateForStep_(incident.Step, p, config);
      var prepared = buildExplicitFollowUpMessage_(p, rendered, config, priorMessage);
      if (prepared.recipient !== incident.Email_Normalized || prepared.priorRfcMessageId !== incident.Prior_Rfc_Message_ID ||
          prepared.references.indexOf(incident.Prior_Rfc_Message_ID) === -1) {
        return { status: 'REJECTED_RENDERED_EVIDENCE' };
      }

      var expected = {
        threadId: incident.Thread_ID, recipient: prepared.recipient, sender: prepared.sender,
        subject: prepared.subject, priorRfcMessageId: prepared.priorRfcMessageId,
        references: prepared.references, bodyHash: prepared.bodyHash, body: prepared.body
      };
      var actual = verifyExplicitFollowUpMessage_(incident.Message_ID, expected);
      if (gmailApiHeader_(actual, 'Message-ID') !== incident.Rfc_Message_ID) {
        return { status: 'REJECTED_RFC_MESSAGE_ID' };
      }

      var threadResource = Gmail.Users.Threads.get('me', incident.Thread_ID, { format: 'full' });
      if (countExactFollowUpCopiesInThread_(threadResource, expected) !== 1) {
        return { status: 'REJECTED_DUPLICATE_OR_MISSING_MESSAGE' };
      }

      var confirmedAt = new Date(Number(actual.internalDate));
      if (!actual.internalDate || isNaN(confirmedAt.getTime())) {
        return { status: 'REJECTED_INVALID_INTERNAL_DATE' };
      }
      var nextDate = computeNextActionDate_(incident.Step, confirmedAt, config);
      var nextStatus = nextDate ? STATUS.IN_SEQUENCE : STATUS.SEQUENCE_DONE;
      var reconciliationMarker = 'RECONCILED_FROM_AMBIGUOUS: exact Gmail message ' + incident.Message_ID +
        ' verified; original incident=' + originalAmbiguity;

      // Metadata first, SENT state last: a killed execution cannot publish
      // SENT before its authoritative Gmail ID/timestamp/audit marker exists.
      if (isOriginalAmbiguous) {
        writeLedgerMetadataThenState_(ledgerRow.rowIndex, {
          Message_ID: incident.Message_ID,
          Confirmed_At: confirmedAt,
          Error: reconciliationMarker
        }, LEDGER_STATE.SENT);
      }

      var fields = {
        Status: nextStatus,
        Sequence_Step: incident.Step,
        Step2_Sent_At: confirmedAt,
        Last_Contacted: confirmedAt,
        Last_Message_ID: incident.Message_ID,
        Next_Action_Date: nextDate || ''
      };
      try {
        writeRowById_(prospectId, fields, {
          origin: ORIGIN.ADMIN,
          operation: OPERATION.ADMIN_FIXTURE_STEP2_AMBIGUOUS_RECONCILIATION
        });
      } catch (persistError) {
        updateLedgerRow_(ledgerRow.rowIndex, {
          Error: reconciliationMarker + ' POST_SEND_PERSISTENCE_FAILURE: reconciliation Prospects write failed (' + persistError + ').'
        });
        throw persistError;
      }

      logEvent_(LOG_LEVEL.INFO, LOG_EVENT.FIXTURE_STEP2_AMBIGUOUS_RECONCILED,
        prospectId, p.Email_Normalized, incident.Step,
        'Exact existing Gmail message verified; AMBIGUOUS row transitioned in place to SENT. Original=' + originalAmbiguity);
      flushLog_();
      return {
        status: 'RECONCILED_SENT', prospectId: prospectId, messageId: incident.Message_ID,
        confirmedAt: confirmedAt, nextActionDate: nextDate || ''
      };
    } finally {
      lock.releaseLock();
    }
  };

  function markFollowUpAmbiguous_(ledgerRowNum, prospectId, prospect, step, error) {
    updateLedgerRow_(ledgerRowNum, {
      State: LEDGER_STATE.AMBIGUOUS,
      Error: String(error) + ' (ambiguous outcome after Gmail API send invocation — durably blocked; SEND is never retried)'
    });
    try {
      writeRowById_(prospectId, { Status: STATUS.NEEDS_REVIEW },
        { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
    } catch (writeError) {
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'doFollowUpSend_: NEEDS_REVIEW write failed after an ambiguous Gmail API send: ' + writeError +
        '. The ledger AMBIGUOUS row remains authoritative and blocks retry.');
    }
  }

  /**
   * Step 2+ uses the Advanced Gmail API, never GmailThread.reply(). The
   * recipient comes only from the freshly re-read Prospect row. The stored
   * Last_Message_ID is a Gmail INTERNAL message id (GmailMessage.getId()),
   * not the RFC Message-ID header; the latter is fetched as metadata and
   * used for In-Reply-To/References. Gmail API messages.send receives the
   * exact existing threadId and explicit RFC headers. Its SEND call occurs
   * exactly once. Only bounded, read-only messages.get calls may retry.
   */
  function doFollowUpSend_(prospectId, step, prospect, rendered, config) {
    if (!prospect.Thread_ID || !prospect.Last_Message_ID) {
      writeRowById_(prospectId, { Status: STATUS.NEEDS_REVIEW },
        { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'LIVE follow-up blocked: Thread_ID or Last_Message_ID is missing/unresolvable.');
      return { status: 'NEEDS_REVIEW_THREAD_NOT_FOUND' };
    }

    var priorMessage;
    var prepared;
    try {
      priorMessage = Gmail.Users.Messages.get('me', prospect.Last_Message_ID, { format: 'metadata' });
      if (!priorMessage || priorMessage.threadId !== prospect.Thread_ID) {
        throw new Error('stored Last_Message_ID does not belong to the stored Thread_ID');
      }
      prepared = buildExplicitFollowUpMessage_(prospect, rendered, config, priorMessage);
    } catch (preSendError) {
      writeRowById_(prospectId, { Status: STATUS.NEEDS_REVIEW },
        { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'LIVE follow-up blocked before claim/send: ' + preSendError);
      return { status: 'NEEDS_REVIEW_FOLLOWUP_METADATA' };
    }

    var ledgerRowNum = appendLedgerRow_({
      Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: prospectId, Email_Normalized: prepared.recipient,
      Step: step, Idempotency_Key: getIdempotencyKey_(prospectId, step), Mode: LEDGER_MODE.LIVE, State: LEDGER_STATE.CLAIMED,
      Thread_ID: prospect.Thread_ID, Message_ID: '', Draft_ID: '', Confirmed_At: '', Error: ''
    });

    // Final fresh row/suppression/state check after the durable claim and
    // immediately before the one permitted Gmail SEND invocation. A
    // script lock prevents another script execution, but it cannot prevent
    // an operator from editing the Sheet, so never rely only on the earlier
    // read in executeLiveSendForStep_. A failure here is definitively
    // pre-send and may therefore be marked FAILED (not AMBIGUOUS).
    var finalFound = findRowById_(prospectId);
    var finalProspect = finalFound && finalFound.values;
    if (!finalProspect || !canSend_(finalProspect, step, config, new Date()) ||
        normalizeEmail_(finalProspect.Email_Normalized) !== prepared.recipient ||
        normalizeEmail_(finalProspect.Email) !== prepared.recipient ||
        String(finalProspect.Thread_ID || '') !== String(prospect.Thread_ID) ||
        String(finalProspect.Last_Message_ID || '') !== String(prospect.Last_Message_ID)) {
      updateLedgerRow_(ledgerRowNum, {
        State: LEDGER_STATE.FAILED,
        Error: 'PRE_SEND_REVALIDATION_FAILED: prospect state/recipient/thread changed after claim; Gmail was not invoked.'
      });
      return { status: 'SKIPPED_PRE_SEND_REVALIDATION' };
    }

    var sentResource;
    try {
      sentResource = Gmail.Users.Messages.send(prepared.resource, 'me');
    } catch (sendError) {
      markFollowUpAmbiguous_(ledgerRowNum, prospectId, prospect, step, sendError);
      throw sendError;
    }

    var sentMessageId = sentResource && String(sentResource.id || '');
    try {
      if (!sentMessageId || sentResource.threadId !== prospect.Thread_ID) {
        throw new Error('Gmail API send returned a missing message id or mismatched threadId');
      }
      verifyExplicitFollowUpMessage_(sentMessageId, {
        threadId: prospect.Thread_ID, recipient: prepared.recipient, sender: prepared.sender,
        subject: prepared.subject, priorRfcMessageId: prepared.priorRfcMessageId,
        references: prepared.references, bodyHash: prepared.bodyHash, body: prepared.body
      });
    } catch (verifyError) {
      markFollowUpAmbiguous_(ledgerRowNum, prospectId, prospect, step, verifyError);
      throw new Error('doFollowUpSend_: Gmail API send outcome is ambiguous after exact-message verification: ' + verifyError);
    }

    var confirmedAt = new Date();
    updateLedgerRow_(ledgerRowNum, { State: LEDGER_STATE.SENT, Message_ID: sentMessageId, Confirmed_At: confirmedAt });
    try {
      var confirmedThread = GmailApp.getThreadById(prospect.Thread_ID);
      if (confirmedThread) applyOutreachLabel_(confirmedThread, config);
      else throw new Error('confirmed thread was not yet visible through GmailApp');
    } catch (labelError) {
      logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'Follow-up was confirmed SENT but applying the Gmail label failed: ' + labelError);
    }

    // N6: same fix as doStep1Send_ — Gmail's reply is CONFIRMED and the
    // ledger is already durably SENT above, so a failure from here on must
    // never look like "nothing was sent". See doStep1Send_'s docstring
    // comment for the full incident writeup; this is the identical defect
    // shape (computeNextActionDate_/writeRowById_ unprotected after
    // ledger SENT), so it gets the identical fix.
    var stepColName = 'Step' + step + '_Sent_At';
    var nextDate = null;
    var cadenceThrew = false;
    try {
      nextDate = computeNextActionDate_(step, confirmedAt, config);
    } catch (cadenceError) {
      cadenceThrew = true;
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'computeNextActionDate_ threw after a CONFIRMED reply (Message_ID=' + sentMessageId +
        '): ' + cadenceError + '. Falling back to blank Next_Action_Date; Status will be forced to NEEDS_REVIEW.');
    }
    var fields = { Sequence_Step: step, Last_Contacted: confirmedAt, Last_Message_ID: sentMessageId };
    fields[stepColName] = confirmedAt;
    fields.Status = cadenceThrew ? STATUS.NEEDS_REVIEW : (nextDate ? STATUS.IN_SEQUENCE : STATUS.SEQUENCE_DONE);
    fields.Next_Action_Date = nextDate || '';

    try {
      writeRowById_(prospectId, fields, { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
    } catch (persistError) {
      // N6: durable marker on the authoritative row first — see the matching
      // comment in doStep1Send_. State stays SENT; this only annotates.
      try {
        updateLedgerRow_(ledgerRowNum, {
          Error: 'POST_SEND_PERSISTENCE_FAILURE: reply CONFIRMED, Prospects write failed (' + persistError +
            '). Prospects may still read its pre-send state. Reconcile Prospects FROM THIS ROW; never resend.'
        });
      } catch (markerError) {
        logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
          'POST_SEND_PERSISTENCE_FAILURE: could not even stamp the ledger Error marker: ' + markerError +
          '. The row is still durably SENT (blocking), but the Log is now the only record of the failure.');
      }
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'POST_SEND_PERSISTENCE_FAILURE: Gmail API follow-up is CONFIRMED (Message_ID=' + sentMessageId +
        ', SendLedger row ' + ledgerRowNum + '=SENT) but the full Prospects write failed: ' + persistError +
        '. Attempting a minimal fallback write (Status=NEEDS_REVIEW only).');
      try {
        writeRowById_(prospectId, { Status: STATUS.NEEDS_REVIEW },
          { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
      } catch (fallbackError) {
        logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
          'POST_SEND_PERSISTENCE_FAILURE: the minimal NEEDS_REVIEW fallback write ALSO failed: ' + fallbackError +
          '. Prospects for ' + prospectId + ' may still read its PRE-SEND state despite a CONFIRMED LIVE reply ' +
          '(SendLedger row ' + ledgerRowNum + ', Message_ID=' + sentMessageId + '). NEEDS MANUAL ' +
          'RECONCILIATION FROM SENDLEDGER — never automatic retry; isLiveKeyBlocked_ already permanently ' +
          'blocks this key because the ledger row is SENT.');
      }
      logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SENT, prospectId, prospect.Email_Normalized, step,
        'LIVE step ' + step + ' sent (Gmail + SendLedger CONFIRMED); Prospects persistence failed and needs ' +
        'manual reconciliation from SendLedger row ' + ledgerRowNum + '.');
      return { status: 'SENT_PERSISTENCE_FAILED', ledgerRowNum: ledgerRowNum, messageId: sentMessageId };
    }

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
        if (isLiveKeyBlocked_(prospectId, step)) {
          // N5: blocks on CLAIMED, SENT, or AMBIGUOUS (Ledger.gs) — this is
          // the ONE check that must hold regardless of canSend_'s result
          // above (a stuck Prospects write could leave canSend_ returning
          // true even for an ambiguous key; the ledger is the real gate).
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
 * Sends REAL Step 1 email for EXACTLY ONE explicitly controlled test
 * fixture, chosen by Prospect_ID, without going through the normal
 * queue/orderQueue_ path — so real READY prospects ahead of the fixture
 * in the natural queue are never touched, never re-ordered, never even
 * read as candidates.
 *
 * ARCHITECTURE: this function performs ONLY read-only, pre-Gmail
 * identity/eligibility guards (below). It does NOT reimplement Gmail
 * sending, ledger claiming, idempotency, or Prospects persistence — once
 * every guard here passes, it delegates to sendStep1(prospectId), the
 * EXACT SAME public entry point normal LIVE sending uses. Every
 * protection sendStep1 already enforces (fresh row re-read, canSend_,
 * isLiveKeyBlocked_/CLAIMED-SENT-AMBIGUOUS blocking, DRY_RUN/PENDING_F0
 * gating via performLiveSend_, the send window, the daily quota, N6's
 * post-send-persistence hard-stop-and-durable-marker handling) applies
 * here unchanged, because this function does not bypass a single one of
 * them — it only adds a narrower gate in front.
 *
 * THE GATE THIS FUNCTION EXISTS FOR: Source must be one of
 * CONTROLLED_FIXTURE_SOURCES (Constants.gs) — a code-level allowlist, not
 * a Config/Sheet value, so a Sheet edit alone cannot widen what this can
 * touch. A real prospect's Source is never in that list, so this function
 * fails closed, before any Gmail call, for every real prospect — always.
 *
 * Every guard below is independently testable and returns a distinct
 * REJECTED_* status naming exactly which one failed. Guards intentionally
 * NOT re-implemented here (already covered by sendStep1's own fresh
 * checks, so duplicating them would only create a second copy that could
 * drift): the blocking-ledger-row check, LIVE Config arming, the send
 * window, and the daily quota. Re-checking Source/identity/email-shape
 * here first means a request for a real prospect never even reaches those
 * deeper, production-shared checks.
 */
function sendControlledFixtureLive(prospectId) {
  if (!prospectId) return { status: 'REJECTED_NO_PROSPECT_ID' };

  // Guard 1: the id must resolve to EXACTLY one row — see
  // countProspectRowsById_'s docstring (SheetRepo.gs), shared with
  // makeControlledFixtureDueNow (StateMachine.gs).
  var matchCount = countProspectRowsById_(prospectId);
  if (matchCount !== 1) {
    return { status: 'REJECTED_AMBIGUOUS_ID', matchCount: matchCount };
  }

  var found = findRowById_(prospectId);
  if (!found) return { status: 'REJECTED_NOT_FOUND' };
  var p = found.values;

  // Guard 2: THE core protection — Source allowlist.
  if (CONTROLLED_FIXTURE_SOURCES.indexOf(p.Source) === -1) {
    return { status: 'REJECTED_SOURCE_NOT_CONTROLLED', source: p.Source };
  }

  // Guard 3/4: Status=READY and Step 1 is genuinely the expected next step.
  if (p.Status !== STATUS.READY) {
    return { status: 'REJECTED_NOT_READY', prospectStatus: p.Status };
  }
  var config = getConfig();
  var expectedStep = getNextStepNumber_(p, config);
  if (expectedStep !== 1) {
    return { status: 'REJECTED_UNEXPECTED_STEP', expectedStep: expectedStep };
  }

  // Guards 5/6/7: the same three eligibility fields canSend_ enforces,
  // re-checked here explicitly so a rejected fixture gets a named,
  // specific reason instead of the single generic SKIPPED_NOT_ELIGIBLE
  // sendStep1 would otherwise return for any of these.
  if (p.Stop_Contact === true) return { status: 'REJECTED_STOP_CONTACT' };
  if (p.Do_Not_Contact_Reason) return { status: 'REJECTED_DNC', reason: p.Do_Not_Contact_Reason };
  if (p.Replied === true) return { status: 'REJECTED_REPLIED' };

  // Guards 8/9: email syntax, and Email/Email_Normalized consistency —
  // defense in depth on top of validateAllRows (which is the only normal
  // path to Status=READY, and already enforces both).
  var recomputedNormalized = normalizeEmail_(p.Email);
  if (!isValidEmailSyntax_(recomputedNormalized)) {
    return { status: 'REJECTED_INVALID_EMAIL' };
  }
  if (recomputedNormalized !== normalizeEmail_(p.Email_Normalized)) {
    return { status: 'REJECTED_EMAIL_NORMALIZATION_MISMATCH' };
  }

  // Guard 10: Suppression — re-checked explicitly for a named reason.
  if (isSuppressed_(p.Email_Normalized, p.Domain)) {
    return { status: 'REJECTED_SUPPRESSED' };
  }

  // Guard 15: this mechanism is for single-target use only — refuse to
  // run unless the operator has the system in a one-shot posture.
  if (Number(config.MAX_PER_RUN) !== 1) {
    return { status: 'REJECTED_MAX_PER_RUN_NOT_ONE', maxPerRun: config.MAX_PER_RUN };
  }

  // Guards 11-14 and 16: delegated, unchanged, to the production primitive.
  // sendStep1 re-reads this exact row fresh under its own lock and applies
  // isLiveKeyBlocked_, DRY_RUN/PENDING_F0 (performLiveSend_), the send
  // window, the daily quota, and (on send) N6's post-send-persistence
  // hard-stop/durable-marker handling — all unmodified.
  return sendStep1(prospectId);
}

/**
 * Sends REAL Step 2 email for EXACTLY ONE explicitly controlled test
 * fixture, chosen by Prospect_ID, without going through the normal
 * queue/orderQueue_ path — the Step-2 sibling of sendControlledFixtureLive
 * above (same architecture, same CONTROLLED_FIXTURE_SOURCES allowlist,
 * same delegation model).
 *
 * ARCHITECTURE: read-only, pre-Gmail guards only. Delegates unchanged to
 * sendFollowUp(prospectId, 2) — the EXACT SAME public entry point
 * sendBatch() itself uses for every real Step-2+ send (executeLiveSendForStep_
 * -> doFollowUpSend_). Nothing about Gmail.Users.Messages.send(), MIME/
 * In-Reply-To/References threading, ledger CLAIMED/SENT/AMBIGUOUS,
 * idempotency, quota, canSend_, post-send verification, Prospects
 * persistence, or N6 post-send-persistence handling is reimplemented here
 * — every one of those still runs, unmodified, inside doFollowUpSend_.
 * This function only adds a narrower gate in front, exactly like its
 * Step-1 sibling.
 *
 * THE GATE THIS FUNCTION EXISTS FOR: Source must be one of
 * CONTROLLED_FIXTURE_SOURCES (Constants.gs) — the SAME allowlist
 * sendControlledFixtureLive and makeControlledFixtureDueNow already use.
 * A real prospect's Source is never in that list, so this fails closed,
 * before any Gmail call, for every real prospect — always.
 *
 * Guards intentionally NOT re-implemented here (already covered by
 * sendFollowUp's own fresh checks — duplicating them would only create a
 * second copy that could drift): the blocking-ledger-row check
 * (isLiveKeyBlocked_), LIVE Config arming (DRY_RUN/PENDING_F0 via
 * performLiveSend_), the send window, and the daily quota.
 */
function sendControlledFixtureStep2Live(prospectId) {
  if (!prospectId) return { status: 'REJECTED_NO_PROSPECT_ID' };

  // Guard 1: the id must resolve to EXACTLY one row.
  var matchCount = countProspectRowsById_(prospectId);
  if (matchCount !== 1) {
    return { status: 'REJECTED_AMBIGUOUS_ID', matchCount: matchCount };
  }

  var found = findRowById_(prospectId);
  if (!found) return { status: 'REJECTED_NOT_FOUND' };
  var p = found.values;

  // Guard 2: THE core protection — Source allowlist.
  if (CONTROLLED_FIXTURE_SOURCES.indexOf(p.Source) === -1) {
    return { status: 'REJECTED_SOURCE_NOT_CONTROLLED', source: p.Source };
  }

  // Guard 3/4/5: must genuinely be mid-sequence, exactly at step 1 done,
  // and step 2 must be the genuinely expected next step (getNextStepNumber_
  // is the SAME function canSend_/sendBatch's queue-builder both use).
  if (p.Status !== STATUS.IN_SEQUENCE) {
    return { status: 'REJECTED_WRONG_STATUS', prospectStatus: p.Status };
  }
  if (Number(p.Sequence_Step) !== 1) {
    return { status: 'REJECTED_WRONG_SEQUENCE_STEP', sequenceStep: p.Sequence_Step };
  }
  var config = getConfig();
  var expectedStep = getNextStepNumber_(p, config);
  if (expectedStep !== 2) {
    return { status: 'REJECTED_UNEXPECTED_STEP', expectedStep: expectedStep };
  }

  // Guards 6/7/8: Step 1 must have genuinely, verifiably happened — never
  // send a follow-up for a step that was never actually sent.
  if (!p.Step1_Sent_At) return { status: 'REJECTED_MISSING_STEP1_SENT_AT' };
  if (!p.Thread_ID) return { status: 'REJECTED_MISSING_THREAD_ID' };
  if (!p.Last_Message_ID) return { status: 'REJECTED_MISSING_LAST_MESSAGE_ID' };

  // Guard 9: due now — named separately from the generic SKIPPED_NOT_ELIGIBLE
  // canSend_ would otherwise produce for this same condition.
  if (!p.Next_Action_Date || new Date(p.Next_Action_Date).getTime() > Date.now()) {
    return { status: 'REJECTED_NOT_DUE', nextActionDate: p.Next_Action_Date };
  }

  // Guards 10/11/12: the same three eligibility fields canSend_ enforces,
  // re-checked here explicitly for a named, specific rejection reason.
  if (p.Replied === true) return { status: 'REJECTED_REPLIED' };
  if (p.Stop_Contact === true) return { status: 'REJECTED_STOP_CONTACT' };
  if (p.Do_Not_Contact_Reason) return { status: 'REJECTED_DNC', reason: p.Do_Not_Contact_Reason };

  // Guard 13: Suppression.
  if (isSuppressed_(p.Email_Normalized, p.Domain)) {
    return { status: 'REJECTED_SUPPRESSED' };
  }

  // Guard 16: this mechanism is for single-target use only.
  if (Number(config.MAX_PER_RUN) !== 1) {
    return { status: 'REJECTED_MAX_PER_RUN_NOT_ONE', maxPerRun: config.MAX_PER_RUN };
  }

  // Guards 14/15/17: delegated, unchanged, to the production primitive.
  // sendFollowUp re-reads this exact row fresh under its own lock and
  // applies isLiveKeyBlocked_, DRY_RUN/PENDING_F0 (performLiveSend_), the
  // send window, the daily quota, and (on send) doFollowUpSend_'s full
  // Gmail-reply/threading/ledger/N6 handling — all unmodified.
  return sendFollowUp(prospectId, 2);
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

  // N6 (independent review of the post-send persistence fix): this loop was
  // a forEach that DISCARDED each send's return value — so a
  // SENT_PERSISTENCE_FAILED outcome was invisible here and the batch rolled
  // straight on to the next prospect. That is the compounding case:
  //
  //   A Gmail sent -> A ledger SENT -> A Prospects persistence fails
  //   -> batch continues -> B Gmail sent -> B persistence fails too -> ...
  //
  // A post-send persistence failure means the mechanism that RECORDS sends
  // is broken, so every further send in this run would be another real,
  // unrecorded email. It is a HARD STOP for the whole batch — a plain `for`
  // loop, because forEach cannot break.
  //
  // Deliberately NOT a hard stop: ordinary skips, quota aborts, and thrown
  // AMBIGUOUS outcomes. Those all still RECORD correctly in the ledger
  // (CLAIMED/AMBIGUOUS are durably blocking), so the run may safely
  // continue — stopping on them would silently throttle normal operation.
  for (var i = 0; i < ordered.length; i++) {
    var r = ordered[i];
    var step = getNextStepNumber_(r.values, config);
    if (!step) continue;

    var outcome = null;
    try {
      outcome = step === 1 ? sendStep1(r.values.Prospect_ID) : sendFollowUp(r.values.Prospect_ID, step);
    } catch (e) {
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, r.values.Prospect_ID, r.values.Email_Normalized, step, String(e));
    }

    if (outcome && outcome.status === 'SENT_PERSISTENCE_FAILED') {
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, r.values.Prospect_ID, r.values.Email_Normalized, step,
        'BATCH ABORTED after a POST_SEND_PERSISTENCE_FAILURE for this prospect (SendLedger row ' +
        outcome.ledgerRowNum + ' is durably SENT). ' + (ordered.length - i - 1) + ' remaining candidate(s) in this ' +
        'run were NOT contacted and were NOT claimed. Refusing to send further real email while Prospects ' +
        'persistence is failing — each additional send would be another unrecorded LIVE email. Reconcile from ' +
        'SendLedger before resuming; consider setting PAUSE_ALL=TRUE if triggers are installed.');
      break;
    }

    if (i < ordered.length - 1) {
      Utilities.sleep((config.MIN_SLEEP_SECONDS + Math.random() * (config.MAX_SLEEP_SECONDS - config.MIN_SLEEP_SECONDS)) * 1000);
    }
  }

  flushLog_();
}
