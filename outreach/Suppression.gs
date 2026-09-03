/**
 * Klinner Outreach — Suppression.gs
 * Permanent, append-only do-not-contact list. Default scope=email.
 * scope=domain is only ever created by an explicit human action (never by
 * the system), and is rejected outright for any domain in
 * PUBLIC_EMAIL_DOMAINS (I11). Rows are never deleted, and — per the N2
 * reaudit fix below — never silently overwritten either: each distinct
 * (Value, Scope, Reason) combination gets its own permanent row.
 */

function readAllSuppression_() {
  var sheet = getSheet_(SHEET_NAMES.SUPPRESSION);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  return data.map(function (row, i) {
    return {
      rowIndex: i + 2,
      Value: String(row[0] || '').trim().toLowerCase(),
      Scope: row[1],
      Reason: row[2],
      Date_Added: row[3],
      Added_By: row[4]
    };
  }).filter(function (r) { return r.Value; });
}

/**
 * Finds a Suppression row by (Value, Scope) and, when `reason` is given,
 * ALSO by Reason.
 *
 * N2 reaudit fix: `reason` is intentionally optional, not mandatory —
 * the two use cases genuinely need different match granularity:
 *   - isSuppressed_() below (the I4 send-blocking gate) must keep matching
 *     on Value+Scope ONLY, regardless of reason — a bounce suppression
 *     blocks sending exactly as much as an unsubscribe one. Do not add a
 *     reason argument to those calls.
 *   - addSuppression_()'s idempotency check, and any caller asking "does
 *     THIS specific reason already have its own permanent record" (e.g.
 *     Recon.gs's unsubscribe-completeness check), must pass `reason` so a
 *     pre-existing row for a DIFFERENT reason never masks the need to
 *     create this one.
 *
 * @param {string} value email or domain
 * @param {string} scope SUPPRESSION_SCOPE.EMAIL | SUPPRESSION_SCOPE.DOMAIN
 * @param {string} [reason] when provided, narrows the match to this exact reason too
 */
function findSuppressionEntry_(value, scope, reason) {
  var v = String(value || '').trim().toLowerCase();
  var rows = readAllSuppression_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].Value !== v || rows[i].Scope !== scope) continue;
    if (reason !== undefined && rows[i].Reason !== reason) continue;
    return rows[i];
  }
  return null;
}

/**
 * I4: a prospect is suppressed if its normalized email is in
 * Suppression(scope=email) OR its domain is in Suppression(scope=domain) —
 * for ANY reason. Deliberately reason-agnostic: this is the send-blocking
 * gate, and a suppression recorded for one reason (e.g. a bounce) must
 * block sending exactly as effectively as one recorded for another (e.g.
 * an unsubscribe). Do not add a reason filter here.
 */
function isSuppressed_(emailNormalized, domain) {
  if (findSuppressionEntry_(emailNormalized, SUPPRESSION_SCOPE.EMAIL)) return true;
  if (domain && findSuppressionEntry_(domain, SUPPRESSION_SCOPE.DOMAIN)) return true;
  return false;
}

/**
 * Adds a suppression entry. Idempotent on the (value, scope, REASON)
 * triple — a second call with the same value+scope+reason is a no-op and
 * returns { added: false, reason: 'exists' }. Rejects scope=domain for any
 * value in PUBLIC_EMAIL_DOMAINS (I11).
 *
 * N2 reaudit fix: idempotency used to be evaluated on (value, scope) ALONE
 * — so if `prospect@example.com` already had a scope=email/reason=bounce
 * row, a later call to record reason=unsubscribe for that SAME address
 * would find the bounce row, consider the address "already suppressed",
 * and silently skip creating the unsubscribe record. That violated the
 * guarantee that an unsubscribe must leave its own, unambiguous,
 * permanent (Value=email, Scope=email, Reason=unsubscribe) row — checking
 * isSuppressed_(email) afterward would have looked satisfied (blocked)
 * without ever proving the unsubscribe itself was recorded. Per Suppression
 * being an append-only, permanent record: a pre-existing row for a
 * DIFFERENT reason is never overwritten and never treated as satisfying a
 * new reason — each distinct reason gets its own permanent row.
 *
 * @param {string} value email or domain
 * @param {string} scope SUPPRESSION_SCOPE.EMAIL | SUPPRESSION_SCOPE.DOMAIN
 * @param {string} reason one of DNC_REASON_VALUES
 * @param {string} addedBy 'system' or an operator identifier
 */
function addSuppression_(value, scope, reason, addedBy) {
  var normalized = String(value || '').trim().toLowerCase();
  if (!normalized) throw new Error('addSuppression_: value is required.');

  if (scope === SUPPRESSION_SCOPE.DOMAIN) {
    var config = getConfig();
    var publicList = (config.PUBLIC_EMAIL_DOMAINS || []).map(function (d) { return d.toLowerCase(); });
    if (publicList.indexOf(normalized) !== -1) {
      logEvent_(LOG_LEVEL.ERROR, LOG_EVENT.ERROR, '', '', '',
        'Rejected domain suppression for public domain "' + normalized + '" (I11).');
      throw new Error('Cannot suppress a public email domain ("' + normalized + '") at scope=domain (I11).');
    }
  }

  var existing = findSuppressionEntry_(normalized, scope, reason);
  if (existing) {
    return { added: false, reason: 'exists' };
  }

  var sheet = getSheet_(SHEET_NAMES.SUPPRESSION);
  sheet.appendRow([normalized, scope, reason, new Date(), addedBy || 'system']);
  logEvent_(LOG_LEVEL.INFO, LOG_EVENT.SUPPRESS, '', normalized, '', 'scope=' + scope + ' reason=' + reason);
  return { added: true };
}
