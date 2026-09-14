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

/**
 * Real Sheets tracks a CONTENT extent — getLastRow() is "the last row that
 * actually holds a value", and writing blanks into rows past it does not
 * extend it. This mock modelled the extent as `data.length`, so
 * setValues()-ing a block of empty strings across rows 2-1000 permanently
 * grew getLastRow() from 1 to 1000 for every subsequent test, silently
 * shifting where appendRow() landed.
 *
 * Codex's follow-up audit found the fix had been applied to setValues()
 * only, leaving the two write paths INCONSISTENT: setValues([['']]) at row
 * 1000 left getLastRow() alone while setValue('') at the same cell pushed
 * it to 1000. Both now route through finishWrite() below, so the content
 * extent is a property of the sheet, not of which API happened to write to
 * it — and, as in real Sheets, blanking out the last cell that held
 * content can SHRINK the extent again.
 *
 * What counts as blank, exactly:
 *   ''         blank
 *   null       blank      (a cleared cell; matches how getValues() renders
 *                          rows that were never written)
 *   undefined  blank      (an unwritten cell inside a short row array)
 *   false      CONTENT    (a checkbox is a value — this is what the
 *                          ghost-row fixture's 994 Stop_Contact cells are)
 *   0          CONTENT
 *   '0'        CONTENT
 *   formula    CONTENT    (stored as '[COMPUTED:=...]', never blank)
 */
function isBlankCellValue(v) {
  return v === '' || v === null || v === undefined;
}

function trimTrailingBlankRows(sheet) {
  while (sheet.data.length > 0) {
    var row = sheet.data[sheet.data.length - 1];
    var hasValue = false;
    for (var c = 0; c < row.length; c++) {
      if (!isBlankCellValue(row[c])) { hasValue = true; break; }
    }
    if (hasValue) return;
    sheet.data.pop();
  }
}

/**
 * The single tail every cell write shares: grow the physical grid to cover
 * what was addressed (the grid and the content extent are different
 * things), then recompute the content extent.
 */
function finishWrite(sheet) {
  if (sheet.data.length > sheet.physicalRowCount) sheet.physicalRowCount = sheet.data.length;
  trimTrailingBlankRows(sheet);
}

function createInMemorySheet(name) {
  return {
    name: name,
    data: [], // array of arrays, data[0] is row 1 — backs getLastRow() (content extent)
    physicalRowCount: 1, // backs getMaxRows() (physical grid size) — DELIBERATELY separate from
                          // data.length: real Sheets distinguishes "how many rows physically
                          // exist" from "how far actual content extends", and a prior version of
                          // this mock conflated the two (both were data.length), which meant a
                          // test could never exercise the real, critical divergent case
                          // (maxRows=1000, lastRow=6) that a correct fixture must handle without
                          // deleting physically-provisioned-but-content-empty rows.
    frozenRows: 0,
    frozenCols: 0,
    protections: [],
    validations: {},
    numberFormats: {}, // 'row:col' -> format string, e.g. '@' for plain text
    formulas: {}, // 'row:col' -> formula string (e.g. '=COUNTIF(...)'), separate from data/getValues()
    getName: function () { return this.name; },
    getLastRow: function () { return this.data.length; },
    getMaxRows: function () { return Math.max(this.physicalRowCount, this.data.length); },
    physicalColumnCount: 26, // backs getMaxColumns(), grown by insertColumnsAfter — real sheets have a finite grid width.
    getMaxColumns: function () {
      var widest = this.physicalColumnCount;
      for (var i = 0; i < this.data.length; i++) if (this.data[i].length > widest) widest = this.data[i].length;
      return widest;
    },
    insertColumnsAfter: function (afterCol, howMany) {
      var target = afterCol + howMany;
      if (target > this.physicalColumnCount) this.physicalColumnCount = target;
    },
    insertRowsAfter: function (afterRow, howMany) {
      // Physical growth only — deliberately does NOT extend `data`
      // (content). A freshly inserted row has no content until something
      // is actually written to it, matching real Sheets.
      var target = afterRow + howMany;
      if (target > this.physicalRowCount) this.physicalRowCount = target;
    },
    setFrozenRows: function (n) { this.frozenRows = n; },
    setFrozenColumns: function (n) { this.frozenCols = n; },
    clear: function () { this.data = []; this.protections = []; this.numberFormats = {}; this.formulas = {}; this.physicalRowCount = 1; },
    autoResizeColumns: function () {},
    appendRow: function (row) { this.data.push(row.slice()); if (this.data.length > this.physicalRowCount) this.physicalRowCount = this.data.length; return this.getLastRow(); },
    deleteRow: function (rowIndex) { this.data.splice(rowIndex - 1, 1); this.physicalRowCount = Math.max(1, this.physicalRowCount - 1); },
    deleteRows: function (start, count) {
      this.data.splice(start - 1, count);
      this.physicalRowCount = Math.max(1, this.physicalRowCount - count);
    },
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
              var cellKey = (row + r) + ':' + (col + c);
              var v = values[r][c];
              if (typeof v === 'string' && v.indexOf('=') === 0) {
                // Mirrors real setValues(): a leading '=' string becomes a
                // real formula, not literal text. Track it separately so
                // getValues() (below) can correctly return a COMPUTED
                // result distinct from the formula string — getFormulas()
                // is the only way to recover the formula itself, exactly
                // like real Apps Script.
                sheet.formulas[cellKey] = v;
                targetRow[col + c - 1] = '[COMPUTED:' + v + ']';
              } else {
                delete sheet.formulas[cellKey]; // overwriting with a literal value clears any prior formula, matching real Sheets.
                targetRow[col + c - 1] = v;
              }
            }
          }
          finishWrite(sheet);
          return this;
        },
        setValue: function (value) {
          while (sheet.data.length < row) sheet.data.push([]);
          var cellKey = row + ':' + col;
          if (typeof value === 'string' && value.indexOf('=') === 0) {
            sheet.formulas[cellKey] = value;
            sheet.data[row - 1][col - 1] = '[COMPUTED:' + value + ']';
          } else {
            delete sheet.formulas[cellKey];
            sheet.data[row - 1][col - 1] = value;
          }
          finishWrite(sheet); // same content-extent rule as setValues — see finishWrite/isBlankCellValue.
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
        getFormulas: function () {
          var out = [];
          for (var r = 0; r < numRows; r++) {
            var outRow = [];
            for (var c = 0; c < numCols; c++) outRow.push(sheet.formulas[(row + r) + ':' + (col + c)] || '');
            out.push(outRow);
          }
          return out;
        },
        setFormula: function (formula) {
          return this.setValues([[formula]]); // single-cell convenience; routes through the same tracked-formula path.
        },
        clearContent: function () {
          var blankRow = [];
          for (var c = 0; c < numCols; c++) blankRow.push('');
          var blankValues = [];
          for (var r = 0; r < numRows; r++) blankValues.push(blankRow.slice());
          return this.setValues(blankValues);
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

var nodeCrypto = require('crypto');

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
      // TIMEZONE AUDIT FIX: a prior version of this mock ignored the `tz`
      // argument entirely and read the given date via raw JS Date getters
      // (getFullYear/getMonth/getDate/getHours/getDay), which resolve
      // according to the EXECUTING NODE PROCESS's own OS/env timezone —
      // NOT the `tz` string passed in. Real Apps Script's V8 runtime
      // happens to honor the project's configured timeZone for those same
      // raw getters, so production code worked; but this mock silently
      // validated Schedule.gs's business-day/send-window logic against
      // whatever timezone the machine running the tests has, not
      // necessarily 'America/Chicago' — a real risk (this repo's own dev
      // machine happens to already be set to America/Chicago, which is
      // exactly why this never surfaced as a visible failure). Rewritten
      // to use Intl.DateTimeFormat with an explicit timeZone, which is
      // environment-independent by specification (verified: resolves
      // 'America/Chicago' correctly even when the Node process itself is
      // forced to TZ=UTC).
      var parts = {};
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short'
      }).formatToParts(date).forEach(function (p) { parts[p.type] = p.value; });
      var hour24 = parts.hour === '24' ? '00' : parts.hour; // Intl quirk: midnight can format as "24" under hour12:false.

      if (pattern === 'yyyy-MM-dd') return parts.year + '-' + parts.month + '-' + parts.day;
      if (pattern === 'u') {
        var weekdayToIso = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
        return String(weekdayToIso[parts.weekday]);
      }
      if (pattern === 'H') return String(Number(hour24));
      if (pattern === 'HH') return hour24;
      if (pattern === 'mm') return parts.minute;
      if (pattern === 'ss') return parts.second;
      if (pattern === 'EEE') return parts.weekday;
      throw new Error('Mock Utilities.formatDate: unsupported pattern "' + pattern + '"');
    },
    sleep: function () { /* no-op in tests */ },
    base64EncodeWebSafe: function (value) {
      return Buffer.from(String(value), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    },
    base64DecodeWebSafe: function (value) {
      var standard = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
      return Array.prototype.slice.call(Buffer.from(standard, 'base64'));
    },
    newBlob: function (bytes) {
      return { getDataAsString: function () { return Buffer.from(bytes).toString('utf8'); } };
    },
    /**
     * Real Apps Script Utilities.computeDigest(algorithm, value, charset)
     * returns a signed byte array (-128..127). Node's crypto gives unsigned
     * 0-255 bytes — converted here so bytesToHex_ in Mailer.gs (which
     * handles the real Apps Script signed-byte convention) round-trips to
     * the exact same hex digest a real Apps Script execution would produce.
     */
    computeDigest: function (algorithm, value) {
      var hash = nodeCrypto.createHash('sha256').update(String(value), 'utf8').digest();
      var bytes = [];
      for (var i = 0; i < hash.length; i++) {
        var b = hash[i];
        bytes.push(b > 127 ? b - 256 : b);
      }
      return bytes;
    },
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' }
  };
}

function createMockGmailApp() {
  var drafts = [];
  var draftCounter = 0;
  var messageCounter = 0;
  var threadCounter = 0;
  var labels = {};
  var threads = {}; // id -> thread mock, for _seedLiveThread / getThreadById
  var messagesById = {}; // Gmail internal id -> message; backs the Advanced Gmail service.
  var sentIndex = []; // {recipientEmail, thread} — backs search(), populated by draft.send()
  // N3/N5 (Codex re-audit): real call counters for the three Gmail side
  // effects that can create/send something. Behavioral tests assert EXACT
  // counts ("exactly one send ever happened"), which is a far stronger
  // proof than inspecting resulting state — state can look identical
  // whether an operation ran once or twice-with-one-failure.
  var callCounts = { createDraft: 0, createDraftReply: 0, send: 0, reply: 0, apiSend: 0, apiGet: 0 };

  function makeMessage(from, to, subject, body, metadata) {
    messageCounter++;
    var id = 'msg-' + messageCounter;
    metadata = metadata || {};
    var message = {
      _id: id,
      _threadId: metadata.threadId || '',
      _headers: {
        From: from, To: to, Subject: subject,
        'Message-ID': metadata.rfcMessageId || ('<mock-' + id + '@example.test>'),
        'In-Reply-To': metadata.inReplyTo || '', References: metadata.references || '',
        'X-Klinner-Body-SHA256': metadata.bodyHash || ''
      },
      _body: body,
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
    messagesById[id] = message;
    return message;
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
      getMessage: function () { return message; },
      /**
       * N5 (Codex final audit, round 2 — real executable tests): real
       * GmailDraft.send() sends the draft and returns the resulting
       * GmailMessage. Consumes the draft (removed from the drafts list —
       * a sent draft is no longer a draft) and creates a real, resolvable
       * thread (getThreadById can find it afterward) with exactly one
       * message. Also indexes it so GmailApp.search('in:sent to:...')
       * can find it — real reconciliation-path testing needs this.
       */
      send: function () {
        callCounts.send++;
        var idx = drafts.indexOf(draft);
        if (idx !== -1) drafts.splice(idx, 1);
        threadCounter++;
        var threadId = 'sent-thread-' + threadCounter;
        var sentThread = {
          getId: function () { return threadId; },
          getMessages: function () { return [message]; },
          getLabels: function () { return []; },
          addLabel: function () {}
        };
        message._ownerThread = sentThread;
        threads[threadId] = sentThread;
        sentIndex.push({ recipientEmail: String(to || '').toLowerCase(), thread: sentThread });
        return message;
      }
    };
    message._ownerThread = thread || { getId: function () { return 'thread-for-' + id; } };
    message.getThread = function () { return message._ownerThread; };
    drafts.push(draft);
    return draft;
  }

  /**
   * Codex atomicity round, P3 — a signature of EVERY piece of shared Gmail
   * mock state, not just the id lists. The previous isolation check
   * compared draft ids and thread ids only, so a test could leave behind a
   * bumped call counter, a created label, or an extra message appended to
   * a thread that already existed, and the suite still reported "clean".
   * Each field is a plain comparable string so verifyCleanTestState_ can
   * diff before/after without any deep-equality machinery.
   */
  function stateSignature() {
    function safe(fn, fallback) {
      try { return fn(); } catch (e) { return fallback; }
    }
    var draftSig = safe(function () {
      return drafts.map(function (d) {
        return safe(function () { return d.getId(); }, 'UNREADABLE') + ':' +
          safe(function () { return String(d.getMessage().getSubject()); }, 'UNREADABLE');
      }).sort().join('|');
    }, 'DRAFT_ENUMERATION_FAILED');

    var threadSig = safe(function () {
      return Object.keys(threads).sort().map(function (tid) {
        var msgs = safe(function () { return threads[tid].getMessages(); }, null);
        if (!msgs) return tid + '#UNREADABLE';
        // Message-LEVEL detail: a reply appended to an already-existing
        // thread changes this even though the thread id set does not.
        return tid + '#' + msgs.length + '#' + msgs.map(function (m) {
          return safe(function () { return m.getId(); }, 'UNREADABLE');
        }).join(',');
      }).join('|');
    }, 'THREAD_ENUMERATION_FAILED');

    var labelSig = safe(function () { return Object.keys(labels).sort().join('|'); }, 'LABEL_ENUMERATION_FAILED');

    var sentSig = safe(function () {
      return sentIndex.map(function (entry) {
        return entry.recipientEmail + '>' + safe(function () { return entry.thread.getId(); }, 'UNREADABLE');
      }).sort().join('|');
    }, 'SENT_INDEX_ENUMERATION_FAILED');

    var countSig = 'createDraft=' + callCounts.createDraft + ',createDraftReply=' + callCounts.createDraftReply +
      ',send=' + callCounts.send + ',reply=' + callCounts.reply + ',apiSend=' + callCounts.apiSend + ',apiGet=' + callCounts.apiGet;

    return { drafts: draftSig, threads: threadSig, labels: labelSig, sentIndex: sentSig, callCounts: countSig };
  }

  return {
    _drafts: drafts,
    _threads: threads,
    _sentIndex: sentIndex,
    _callCounts: callCounts,
    _resetCallCounts: function () {
      callCounts.createDraft = 0; callCounts.createDraftReply = 0; callCounts.send = 0; callCounts.reply = 0;
      callCounts.apiSend = 0; callCounts.apiGet = 0;
    },
    /** P3: full shared-state signature — see stateSignature() above. */
    _stateSignature: stateSignature,
    /**
     * P3: restore the call counters to a previously captured baseline.
     * Tests that assert exact call counts reset them mid-test; teardown
     * puts them back to whatever they were when the test started, so a
     * residual counter is a real, detectable leak rather than the norm.
     */
    _setCallCounts: function (values) {
      callCounts.createDraft = values.createDraft || 0;
      callCounts.createDraftReply = values.createDraftReply || 0;
      callCounts.send = values.send || 0;
      callCounts.reply = values.reply || 0;
      callCounts.apiSend = values.apiSend || 0;
      callCounts.apiGet = values.apiGet || 0;
    },
    _labelNames: function () { return Object.keys(labels).slice(); },
    /** P3: teardown for a label a test created. */
    _removeLabelForTest: function (name) { delete labels[name]; },
    /** Test-only: removes a thread seeded by _seedLiveThread so a test leaves no residual mock state. */
    _removeThreadForTest: function (threadId) {
      var doomed = threads[threadId];
      if (doomed && doomed.getMessages) {
        doomed.getMessages().forEach(function (m) { delete messagesById[m.getId()]; });
      }
      delete threads[threadId];
      for (var i = sentIndex.length - 1; i >= 0; i--) {
        if (sentIndex[i].thread && sentIndex[i].thread.getId() === threadId) sentIndex.splice(i, 1);
      }
    },
    createDraft: function (to, subject, body) {
      callCounts.createDraft++;
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
    /**
     * N5: real (if minimal) query support — parses `to:<email>` out of the
     * query string (the only clause reconcileStaleLiveClaims_ actually
     * uses) and returns every sent thread recorded for that recipient by
     * draft.send() above. `newer_than:` is deliberately NOT enforced (this
     * mock has no notion of "now" independent of what a test seeds) —
     * tests control what's in the index directly, which is a stronger,
     * more explicit form of control than simulating a date filter would be.
     */
    search: function (query) {
      var m = /to:(\S+)/.exec(String(query || ''));
      if (!m) return [];
      var email = m[1].toLowerCase();
      return sentIndex.filter(function (s) { return s.recipientEmail === email; }).map(function (s) { return s.thread; });
    },
    /**
     * Test-only helper: seeds a fake existing LIVE thread with one prior
     * outbound message, so tests can exercise thread.reply()/
     * thread.createDraftReply() and getThreadById() against something real.
     */
    _seedLiveThread: function (recipientEmail, senderEmail) {
      threadCounter++;
      var threadId = 'live-thread-' + threadCounter;
      var messages = [makeMessage(senderEmail, recipientEmail, 'A quick note', 'Original outreach body.', { threadId: threadId })];
      var thread = {
        getId: function () { return threadId; },
        getMessages: function () { return messages.slice(); },
        getLabels: function () { return []; },
        addLabel: function () {},
        /** Real GmailThread.reply() returns the GmailThread itself, NOT a GmailMessage — Codex finding #7. */
        reply: function (body) {
          callCounts.reply++;
          messages.push(makeMessage(senderEmail, recipientEmail, 'Re: A quick note', body));
          return thread;
        },
        createDraftReply: function (body) {
          callCounts.createDraftReply++;
          return makeDraft(recipientEmail, 'Re: A quick note', body, thread);
        }
      };
      threads[threadId] = thread;
      return thread;
    },
    _messagesById: messagesById,
    _makeApiSentMessage: function (fields, threadId) {
      var message = makeMessage(fields.From, fields.To, fields.Subject, fields.body, {
        threadId: threadId, inReplyTo: fields['In-Reply-To'], references: fields.References,
        bodyHash: fields['X-Klinner-Body-SHA256']
      });
      message._threadId = threadId;
      if (!threads[threadId]) throw new Error('Mock Gmail API: unknown threadId ' + threadId);
      var existing = threads[threadId];
      var current = existing.getMessages();
      current.push(message);
      existing.getMessages = function () { return current.slice(); };
      sentIndex.push({ recipientEmail: String(fields.To || '').toLowerCase(), thread: existing });
      return message;
    }
  };
}

function createMockGmailAdvancedService(gmailApp) {
  function parseRaw(raw) {
    var standard = String(raw || '').replace(/-/g, '+').replace(/_/g, '/');
    var source = Buffer.from(standard, 'base64').toString('utf8');
    var split = source.split(/\r?\n\r?\n/);
    var headerLines = split.shift().split(/\r?\n/);
    var headers = {};
    headerLines.forEach(function (line) {
      var colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon)] = line.slice(colon + 1).trim();
    });
    headers.body = split.join('\n\n');
    return headers;
  }

  function resourceFor(message) {
    return {
      id: message._id,
      threadId: message._threadId,
      payload: {
        body: { data: Buffer.from(String(message._body || ''), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_') },
        headers: Object.keys(message._headers).filter(function (name) { return message._headers[name] !== ''; }).map(function (name) {
          return { name: name, value: message._headers[name] };
        })
      }
    };
  }

  return {
    Users: { Messages: {
      send: function (resource) {
        gmailApp._callCounts.apiSend++;
        var fields = parseRaw(resource.raw);
        var message = gmailApp._makeApiSentMessage(fields, resource.threadId);
        return { id: message._id, threadId: message._threadId };
      },
      get: function (userId, messageId) {
        gmailApp._callCounts.apiGet++;
        var message = gmailApp._messagesById[messageId];
        if (!message) throw new Error('Mock Gmail API: message not found: ' + messageId);
        return resourceFor(message);
      }
    } }
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
  sandbox.Gmail = createMockGmailAdvancedService(sandbox.GmailApp);
  sandbox.LockService = createMockLockService();
  sandbox.ScriptApp = createMockScriptApp();
  sandbox.Session = {
    getScriptTimeZone: function () { return 'America/Chicago'; },
    getEffectiveUser: function () { return { getEmail: function () { return 'test-resolved-sender_email@example.com'; } }; }
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
