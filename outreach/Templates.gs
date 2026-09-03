/**
 * Klinner Outreach — Templates.gs
 * Parses {{field}} / {{field|fallback}} tokens, renders templates against a
 * prospect row, and reports which fields are required (no pipe, no fallback).
 */

var MERGE_TOKEN_REGEX = /\{\{\s*([A-Za-z0-9_]+)\s*(\|([^}]*))?\s*\}\}/g;

var TEMPLATE_FIELD_SOURCE = {
  Business_Name: 'prospect',
  Contact_Name: 'prospect',
  City: 'prospect',
  State: 'prospect',
  Website: 'prospect',
  Problem_Found: 'prospect',
  Personalization_Line: 'prospect',
  Sender_Name: 'config:SENDER_NAME',
  Physical_Address: 'config:PHYSICAL_ADDRESS',
  Unsubscribe_Line: 'config:UNSUBSCRIBE_LINE'
};

/**
 * Parses a template string (subject or body) and returns
 * { requiredFields: [...], allFields: [...] }.
 * A field is "required" only if it appears with no |fallback anywhere in
 * the template. If the same field appears once with a fallback and once
 * without, it is treated as required (the strictest reading wins).
 */
function parseTemplateFields_(text) {
  var required = {};
  var all = {};
  if (!text) return { requiredFields: [], allFields: [] };
  var match;
  MERGE_TOKEN_REGEX.lastIndex = 0;
  while ((match = MERGE_TOKEN_REGEX.exec(text)) !== null) {
    var field = match[1];
    var hasFallback = match[2] !== undefined;
    all[field] = true;
    if (!hasFallback) required[field] = true;
  }
  return { requiredFields: Object.keys(required), allFields: Object.keys(all) };
}

/** Required fields across subject+body of one template row. */
function getTemplateRequiredFields_(template) {
  var subjectFields = parseTemplateFields_(template.Subject);
  var bodyFields = parseTemplateFields_(template.Body);
  var required = {};
  subjectFields.requiredFields.forEach(function (f) { required[f] = true; });
  bodyFields.requiredFields.forEach(function (f) { required[f] = true; });
  return Object.keys(required);
}

/** Reads active Templates rows into an array indexed by step (1-based, sparse). */
function readTemplates_() {
  var sheet = getSheet_(SHEET_NAMES.TEMPLATES);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  var data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  var byStep = {};
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var step = Number(row[0]);
    if (!step) continue;
    byStep[step] = {
      Step: step,
      Subject: String(row[1] || ''),
      Body: String(row[2] || ''),
      Active: row[3] === true || String(row[3]).toUpperCase() === 'TRUE',
      Internal_Note: String(row[4] || '')
    };
  }
  return byStep;
}

function getActiveTemplateForStep_(step) {
  var templates = readTemplates_();
  var t = templates[step];
  if (!t || !t.Active) return null;
  return t;
}

/** Merges every required field (subject+body) across all active steps. */
function getAllRequiredTemplateFields_() {
  var templates = readTemplates_();
  var required = {};
  for (var step in templates) {
    if (!templates[step].Active) continue;
    getTemplateRequiredFields_(templates[step]).forEach(function (f) { required[f] = true; });
  }
  return Object.keys(required);
}

/**
 * Renders one field's value given a prospect row + config.
 * Returns undefined if the field is unknown or the prospect value is blank.
 */
function resolveFieldValue_(field, prospect, config) {
  var source = TEMPLATE_FIELD_SOURCE[field];
  if (!source) return undefined;
  if (source === 'prospect') {
    var v = prospect[field];
    return (v === undefined || v === null) ? '' : String(v);
  }
  if (source.indexOf('config:') === 0) {
    var key = source.substring('config:'.length);
    var cv = config[key];
    return (cv === undefined || cv === null) ? '' : String(cv);
  }
  return undefined;
}

/**
 * Renders a template string against a prospect row.
 * Throws MissingRequiredFieldError if a required (no-fallback) field is blank.
 */
function renderTemplateText_(text, prospect, config) {
  if (!text) return '';
  var missing = [];
  var rendered = text.replace(MERGE_TOKEN_REGEX, function (whole, field, _pipe, fallback) {
    var value = resolveFieldValue_(field, prospect, config);
    var hasFallback = _pipe !== undefined;
    // Codex finding #14: a whitespace-only value ("   ") must count as
    // blank, the same as an empty string — otherwise a stray space in a
    // pasted cell silently produces "Hi there,\n\nI was looking at    ..."
    // instead of triggering the missing-field / fallback behavior.
    var isBlank = value === undefined || value === null || String(value).trim() === '';
    if (isBlank) {
      if (hasFallback) return fallback === undefined ? '' : fallback;
      missing.push(field);
      return '';
    }
    return value;
  });
  if (missing.length > 0) {
    var err = new Error('Missing required template field(s): ' + missing.join(', '));
    err.missingFields = missing;
    err.isMissingRequiredFieldError = true;
    throw err;
  }
  return collapseBlankLines_(rendered);
}

function collapseBlankLines_(text) {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Renders subject+body for one step. Returns { subject, body } or throws
 * MissingRequiredFieldError. Caller (Mailer.previewStep) decides what to do
 * with a missing-field failure (log SKIP:needs_data, do not draft).
 */
function renderTemplateForStep_(step, prospect, config) {
  var template = getActiveTemplateForStep_(step);
  if (!template) throw new Error('No active template for step ' + step);
  var subject = renderTemplateText_(template.Subject, prospect, config);
  var body = renderTemplateText_(template.Body, prospect, config);
  return { subject: subject, body: body, template: template };
}
