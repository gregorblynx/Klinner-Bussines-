/**
 * Klinner Outreach — Validate.gs
 * Email syntax validation (NO MX lookup — I20 / invariant on INVALID_EMAIL),
 * normalization, domain derivation, and the "Validate all rows" ADMIN
 * operation. This is the only place NEW/NEEDS_DATA rows get classified.
 */

// Syntax-only check. Deliberately does not attempt to resolve MX records —
// a domain that "looks fine" but does not exist is NOT INVALID_EMAIL; it is
// discovered later as BOUNCED via reply/bounce detection (I20).
var EMAIL_SYNTAX_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

var BASE_REQUIRED_FIELDS = ['Business_Name', 'Email', 'City', 'State', 'Problem_Found'];

function normalizeEmail_(raw) {
  return String(raw || '').trim().toLowerCase();
}

function isValidEmailSyntax_(emailNormalized) {
  if (!emailNormalized) return false;
  return EMAIL_SYNTAX_REGEX.test(emailNormalized);
}

function extractDomain_(emailNormalized) {
  var at = emailNormalized.lastIndexOf('@');
  if (at === -1) return '';
  return emailNormalized.substring(at + 1);
}

function getDomainType_(domain, config) {
  if (!domain) return DOMAIN_TYPE.CORPORATE;
  var publicList = (config.PUBLIC_EMAIL_DOMAINS || []).map(function (d) { return d.toLowerCase(); });
  return publicList.indexOf(domain.toLowerCase()) !== -1 ? DOMAIN_TYPE.PUBLIC : DOMAIN_TYPE.CORPORATE;
}

/** Rows whose Status marks them as still needing (re)validation. */
var VALIDATABLE_STATUSES = ['', STATUS.NEW, STATUS.NEEDS_DATA];

/**
 * Classifies a single prospect row.
 * @param {Object} row prospect.values (raw, possibly with blank identity fields)
 * @param {Object} config
 * @param {{normalizedEmails: Object, corporateDomains: Object}} seenSoFar
 *        Sets accumulated from earlier rows in this same validation pass —
 *        first occurrence in sheet order wins; later ones become DUPLICATE.
 * @return {{status: string, emailNormalized: string, domain: string,
 *           domainType: string, dncReason: (string|undefined)}}
 */
function classifyProspectRow_(row, config, seenSoFar) {
  var emailRaw = row.Email;
  var emailNormalized = normalizeEmail_(emailRaw);
  var domain = emailNormalized ? extractDomain_(emailNormalized) : '';
  var domainType = domain ? getDomainType_(domain, config) : '';

  // 1) Required structural fields.
  var missingBase = BASE_REQUIRED_FIELDS.filter(function (f) {
    return row[f] === undefined || row[f] === null || String(row[f]).trim() === '';
  });
  if (missingBase.length > 0) {
    return { status: STATUS.NEEDS_DATA, emailNormalized: emailNormalized, domain: domain, domainType: domainType };
  }

  // 2) Email syntax (no MX — I20).
  if (!isValidEmailSyntax_(emailNormalized)) {
    return { status: STATUS.INVALID_EMAIL, emailNormalized: emailNormalized, domain: domain, domainType: domainType };
  }

  // 2b) Public-domain policy (Codex finding #13: ALLOW_PUBLIC_DOMAIN_PROSPECTS
  // was defined in Config but never actually consulted anywhere — a FALSE
  // value had no effect). A policy exclusion is terminal and not something
  // the operator can fix by editing the row, so it is not NEEDS_DATA;
  // STOPPED already makes it correctly ineligible everywhere else in the
  // state machine (getNextStepNumber_ only returns non-null for READY/
  // IN_SEQUENCE), with no need to also set Stop_Contact/DNC.
  if (domainType === DOMAIN_TYPE.PUBLIC && config.ALLOW_PUBLIC_DOMAIN_PROSPECTS === false) {
    return { status: STATUS.STOPPED, emailNormalized: emailNormalized, domain: domain, domainType: domainType };
  }

  // 3) Additional merge fields required by active templates (beyond the base 5).
  var templateRequired = getAllRequiredTemplateFields_().filter(function (f) {
    return TEMPLATE_FIELD_SOURCE[f] === 'prospect' && BASE_REQUIRED_FIELDS.indexOf(f) === -1;
  });
  var missingTemplateFields = templateRequired.filter(function (f) {
    return row[f] === undefined || row[f] === null || String(row[f]).trim() === '';
  });
  if (missingTemplateFields.length > 0) {
    return { status: STATUS.NEEDS_DATA, emailNormalized: emailNormalized, domain: domain, domainType: domainType };
  }

  // 4) Duplicate email (exact match already claimed earlier in this pass or sheet).
  if (seenSoFar.normalizedEmails[emailNormalized]) {
    return {
      status: STATUS.DUPLICATE, emailNormalized: emailNormalized, domain: domain, domainType: domainType,
      dncReason: DNC_REASON.DUPLICATE
    };
  }

  // 5) One active sequence per CORPORATE domain (I12). Public domains exempt (I12, T13).
  if (config.ONE_ACTIVE_PER_CORPORATE_DOMAIN === true && domainType === DOMAIN_TYPE.CORPORATE) {
    if (seenSoFar.corporateDomains[domain]) {
      return {
        status: STATUS.DUPLICATE, emailNormalized: emailNormalized, domain: domain, domainType: domainType,
        dncReason: DNC_REASON.DUPLICATE
      };
    }
  }

  return { status: STATUS.READY, emailNormalized: emailNormalized, domain: domain, domainType: domainType };
}

/**
 * ADMIN operation: "Validate all rows".
 * Persists results to Prospects even while DRY_RUN=TRUE (origin=ADMIN is
 * never blocked by DRY_RUN — PATCH FINAL V1.1, Patch 1).
 * Only touches rows whose Status is currently '', NEW, or NEEDS_DATA.
 */
function validateAllRows() {
  var config = getConfig();
  var rows = readAllProspects();

  // First pass: build the "claimed" sets from rows that are ALREADY valid
  // and not themselves being revalidated (so a previously-READY row still
  // reserves its email/domain against newly pasted duplicates).
  var seen = { normalizedEmails: {}, corporateDomains: {} };
  var nonTerminalActiveStatuses = [STATUS.READY, STATUS.IN_SEQUENCE, STATUS.SEQUENCE_DONE, STATUS.NEEDS_REVIEW];
  rows.forEach(function (r) {
    if (VALIDATABLE_STATUSES.indexOf(r.values.Status || '') !== -1) return; // will be classified below
    if (nonTerminalActiveStatuses.indexOf(r.values.Status) === -1) return; // ignore STOPPED/BOUNCED/etc as claims
    var normEmail = r.values.Email_Normalized || normalizeEmail_(r.values.Email);
    if (normEmail) seen.normalizedEmails[normEmail] = true;
    if (r.values.Domain_Type === DOMAIN_TYPE.CORPORATE && r.values.Domain) seen.corporateDomains[r.values.Domain] = true;
  });

  var results = { processed: 0, ready: 0, needsData: 0, invalidEmail: 0, duplicate: 0, skipped: 0 };

  rows.forEach(function (r) {
    var currentStatus = r.values.Status || '';
    if (VALIDATABLE_STATUSES.indexOf(currentStatus) === -1) {
      results.skipped++;
      return;
    }

    var classification = classifyProspectRow_(r.values, config, seen);
    var fields = {
      Email_Normalized: classification.emailNormalized,
      Domain: classification.domain,
      Domain_Type: classification.domainType,
      Status: classification.status
    };

    if (classification.dncReason) fields.Do_Not_Contact_Reason = classification.dncReason;

    var opts = { origin: ORIGIN.ADMIN, operation: OPERATION.ADMIN_VALIDATE };
    var prospectId = r.values.Prospect_ID;
    if (!prospectId) {
      // Brand-new row: no ID to look up yet. Assign it directly by rowIndex.
      prospectId = Utilities.getUuid();
      fields.Prospect_ID = prospectId;
      if (!r.values.Date_Added) fields.Date_Added = new Date();
      assignNewProspectIdAndFields_(r.rowIndex, fields, opts);
    } else {
      if (!r.values.Date_Added) fields.Date_Added = new Date();
      writeRowById_(prospectId, fields, opts);
    }

    if (classification.status === STATUS.READY) {
      seen.normalizedEmails[classification.emailNormalized] = true;
      if (classification.domainType === DOMAIN_TYPE.CORPORATE) seen.corporateDomains[classification.domain] = true;
    }

    results.processed++;
    if (classification.status === STATUS.READY) results.ready++;
    else if (classification.status === STATUS.NEEDS_DATA) results.needsData++;
    else if (classification.status === STATUS.INVALID_EMAIL) results.invalidEmail++;
    else if (classification.status === STATUS.DUPLICATE) results.duplicate++;

    logEvent_(LOG_LEVEL.INFO, LOG_EVENT.VALIDATE, prospectId, classification.emailNormalized, '',
      'Status=' + classification.status);
  });

  flushLog_();
  return results;
}
