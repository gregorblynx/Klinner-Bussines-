/**
 * Klinner Outreach — Ledger.gs
 * SendLedger read/write. Implements the idempotency scoping rule from
 * PATCH FINAL V1.1 (Patch 1 / I13): uniqueness and the LIVE daily-quota
 * count are evaluated ONLY over Mode=LIVE rows. DRY_RUN rows are written
 * for traceability and draft-regeneration bookkeeping, but are invisible
 * to every LIVE guard.
 */

function getLedgerSheet_() {
  return getSheet_(SHEET_NAMES.SEND_LEDGER);
}

function getIdempotencyKey_(prospectId, step) {
  return prospectId + ':' + step;
}

function ledgerRowToObject_(raw) {
  var obj = {};
  for (var i = 0; i < SEND_LEDGER_COLUMN_ORDER.length; i++) obj[SEND_LEDGER_COLUMN_ORDER[i]] = raw[i];
  return obj;
}

/** Reads the full ledger into memory. Fine at F1/F2 volumes (tens/hundreds of rows). */
function readAllLedgerRows_() {
  var sheet = getLedgerSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var data = sheet.getRange(2, 1, lastRow - 1, SEND_LEDGER_COLUMN_ORDER.length).getValues();
  var rows = [];
  for (var i = 0; i < data.length; i++) {
    rows.push({ rowIndex: i + 2, values: ledgerRowToObject_(data[i]) });
  }
  return rows;
}

function appendLedgerRow_(entry) {
  var sheet = getLedgerSheet_();
  var row = SEND_LEDGER_COLUMN_ORDER.map(function (col) {
    return entry.hasOwnProperty(col) ? entry[col] : '';
  });
  sheet.appendRow(row);
  SpreadsheetApp.flush();
  return sheet.getLastRow();
}

function updateLedgerRow_(rowIndex, fields) {
  var sheet = getLedgerSheet_();
  for (var name in fields) {
    if (!fields.hasOwnProperty(name)) continue;
    var col = SEND_LEDGER_COLUMNS[name];
    if (!col) throw new Error('Unknown SendLedger column: ' + name);
    sheet.getRange(rowIndex, col).setValue(fields[name]);
  }
}

/**
 * I13 (extended by N5): a step is BLOCKED from any new LIVE send/reply
 * attempt if a Mode=LIVE row exists in ANY of these states for that
 * idempotency key:
 *   - CLAIMED: a send/reply attempt is in flight or died mid-flight
 *     (Apps Script execution killed before completion) — never safe to
 *     assume it didn't happen.
 *   - SENT: confirmed success — obviously never resend.
 *   - AMBIGUOUS (N5): the Gmail operation that may have sent/replied threw
 *     or returned an unverifiable outcome — we cannot prove it did NOT
 *     act, so retry is exactly as dangerous as retrying a live SENT.
 * FAILED is deliberately excluded — it means we KNOW nothing was sent
 * (e.g. the ledger CLAIM write itself failed, or a genuinely ordinary
 * transient error that occurred BEFORE the Gmail call was even attempted),
 * so it SHOULD be retryable. DRY_RUN rows never participate in this check.
 *
 * Renamed from isLiveKeyClaimedOrSent_ (N5, Codex final audit) — the old
 * name no longer described what the function actually guards.
 */
function isLiveKeyBlocked_(prospectId, step) {
  var key = getIdempotencyKey_(prospectId, step);
  var rows = readAllLedgerRows_();
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i].values;
    if (v.Idempotency_Key === key && v.Mode === LEDGER_MODE.LIVE &&
        (v.State === LEDGER_STATE.CLAIMED || v.State === LEDGER_STATE.SENT || v.State === LEDGER_STATE.AMBIGUOUS)) {
      return true;
    }
  }
  return false;
}

/** I10: LIVE sends already counted TODAY (script timezone), for the daily quota. */
function getDailyLiveSentCount_() {
  var today = formatDateYmd_(new Date());
  var rows = readAllLedgerRows_();
  var count = 0;
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i].values;
    if (v.Mode === LEDGER_MODE.LIVE && v.State === LEDGER_STATE.SENT && v.Confirmed_At) {
      if (formatDateYmd_(new Date(v.Confirmed_At)) === today) count++;
    }
  }
  return count;
}

/**
 * Finds the currently-live (non-superseded) DRY_RUN draft ledger row for
 * (prospectId, step), if any. Used by Mailer's draft-regeneration logic
 * (§6.4 — at most one live preview draft per prospect+step).
 */
function findActiveDryRunDraft_(prospectId, step) {
  var key = getIdempotencyKey_(prospectId, step);
  var rows = readAllLedgerRows_();
  for (var i = rows.length - 1; i >= 0; i--) {
    var v = rows[i].values;
    if (v.Idempotency_Key === key && v.Mode === LEDGER_MODE.DRY_RUN && v.State === LEDGER_STATE.DRAFTED) {
      return rows[i];
    }
  }
  return null;
}

/**
 * N3 V3 (Codex final audit, blocker N3-4): plural counterpart of
 * findActiveDryRunDraft_, returning EVERY active (Mode=DRY_RUN,
 * State=DRAFTED) row for the key, not just the last one. Normally 0 or 1.
 * More than 1 is only possible after a partially-applied
 * preserveDraftDurably_ transition (append succeeded, supersede of the old
 * row failed) — resolveExistingPreviewDraft_ uses the length of this list
 * as an explicit ambiguity guard and refuses to guess which row is
 * authoritative, rather than silently picking "the last one" the way
 * findActiveDryRunDraft_ does for its other (non-safety-critical) callers.
 */
function findActiveDryRunDraftRows_(prospectId, step) {
  var key = getIdempotencyKey_(prospectId, step);
  var rows = readAllLedgerRows_();
  var matches = [];
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i].values;
    if (v.Idempotency_Key === key && v.Mode === LEDGER_MODE.DRY_RUN && v.State === LEDGER_STATE.DRAFTED) {
      matches.push(rows[i]);
    }
  }
  return matches;
}

/**
 * N3 (Codex re-audit, final round): the PREVIEW-side blocking states.
 * A preview idempotency key is blocked from any NEW Gmail draft creation
 * while a row in ANY of these states exists:
 *   - DRAFTED           a live preview draft already exists for this key.
 *   - PREVIEW_CLAIMED   a draft creation was claimed and may be in flight
 *                       (or died mid-flight — a killed Apps Script
 *                       execution leaves exactly this).
 *   - PREVIEW_AMBIGUOUS a Gmail side effect that could have created a
 *                       draft had an outcome we cannot resolve, and
 *                       compensation could not confirm cleanup.
 * SUPERSEDED/FAILED are deliberately NOT blocking: both mean "no Gmail
 * draft exists for this key any more", which is exactly when a fresh
 * preview SHOULD be allowed.
 */
function isPreviewKeyBlockedState_(state) {
  return state === LEDGER_STATE.DRAFTED ||
    state === LEDGER_STATE.PREVIEW_CLAIMED ||
    state === LEDGER_STATE.PREVIEW_AMBIGUOUS;
}

/**
 * Every DRY_RUN row for this key currently in a preview-blocking state
 * (see isPreviewKeyBlockedState_). Normally 0 or 1. This is what
 * resolveExistingPreviewDraft_ reads — NOT findActiveDryRunDraftRows_,
 * which only sees DRAFTED and would therefore miss an unresolved claim.
 */
function findActivePreviewRows_(prospectId, step) {
  var key = getIdempotencyKey_(prospectId, step);
  var rows = readAllLedgerRows_();
  var matches = [];
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i].values;
    if (v.Idempotency_Key === key && v.Mode === LEDGER_MODE.DRY_RUN && isPreviewKeyBlockedState_(v.State)) {
      matches.push(rows[i]);
    }
  }
  return matches;
}

/**
 * N3: writes and FLUSHES the durable PREVIEW_CLAIMED barrier for
 * (prospectId, step) BEFORE any Gmail draft-creating call is made.
 * appendLedgerRow_ calls SpreadsheetApp.flush() itself, so by the time
 * this returns the barrier is persisted, not merely buffered — that
 * ordering is the whole point: if this throws, the caller must NOT call
 * GmailApp.createDraft() at all (there would be no barrier for the draft
 * it would create).
 * @return {number} the ledger row index of the claim.
 */
function appendPreviewClaim_(prospectId, step, emailNormalized) {
  return appendLedgerRow_({
    Run_ID: getRunId_(), Claimed_At: new Date(), Prospect_ID: prospectId, Email_Normalized: emailNormalized,
    Step: step, Idempotency_Key: getIdempotencyKey_(prospectId, step), Mode: LEDGER_MODE.DRY_RUN,
    State: LEDGER_STATE.PREVIEW_CLAIMED, Thread_ID: '', Message_ID: '', Draft_ID: '',
    Confirmed_At: '', Error: 'PREVIEW_CLAIMED: barrier written before GmailApp.createDraft() was called.',
    Draft_Fingerprint: '', Human_Edit_Preserved: false, Human_Edit_Detected_At: ''
  });
}

/**
 * N3: the claim's Gmail side effect had an unresolvable outcome (or a
 * post-creation failure could not be compensated). Transitions the claim
 * to PREVIEW_AMBIGUOUS — still blocking, permanently, until a human
 * resolves it. NOTE: if this write itself fails the row simply stays
 * PREVIEW_CLAIMED, which is ALSO blocking — either way the key remains
 * closed, which is why this is safe to call best-effort.
 */
function markPreviewClaimAmbiguous_(rowIndex, note) {
  updateLedgerRow_(rowIndex, {
    State: LEDGER_STATE.PREVIEW_AMBIGUOUS,
    Error: 'PREVIEW_AMBIGUOUS: ' + note + ' Needs manual ADMIN review — never auto-retried.'
  });
}

/**
 * N3: the claim is provably resolvable to "no Gmail draft exists" (the
 * draft was confirmed deleted, or was never created at all). Releasing
 * the claim to SUPERSEDED — a NON-blocking state — is the only path that
 * re-opens the key for a future preview, and it is only ever taken on
 * CONFIRMED cleanup, never on an unproven assumption.
 */
function releasePreviewClaim_(rowIndex, note) {
  updateLedgerRow_(rowIndex, {
    State: LEDGER_STATE.SUPERSEDED,
    Error: 'PREVIEW_CLAIM_RELEASED: ' + note
  });
}

/**
 * N3: the happy path — the draft exists, all its metadata was captured,
 * so the claim row itself becomes the DRAFTED row (updated in place, so
 * there is never a window with two active rows or zero active rows for
 * this key).
 */
function finalizePreviewClaimAsDrafted_(rowIndex, fields) {
  updateLedgerRow_(rowIndex, {
    State: LEDGER_STATE.DRAFTED,
    Thread_ID: fields.threadId, Message_ID: fields.messageId, Draft_ID: fields.draftId,
    Confirmed_At: new Date(), Error: '', Draft_Fingerprint: fields.fingerprint,
    Human_Edit_Preserved: false, Human_Edit_Detected_At: ''
  });
}

function supersedeLedgerRow_(rowIndex) {
  updateLedgerRow_(rowIndex, { State: LEDGER_STATE.SUPERSEDED });
}

/**
 * N3 V3 (Codex final audit, blocker N3-4 — partial-failure safety):
 * the Gmail draft at Draft_ID/Thread_ID needs to be durably preserved —
 * either because a human edit was detected (content fingerprint changed)
 * or because this is a legacy row with no baseline fingerprint to compare
 * against (see verifyPreviewDraftOwnership_'s `legacy` flag). The
 * underlying resource was NOT deleted or recreated, so this is
 * deliberately NOT the same thing as supersedeLedgerRow_() + a fresh
 * appendLedgerRow_() for a brand-new draft — and it is a ONE-TIME, DURABLE
 * transition: the appended row carries Human_Edit_Preserved=true, so
 * resolveExistingPreviewDraft_ short-circuits straight to preserving it on
 * every future run without ever calling this function again for the same
 * key (no repeated reconciliation rows, no re-evaluating content that was
 * already confirmed human-edited/legacy — see resolveExistingPreviewDraft_).
 *
 * ORDER MATTERS (blocker N3-4): the new row is APPENDED FIRST, the old row
 * is SUPERSEDED SECOND — the reverse of a naive "retire then add"
 * ordering, chosen specifically so a partial failure can never leave ZERO
 * active rows for this key:
 *   - append throws -> the old row is completely untouched, still the
 *     sole active row for this key. The next resolveExistingPreviewDraft_
 *     call sees exactly one active row and safely re-attempts the same
 *     transition (idempotent in effect — it will recompute the same
 *     `edited`/`legacy` determination and try again).
 *   - append succeeds but the FOLLOWING supersede throws -> there are now
 *     TWO active rows for this key (old + new). This is deliberately NOT
 *     silently resolved here or anywhere downstream — the very next
 *     resolveExistingPreviewDraft_ call's findActiveDryRunDraftRows_()
 *     ambiguity guard (Mailer.gs) sees length > 1 and fails closed
 *     (BLOCKED_NEEDS_REVIEW) rather than guessing which row is
 *     authoritative. Never "last row wins" — that could delete or
 *     duplicate a real Gmail draft based on an unverified guess.
 * Either partial-failure outcome is safe: no automatic delete, no
 * automatic duplicate draft, ever.
 *
 * Audit trail is preserved by APPENDING rather than overwriting: the old
 * row keeps its originally-recorded Message_ID and Draft_Fingerprint
 * untouched (so a reviewer can still see exactly what was first created)
 * and is marked SUPERSEDED with an Error-column note distinguishing this
 * from an ordinary delete+recreate supersede. The new row carries the SAME
 * Prospect_ID/Step/Idempotency_Key/Mode/Draft_ID/Thread_ID (the resource
 * identity did not change) plus the CURRENT Message_ID/fingerprint and the
 * durable marker + detection timestamp.
 *
 * @param {string} reasonTag 'HUMAN_EDIT_PRESERVED' or 'LEGACY_BASELINE_PRESERVED'
 *   — recorded verbatim in the old row's Error column so a reviewer can
 *   tell a confirmed edit apart from a conservative legacy bootstrap.
 */
function preserveDraftDurably_(oldRowIndex, oldValues, verification, reasonTag) {
  var now = new Date();
  appendLedgerRow_({
    Run_ID: getRunId_(), Claimed_At: '', Prospect_ID: oldValues.Prospect_ID, Email_Normalized: oldValues.Email_Normalized,
    Step: oldValues.Step, Idempotency_Key: oldValues.Idempotency_Key, Mode: LEDGER_MODE.DRY_RUN,
    State: LEDGER_STATE.DRAFTED, Thread_ID: oldValues.Thread_ID, Message_ID: verification.currentMessageId,
    Draft_ID: oldValues.Draft_ID, Confirmed_At: now, Error: '',
    Draft_Fingerprint: verification.currentFingerprint, Human_Edit_Preserved: true, Human_Edit_Detected_At: now
  });
  updateLedgerRow_(oldRowIndex, {
    State: LEDGER_STATE.SUPERSEDED,
    Error: reasonTag + ': draft preserved; ' + (oldValues.Draft_Fingerprint
      ? 'content fingerprint changed from "' + oldValues.Draft_Fingerprint + '" to "' + verification.currentFingerprint + '".'
      : 'no baseline fingerprint existed (legacy row) — bootstrapped conservatively, not evidence it was ever unedited.')
  });
}

/**
 * F2 functionality — defined per the approved file list, NOT exercised or
 * activated during F1 (no LIVE claims exist yet; nothing calls this).
 * Finds CLAIMED (Mode=LIVE) rows older than CLAIM_STALE_MINUTES for
 * nightlyRecon's orphan-claim reconciliation.
 */
function findStaleLiveClaims_(config) {
  var staleMs = (config.CLAIM_STALE_MINUTES || 120) * 60 * 1000;
  var now = new Date().getTime();
  var rows = readAllLedgerRows_();
  return rows.filter(function (r) {
    var v = r.values;
    if (v.Mode !== LEDGER_MODE.LIVE || v.State !== LEDGER_STATE.CLAIMED) return false;
    var claimedAt = v.Claimed_At ? new Date(v.Claimed_At).getTime() : 0;
    return (now - claimedAt) >= staleMs;
  });
}
