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
  // CASO 10: ambiguity guard FIRST, before anything else touches Gmail or
  // the ledger. findActiveDryRunDraftRows_ (Ledger.gs) returns every
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
 *           'ERROR_DRAFT_METADATA_CAPTURE_FAILED'
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

    var draftResult = createPreviewDraft_(prospectId, step, prospect, rendered, config);
    if (draftResult.skipped) return { status: draftResult.status };

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
      // Fail closed: never write a "healthy" DRAFTED row with a blank
      // fingerprint from a metadata-capture failure. We created this draft
      // ourselves, synchronously, in this same execution — no human could
      // have touched it yet — so deleting it via the DIRECT OBJECT
      // REFERENCE we already hold (attemptDeleteDraftDirectly_) is safe
      // (not an ownership check; there is nothing to distinguish it from
      // yet) AND avoids the enumeration failure surface entirely (Codex
      // round 2: a Draft_ID lookup through GmailApp.getDrafts() could
      // itself throw on an UNRELATED draft's getId() — see
      // findDraftInListSafely_ — a risk that simply does not exist when
      // deleting the object we already have in hand).
      var compensated = attemptDeleteDraftDirectly_(draftResult.draft);
      if (!compensated && draftId) {
        // Could not confirm the draft is gone (the delete call itself
        // threw) — it may still physically exist. Record what we DO know
        // as a recovery row (blank fingerprint) so the legacy-blank-
        // fingerprint policy above durably preserves it on the very next
        // run instead of a future previewStep() silently creating a
        // second draft alongside an untracked orphan.
        try {
          appendLedgerRow_({
            Run_ID: getRunId_(), Claimed_At: '', Prospect_ID: prospectId, Email_Normalized: prospect.Email_Normalized,
            Step: step, Idempotency_Key: getIdempotencyKey_(prospectId, step), Mode: LEDGER_MODE.DRY_RUN,
            State: LEDGER_STATE.DRAFTED, Thread_ID: usedThreadId || '', Message_ID: draftMessageId, Draft_ID: draftId,
            Confirmed_At: new Date(),
            Error: 'CREATION_METADATA_CAPTURE_FAILED: ' + creationError + ' — recorded as a recovery row; ' +
              'treated as legacy/needs-review by resolveExistingPreviewDraft_, never auto-deleted or duplicated.',
            Draft_Fingerprint: '', Human_Edit_Preserved: false, Human_Edit_Detected_At: ''
          });
        } catch (recoveryLedgerError) {
          logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
            'Draft metadata capture failed AND the recovery ledger row also failed to write: ' + recoveryLedgerError +
            '. Draft_ID=' + (draftId || 'UNKNOWN') + ' is a fully untracked orphan — NEEDS MANUAL REVIEW.');
        }
      } else if (!compensated) {
        logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
          'Draft creation metadata capture failed AND the created draft\'s own Draft_ID is unknown — a Gmail draft ' +
          'may exist with NO trace in SendLedger. NEEDS MANUAL REVIEW (residual risk; see Mailer.gs docstring).');
      }
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'Draft creation metadata capture failed: ' + creationError + '. draftId=' + (draftId || 'UNKNOWN') +
        ' compensated=' + compensated + '. No healthy DRAFTED row written (fail-closed).');
      return { status: 'ERROR_DRAFT_METADATA_CAPTURE_FAILED', draftId: draftId || undefined, compensated: compensated };
    }

    var ledgerEntry = {
      Run_ID: getRunId_(), Claimed_At: '', Prospect_ID: prospectId, Email_Normalized: prospect.Email_Normalized,
      Step: step, Idempotency_Key: getIdempotencyKey_(prospectId, step), Mode: LEDGER_MODE.DRY_RUN,
      State: LEDGER_STATE.DRAFTED, Thread_ID: usedThreadId, Message_ID: draftMessageId, Draft_ID: draftId,
      Confirmed_At: new Date(), Error: '', Draft_Fingerprint: draftFingerprint, Human_Edit_Preserved: false, Human_Edit_Detected_At: ''
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
   * N5 CLOSED, round 2 (Codex final audit — was: BLOCKER BEFORE FIRST LIVE
   * EMAIL). This function is still unreachable in F1 (DRY_RUN=TRUE + 5
   * unresolved PENDING_F0 keys both block performLiveSend_ before this
   * code can ever run) but every ambiguous outcome below now durably
   * blocks the ledger row itself (LEDGER_STATE.AMBIGUOUS — see
   * Constants.gs/Ledger.gs), not merely a secondary Prospects write.
   *
   * TWO ambiguous outcomes are handled identically, both ending in
   * AMBIGUOUS:
   *   1. thread.reply() itself THROWS — we don't know if Gmail published
   *      the reply before/during/after the throw.
   *   2. thread.reply() RETURNS but the message-count guard below trips
   *      ("nothing else can have appended a message in between" assumes no
   *      inbound reply lands in the narrow window between reply()
   *      returning and the immediately-following getMessages() call — if
   *      one does, messagesAfter.length is off by more than 1). reply()
   *      DID return successfully here, so a message was almost certainly
   *      sent — we just cannot prove which one is ours.
   *
   * Round 1 (previous audit) marked both cases LEDGER_STATE.FAILED, which
   * isLiveKeyBlocked_ (Ledger.gs) does NOT treat as blocking — FAILED
   * means "we KNOW nothing was sent", which is false for an ambiguous
   * outcome. Round 1 then relied ENTIRELY on a second write
   * (Prospects.Status=NEEDS_REVIEW) to prevent a retry — if THAT write
   * also failed (Sheets API error, quota, anything), the prospect could
   * stay eligible and a later sendBatch run could send a SECOND real
   * follow-up. Round 2 closes this at the source: the ledger row is marked
   * AMBIGUOUS (a durably blocking state, enforced by isLiveKeyBlocked_
   * regardless of what happens to Prospects), and the Prospects
   * NEEDS_REVIEW write is now purely a secondary, operational signal.
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
      // N5: reply() itself threw — durably block first (ledger), Prospects
      // NEEDS_REVIEW second, purely as an operational signal. See docstring.
      updateLedgerRow_(ledgerRowNum, {
        State: LEDGER_STATE.AMBIGUOUS,
        Error: String(replyError) + ' (ambiguous outcome — durably blocked in the ledger, never automatically retryable)'
      });
      try {
        writeRowById_(prospectId, { Status: STATUS.NEEDS_REVIEW },
          { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
      } catch (writeError) {
        logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
          'doFollowUpSend_: the Prospects NEEDS_REVIEW write ALSO failed after reply() threw: ' + writeError +
          ' — this is a SECONDARY signal only; the ledger AMBIGUOUS state (already written above) still blocks retry regardless. NEEDS MANUAL REVIEW.');
      }
      throw replyError;
    }

    var messagesAfter = repliedThread.getMessages();
    if (messagesAfter.length !== messagesBefore + 1) {
      // N5: ambiguous outcome — never invent a Message_ID, and never leave
      // this automatically retryable. Durably block the ledger row itself
      // FIRST (AMBIGUOUS, not FAILED — see docstring); Prospects
      // NEEDS_REVIEW is a secondary, operational signal only.
      updateLedgerRow_(ledgerRowNum, {
        State: LEDGER_STATE.AMBIGUOUS,
        Error: 'Unexpected message count after reply() — ambiguous outcome, durably blocked in the ledger.'
      });
      try {
        writeRowById_(prospectId, { Status: STATUS.NEEDS_REVIEW },
          { origin: ORIGIN.PIPELINE, operation: OPERATION.PIPELINE_SEND });
      } catch (writeError) {
        logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
          'doFollowUpSend_: the Prospects NEEDS_REVIEW write ALSO failed after an ambiguous reply() outcome: ' + writeError +
          ' — this is a SECONDARY signal only; the ledger AMBIGUOUS state (already written above) still blocks retry regardless. NEEDS MANUAL REVIEW.');
      }
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospectId, prospect.Email_Normalized, step,
        'doFollowUpSend_: could not reliably identify the message reply() just created ' +
        '(expected ' + (messagesBefore + 1) + ' messages, found ' + messagesAfter.length + '). ' +
        'Ambiguous — may have actually sent. Durably blocked in SendLedger (AMBIGUOUS), not retried automatically.');
      throw new Error('doFollowUpSend_: ambiguous outcome after reply() — durably blocked in SendLedger, see Log.');
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
