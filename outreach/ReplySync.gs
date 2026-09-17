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

/** Fast hourly sweep: recently active labeled threads only. */
function syncReplies() {
  var config = getConfig();
  var now = new Date();
  if (!isWithinReplySyncWindow_(now, config)) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { logEvent_(LOG_LEVEL.WARN, LOG_EVENT.LOCK_BUSY, '', '', '', 'syncReplies'); flushLog_(); return; }

  try {
    var labelName = config.GMAIL_LABEL || DEFAULT_GMAIL_LABEL;
    var query = 'label:"' + labelName + '" ' + (config.FAST_SWEEP_QUERY_WINDOW || 'newer_than:3d');
    var threads = GmailApp.search(query);

    var rows = readAllProspects();
    var byThreadId = {};
    rows.forEach(function (r) { if (r.values.Thread_ID) byThreadId[r.values.Thread_ID] = r; });

    threads.forEach(function (thread) {
      var row = byThreadId[thread.getId()];
      if (!row) return;
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
