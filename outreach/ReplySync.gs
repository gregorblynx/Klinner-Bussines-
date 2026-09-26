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
 * Auto-unsubscribe, step 2 — intent detection. THE one canonical definition:
 * first replies, later messages from already-REPLIED prospects, and every
 * other caller go through detectUnsubscribeIntent_ — there is no second
 * detector.
 *
 * Deterministic phrase/pattern matching ONLY — no semantic/NLP guessing, and
 * only ever called on text already isolated by extractNewReplyText_.
 *
 * "stop" is the dangerous word: in commercial replies it is a movement verb
 * ("can you stop by tomorrow?", "stop in", "let's stop there first",
 * "don't stop the service"). It therefore counts as an opt-out ONLY in two
 * conservative forms, never as a bare substring:
 *   1. STANDALONE: an entire sentence/line that is just "stop" (optionally
 *      wrapped in please/pls/kindly/thanks) — "STOP", "Stop.", "Please stop.",
 *      "Not interested. Stop." — the industry-standard "reply STOP" reply.
 *   2. OPT-OUT CONTEXT: "stop" directly followed by a contact verb or
 *      contact object — "stop emailing me", "stop contacting us",
 *      "stop sending me emails", "stop all emails".
 * Everything else containing "stop" ("stop by", "stop in", "stopped",
 * "nonstop") is a normal reply. All other phrases are matched with word
 * boundaries against normalized text (lowercase, apostrophes stripped,
 * whitespace collapsed) so "don't" and "dont" are the same.
 */
var UNSUBSCRIBE_INTENT_PHRASES_ = [
  'unsubscribe',
  'remove me',
  'remove us',
  'remove me from your list',
  'do not contact me',
  'dont contact me',
  'do not contact us',
  'dont contact us',
  'do not email me',
  'dont email me',
  'do not email us',
  'dont email us',
  'take me off your list',
  'take me off the list',
  'take me off your mailing list',
  'take us off your list',
  'no more emails',
  'no more email'
];

var UNSUBSCRIBE_STOP_CONTEXT_PATTERNS_ = [
  /\bstop (emailing|e-mailing|mailing|contacting|messaging|texting|bothering|spamming)\b/,
  /\bstop (calling|sending) (me|us)\b/,
  /\bstop (all |sending )?(me |us )?(any )?(more |further )?(emails?|e-mails?|messages?|mail)\b/
];

function normalizeReplyTextForIntentMatch_(text) {
  return String(text || '')
    .replace(/[‘’']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** True if this sentence/line is nothing but "stop" (allowing please/thanks wrappers). */
function isStandaloneStopSentence_(sentence) {
  var s = String(sentence || '')
    .replace(/[‘’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^((please|pls|kindly|just) )+/, '').replace(/( (please|pls|thanks|thank you|now))+$/, '');
  return s === 'stop';
}

function detectUnsubscribeIntent_(newReplyText) {
  var raw = String(newReplyText || '');
  var normalized = normalizeReplyTextForIntentMatch_(raw);
  if (!normalized) return false;

  for (var i = 0; i < UNSUBSCRIBE_INTENT_PHRASES_.length; i++) {
    var re = new RegExp('\\b' + UNSUBSCRIBE_INTENT_PHRASES_[i] + '\\b');
    if (re.test(normalized)) return true;
  }
  for (var k = 0; k < UNSUBSCRIBE_STOP_CONTEXT_PATTERNS_.length; k++) {
    if (UNSUBSCRIBE_STOP_CONTEXT_PATTERNS_[k].test(normalized)) return true;
  }
  var sentences = raw.split(/[\r\n.!?;]+/);
  for (var j = 0; j < sentences.length; j++) {
    if (isStandaloneStopSentence_(sentences[j])) return true;
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
  // v1.0.2: an already-REPLIED prospect is still terminal for the state
  // machine (unchanged), but a NEW inbound message from them — or an alert
  // that failed earlier — is picked up by the notification-only pass.
  if (prospect.Replied === true && prospect.Status === STATUS.REPLIED) {
    notifyNewRepliesForRepliedProspect_(thread, prospect, config);
    unsubscribeRepliedProspectIfRequested_(thread, prospect, config);
    return;
  }
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
    // Canonical state is durably written above. The alert is strictly
    // best-effort AFTER it and never throws.
    sendProspectReplyAlert_(msg, prospect, config);
    return;
  }
}

/**
 * v1.0.2 — Prospect reply notification.
 *
 * Attached to the existing reply flow only; there is no second Gmail scan.
 * Alerted: a message the canonical classifier called a human REPLY, for a
 * real prospect, that is not an unsubscribe request (those keep their
 * existing STOPPED/suppression handling and are NOT announced as replies —
 * there is nothing for a human to follow up on). Never alerted: bounces,
 * auto-replies (separate branches), controlled fixtures, and mail from our
 * own sender/reply-to/admin/alert addresses.
 *
 * Idempotency is per inbound Gmail Message_ID, stored as a JSON array in
 * Script Property REPLY_ALERTED_<Prospect_ID> (capped at 50 ids). A later,
 * genuinely new message has a new id and alerts again; the same message can
 * never alert twice. Claim-before-send: the id is recorded BEFORE the email
 * and released only if the send throws, so a failed alert is retried on the
 * next sync (the REPLIED prospect is revisited by
 * notifyNewRepliesForRepliedProspect_ while the thread is inside the sweep
 * window) but a delivered one can never repeat.
 */
function getReplyAlertEmail_(config) {
  var v = String(config.REPLY_ALERT_EMAIL || '').trim();
  return v || DEFAULT_REPLY_ALERT_EMAIL;
}

function extractEmailAddress_(fromHeader) {
  var s = String(fromHeader || '');
  var m = /<([^<>]+)>/.exec(s);
  return normalizeEmail_(m ? m[1] : s);
}

function isReplyAlertEligible_(msg, prospect, config) {
  if (CONTROLLED_FIXTURE_SOURCES.indexOf(prospect.Source) !== -1) return false;
  var from = extractEmailAddress_(msg.getFrom());
  var internal = [config.SENDER_EMAIL, config.REPLY_TO, config.ADMIN_EMAIL, getReplyAlertEmail_(config)]
    .map(normalizeEmail_)
    .filter(function (a) { return a && a.indexOf('@') !== -1; });
  if (internal.indexOf(from) !== -1) return false;
  return true;
}

function readAlertedReplyIds_(prospectId) {
  var raw = PropertiesService.getScriptProperties().getProperty(REPLY_ALERT_PROPERTY_PREFIX + prospectId);
  if (raw === null || raw === undefined || raw === '') return [];
  var parsed = JSON.parse(raw); // A corrupt value throws -> caller fails closed (no alert).
  if (!Array.isArray(parsed)) throw new Error('alerted-id record is not an array');
  return parsed;
}

function writeAlertedReplyIds_(prospectId, ids) {
  PropertiesService.getScriptProperties().setProperty(
    REPLY_ALERT_PROPERTY_PREFIX + prospectId, JSON.stringify(ids.slice(-50)));
}

/** Never throws. Returns {alerted, reason} for tests/diagnostics. */
function sendProspectReplyAlert_(msg, prospect, config) {
  try {
    if (!isReplyAlertEligible_(msg, prospect, config)) return { alerted: false, reason: 'NOT_ELIGIBLE' };
    if (typeof msg.getId !== 'function' || !msg.getId()) return { alerted: false, reason: 'NO_MESSAGE_ID' };
    var messageId = String(msg.getId());

    var alerted = readAlertedReplyIds_(prospect.Prospect_ID);
    if (alerted.indexOf(messageId) !== -1) return { alerted: false, reason: 'ALREADY_ALERTED' };

    writeAlertedReplyIds_(prospect.Prospect_ID, alerted.concat([messageId])); // claim; a throw here means NO email.

    var recipient = getReplyAlertEmail_(config);
    try {
      var snippet = extractNewReplyText_(msg);
      if (snippet.length > 600) snippet = snippet.slice(0, 600) + '…';
      var when = (typeof msg.getDate === 'function' && msg.getDate()) ? msg.getDate() : new Date();
      var businessName = String(prospect.Business_Name || prospect.Email_Normalized || 'Unknown').replace(/[\r\n]+/g, ' ');
      MailApp.sendEmail({
        to: recipient,
        subject: 'Klinner Outreach — Prospect Replied: ' + businessName,
        body: [
          'A prospect replied to Klinner outreach. Human follow-up may be required.',
          '',
          'Business: ' + businessName,
          'Prospect email: ' + (prospect.Email_Normalized || prospect.Email || ''),
          'Outreach context: reply received after Step ' + (prospect.Sequence_Step || '?') + ' of the sequence',
          'Reply received: ' + formatAlertTimestamp_(new Date(when)),
          'Prospect_ID: ' + prospect.Prospect_ID,
          'Current status: ' + STATUS.REPLIED,
          '',
          'Reply:',
          snippet || '(no new text detected)'
        ].join('\n')
      });
    } catch (sendError) {
      try {
        writeAlertedReplyIds_(prospect.Prospect_ID, readAlertedReplyIds_(prospect.Prospect_ID)
          .filter(function (id) { return id !== messageId; })); // release the claim: retry next sync.
      } catch (releaseError) { /* alert lost rather than duplicated; logged below */ }
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.REPLY_ALERT_FAILED, prospect.Prospect_ID, prospect.Email_Normalized, '',
        'Reply alert email failed (reply itself is recorded). messageId=' + messageId + ' error=' + sendError);
      return { alerted: false, reason: 'SEND_FAILED' };
    }
    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.REPLY_ALERT_SENT, prospect.Prospect_ID, prospect.Email_Normalized, '',
      'Reply alert sent to ' + recipient + ' messageId=' + messageId);
    return { alerted: true, reason: 'SENT' };
  } catch (e) {
    try {
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.REPLY_ALERT_FAILED, prospect.Prospect_ID, prospect.Email_Normalized, '',
        'Reply alert error (reply itself is recorded): ' + e);
    } catch (logError) { /* nothing more to do */ }
    return { alerted: false, reason: 'ERROR' };
  }
}

/** Inbound (non-sender) messages after our last outbound one, oldest first. */
function inboundMessagesAfterLastSend_(thread, config) {
  var messages = thread.getMessages();
  var senderEmail = (config.SENDER_EMAIL || '').toLowerCase();
  var lastSentIndex = -1;
  for (var i = messages.length - 1; i >= 0; i--) {
    if ((messages[i].getFrom() || '').toLowerCase().indexOf(senderEmail) !== -1) { lastSentIndex = i; break; }
  }
  var inbound = [];
  for (var j = lastSentIndex + 1; j < messages.length; j++) {
    if ((messages[j].getFrom() || '').toLowerCase().indexOf(senderEmail) === -1) inbound.push(messages[j]);
  }
  return inbound;
}

/**
 * Post-REPLIED unsubscribe (v1.0.2 hardening). REPLIED is terminal for the
 * sequence, so the top guard in processThreadForReplies_ used to return
 * before a LATER "unsubscribe" in the same thread was ever inspected — the
 * prospect stayed REPLIED, unsuppressed, forever. This reuses the canonical
 * detection (classifyInboundMessage_ + extractNewReplyText_ +
 * detectUnsubscribeIntent_) and the canonical write path (the SAME
 * SYSTEM_AUTO_UNSUBSCRIBE marker write + applyUnsubscribeEffects_) used for
 * a first-response unsubscribe: Stop_Contact, Status=STOPPED, blank
 * Next_Action_Date, and one email-scope Suppression row. Replied and
 * Replied_At are outside that operation's permission grant, so the
 * historical reply record is preserved. Nothing restarts outreach.
 * Idempotent: once STOPPED the prospect is skipped by the top guard, and
 * applyUnsubscribeEffects_/addSuppression_ are themselves idempotent (a
 * stale re-run cannot add a second suppression row). A failure is logged and
 * left for the next hourly sync / nightly sweep; it never aborts the sweep.
 * @return {boolean} true if an unsubscribe was applied
 */
function unsubscribeRepliedProspectIfRequested_(thread, prospect, config) {
  try {
    var inbound = inboundMessagesAfterLastSend_(thread, config);
    for (var i = 0; i < inbound.length; i++) {
      if (classifyInboundMessage_(inbound[i]) !== 'REPLY') continue;
      if (!detectUnsubscribeIntent_(extractNewReplyText_(inbound[i]))) continue;
      writeRowById_(prospect.Prospect_ID, { Do_Not_Contact_Reason: DNC_REASON.UNSUBSCRIBE },
        { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_AUTO_UNSUBSCRIBE });
      applyUnsubscribeEffects_(prospect.Prospect_ID, ORIGIN.SYSTEM, OPERATION.SYSTEM_AUTO_UNSUBSCRIBE);
      return true;
    }
  } catch (e) {
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, prospect.Prospect_ID, prospect.Email_Normalized, '',
      'Post-REPLIED unsubscribe could not be applied (will retry next sync / nightly sweep): ' + e);
  }
  return false;
}

/**
 * Notification-only pass for a prospect that is already REPLIED. Changes NO
 * prospect state. Looks at inbound messages after our last outbound one,
 * skipping bounces, auto-replies and unsubscribe requests, and alerts on any
 * message id not yet alerted (a new follow-up reply, or a retry of a failed
 * alert). Never throws.
 */
function notifyNewRepliesForRepliedProspect_(thread, prospect, config) {
  try {
    var inbound = inboundMessagesAfterLastSend_(thread, config);
    for (var j = 0; j < inbound.length; j++) {
      var msg = inbound[j];
      if (classifyInboundMessage_(msg) !== 'REPLY') continue;
      if (detectUnsubscribeIntent_(extractNewReplyText_(msg))) continue;
      sendProspectReplyAlert_(msg, prospect, config);
    }
  } catch (e) {
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.REPLY_ALERT_FAILED, prospect.Prospect_ID, prospect.Email_Normalized, '',
      'Reply-alert pass error (no prospect state was touched): ' + e);
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
