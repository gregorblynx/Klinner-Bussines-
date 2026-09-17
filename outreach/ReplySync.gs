/**
 * Klinner Outreach — ReplySync.gs
 * Reply/bounce/autoreply detection. F3 functionality per the approved file
 * list — defined in full here but NOT wired to any trigger in this F1
 * delivery (no automatic execution). Requires a real Gmail mailbox with
 * live LIVE-sent threads to exercise meaningfully (tests T9–T11 are
 * "B" — require Google real; see final report).
 *
 * Deliberately does NOT call GmailMessage.getHeader(name) — that method is
 * not a documented, guaranteed part of the Apps Script GmailApp service.
 * Header inspection instead parses getRawContent() directly (§8.2).
 */

var AUTOREPLY_SUBJECT_REGEX = /^\s*(re:\s*)?(out of office|automatic reply|auto:|autoreply|automatische)/i;

/** Parses the raw header block of an RFC 5322 message (folded lines supported). */
function parseRawHeaders_(rawContent) {
  var headerBlockEnd = rawContent.indexOf('\r\n\r\n');
  var altEnd = rawContent.indexOf('\n\n');
  var end = headerBlockEnd !== -1 ? headerBlockEnd : altEnd;
  var block = end !== -1 ? rawContent.substring(0, end) : rawContent;
  var lines = block.split(/\r\n|\n/);

  var headers = {};
  var currentName = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^[ \t]/.test(line) && currentName) {
      headers[currentName] += ' ' + line.trim();
      continue;
    }
    var colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    var name = line.substring(0, colonIdx).trim().toLowerCase();
    var value = line.substring(colonIdx + 1).trim();
    headers[name] = headers.hasOwnProperty(name) ? headers[name] + ', ' + value : value;
    currentName = name;
  }
  return headers;
}

function isAutoreplyByHeaders_(headers) {
  if (headers['auto-submitted'] && headers['auto-submitted'].toLowerCase() !== 'no') return true;
  if (headers['x-autoreply'] || headers['x-autorespond']) return true;
  var precedence = (headers['precedence'] || '').toLowerCase();
  if (precedence === 'bulk' || precedence === 'auto_reply' || precedence === 'junk') return true;
  return false;
}

function isBounceSender_(fromAddress) {
  var f = (fromAddress || '').toLowerCase();
  return f.indexOf('mailer-daemon') !== -1 || f.indexOf('postmaster') !== -1;
}

/**
 * Auto-unsubscribe, step 1 — body isolation.
 *
 * The Klinner outbound footer itself contains the literal instruction
 * 'reply "unsubscribe" and we'll remove you from future outreach.' Gmail's
 * default top-posting client quotes the ENTIRE prior message — footer
 * included — below any reply. Matching against the full body would
 * therefore self-trigger on every quoted reply in the thread, forever.
 * This function returns ONLY the new, human-authored text above the first
 * quote boundary — matching against anything else is unsafe.
 *
 * Two boundary markers are recognized, whichever occurs first:
 *   - Gmail's own "On <date>, <sender> wrote:" quote header line.
 *   - A classic plain-text quoted line beginning with '>'.
 * Both are standard, client-inserted quoting conventions — this does not
 * attempt to parse arbitrary forwarded-message banners or signatures, only
 * the two forms Gmail itself produces when quoting a prior message.
 */
function extractNewReplyText_(message) {
  var body = message.getPlainBody ? message.getPlainBody() : message.getBody();
  body = String(body || '');

  var cutIndex = body.length;

  var quoteHeaderMatch = /^On .+ wrote:\s*$/m.exec(body);
  if (quoteHeaderMatch && quoteHeaderMatch.index < cutIndex) cutIndex = quoteHeaderMatch.index;

  var quotedLineMatch = /^>/m.exec(body);
  if (quotedLineMatch && quotedLineMatch.index < cutIndex) cutIndex = quotedLineMatch.index;

  return body.slice(0, cutIndex).trim();
}

/**
 * Auto-unsubscribe, step 2 — intent detection.
 *
 * Deterministic phrase matching ONLY — no substring search across
 * unbounded text, no semantic/NLP guessing. Each phrase is matched with
 * word boundaries (`\b`) against normalized text, so 'stop' matches a
 * bare "Stop." but never matches inside "stopped by" or "nonstop" — this
 * matters because a short, common word like 'stop' would otherwise false-
 * positive on completely ordinary replies. The trade-off is intentional
 * and matches the industry-standard "reply STOP to unsubscribe"
 * convention: a bare, whole-word "stop" is treated as opt-out intent.
 *
 * Normalization: lowercase, apostrophes/curly-quotes stripped (so "don't"
 * and "dont" match the same phrase), repeated whitespace collapsed. This
 * is intentionally NOT called on the raw message body — the caller must
 * pass text already isolated by extractNewReplyText_.
 */
var UNSUBSCRIBE_INTENT_PHRASES_ = [
  'unsubscribe',
  'stop',
  'stop emailing me',
  'remove me',
  'remove me from your list',
  'do not contact me',
  'dont contact me'
];

function normalizeReplyTextForIntentMatch_(text) {
  return String(text || '')
    .replace(/[‘’']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function detectUnsubscribeIntent_(newReplyText) {
  var normalized = normalizeReplyTextForIntentMatch_(newReplyText);
  if (!normalized) return false;
  for (var i = 0; i < UNSUBSCRIBE_INTENT_PHRASES_.length; i++) {
    var re = new RegExp('\\b' + UNSUBSCRIBE_INTENT_PHRASES_[i] + '\\b');
    if (re.test(normalized)) return true;
  }
  return false;
}

/**
 * Classifies one inbound Gmail message relative to our own sends.
 * Cheap checks (sender, subject regex) run first; getRawContent() —
 * expensive — is only called for messages that survive the cheap filter.
 * @return {'BOUNCE'|'AUTOREPLY'|'REPLY'}
 */
function classifyInboundMessage_(message) {
  var from = message.getFrom();
  if (isBounceSender_(from)) return 'BOUNCE';

  var subject = message.getSubject() || '';
  if (AUTOREPLY_SUBJECT_REGEX.test(subject)) return 'AUTOREPLY';

  try {
    var headers = parseRawHeaders_(message.getRawContent());
    if (isAutoreplyByHeaders_(headers)) return 'AUTOREPLY';
  } catch (e) {
    logEvent_(LOG_LEVEL.WARN, LOG_EVENT.ERROR, '', '', '', 'parseRawHeaders_ failed: ' + e);
  }

  return 'REPLY';
}

/**
 * N14 (Google-real discovery failure — controlled Thread_ID
 * 1a0a125e8dde9823): parses the days component out of a 'newer_than:<N>d'
 * Config fragment into a millisecond window, computed here in JS rather
 * than left to a Gmail query operator. See syncReplies()'s docstring for
 * why label and recency can no longer be combined in a single search.
 * Falls back to 3 days if unparseable, so an operator typo in
 * FAST_SWEEP_QUERY_WINDOW never silently disables the recency filter
 * (never silently WIDENS it either — an unparseable value could otherwise
 * be read as "no limit").
 */
function parseNewerThanWindowMs_(queryFragment) {
  var match = /newer_than:(\d+)d/.exec(String(queryFragment || ''));
  var days = match ? Number(match[1]) : 3;
  if (!isFinite(days) || days <= 0) days = 3;
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Fast hourly sweep: recently active labeled threads only.
 *
 * N14 root cause (Google-real evidence, controlled Thread_ID
 * 1a0a125e8dde9823): the query used to be a single combined
 * `label:"X" newer_than:3d`. Gmail's search evaluates a query like that as
 * a per-MESSAGE conjunction — a thread matches only if ONE message
 * satisfies BOTH clauses together. `applyOutreachLabel_` (Mailer.gs) calls
 * `GmailThread.addLabel()`, which — per observed real Gmail behavior —
 * marks only the messages that existed in the thread at the moment it was
 * called; it does NOT retroactively apply to messages that arrive in the
 * thread later. So the label lives only on the original OUTBOUND
 * message(s), and once those age past the recency window, NO message in
 * the thread is simultaneously labeled AND recent — not even a brand-new
 * INBOUND reply, which was never labeled at all. The combined query then
 * correctly, silently returns zero, even though the thread (found by
 * `label:"X"` alone) and the reply (found by a recency-only search) both
 * genuinely exist. Confirmed directly: `label:"KLINNER/Outreach"` alone
 * finds the thread; the combined query does not.
 *
 * Fix: decouple the two conditions. `label:"X"` alone (Part 2, architecture
 * B) scopes the search to exactly the threads Klinner itself labeled —
 * this still touches no unrelated Gmail, and does not depend on the
 * inbound reply inheriting anything. Recency is then checked in code via
 * `GmailThread.getLastMessageDate()` against each already-known-relevant
 * thread — semantically identical to "does this thread have a message
 * newer than the window", cheaper than iterating every message, and
 * immune to the query-conjunction bug because it is not a Gmail query
 * term at all. `byThreadId` remains the sole authorization boundary
 * before any Prospects/Suppression write: an unrecognized Gmail thread —
 * label or no label — is never touched.
 */
function syncReplies() {
  var config = getConfig();
  var now = new Date();
  if (!isWithinReplySyncWindow_(now, config)) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { logEvent_(LOG_LEVEL.WARN, LOG_EVENT.LOCK_BUSY, '', '', '', 'syncReplies'); flushLog_(); return; }

  try {
    var labelName = config.GMAIL_LABEL || DEFAULT_GMAIL_LABEL;
    var query = 'label:"' + labelName + '"';
    var threads = GmailApp.search(query);

    var rows = readAllProspects();
    var byThreadId = {};
    rows.forEach(function (r) { if (r.values.Thread_ID) byThreadId[r.values.Thread_ID] = r; });

    var recencyCutoffMs = now.getTime() - parseNewerThanWindowMs_(config.FAST_SWEEP_QUERY_WINDOW);

    threads.forEach(function (thread) {
      var row = byThreadId[thread.getId()];
      if (!row) return; // Unknown Gmail thread — never touched, label or no label.
      if (thread.getLastMessageDate().getTime() < recencyCutoffMs) return; // No recent activity — skip, cheaply.
      processThreadForReplies_(thread, row.values, config);
    });

    checkStopLabel_(threads, byThreadId, config);
  } finally {
    flushLog_();
    lock.releaseLock();
  }
}

function processThreadForReplies_(thread, prospect, config) {
  if (prospect.Replied === true || prospect.Status === STATUS.BOUNCED || prospect.Status === STATUS.STOPPED) return;

  var messages = thread.getMessages();
  var senderEmail = (config.SENDER_EMAIL || '').toLowerCase();
  var lastSentIndex = -1;
  for (var i = messages.length - 1; i >= 0; i--) {
    if ((messages[i].getFrom() || '').toLowerCase().indexOf(senderEmail) !== -1) { lastSentIndex = i; break; }
  }

  for (var j = lastSentIndex + 1; j < messages.length; j++) {
    var msg = messages[j];
    if ((msg.getFrom() || '').toLowerCase().indexOf(senderEmail) !== -1) continue;
    var classification = classifyInboundMessage_(msg);

    if (classification === 'BOUNCE') {
      writeRowById_(prospect.Prospect_ID, { Status: STATUS.BOUNCED, Do_Not_Contact_Reason: DNC_REASON.BOUNCE, Next_Action_Date: '' },
        { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_REPLY_SYNC });
      addSuppression_(prospect.Email_Normalized, SUPPRESSION_SCOPE.EMAIL, DNC_REASON.BOUNCE, 'system');
      logEvent_(LOG_LEVEL.INFO, LOG_EVENT.BOUNCE, prospect.Prospect_ID, prospect.Email_Normalized, '', '');
      return;
    }
    if (classification === 'AUTOREPLY') {
      var pushedDate = addBusinessDays_(new Date(), 3, config.HOLIDAYS || []);
      writeRowById_(prospect.Prospect_ID, { Next_Action_Date: pushedDate },
        { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_REPLY_SYNC });
      logEvent_(LOG_LEVEL.INFO, LOG_EVENT.AUTOREPLY, prospect.Prospect_ID, prospect.Email_Normalized, '', '');
      continue;
    }
    // REPLY — human response. Check unsubscribe intent on the ISOLATED new
    // reply text (never the full/quoted body — see extractNewReplyText_)
    // BEFORE the generic terminal write below: STOPPED must supersede
    // REPLIED for an unsubscribe request, and the generic REPLIED write
    // must never happen for it.
    var newReplyText = extractNewReplyText_(msg);
    if (detectUnsubscribeIntent_(newReplyText)) {
      writeRowById_(prospect.Prospect_ID, { Do_Not_Contact_Reason: DNC_REASON.UNSUBSCRIBE },
        { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_AUTO_UNSUBSCRIBE });
      applyUnsubscribeEffects_(prospect.Prospect_ID, ORIGIN.SYSTEM, OPERATION.SYSTEM_AUTO_UNSUBSCRIBE);
      return;
    }

    // Ordinary human reply. Terminal; stop the sequence.
    writeRowById_(prospect.Prospect_ID, { Status: STATUS.REPLIED, Replied: true, Replied_At: new Date(), Next_Action_Date: '' },
      { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_REPLY_SYNC });
    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.REPLY, prospect.Prospect_ID, prospect.Email_Normalized, '', '');
    return;
  }
}

/** Manual escape hatch: a KLINNER/Stop label applied to a thread from the operator's phone. */
function checkStopLabel_(threads, byThreadId, config) {
  var stopLabelName = config.GMAIL_STOP_LABEL || DEFAULT_GMAIL_STOP_LABEL;
  var stopLabel = GmailApp.getUserLabelByName(stopLabelName);
  if (!stopLabel) return;

  threads.forEach(function (thread) {
    var labels = thread.getLabels().map(function (l) { return l.getName(); });
    if (labels.indexOf(stopLabelName) === -1) return;
    var row = byThreadId[thread.getId()];
    if (!row || row.values.Status === STATUS.STOPPED) return;
    writeRowById_(row.values.Prospect_ID, {
      Stop_Contact: true, Do_Not_Contact_Reason: DNC_REASON.MANUAL, Status: STATUS.STOPPED, Next_Action_Date: ''
    }, { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_REPLY_SYNC });
    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.STOP, row.values.Prospect_ID, row.values.Email_Normalized, '', 'via ' + stopLabelName + ' label');
  });
}
