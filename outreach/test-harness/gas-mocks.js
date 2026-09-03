'use strict';
/**
 * Minimal mocks of the Google Apps Script global services, just enough to
 * load the real outreach/*.gs source files (unmodified) in plain Node and
 * exercise their pure logic. This is NOT a Gmail/Sheets simulator and does
 * NOT prove anything about real GAS runtime behavior (quotas, real Gmail
 * threading semantics, real spreadsheet protection UI, etc). It exists
 * solely to give local, honest verification of the logic that does not
 * inherently require a live Google account — see the delivery report for
 * exactly which tests this covers vs. which require Google real.
 */

function createInMemorySheet(name) {
  return {
    name: name,
    data: [], // array of arrays, data[0] is row 1
    frozenRows: 0,
    frozenCols: 0,
    protections: [],
    validations: {},
    numberFormats: {}, // 'row:col' -> format string, e.g. '@' for plain text
    getName: function () { return this.name; },
    getLastRow: function () { return this.data.length; },
    getMaxRows: function () { return Math.max(this.data.length, 1); },
    insertRowsAfter: function (afterRow, howMany) {
      while (this.data.length < afterRow + howMany) this.data.push([]);
    },
    setFrozenRows: function (n) { this.frozenRows = n; },
    setFrozenColumns: function (n) { this.frozenCols = n; },
    clear: function () { this.data = []; this.protections = []; this.numberFormats = {}; },
    autoResizeColumns: function () {},
    appendRow: function (row) { this.data.push(row.slice()); return this.getLastRow(); },
    deleteRow: function (rowIndex) { this.data.splice(rowIndex - 1, 1); },
    deleteRows: function (start, count) { this.data.splice(start - 1, count); },
    getRange: function (row, col, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      var sheet = this;
      return {
        setValues: function (values) {
          for (var r = 0; r < numRows; r++) {
            while (sheet.data.length < row + r) sheet.data.push([]);
            var targetRow = sheet.data[row + r - 1];
            for (var c = 0; c < numCols; c++) {
              targetRow[col + c - 1] = values[r][c];
            }
          }
          return this;
        },
        setValue: function (value) {
          while (sheet.data.length < row) sheet.data.push([]);
          sheet.data[row - 1][col - 1] = value;
          return this;
        },
        getValues: function () {
          var out = [];
          for (var r = 0; r < numRows; r++) {
            var srcRow = sheet.data[row + r - 1] || [];
            var outRow = [];
            for (var c = 0; c < numCols; c++) outRow.push(srcRow[col + c - 1] === undefined ? '' : srcRow[col + c - 1]);
            out.push(outRow);
          }
          return out;
        },
        getValue: function () {
          var srcRow = sheet.data[row - 1] || [];
          var v = srcRow[col - 1];
          return v === undefined ? '' : v;
        },
        setDataValidation: function (rule) { sheet.validations[row + ':' + col] = rule; return this; },
        setNumberFormat: function (fmt) {
          for (var r = 0; r < numRows; r++) {
            for (var c = 0; c < numCols; c++) {
              sheet.numberFormats[(row + r) + ':' + (col + c)] = fmt;
            }
          }
          return this;
        },
        getNumberFormat: function () {
          return sheet.numberFormats[row + ':' + col] || 'General';
        },
        protect: function () {
          // Editors modeled as {getEmail(), _groupDerived} so tests can
          // exercise the "cannot remove a Group-derived editor" path that
          // real Apps Script can hit on a Workspace-shared sheet.
          var editors = [
            { getEmail: function () { return 'test-runner@example.com'; }, _groupDerived: false },
            { getEmail: function () { return 'shared-via-group@example.com'; }, _groupDerived: true }
          ];
          var p = {
            description: '',
            domainEdit: true,
            setDescription: function (d) { this.description = d; return this; },
            getDescription: function () { return this.description; },
            getEditors: function () { return editors.slice(); },
            removeEditor: function (editor) {
              var email = editor && editor.getEmail ? editor.getEmail() : editor;
              var target = editors.filter(function (e) { return e.getEmail() === email; })[0];
              if (target && target._groupDerived) {
                throw new Error('Mock: cannot remove Group-derived editor "' + email + '" (mirrors real Apps Script behavior).');
              }
              editors = editors.filter(function (e) { return e.getEmail() !== email; });
              return this;
            },
            removeEditors: function (list) { list.forEach(function (e) { p.removeEditor(e); }); return this; },
            addEditor: function (email) {
              var addr = email && email.getEmail ? email.getEmail() : email;
              if (!editors.some(function (e) { return e.getEmail() === addr; })) {
                editors.push({ getEmail: function () { return addr; }, _groupDerived: false });
              }
              return this;
            },
            canDomainEdit: function () { return this.domainEdit; },
            setDomainEdit: function (v) { this.domainEdit = v; return this; }
          };
          sheet.protections.push(p);
          return p;
        }
      };
    },
    getProtections: function () { return this.protections; },
    getActiveCell: function () { return this._activeCell || { getRow: function () { return 2; } }; }
  };
}

function createMockSpreadsheetApp() {
  var sheets = {};
  var activeSheetName = null;

  var api = {
    _sheets: sheets,
    getActiveSpreadsheet: function () {
      return {
        getSheetByName: function (name) { return sheets[name] || null; },
        insertSheet: function (name) {
          var s = createInMemorySheet(name);
          sheets[name] = s;
          return s;
        }
      };
    },
    getActiveSheet: function () {
      return sheets[activeSheetName] || createInMemorySheet('Unknown');
    },
    setActiveSheetForTest: function (name) { activeSheetName = name; },
    newDataValidation: function () {
      var rule = { type: null, values: null, allowInvalid: true };
      return {
        requireCheckbox: function () { rule.type = 'checkbox'; return this; },
        requireValueInList: function (values, allowInvalid) { rule.type = 'list'; rule.values = values; rule.allowInvalid = allowInvalid; return this; },
        setAllowInvalid: function (v) { rule.allowInvalid = v; return this; },
        build: function () { return rule; }
      };
    },
    ProtectionType: { RANGE: 'RANGE' },
    flush: function () { /* no-op: mock writes are synchronous already */ }
  };
  return api;
}

function createMockUtilities() {
  // Real GAS Utilities.getUuid() returns a standard random UUID v4, whose
  // first 8 chars are already unique per call. Match that shape exactly —
  // a previous version of this mock used a "test-uuid-N-..." prefix whose
  // first 8 characters were CONSTANT across every call, which silently
  // made every test-generated email land on the same fake corporate
  // domain and broke the 1-per-domain invariant test setup. Caught only
  // by actually running the suite, not by inspection.
  function randomHex(len) {
    var chars = '0123456789abcdef';
    var out = '';
    for (var i = 0; i < len; i++) out += chars[Math.floor(Math.random() * 16)];
    return out;
  }
  return {
    getUuid: function () {
      return [randomHex(8), randomHex(4), '4' + randomHex(3), randomHex(4), randomHex(12)].join('-');
    },
    formatDate: function (date, tz, pattern) {
      // Enough of SimpleDateFormat to satisfy Schedule.gs's usage:
      // 'yyyy-MM-dd', 'u' (ISO day 1-7 Mon-Sun), 'H' (0-23 hour), 'EEE' (weekday abbrev).
      var d = new Date(date.getTime());
      var pad = function (n) { return String(n).length < 2 ? '0' + n : String(n); };
      if (pattern === 'yyyy-MM-dd') {
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      }
      if (pattern === 'u') {
        var jsDay = d.getDay(); // 0=Sun..6=Sat
        return String(jsDay === 0 ? 7 : jsDay); // 1=Mon..7=Sun
      }
      if (pattern === 'H') {
        return String(d.getHours());
      }
      if (pattern === 'EEE') {
        var names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        return names[d.getDay()];
      }
      throw new Error('Mock Utilities.formatDate: unsupported pattern "' + pattern + '"');
    },
    sleep: function () { /* no-op in tests */ }
  };
}

function createMockGmailApp() {
  var drafts = [];
  var draftCounter = 0;
  var messageCounter = 0;
  var threadCounter = 0;
  var labels = {};
  var threads = {}; // id -> thread mock, for _seedLiveThread / getThreadById

  function makeMessage(from, to, subject, body) {
    messageCounter++;
    var id = 'msg-' + messageCounter;
    return {
      getId: function () { return id; },
      getFrom: function () { return from; },
      getTo: function () { return to; },
      getSubject: function () { return subject; },
      getPlainBody: function () { return body; },
      getBody: function () { return body; },
      getRawContent: function () {
        return 'From: ' + from + '\r\nTo: ' + to + '\r\nSubject: ' + subject + '\r\n\r\n' + body;
      }
    };
  }

  function makeDraft(to, subject, body, thread) {
    draftCounter++;
    var id = 'draft-' + draftCounter;
    var message = makeMessage('klinner-outreach-test@example.com', to, subject, body);
    var draft = {
      _id: id,
      getId: function () { return id; },
      deleteDraft: function () {
        var idx = drafts.indexOf(draft);
        if (idx !== -1) drafts.splice(idx, 1);
      },
      getMessage: function () { return message; }
    };
    message._ownerThread = thread || { getId: function () { return 'thread-for-' + id; } };
    message.getThread = function () { return message._ownerThread; };
    drafts.push(draft);
    return draft;
  }

  return {
    _drafts: drafts,
    _threads: threads,
    createDraft: function (to, subject, body) {
      return makeDraft(to, subject, body, null);
    },
    getDrafts: function () { return drafts.slice(); },
    getUserLabelByName: function (name) { return labels[name] || null; },
    createLabel: function (name) {
      var label = { getName: function () { return name; } };
      labels[name] = label;
      return label;
    },
    /** Real GmailApp.getThreadById returns null for an unknown/deleted thread — never throws. */
    getThreadById: function (id) {
      return threads[id] || null;
    },
    search: function () { return []; },
    /**
     * Test-only helper: seeds a fake existing LIVE thread with one prior
     * outbound message, so tests can exercise thread.reply()/
     * thread.createDraftReply() and getThreadById() against something real.
     */
    _seedLiveThread: function (recipientEmail, senderEmail) {
      threadCounter++;
      var threadId = 'live-thread-' + threadCounter;
      var messages = [makeMessage(senderEmail, recipientEmail, 'A quick note', 'Original outreach body.')];
      var thread = {
        getId: function () { return threadId; },
        getMessages: function () { return messages.slice(); },
        getLabels: function () { return []; },
        addLabel: function () {},
        /** Real GmailThread.reply() returns the GmailThread itself, NOT a GmailMessage — Codex finding #7. */
        reply: function (body) {
          messages.push(makeMessage(senderEmail, recipientEmail, 'Re: A quick note', body));
          return thread;
        },
        createDraftReply: function (body) {
          return makeDraft(recipientEmail, 'Re: A quick note', body, thread);
        }
      };
      threads[threadId] = thread;
      return thread;
    }
  };
}

function createMockLockService() {
  // A single shared lock state, matching real LockService.getScriptLock()
  // returning the same script-wide lock every time. Lets tests simulate
  // contention: acquire it externally, then call code that tries to lock,
  // and observe the LOCK_BUSY path — real concurrency (two actual
  // simultaneous Apps Script executions) cannot be simulated here; see the
  // delivery report.
  var held = false;
  var lock = {
    tryLock: function () {
      if (held) return false;
      held = true;
      return true;
    },
    releaseLock: function () { held = false; },
    hasLock: function () { return held; }
  };
  return {
    getScriptLock: function () { return lock; },
    _forceHeldForTest: function (v) { held = v; }
  };
}

function createMockScriptApp() {
  var triggers = [];
  return {
    _triggers: triggers,
    getProjectTriggers: function () { return triggers.slice(); },
    deleteTrigger: function (t) { var i = triggers.indexOf(t); if (i !== -1) triggers.splice(i, 1); },
    newTrigger: function (handler) {
      var builder = {
        _handler: handler,
        timeBased: function () { return this; },
        everyHours: function () { return this; },
        everyDays: function () { return this; },
        atHour: function () { return this; },
        create: function () {
          var t = { getHandlerFunction: function () { return handler; } };
          triggers.push(t);
          return t;
        }
      };
      return builder;
    },
    addTriggerForTest: function (handlerName) {
      triggers.push({ getHandlerFunction: function () { return handlerName; } });
    }
  };
}

function buildSandbox() {
  var sandbox = {
    console: console,
    Object: Object,
    JSON: JSON,
    Date: Date,
    Math: Math,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Array: Array,
    Error: Error,
    RegExp: RegExp,
    isNaN: isNaN,
    parseInt: parseInt,
    parseFloat: parseFloat
  };
  sandbox.SpreadsheetApp = createMockSpreadsheetApp();
  sandbox.Utilities = createMockUtilities();
  sandbox.GmailApp = createMockGmailApp();
  sandbox.LockService = createMockLockService();
  sandbox.ScriptApp = createMockScriptApp();
  sandbox.Session = {
    getScriptTimeZone: function () { return 'America/Chicago'; },
    getEffectiveUser: function () { return { getEmail: function () { return 'test-runner@example.com'; } }; }
  };
  sandbox.MailApp = {
    _sent: [],
    _remainingQuota: 1500,
    sendEmail: function (opts) {
      sandbox.MailApp._sent.push(opts);
      sandbox.MailApp._remainingQuota--;
    },
    getRemainingDailyQuota: function () { return sandbox.MailApp._remainingQuota; }
  };
  return sandbox;
}

module.exports = { buildSandbox: buildSandbox, createInMemorySheet: createInMemorySheet };
