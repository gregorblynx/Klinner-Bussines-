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

  var sentToday = getDailyLiveQuotaUsedCount_();
  var cap = config.MAX_PER_DAY || 5; // Always reads live from Config; this fallback only covers a missing key.

  var inventory = computeQualifiedFutureInventory_(config);

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
  lines.push('Qualified future inventory: ' + inventory.total + '  (READY ' + inventory.ready + ' + IN_SEQUENCE with future steps ' + inventory.inSequence + ')');

  return { text: lines.join('\n'), mode: config.DRY_RUN ? 'DRY_RUN' : 'LIVE', inventory: inventory };
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

  // v1.0.2: runs strictly AFTER the digest is out and can never throw, so
  // it cannot affect the digest's own outcome.
  var inventoryAlert = runInventoryAlert_(config, digest.inventory);
  flushLog_();
  return { sent: true, digest: digest.text, inventoryAlert: inventoryAlert };
}

/**
 * QUALIFIED FUTURE INVENTORY (v1.0.2): real prospects that still have at
 * least one legitimate future outreach opportunity — READY, or IN_SEQUENCE
 * with a step remaining. NOT "sendable right now".
 *
 * Deliberately reuses the canonical isEligibleForNextStep_ (StateMachine.gs)
 * rather than a second eligibility system: it already excludes Stop_Contact,
 * any Do_Not_Contact_Reason, Replied, suppressed addresses/domains, and
 * every status other than READY/IN_SEQUENCE with steps left
 * (getNextStepNumber_ honours MAX_STEPS, so an exhausted sequence is out).
 * Passing the maximum representable Date as `now` disables ONLY its
 * "Next_Action_Date is not due yet" test — that is the difference between
 * "sendable now" and "future inventory". A blank Next_Action_Date on an
 * IN_SEQUENCE row still excludes it (I6: blank means ignore, forever).
 * Controlled fixtures are excluded explicitly. ONE_ACTIVE_PER_CORPORATE_DOMAIN
 * is intentionally NOT consulted: another active prospect at the same
 * domain does not remove a valid future opportunity.
 */
function computeQualifiedFutureInventory_(config) {
  var farFuture = new Date(8640000000000000);
  var inventory = { total: 0, ready: 0, inSequence: 0 };
  readAllProspects().forEach(function (r) {
    var v = r.values;
    if (CONTROLLED_FIXTURE_SOURCES.indexOf(v.Source) !== -1) return;
    if (!isEligibleForNextStep_(v, config, farFuture)) return;
    if (v.Status === STATUS.READY) inventory.ready++;
    else if (v.Status === STATUS.IN_SEQUENCE) inventory.inSequence++;
    else return;
    inventory.total++;
  });
  return inventory;
}

/** Config-backed threshold; a missing/blank/non-positive value falls back to the default (20). */
function getInventoryRefillThreshold_(config) {
  var n = Number(config.INVENTORY_REFILL_THRESHOLD);
  return (isFinite(n) && n > 0) ? n : DEFAULT_INVENTORY_REFILL_THRESHOLD;
}

/**
 * CRITICAL threshold (default 10). Must be positive and strictly lower than
 * the refill threshold, otherwise the default is used. If even the default
 * is not lower than a (validly) small refill threshold, half of the refill
 * threshold is used so the two zones can never overlap or invert. Never throws.
 */
function getInventoryCriticalThreshold_(config) {
  var low = getInventoryRefillThreshold_(config);
  var n = Number(config.INVENTORY_CRITICAL_THRESHOLD);
  if (isFinite(n) && n > 0 && n < low) return n;
  if (DEFAULT_INVENTORY_CRITICAL_THRESHOLD < low) return DEFAULT_INVENTORY_CRITICAL_THRESHOLD;
  return Math.floor(low / 2);
}

/** "yyyy-MM-dd HH:mm <tz>" using only formatDate patterns already relied on elsewhere. */
function formatAlertTimestamp_(date) {
  var tz = getScriptTimeZone_();
  return formatDateYmd_(date) + ' ' + Utilities.formatDate(date, tz, 'HH') + ':' +
    Utilities.formatDate(date, tz, 'mm') + ' ' + tz;
}

/**
 * Two-level inventory alert, edge-triggered, persisted in Script Properties
 * (INVENTORY_ALERT_STATE = 'OK' | 'LOW' | 'CRITICAL'; absent counts as 'OK').
 * The state is the STRONGEST level already alerted since the last refill:
 *   inventory above the refill threshold  -> state 'OK' (re-arms BOTH), no email;
 *   at/below refill, above critical       -> ONE 'LOW' email unless already LOW/CRITICAL;
 *   at/below critical                     -> ONE 'CRITICAL' email unless already CRITICAL.
 * A direct jump from above the refill threshold to at/below critical sends
 * the CRITICAL email only (one email per digest run, the stronger condition).
 * Partial recovery that stays at/below the refill threshold does not re-arm.
 * Claim-before-send, like the LIVE ledger: the new state is written BEFORE
 * the email and the previous state is restored if the send throws, so a
 * failed send is retried at the next digest while a successful one can never
 * repeat. Never throws: an alert failure must not disturb the digest.
 */
function runInventoryAlert_(config, inventory) {
  try {
    var low = getInventoryRefillThreshold_(config);
    var critical = getInventoryCriticalThreshold_(config);
    var props = PropertiesService.getScriptProperties();
    var state = props.getProperty(INVENTORY_ALERT_STATE_PROPERTY);
    var summary = { total: inventory.total, threshold: low, criticalThreshold: critical };

    if (inventory.total > low) {
      if (state !== 'OK') props.setProperty(INVENTORY_ALERT_STATE_PROPERTY, 'OK');
      return Object.assign({ alerted: false, reason: 'ABOVE_THRESHOLD' }, summary);
    }

    var level = inventory.total <= critical ? 'CRITICAL' : 'LOW';
    var alreadyAlerted = (level === 'CRITICAL') ? state === 'CRITICAL' : (state === 'LOW' || state === 'CRITICAL');
    if (alreadyAlerted) return Object.assign({ alerted: false, reason: 'ALREADY_ALERTED', level: level }, summary);

    props.setProperty(INVENTORY_ALERT_STATE_PROPERTY, level);
    try {
      var body = [
        level === 'CRITICAL'
          ? 'Qualified future inventory is CRITICALLY low.'
          : 'Qualified future inventory is at or below the refill threshold.',
        '',
        'Qualified future inventory: ' + inventory.total,
        'READY: ' + inventory.ready,
        'IN_SEQUENCE with future steps remaining: ' + inventory.inSequence,
        'Refill threshold (low): ' + low,
        'Critical threshold: ' + critical,
        'Date/time: ' + formatAlertTimestamp_(new Date()),
        '',
        level === 'CRITICAL'
          ? 'Qualified prospects should be replenished NOW so outreach does not run dry.'
          : 'Please add new qualified prospects soon so outreach does not run dry.'
      ].join('\n');
      MailApp.sendEmail({
        to: config.ADMIN_EMAIL,
        subject: level === 'CRITICAL' ? 'Klinner Outreach — CRITICAL Inventory Alert' : 'Klinner Outreach — Low Inventory Alert',
        body: body
      });
    } catch (sendError) {
      try {
        if (state === null || state === undefined) props.deleteProperty(INVENTORY_ALERT_STATE_PROPERTY);
        else props.setProperty(INVENTORY_ALERT_STATE_PROPERTY, state);
      } catch (rollbackError) { /* logged below */ }
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.INVENTORY_ALERT_FAILED, '', config.ADMIN_EMAIL, '',
        level + ' inventory email failed; state restored so the next digest retries. error=' + sendError);
      return Object.assign({ alerted: false, reason: 'SEND_FAILED', level: level }, summary);
    }
    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.INVENTORY_ALERT_SENT, '', config.ADMIN_EMAIL, '',
      level + ' inventory alert sent: total=' + inventory.total + ' low=' + low + ' critical=' + critical);
    return Object.assign({ alerted: true, reason: 'SENT', level: level }, summary);
  } catch (e) {
    logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.INVENTORY_ALERT_FAILED, '', '', '', 'Inventory alert error: ' + e);
    return { alerted: false, reason: 'ERROR' };
  }
}
