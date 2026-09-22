/**
 * Klinner Outreach — Constants.gs
 * Single source of truth for sheet names, column layout, enums and
 * origin/operation write permissions. No other file may hardcode a
 * column index, sheet name, status string, or permission rule.
 *
 * Spec: ESPECIFICACION FINAL V1.1 + PATCH FINAL V1.1
 */

var SHEET_NAMES = {
  PROSPECTS: 'Prospects',
  CONFIG: 'Config',
  TEMPLATES: 'Templates',
  SEND_LEDGER: 'SendLedger',
  LOG: 'Log',
  SUPPRESSION: 'Suppression',
  DASHBOARD: 'Dashboard'
};

var PENDING_F0 = 'PENDING_F0';

/**
 * The five Config keys that must be resolved (not PENDING_F0) before
 * LIVE mode is allowed to run. Invariant I21.
 */
var PENDING_F0_REQUIRED_KEYS = [
  'SENDER_EMAIL',
  'REPLY_TO',
  'ADMIN_EMAIL',
  'PHYSICAL_ADDRESS',
  'UNSUBSCRIBE_LINE'
];

/**
 * Prospects sheet column layout — A:AG, 33 columns, 1-indexed.
 * This is the ONLY place column indices are defined.
 */
var PROSPECTS_COLUMNS = {
  Prospect_ID: 1,
  Date_Added: 2,
  Source: 3,
  Business_Name: 4,
  Contact_Name: 5,
  Email: 6,
  Email_Normalized: 7,
  Domain: 8,
  Domain_Type: 9,
  Website: 10,
  City: 11,
  State: 12,
  Problem_Found: 13,
  Personalization_Line: 14,
  Stop_Contact: 15,
  Do_Not_Contact_Reason: 16,
  Notes: 17,
  Outcome: 18,
  Status: 19,
  Sequence_Step: 20,
  Next_Action_Date: 21,
  Last_Contacted: 22,
  Step1_Sent_At: 23,
  Step2_Sent_At: 24,
  Step3_Sent_At: 25,
  Step4_Sent_At: 26,
  Replied: 27,
  Replied_At: 28,
  Thread_ID: 29,
  Last_Message_ID: 30,
  Error_Count: 31,
  Last_Error: 32,
  Last_Run_ID: 33
};

var PROSPECTS_COLUMN_ORDER = (function () {
  var names = [];
  for (var name in PROSPECTS_COLUMNS) {
    if (PROSPECTS_COLUMNS.hasOwnProperty(name)) names[PROSPECTS_COLUMNS[name] - 1] = name;
  }
  return names;
})();

var PROSPECTS_HEADER_ROW = PROSPECTS_COLUMN_ORDER.slice();

/**
 * Google-real finding: the columns a human actually types into when adding
 * a prospect (spec §2, "Bloque 2 — Datos del negocio, humano escribe D-N").
 * A row counts as a real prospect ONLY if at least one of these is
 * non-blank (or the row already has a Prospect_ID — see
 * isProspectRowSubstantive_ in SheetRepo.gs).
 *
 * Deliberately EXCLUDES Stop_Contact (O): applying checkbox data
 * validation to a range of blank cells makes real Google Sheets
 * auto-populate each one with a literal FALSE — including rows a human
 * never touched. Treating that auto-populated FALSE as "content" is
 * exactly what turned 994 blank template rows (7-1000) into phantom
 * NEEDS_DATA prospects the first time Validate all rows ran for real. It
 * also excludes Domain/Email_Normalized/Domain_Type (system-derived,
 * never present before a row is processed) and Status/Outcome/Notes
 * (control columns, not identifying input).
 */
var PROSPECT_SUBSTANTIVE_INPUT_COLUMNS = [
  'Business_Name', 'Contact_Name', 'Email', 'Website', 'City', 'State', 'Problem_Found', 'Personalization_Line'
];

/** First protected column (S). Columns S:AG are system-owned, protected range. */
var PROSPECTS_PROTECTED_RANGE_START_COL = PROSPECTS_COLUMNS.Status; // 19
var PROSPECTS_PROTECTED_RANGE_END_COL = PROSPECTS_COLUMNS.Last_Run_ID; // 33
var PROSPECTS_LAST_COL = PROSPECTS_COLUMNS.Last_Run_ID; // 33 = AG

var STEP_SENT_AT_COLUMNS = [
  PROSPECTS_COLUMNS.Step1_Sent_At,
  PROSPECTS_COLUMNS.Step2_Sent_At,
  PROSPECTS_COLUMNS.Step3_Sent_At,
  PROSPECTS_COLUMNS.Step4_Sent_At
];

/** Prospect status enum. 11 states. */
var STATUS = {
  NEW: 'NEW',
  NEEDS_DATA: 'NEEDS_DATA',
  INVALID_EMAIL: 'INVALID_EMAIL',
  DUPLICATE: 'DUPLICATE',
  READY: 'READY',
  IN_SEQUENCE: 'IN_SEQUENCE',
  SEQUENCE_DONE: 'SEQUENCE_DONE',
  REPLIED: 'REPLIED',
  BOUNCED: 'BOUNCED',
  STOPPED: 'STOPPED',
  NEEDS_REVIEW: 'NEEDS_REVIEW'
};

var TERMINAL_STATUSES = [
  STATUS.INVALID_EMAIL,
  STATUS.DUPLICATE,
  STATUS.SEQUENCE_DONE,
  STATUS.REPLIED,
  STATUS.BOUNCED,
  STATUS.STOPPED,
  STATUS.NEEDS_REVIEW
];

/** Do_Not_Contact_Reason controlled values. */
var DNC_REASON = {
  UNSUBSCRIBE: 'unsubscribe',
  NOT_INTERESTED: 'not interested',
  WRONG_PERSON: 'wrong person',
  BOUNCE: 'bounce',
  MANUAL: 'manual',
  DUPLICATE: 'duplicate'
};

var DNC_REASON_VALUES = [
  DNC_REASON.UNSUBSCRIBE,
  DNC_REASON.NOT_INTERESTED,
  DNC_REASON.WRONG_PERSON,
  DNC_REASON.BOUNCE,
  DNC_REASON.MANUAL,
  DNC_REASON.DUPLICATE
];

var OUTCOME_VALUES = ['', 'interested', 'not interested', 'meeting', 'client'];

/**
 * N8 (controlled-fixture LIVE targeting): the ONLY Source values
 * sendControlledFixtureLive (Mailer.gs) will act on. Deliberately a code
 * constant, not a Config sheet key — an operator-editable allowlist would
 * let a Sheet edit alone widen what this mechanism can touch, which
 * defeats its entire purpose (never usable on a real prospect). Extend
 * this list only for genuinely new controlled-test fixtures, never for a
 * production Source.
 */
var CONTROLLED_FIXTURE_SOURCES = [
  'CONTROLLED_INTERNAL_STEP2_RETEST'
];

/** The one Google-real Step-2 fixture allowed to recover from the documented pre-CLAIM scope failure. */
var CONTROLLED_STEP2_RECOVERY_PROSPECT_ID = 'cd55d881-113f-4949-850d-ecde913d83cb';

/**
 * The one already-sent Google-real Step-2 incident that may be reconciled
 * without another Gmail SEND. These immutable identifiers are deliberately
 * code constants: Sheet edits cannot widen this operator action to another
 * prospect, run, message, recipient, or thread.
 */
var CONTROLLED_STEP2_AMBIGUOUS_INCIDENT = {
  Prospect_ID: 'cd55d881-113f-4949-850d-ecde913d83cb',
  Source: 'CONTROLLED_INTERNAL_STEP2_RETEST',
  Run_ID: 'df1c0772-4e10-47bf-aa9d-366ee7828320',
  Step: 2,
  Email_Normalized: 'gregorsilvauber+step2fix@gmail.com',
  Sender_Email: 'jhessyca@klinnerpro.com',
  Thread_ID: '1a0a125e8dde9823',
  Prior_Message_ID: '1a0a125eb01e480c',
  Message_ID: '1a0a6999b8bf445f',
  Rfc_Message_ID: '<CABTxQ3he_jUOzq=SMJO6k7KdGi=bLdTeNvy7TaLMcKPXouKEew@mail.gmail.com>',
  Prior_Rfc_Message_ID: '<CABTxQ3j5XhXY6=++FAF6a3foFJ9+V2t=F59VJujUUByCCO4UNg@mail.gmail.com>'
};

/**
 * The one real, already-confirmed misdirected LIVE Step-2 send: Gmail
 * confirmed the message was delivered, but to a recipient other than the
 * one this prospect's own send attempt was claimed for (Acme Plumbing LLC,
 * 2026-09-11). Immutable identifiers, deliberately code constants — a Sheet
 * edit cannot widen this operator action to another prospect, run, message,
 * thread, or recipient. Prospect_ID/Thread_ID come from
 * N6_POST_LIVE_INCIDENT_REPORT.md (this prospect's earlier, unrelated,
 * already-reconciled Step-1 incident, same Thread_ID since Step 2 continues
 * the same Gmail thread); Run_ID/Message_ID/recipients come from the
 * Google-real evidence gathered for THIS incident's read-only audit.
 * Confirmed_At is the real Gmail send instant (2026-09-11 15:37:28
 * America/Chicago = CDT = UTC-5), stored as UTC so no local timezone
 * assumption is baked into the constant itself. Exact to the second —
 * corrected from an initial 20:37:00Z placeholder once the precise
 * Google-real Gmail timestamp (20:37:28Z) was confirmed; never round or
 * truncate this value.
 */
var ACME_MISDIRECTED_STEP2_INCIDENT = {
  Prospect_ID: '2f4d0c6c-ccd7-420b-8dd3-22c915a792f4',
  Run_ID: '53cab5cd-44c8-42cc-9199-f43f3d5f1390',
  Step: 2,
  Thread_ID: '1a08200c7ad4ac0d',
  Message_ID: '1a0923084e6c87f8',
  Expected_Recipient: 'info+testa@klinnercleaning.com',
  Actual_Recipient: 'jhessyca@klinnerpro.com',
  Confirmed_At: '2026-09-11T20:37:28Z'
};

/** SendLedger enums. */
var LEDGER_MODE = { LIVE: 'LIVE', DRY_RUN: 'DRY_RUN' };
/**
 * N5 (Codex final audit): AMBIGUOUS is the durable, non-retryable state for
 * a LIVE idempotency key after a Gmail operation that MAY have succeeded
 * (draft.send() or GmailThread.reply() threw, or returned in a way that
 * cannot be reliably confirmed) throws or returns an unverifiable outcome.
 * Unlike FAILED (an ordinary, safely-retryable transient failure — network
 * blip, quota hiccup — where we KNOW nothing was sent), AMBIGUOUS means we
 * cannot prove Gmail did NOT act. It is included in isLiveKeyBlocked_'s
 * check (Ledger.gs) alongside CLAIMED/SENT, so retry is blocked at the
 * ledger level — the one place that must hold regardless of whether a
 * secondary Prospects write (Status=NEEDS_REVIEW) succeeds or fails.
 * Never automatically transitioned away from AMBIGUOUS by any code path —
 * only a human, reconciling manually, may resolve it.
 */
var LEDGER_STATE = {
  CLAIMED: 'CLAIMED',
  SENT: 'SENT',
  DRAFTED: 'DRAFTED',
  SUPERSEDED: 'SUPERSEDED',
  FAILED: 'FAILED',
  // N5 (Codex final audit, round 2): no longer written by any code path —
  // reconcileStaleLiveClaims_ (Recon.gs) used to transition a zero-result
  // stale claim to ABANDONED, a state isLiveKeyBlocked_ does NOT block on,
  // which could authorize a genuine duplicate send if the original send
  // had actually succeeded but was simply invisible to that search. Kept
  // defined (not deleted) only so the enum remains a stable reference for
  // any historical row a value like this could already exist in.
  ABANDONED: 'ABANDONED',
  AMBIGUOUS: 'AMBIGUOUS',
  // N3 (Codex re-audit, final round — orphan drafts eliminated
  // structurally): the PREVIEW-side equivalents of LIVE's
  // CLAIMED/AMBIGUOUS. A durable PREVIEW_CLAIMED row is written AND
  // FLUSHED before GmailApp.createDraft() is ever called, mirroring
  // doStep1Send_'s claim-before-send ordering — so a draft can never
  // exist in Gmail without a durable ledger barrier for its idempotency
  // key. PREVIEW_AMBIGUOUS is where that claim lands when the outcome of
  // the Gmail side effect cannot be resolved (createDraft threw, or a
  // post-creation failure could not be compensated). BOTH block any
  // further preview attempt for the same key — see
  // isPreviewKeyBlockedState_/findActivePreviewRows_ (Ledger.gs).
  // Neither is ever auto-resolved: only an explicit ADMIN action clears
  // them (see the recovery notes in Mailer.gs's previewStep docstring).
  PREVIEW_CLAIMED: 'PREVIEW_CLAIMED',
  PREVIEW_AMBIGUOUS: 'PREVIEW_AMBIGUOUS',
  // ACME misdirected-incident reconciliation (V1.0.1 patch): a Gmail side
  // effect is CONFIRMED to have occurred — unlike FAILED, which means we
  // KNOW nothing was sent — but it reached a recipient OTHER than the one
  // this key's claim recorded as intended (Ledger.gs's Email_Normalized
  // column at CLAIM time). It must never read as SENT (no credit for
  // contacting the intended prospect) and must never be conflated with
  // AMBIGUOUS (an unresolved, still-maybe-nothing-happened outcome — this
  // is resolved; Gmail's action is proven, just proven wrong).
  // Deliberately excluded from isLiveKeyBlocked_'s CLAIMED/SENT/AMBIGUOUS
  // check (Ledger.gs) — non-blocking by omission, exactly like
  // SUPERSEDED/FAILED already are — so the key is free for a human-
  // authorized future send attempt, once one is explicitly decided
  // (a separate decision, out of scope for the reconciliation itself).
  // Written ONLY by reconcileMisdirectedLiveIncident_ (Recon.gs),
  // transitioning one exact, pinned AMBIGUOUS row in place — never
  // appended fresh, never auto-transitioned by any sweep or trigger.
  MISDIRECTED: 'MISDIRECTED'
};

/**
 * N3 V2 (Google-real reaudit, round 3 — durable human-edit protection):
 * three columns appended at the END of the layout (never inserted between
 * existing ones, so every pre-existing column index is untouched):
 *
 *   Draft_Fingerprint       SHA-256 hex digest over (recipient, subject,
 *                           canonical body) at the time this row's draft
 *                           content was last known-good — see
 *                           computeDraftFingerprint_ in Mailer.gs. Used to
 *                           detect ANY human edit (recipient, subject, or
 *                           body), independent of Message_ID.
 *   Human_Edit_Preserved    boolean. TRUE only on the ACTIVE row of a
 *                           draft that has been durably recognized as
 *                           human-edited. Once TRUE, resolveExistingPreviewDraft_
 *                           never re-evaluates content again for that key —
 *                           it short-circuits straight to preserving the
 *                           draft, every future run, until the Draft_ID
 *                           itself genuinely stops resolving in Gmail.
 *   Human_Edit_Detected_At  timestamp of the run that first detected the
 *                           edit and transitioned the row into the
 *                           preserved state. Blank on every other row.
 *
 * Appending (not inserting) means initializeSendLedgerSheet_'s existing
 * idempotency check (sheetHasExpectedHeader_ on cell A1 = 'Run_ID') still
 * correctly recognizes an already-initialized real sheet — see
 * repairSendLedgerColumns_ in SheetRepo.gs for the one-time, additive,
 * non-destructive migration a pre-existing real Sheet needs before this
 * fix's ledger writes will include these columns. NOT run against Google
 * as part of this delivery — see README.md.
 */
var SEND_LEDGER_COLUMNS = {
  Run_ID: 1,
  Claimed_At: 2,
  Prospect_ID: 3,
  Email_Normalized: 4,
  Step: 5,
  Idempotency_Key: 6,
  Mode: 7,
  State: 8,
  Thread_ID: 9,
  Message_ID: 10,
  Draft_ID: 11,
  Confirmed_At: 12,
  Error: 13,
  Draft_Fingerprint: 14,
  Human_Edit_Preserved: 15,
  Human_Edit_Detected_At: 16
};
var SEND_LEDGER_COLUMN_ORDER = (function () {
  var names = [];
  for (var name in SEND_LEDGER_COLUMNS) {
    if (SEND_LEDGER_COLUMNS.hasOwnProperty(name)) names[SEND_LEDGER_COLUMNS[name] - 1] = name;
  }
  return names;
})();

/** Log sheet columns. */
var LOG_COLUMNS = {
  Timestamp: 1,
  Run_ID: 2,
  Mode: 3,
  Level: 4,
  Event: 5,
  Prospect_ID: 6,
  Email: 7,
  Step: 8,
  Detail: 9
};
var LOG_COLUMN_ORDER = (function () {
  var names = [];
  for (var name in LOG_COLUMNS) {
    if (LOG_COLUMNS.hasOwnProperty(name)) names[LOG_COLUMNS[name] - 1] = name;
  }
  return names;
})();

var LOG_LEVEL = { INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' };

var LOG_EVENT = {
  RUN_START: 'RUN_START',
  RUN_END: 'RUN_END',
  CLAIM: 'CLAIM',
  SENT: 'SENT',
  DRAFTED: 'DRAFTED',
  DRAFT_SUPERSEDED: 'DRAFT_SUPERSEDED',
  SKIP: 'SKIP',
  REPLY: 'REPLY',
  BOUNCE: 'BOUNCE',
  AUTOREPLY: 'AUTOREPLY',
  VALIDATE: 'VALIDATE',
  RESET: 'RESET',
  RESET_REFUSED: 'RESET_REFUSED',
  STOP: 'STOP',
  DNC_SYNC: 'DNC_SYNC',
  UNSUBSCRIBE: 'UNSUBSCRIBE',
  SUPPRESS: 'SUPPRESS',
  ERROR: 'ERROR',
  QUOTA_ABORT: 'QUOTA_ABORT',
  LOCK_BUSY: 'LOCK_BUSY',
  LIVE_BLOCKED_PENDING_F0: 'LIVE_BLOCKED_PENDING_F0',
  WRITE_REFUSED_DRY_RUN: 'WRITE_REFUSED_DRY_RUN',
  DIGEST_NOT_SENT_PENDING_F0: 'DIGEST_NOT_SENT_PENDING_F0',
  DIGEST_SENT: 'DIGEST_SENT',
  FIXTURE_DUE_OVERRIDE: 'FIXTURE_DUE_OVERRIDE',
  FIXTURE_STEP2_RECOVERY: 'FIXTURE_STEP2_RECOVERY',
  FIXTURE_STEP2_AMBIGUOUS_RECONCILED: 'FIXTURE_STEP2_AMBIGUOUS_RECONCILED',
  LIVE_MISDIRECTED_RECONCILED: 'LIVE_MISDIRECTED_RECONCILED'
};

/** Suppression sheet columns. */
var SUPPRESSION_COLUMNS = {
  Value: 1,
  Scope: 2,
  Reason: 3,
  Date_Added: 4,
  Added_By: 5
};
var SUPPRESSION_SCOPE = { EMAIL: 'email', DOMAIN: 'domain' };

/** Templates sheet columns. */
var TEMPLATES_COLUMNS = {
  Step: 1,
  Subject: 2,
  Body: 3,
  Active: 4,
  Internal_Note: 5
};

/**
 * Write-origin model (PATCH FINAL V1.1 — Patch 1).
 * Every write to Prospects must declare an ORIGIN and an OPERATION.
 * PIPELINE writes are rejected outright while DRY_RUN=TRUE (I14).
 * ADMIN and SYSTEM writes are never blocked by DRY_RUN.
 */
var ORIGIN = {
  PIPELINE: 'PIPELINE',
  ADMIN: 'ADMIN',
  SYSTEM: 'SYSTEM'
};

var OPERATION = {
  PIPELINE_SEND: 'PIPELINE_SEND', // sendBatch / previewStep — origin PIPELINE
  ADMIN_VALIDATE: 'ADMIN_VALIDATE', // Validate all rows
  ADMIN_STOP: 'ADMIN_STOP', // Stop prospect
  ADMIN_UNSUBSCRIBE: 'ADMIN_UNSUBSCRIBE', // Process unsubscribe
  ADMIN_RESET: 'ADMIN_RESET', // Reset prospect
  SYSTEM_REPLY_SYNC: 'SYSTEM_REPLY_SYNC', // syncReplies
  SYSTEM_NIGHTLY_RECON: 'SYSTEM_NIGHTLY_RECON', // nightlyRecon
  SYSTEM_AUTO_UNSUBSCRIBE: 'SYSTEM_AUTO_UNSUBSCRIBE', // processThreadForReplies_ — auto-detected unsubscribe intent ONLY
  ADMIN_FIXTURE_DUE_OVERRIDE: 'ADMIN_FIXTURE_DUE_OVERRIDE', // makeControlledFixtureDueNow — controlled fixtures ONLY
  ADMIN_FIXTURE_STEP2_PRE_SEND_RECOVERY: 'ADMIN_FIXTURE_STEP2_PRE_SEND_RECOVERY', // one exact controlled fixture only
  ADMIN_FIXTURE_STEP2_AMBIGUOUS_RECONCILIATION: 'ADMIN_FIXTURE_STEP2_AMBIGUOUS_RECONCILIATION' // one exact already-sent incident only
};

var OPERATION_ORIGIN = {};
OPERATION_ORIGIN[OPERATION.PIPELINE_SEND] = ORIGIN.PIPELINE;
OPERATION_ORIGIN[OPERATION.ADMIN_VALIDATE] = ORIGIN.ADMIN;
OPERATION_ORIGIN[OPERATION.ADMIN_STOP] = ORIGIN.ADMIN;
OPERATION_ORIGIN[OPERATION.ADMIN_UNSUBSCRIBE] = ORIGIN.ADMIN;
OPERATION_ORIGIN[OPERATION.ADMIN_RESET] = ORIGIN.ADMIN;
OPERATION_ORIGIN[OPERATION.SYSTEM_REPLY_SYNC] = ORIGIN.SYSTEM;
OPERATION_ORIGIN[OPERATION.SYSTEM_NIGHTLY_RECON] = ORIGIN.SYSTEM;
OPERATION_ORIGIN[OPERATION.SYSTEM_AUTO_UNSUBSCRIBE] = ORIGIN.SYSTEM;
OPERATION_ORIGIN[OPERATION.ADMIN_FIXTURE_DUE_OVERRIDE] = ORIGIN.ADMIN;
OPERATION_ORIGIN[OPERATION.ADMIN_FIXTURE_STEP2_PRE_SEND_RECOVERY] = ORIGIN.ADMIN;
OPERATION_ORIGIN[OPERATION.ADMIN_FIXTURE_STEP2_AMBIGUOUS_RECONCILIATION] = ORIGIN.ADMIN;

/**
 * Per-operation permitted columns and permitted Status values.
 * A write outside this list is rejected (defense beyond I14 alone).
 */
var OPERATION_PERMISSIONS = {};

OPERATION_PERMISSIONS[OPERATION.PIPELINE_SEND] = {
  columns: [
    'Status', 'Sequence_Step', 'Next_Action_Date', 'Last_Contacted',
    'Step1_Sent_At', 'Step2_Sent_At', 'Step3_Sent_At', 'Step4_Sent_At',
    'Thread_ID', 'Last_Message_ID', 'Error_Count', 'Last_Error', 'Last_Run_ID'
  ],
  statuses: [STATUS.IN_SEQUENCE, STATUS.SEQUENCE_DONE, STATUS.NEEDS_REVIEW]
};

OPERATION_PERMISSIONS[OPERATION.ADMIN_VALIDATE] = {
  columns: [
    'Prospect_ID', 'Date_Added', 'Email_Normalized', 'Domain', 'Domain_Type',
    'Status', 'Do_Not_Contact_Reason'
  ],
  // STATUS.STOPPED covers the ALLOW_PUBLIC_DOMAIN_PROSPECTS=FALSE policy
  // exclusion (Codex finding #13) — a validation-time terminal outcome,
  // distinct from a human-initiated Stop.
  statuses: [STATUS.READY, STATUS.NEEDS_DATA, STATUS.INVALID_EMAIL, STATUS.DUPLICATE, STATUS.STOPPED],
  // Do_Not_Contact_Reason may ONLY be set to 'duplicate' by this operation —
  // "unsubscribe" specifically must never be reachable from Validate
  // (Codex finding #2). Verified identically whether the row is a fresh
  // identity assignment or an existing-row update (PATCH FINAL V1.1 /
  // Codex #1's shared authorizeWrite_ in SheetRepo.gs).
  restrictedValues: { Do_Not_Contact_Reason: [DNC_REASON.DUPLICATE] }
};

OPERATION_PERMISSIONS[OPERATION.ADMIN_STOP] = {
  columns: ['Stop_Contact', 'Do_Not_Contact_Reason', 'Status', 'Next_Action_Date'],
  statuses: [STATUS.STOPPED],
  // Codex finding #3: "unsubscribe" must be structurally unreachable via a
  // plain Stop — it carries a Suppression guarantee that ADMIN_STOP alone
  // does not provide. stopProspect() special-cases reason="unsubscribe"
  // and routes it through OPERATION.ADMIN_UNSUBSCRIBE + the shared
  // applyUnsubscribeEffects_ procedure instead (StateMachine.gs).
  restrictedValues: {
    Do_Not_Contact_Reason: DNC_REASON_VALUES.filter(function (r) { return r !== DNC_REASON.UNSUBSCRIBE; })
  }
};

OPERATION_PERMISSIONS[OPERATION.ADMIN_UNSUBSCRIBE] = {
  columns: ['Stop_Contact', 'Do_Not_Contact_Reason', 'Status', 'Next_Action_Date'],
  statuses: [STATUS.STOPPED],
  restrictedValues: { Do_Not_Contact_Reason: [DNC_REASON.UNSUBSCRIBE] }
};

OPERATION_PERMISSIONS[OPERATION.ADMIN_RESET] = {
  columns: [
    'Status', 'Sequence_Step', 'Next_Action_Date',
    'Step1_Sent_At', 'Step2_Sent_At', 'Step3_Sent_At', 'Step4_Sent_At',
    'Replied', 'Replied_At', 'Thread_ID', 'Last_Message_ID',
    'Error_Count', 'Last_Error'
  ],
  statuses: [STATUS.READY]
};

// ============================================================================
// N4 — CLOSED. Was: BLOCKER BEFORE F3 (reaudit finding). Both operations
// below now carry the SAME `restrictedValues` pattern ADMIN_VALIDATE/
// ADMIN_STOP already had (Codex #2/#3): structurally forbidden from ever
// setting DNC="unsubscribe" — any future write path (F3 or otherwise) that
// tries to set Do_Not_Contact_Reason="unsubscribe" through either
// SYSTEM_REPLY_SYNC or SYSTEM_NIGHTLY_RECON is rejected outright by
// authorizeWrite_ (SheetRepo.gs), the same generic enforcement that already
// protected ADMIN_VALIDATE/ADMIN_STOP — no new enforcement code needed,
// only closing this permission-list gap.
//
// No CURRENT code path wrote "unsubscribe" through either operation before
// this fix either (ReplySync.gs's BOUNCE/REPLY/manual-stop writes and
// Recon.gs's DNC-sync write only "bounce"/"manual" or leave the column
// untouched — verified by `grep -n "Do_Not_Contact_Reason" ReplySync.gs
// Recon.gs`), so this closes a LATENT gap, not an active bug — but it is
// now closed structurally rather than merely documented, so a future
// SYSTEM-origin write path can never reach DNC="unsubscribe" without the
// Suppression guarantee applyUnsubscribeEffects_() provides, even if
// whoever adds it forgets this comment exists.
// ============================================================================
OPERATION_PERMISSIONS[OPERATION.SYSTEM_REPLY_SYNC] = {
  columns: ['Stop_Contact', 'Do_Not_Contact_Reason', 'Status', 'Next_Action_Date', 'Replied', 'Replied_At'],
  statuses: [STATUS.REPLIED, STATUS.BOUNCED, STATUS.STOPPED],
  restrictedValues: {
    Do_Not_Contact_Reason: DNC_REASON_VALUES.filter(function (r) { return r !== DNC_REASON.UNSUBSCRIBE; })
  }
};

OPERATION_PERMISSIONS[OPERATION.SYSTEM_NIGHTLY_RECON] = {
  columns: ['Stop_Contact', 'Do_Not_Contact_Reason', 'Status', 'Sequence_Step', 'Next_Action_Date', 'Error_Count', 'Last_Error'],
  restrictedValues: {
    Do_Not_Contact_Reason: DNC_REASON_VALUES.filter(function (r) { return r !== DNC_REASON.UNSUBSCRIBE; })
  },
  statuses: [STATUS.STOPPED, STATUS.SEQUENCE_DONE, STATUS.NEEDS_REVIEW]
};

/**
 * Automatic unsubscribe (inbound reply). Deliberately NOT a broadening of
 * SYSTEM_REPLY_SYNC or SYSTEM_NIGHTLY_RECON — both remain structurally
 * forbidden from writing DNC="unsubscribe" (see the N4 block above). This
 * is instead its own narrowly-scoped operation, modeled EXACTLY on
 * ADMIN_UNSUBSCRIBE's shape (same columns, same statuses, same
 * restrictedValues), so its permission grant is provably no wider than the
 * already-proven manual unsubscribe path — the only difference is origin.
 * The sole caller is processThreadForReplies_ (ReplySync.gs), and only
 * after detectUnsubscribeIntent_ matches text already isolated by
 * extractNewReplyText_ — never on raw/quoted body content.
 */
OPERATION_PERMISSIONS[OPERATION.SYSTEM_AUTO_UNSUBSCRIBE] = {
  columns: ['Stop_Contact', 'Do_Not_Contact_Reason', 'Status', 'Next_Action_Date'],
  statuses: [STATUS.STOPPED],
  restrictedValues: { Do_Not_Contact_Reason: [DNC_REASON.UNSUBSCRIBE] }
};

/**
 * N9 (controlled-fixture Step-2 due override): the SMALLEST possible
 * permission grant in this whole model — exactly ONE column, ZERO
 * permitted Status values. `statuses: []` is not an oversight: it means
 * authorizeWrite_ would reject this operation outright if it ever tried
 * to include Status in its write (see authorizeWrite_'s
 * `fields.hasOwnProperty('Status')` check, SheetRepo.gs) — so "this
 * operation may change ONLY Next_Action_Date" is enforced structurally,
 * not merely by the caller's own discipline. makeControlledFixtureDueNow
 * (StateMachine.gs) is the only caller, and it is itself gated to
 * CONTROLLED_FIXTURE_SOURCES rows only (Mailer.gs's sendControlledFixtureLive
 * uses the same allowlist for the equivalent LIVE-targeting guard).
 */
OPERATION_PERMISSIONS[OPERATION.ADMIN_FIXTURE_DUE_OVERRIDE] = {
  columns: ['Next_Action_Date'],
  statuses: []
};

/** Recovery may only restore the pre-send lifecycle state; history is immutable. */
OPERATION_PERMISSIONS[OPERATION.ADMIN_FIXTURE_STEP2_PRE_SEND_RECOVERY] = {
  columns: ['Status'],
  statuses: [STATUS.IN_SEQUENCE]
};

/** Exact fields a verified, already-sent controlled Step-2 may persist. */
OPERATION_PERMISSIONS[OPERATION.ADMIN_FIXTURE_STEP2_AMBIGUOUS_RECONCILIATION] = {
  columns: ['Status', 'Sequence_Step', 'Next_Action_Date', 'Last_Contacted', 'Step2_Sent_At', 'Last_Message_ID'],
  statuses: [STATUS.IN_SEQUENCE, STATUS.SEQUENCE_DONE]
};

/** Gmail labels — defaults only; runtime values come from Config. */
var DEFAULT_GMAIL_LABEL = 'KLINNER/Outreach';
var DEFAULT_GMAIL_STOP_LABEL = 'KLINNER/Stop';

/** Preview (DRY_RUN) draft banner — prepended to every preview draft body. */
var PREVIEW_BANNER = '--- KLINNER OUTREACH PREVIEW — DO NOT SEND ---';
var PREVIEW_SUBJECT_PREFIX_TEMPLATE = '[KLINNER PREVIEW · Step {STEP}] ';

/** Default PUBLIC_EMAIL_DOMAINS seed list (spec section 2.4). */
var DEFAULT_PUBLIC_EMAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'gmx.com',
  'mail.com', 'zoho.com', 'comcast.net', 'sbcglobal.net', 'att.net', 'verizon.net',
  'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net', 'juno.com',
  'optonline.net', 'roadrunner.com', 'rr.com', 'windstream.net', 'frontier.com'
].join(',');

/** Default HOLIDAYS seed list (America/Chicago, spec section 5). */
var DEFAULT_HOLIDAYS = [
  '2026-01-01', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-11-26', '2026-11-27', '2026-12-24', '2026-12-25', '2026-12-31', '2027-01-01'
].join(',');

var DOMAIN_TYPE = { CORPORATE: 'corporate', PUBLIC: 'public' };
