/**
 * Klinner Outreach — Triggers.gs
 * Idempotent trigger installer, scoped to exactly the 4 managed handlers
 * (I19). NEVER deletes triggers in bulk — it must survive a project that
 * already has unrelated triggers installed (T24).
 *
 * IMPORTANT (F1 restriction): this file defines installTriggers() but
 * nothing in this delivery calls it automatically. Installing triggers is
 * an explicit, manual, later step — see README.md "Manual steps pending".
 */

var MANAGED_TRIGGER_HANDLERS = ['sendBatch', 'syncReplies', 'nightlyRecon', 'dailyDigest'];

/**
 * Deletes only triggers whose handler function is one of
 * MANAGED_TRIGGER_HANDLERS, then recreates all 4 on their configured
 * schedules. Any trigger for a handler NOT in this list — belonging to
 * this project or created by someone else — is left completely untouched.
 */
function installTriggers() {
  var existing = ScriptApp.getProjectTriggers();
  var removed = [];
  existing.forEach(function (t) {
    var handler = t.getHandlerFunction();
    if (MANAGED_TRIGGER_HANDLERS.indexOf(handler) !== -1) {
      ScriptApp.deleteTrigger(t);
      removed.push(handler);
    }
    // Anything else (including triggers this project doesn't recognize) is left alone — I19.
  });

  ScriptApp.newTrigger('sendBatch').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('syncReplies').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('nightlyRecon').timeBased().atHour(2).everyDays(1).create();
  ScriptApp.newTrigger('dailyDigest').timeBased().atHour(18).everyDays(1).create();

  logEvent_(LOG_LEVEL.INFO, LOG_EVENT.RUN_START, '', '', '', 'installTriggers: removed=' + removed.join(',') +
    ' installed=' + MANAGED_TRIGGER_HANDLERS.join(','));
  flushLog_();

  return { removed: removed, installed: MANAGED_TRIGGER_HANDLERS.slice() };
}

/** Removes only the 4 managed triggers, leaving any other project trigger untouched. */
function uninstallTriggers() {
  var existing = ScriptApp.getProjectTriggers();
  var removed = [];
  existing.forEach(function (t) {
    var handler = t.getHandlerFunction();
    if (MANAGED_TRIGGER_HANDLERS.indexOf(handler) !== -1) {
      ScriptApp.deleteTrigger(t);
      removed.push(handler);
    }
  });
  return { removed: removed };
}

/** Reports currently installed managed triggers vs. unmanaged ones (diagnostic; no side effects). */
function listManagedTriggers_() {
  var existing = ScriptApp.getProjectTriggers();
  var managed = [];
  var unmanaged = [];
  existing.forEach(function (t) {
    var handler = t.getHandlerFunction();
    (MANAGED_TRIGGER_HANDLERS.indexOf(handler) !== -1 ? managed : unmanaged).push(handler);
  });
  return { managed: managed, unmanaged: unmanaged };
}
