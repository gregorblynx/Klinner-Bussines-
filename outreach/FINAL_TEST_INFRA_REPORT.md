# Final test-infra fix — after Codex final audit

Both remaining local blockers closed. No production code changed. Nothing pushed, nothing touched on Google.

## 1. `_configCache` baseline model

`_configCache` is declared in [Config.gs](Config.gs) as a module-level `var`, populated by `getConfig()` and cleared by `resetConfigCache_()`. It is shared mutable state that no sheet comparison can see — which is exactly why the false negative was possible: in the reported case the Config *sheet* is untouched and only the in-memory copy diverges.

The baseline has to distinguish **three** states, not two:

| state | signature |
|---|---|
| nothing cached | `NULL` |
| cached, agreeing with the sheet | full sorted key/value JSON |
| cached, **diverging** from the sheet | a *different* full key/value JSON |

`configCacheSignature_` encodes null-ness plus the complete content, so both "was null, now populated" and "was populated, now says `MAX_PER_DAY=999`" register as changes. Cached values are strings, numbers, booleans and string arrays (see `coerceConfigValue_`), so sorted-key JSON is a faithful and comparable rendering.

## 2. Reset / restore implementation

`captureConfigCache_()` stores both the signature and a **deep copy**; `restoreConfigCache_()` puts back exactly that, calling `resetConfigCache_()` when the baseline was null. `cleanupTestArtifacts_` restores it per test.

Two deliberate choices:

- **Restore the baseline, not a fixed value.** Nothing hardcodes `MAX_PER_DAY=5`. A test that legitimately starts with a populated cache gets that cache back.
- **Deep copy, not the object reference.** A test that mutates the cache *in place* mutates the very object a reference-based capture would hand back — "restoring" it to its own mutation. `test_configCache_baselineObjectRestoredExactly` mutates in place specifically to pin this down.

There are **two independent detectors**, because they fail on different things:

1. `verifyCleanTestState_` compares the cache against this test's own baseline — catches "changed it and didn't put it back".
2. `configCacheCoherenceProblem_` re-reads the Config sheet with the cache bypassed and compares — catches "the cache no longer agrees with the sheet", and fires **even if the baseline was already contaminated**, which a before/after diff would call "unchanged".

New tests: `configCache_baselineNullRestored`, `configCache_baselineObjectRestoredExactly`, `configCache_divergenceDetected` (the last asserts the sheet is untouched, that `999` is not the real value, that both detectors fire, and that `verifyCleanTestState_` itself reports it).

## 3. Config-cache leak enforcement

Scenario 8 in [verify-isolation-enforcement.js](test-harness/verify-isolation-enforcement.js): the Config **sheet** stays completely correct, `MAX_PER_DAY=999` goes into the cache only, and the per-test restore is removed so the contamination survives teardown.

```
8. contaminated _configCache (Config sheet untouched):
   functional 95/95 PASS, isolation clean 28/95 FAIL, exit=1
```

Every functional assertion stays green. The failure comes entirely from the isolation gate.

## 4. Independent checker

[verify-post-suite-sandbox.js](test-harness/verify-post-suite-sandbox.js) now inspects the cache with its **own** rendering (`configCacheView`) and its **own** coherence probe, written there rather than imported — reusing `configCacheSignature_` would reintroduce the shared failure mode this file exists to rule out.

Real run, all three timezones:

```
before: NULL (nothing cached)
after : NULL (nothing cached)
equality: identical
coherence: nothing cached, so nothing can diverge from the Config sheet
```

The exact leak Codex reported — cache null before, populated after — is closed at suite level.

Verified as a detector, not just asserted: injecting a divergent cache into a copy of the checker produced

```
LEAK  _configCache: before=NULL (nothing cached) | after=CACHED{...}
LEAK  _configCache coherence with the Config sheet: DIVERGENT keys: MAX_PER_DAY
POST-SUITE SANDBOX INSPECTION: FAIL
exit code 1
```

## 5. `setValue` blank-extent fix

The previous round taught the mock that real Sheets tracks a content extent and does not grow it with blanks — but wired that into `setValues()` only, leaving `setValue()` on the old `data.length` behaviour. Both now route through a single `finishWrite(sheet)`, which grows the **physical grid** (a different thing) and then recomputes the **content extent**. Blanking the last cell that held content shrinks the extent back again, as in real Sheets.

Fixed in [gas-mocks.js](test-harness/gas-mocks.js) only. No production code was involved — production never sees the difference.

## 6. `setValue` / `setValues` consistency

| write at row 1000 | before | after |
|---|---|---|
| `setValues([['']])` | `getLastRow()` = 1 | `getLastRow()` = 1 |
| `setValue('')` | `getLastRow()` = **1000** | `getLastRow()` = 1 |

Case 3 of [verify-mock-sheet-extent.js](test-harness/verify-mock-sheet-extent.js) asserts the two agree directly, rather than testing each in isolation and hoping.

## 7. false / 0 / formula behaviour

The blank rule is now stated once, in `isBlankCellValue`:

| value | verdict |
|---|---|
| `''` | blank |
| `null` | blank (a cleared cell; matches how `getValues()` renders never-written rows) |
| `undefined` | blank (an unwritten cell inside a short row array) |
| `false` | **content** — a checkbox is a value |
| `0` | **content** |
| `'0'` | **content** |
| formula | **content** (stored as `[COMPUTED:=…]`, never blank) |

`false` matters most: the ghost-row fixture's 994 `Stop_Contact` cells are exactly that, and treating them as blank would silently gut the fixture.

## 8. Ghost-row regression

Unchanged and green: `ghostRowsNeverBecomeProspects`, `ghostRowFixtureNonDestructive` and `preexistingRow500SurvivesNested` all pass in all three timezones, and `mutation-test-ghost-rows.js` still passes. The new verifier also proves *why* the ghost-row mutation could not have caught this bug: under the `setValue` mutation, the `setValues` case stays green, and the ghost-row fixture only ever writes through `setValues`.

## 9. Files modified

`Tests.gs`, `test-harness/gas-mocks.js`, `test-harness/verify-isolation-enforcement.js`, `test-harness/verify-post-suite-sandbox.js`, new `test-harness/verify-mock-sheet-extent.js`, and this report.

## 10. Commits (local only)

```
f1bb2e2 test(outreach): align setValue blank extent with Sheets semantics
16d9391 test(outreach): include config cache in real sandbox isolation
```
plus this report. `.gitignore`, `auditoria-seo-klinnercleaning.html` and `imagen para cambio.HEIC` were left untouched and excluded from every commit.

## 11. Functional

**95/95 PASS** (was 92; +3 config-cache tests).

## 12. Isolation

**95/95 clean**, now including `_configCache` in both the per-test baseline comparison and the sheet-coherence check.

## 13. Static

**14/14 PASS**

## 14. Mutations / verifications

| suite | scope | result |
|---|---|---|
| N3 | 13 mutations (A–M) | PASS |
| N5 behavioral | 5 mutations (A–E) | PASS |
| N4 | 2 mutations | PASS |
| N7 | 2 mutations | PASS |
| ghost rows | 1 mutation | PASS |
| timezone | 3 mutations | PASS |
| isolation enforcement | 8 scenarios | PASS |
| **mock sheet extent** *(new)* | 12 cases + 1 mutation | PASS |

Isolation enforcement, in full — every scenario keeps the functional gate all-green and still forces a non-zero exit:

| scenario | functional | isolation | exit |
|---|---|---|---|
| 1. unmodified | 95/95 PASS | 95/95 PASS | 0 |
| 2. sheet-row residue | 95/95 PASS | 0/95 FAIL | 1 |
| 3. leaked Gmail draft | 95/95 PASS | 94/95 FAIL | 1 |
| 4. leaked call counter | 95/95 PASS | 60/95 FAIL | 1 |
| 5. leaked Gmail label | 95/95 PASS | 93/95 FAIL | 1 |
| 6. message appended to a pre-existing thread | 95/95 PASS | 94/95 FAIL | 1 |
| 7. untracked Suppression row | 95/95 PASS | 94/95 FAIL | 1 |
| 8. contaminated `_configCache` | 95/95 PASS | 28/95 FAIL | 1 |

## 15. Three-timezone results

`America/Chicago`, `UTC`, `Asia/Kolkata` — identical in all three: functional 95/95, isolation 95/95, static 14/14, post-suite sandbox PASS, mock extent PASS, and all seven mutation/enforcement suites PASS.

## 16. Independent sandbox result

Every dimension byte-identical to the pre-suite baseline, in all three timezones:

```
drafts 0=0 · threads 0=0 · messages 0=0 · labels 0=0 · sentIndex 0=0
callCounts {createDraft:0, createDraftReply:0, send:0, reply:0}
_configCache NULL (nothing cached) · coherence: nothing cached
Prospects / SendLedger / Log / Suppression / Config / Templates identical
script lock free · 10/10 patched functions restored
```

## 17. Production-code changes

**None.** No `.gs` file outside `Tests.gs` was touched, and no test surfaced a production bug that would have required one. Both blockers were test-infrastructure defects and were fixed there. Regression confirms the previously-passing production behaviour is untouched: N3 atomicity, N5 call counts, Recon, N4, timezone/DST, ghost rows, fingerprint and PREVIEW_CLAIMED blocking all still pass.

## 18. Self-audit

1. **Can `_configCache` change and isolation still PASS?** No — scenario 8, `configCache_divergenceDetected`.
2. **Can a cached `MAX_PER_DAY=999` sit behind a sheet that says 5 and isolation still PASS?** No — that is the literal case both detectors and scenario 8 are built on.
3. **Can `setValue('')` at row 1000 extend `getLastRow()`?** No — case 1, red under the mutation.
4. **Does `setValue(false)` still count as content?** Yes — case 4.
5. **Does `setValue(0)` still count as content?** Yes — case 5 (and `'0'`, case 6).
6. **Does a formula still count?** Yes — case 7.
7. **Are the ghost-row tests still green?** Yes — all three, plus their mutation suite, in all three timezones.
8. **Did any production file have to change?** No.

## 19. Remaining LOCAL blockers

None.

## 20. Remaining GOOGLE-REAL-only gates

Unchanged from the previous round:

- Real `SpreadsheetApp.flush()` durability — the metadata-before-State ordering assumes a flush that returns has persisted. The mock's flush is a no-op because its writes are synchronous, so this is the one assumption in the atomicity design that only Google can confirm.
- Gmail fingerprint round-trip stability on an untouched real draft.
- Real concurrent Apps Script executions, real Gmail send/reply timing and quota behaviour, real `GmailApp.search` semantics.
- The SendLedger N:P migration (`repairSendLedgerColumns()`), and the whole `F1_GOOGLE_CLOSURE_PLAN.md` sequence.
- Operationally new, worth watching on the first real Preview runs: a killed execution leaves a `PREVIEW_CLAIMED` row that blocks that prospect until a human clears it. Intended trade — a blocked preview beats a duplicate draft.

## 21. Verdict

**READY FOR CODEX FINAL SIGN-OFF**

No push. No Google. No Gmail real. No LIVE. No triggers. `DRY_RUN`, `MAX_PER_DAY` and the `PENDING_F0` values untouched.
