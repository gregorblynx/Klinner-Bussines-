/**
 * Klinner Outreach — Digest.gs
 * "Klinner Outreach — Daily Digest". Always computes the full summary.
 * PATCH FINAL V1.1 (Patch 2 / I22): if ADMIN_EMAIL still contains
 * PENDING_F0, the digest is computed and logged but NEVER sent — and that
 * is not an error. This check is independent of I21 (which still blocks
 * LIVE sending on ANY of the 5 pending keys).
 */

function computeDigest_() {
  var config = getConfig();
  var rows = readAllProspects();
  var ledger = readAllLedgerRows_();
  var today = formatDateYmd_(new Date());

  var liveSentToday = ledger.filter(function (r) {
    return r.values.Mode === LEDGER_MODE.LIVE && r.values.State === LEDGER_STATE.SENT &&
      r.values.Confirmed_At && formatDateYmd_(new Date(r.values.Confirmed_At)) === today;
  });
  var newSentToday = liveSentToday.filter(function (r) { return Number(r.values.Step) === 1; }).length;
  var followUpSentToday = liveSentToday.length - newSentToday;

  var draftsToday = ledger.filter(function (r) {
    return r.values.Mode === LEDGER_MODE.DRY_RUN && r.values.State === LEDGER_STATE.DRAFTED &&
      r.values.Confirmed_At && formatDateYmd_(new Date(r.values.Confirmed_At)) === today;
  }).length;

  var repliedToday = rows.filter(function (r) {
    return r.values.Replied === true && r.values.Replied_At && formatDateYmd_(new Date(r.values.Replied_At)) === today;
  });
  var bouncedTotal = rows.filter(function (r) { return r.values.Status === STATUS.BOUNCED; }).length;
  var unsubscribedToday = rows.filter(function (r) {
    return r.values.Do_Not_Contact_Reason === DNC_REASON.UNSUBSCRIBE;
  }).length; // all-time count of unsubscribed rows; "today" granularity would require a timestamp column not in spec.

  var needsData = rows.filter(function (r) { return r.values.Status === STATUS.NEEDS_DATA; }).length;
  var needsReview = rows.filter(function (r) { return r.values.Status === STATUS.NEEDS_REVIEW; }).length;
  var ready = rows.filter(function (r) { return r.values.Status === STATUS.READY; }).length;
  var errors = rows.filter(function (r) { return Number(r.values.Error_Count) > 0; }).length;

  var sentToday = getDailyLiveSentCount_();
  var cap = config.MAX_PER_DAY || 5; // Always reads live from Config; this fallback only covers a missing key.

  var lines = [];
  lines.push('Klinner Outreach — Daily Digest    ' + today + '    MODE: ' + (config.DRY_RUN ? 'DRY_RUN' : 'LIVE'));
  lines.push('Enviados LIVE hoy: ' + liveSentToday.length + '  (nuevos ' + newSentToday + ' / follow-ups ' + followUpSentToday + ')     Cupo: ' + sentToday + '/' + cap);
  lines.push('Borradores de preview generados hoy: ' + draftsToday);
  lines.push('Respuestas hoy: ' + repliedToday.length);
  lines.push('Rebotes (total suprimidos): ' + bouncedTotal);
  lines.push('Bajas (unsubscribe, total): ' + unsubscribedToday);
  lines.push('Errores (Error_Count > 0): ' + errors);
  lines.push('Requieren atención: ' + needsData + ' NEEDS_DATA · ' + needsReview + ' NEEDS_REVIEW');
  lines.push('READY restantes: ' + ready);

  return { text: lines.join('\n'), mode: config.DRY_RUN ? 'DRY_RUN' : 'LIVE' };
}

/**
 * dailyDigest trigger handler. Safe to call at any time in any mode.
 * PATCH 2 / I22: computes and logs unconditionally; sends only if
 * ADMIN_EMAIL is a real address.
 */
function dailyDigest() {
  var config = getConfig();
  var digest = computeDigest_();

  if (isPendingF0_('ADMIN_EMAIL')) {
    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.DIGEST_NOT_SENT_PENDING_F0, '', '', '', digest.text);
    console.log(digest.text);
    flushLog_();
    return { sent: false, reason: 'ADMIN_EMAIL_PENDING_F0', digest: digest.text };
  }

  MailApp.sendEmail({
    to: config.ADMIN_EMAIL,
    subject: 'Klinner Outreach — Daily Digest',
    body: digest.text
  });
  logEvent_(LOG_LEVEL.INFO, LOG_EVENT.DIGEST_SENT, '', config.ADMIN_EMAIL, '', 'Digest sent.');
  flushLog_();
  return { sent: true, digest: digest.text };
}
