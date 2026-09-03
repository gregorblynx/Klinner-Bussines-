# N5 — LIVE send concurrency audit (blocker before first LIVE email)

Status: **round 2 hardening applied and tested locally — NOT independently verified as closed.** Round 1's "CLOSED" claim (below the fold, superseded) was itself found insufficient by an independent Codex audit, which confirmed three structural gaps. All three are now fixed and covered by real executable tests (not just static checks), but per that same audit's explicit instruction, this document does not claim "N5 CLOSED" again until a fresh independent audit confirms it.

## 1. What round 1 got wrong (Codex final audit findings)

Round 1's design wrote `LEDGER_STATE.FAILED` on an ambiguous Gmail outcome (a `draft.send()` or `GmailThread.reply()` call that threw, or an unverifiable message-count result) and relied ENTIRELY on a second, independent write — `Prospects.Status = NEEDS_REVIEW` — to keep the prospect from being retried. Codex identified why this was not sufficient:

- **A.** If that second Prospects write itself failed (a real possibility — same class of Sheets API failure as the Gmail call itself), `FAILED` alone is retryable (`isLiveKeyClaimedOrSent_`/I13 only excluded `CLAIMED`/`SENT`) and the prospect could still show its pre-send `Status`. A later run could genuinely send twice.
- **B.** Same structural gap on the follow-up (`GmailThread.reply()`) path.
- **C.** `reconcileStaleLiveClaims_`'s stale-claim reconciliation transitioned a zero-Gmail-search-result claim to `LEDGER_STATE.ABANDONED` — a state `isLiveKeyClaimedOrSent_` did **not** treat as blocking. A negative search result does not prove Gmail never sent (search delay, too-narrow query, message elsewhere) — this was a real, additional path to a duplicate send, previously (incorrectly) assessed in this document as "not a duplicate-send risk." That assessment was wrong; Codex's audit is the correct one.

**The non-negotiable principle Codex stated, now the design rule for this whole area:** after invoking a Gmail operation that could have sent, if the outcome is uncertain, the idempotency key must become durably blocked **in the ledger itself** — never merely via a second write to Prospects, which can independently fail.

## 2. Round 2 design

Added `LEDGER_STATE.AMBIGUOUS` (Constants.gs) — included in the ledger-blocking check (renamed `isLiveKeyClaimedOrSent_` → `isLiveKeyBlocked_`, Ledger.gs) alongside `CLAIMED`/`SENT`. On every ambiguous outcome, the ledger row is written to `AMBIGUOUS` (a durably blocking state) — the Prospects `NEEDS_REVIEW` write remains, but now purely as a **secondary, operational** signal for dashboards/human review; its success or failure has zero bearing on whether a retry is possible.

Applied to:
- `doStep1Send_`'s `catch (sendError)` — `draft.send()` throwing.
- `doFollowUpSend_`'s `catch (replyError)` — `thread.reply()` throwing (a gap round 1 did not even address — only the message-count-mismatch case was handled before).
- `doFollowUpSend_`'s `messagesAfter.length !== messagesBefore + 1` guard.
- `reconcileStaleLiveClaims_` (Recon.gs) — zero-result AND multi-result stale-claim outcomes now both resolve to `AMBIGUOUS`, never `ABANDONED`. Search window widened `newer_than:2d` → `newer_than:30d` (reduces false-ambiguous flagging from delayed reconciliation; does not change the safety property — a false negative already failed closed to `AMBIGUOUS` either way). A `GmailApp.search()` failure now leaves the row completely untouched (still `CLAIMED`, already blocking) rather than attempting any transition.

## 3. Why this closes gap A/B specifically (Prospects write failing)

Because the ledger write is no longer conditioned on, or ordered after, the Prospects write — it happens first (or independently), and a failure in the Prospects write is caught and logged separately without affecting the already-written ledger state. Proven directly by `test_N5_step1SendThrowsDurablyBlocksLedgerEvenIfProspectsWriteFails_` and `test_N5_followUpMessageCountMismatchDurablyBlocksEvenIfProspectsWriteFails_` (Tests.gs), which deliberately break `writeRowById_` globally for the duration of the test and confirm the ledger row still reaches `AMBIGUOUS` and a second execution is still blocked.

## 4. Real executable tests (round 2 — static checks alone were rejected as insufficient)

Codex explicitly required real tests, not static source-pattern checks, for N5 — the ONE deliberate, well-audited exception to this project's "never flip `DRY_RUN=FALSE` locally" policy. `withLiveModeEnabledForTest_` (Tests.gs) resolves all 5 `PENDING_F0` keys, sets `DRY_RUN=FALSE`, and widens the send/reply window to "always open" (so tests are never flaky depending on real wall-clock time), restoring every value in `finally`. New mock capability: `GmailDraft.send()` (creates a real resolvable sent thread, indexes it for search) and a real (if minimal) `GmailApp.search()` implementation (gas-mocks.js).

14 real tests (`test_N5_*`), covering: step-1 send() throwing (with and without the Prospects write also failing), a second execution never re-sending, follow-up reply() throwing, the message-count mismatch (with and without the Prospects write also failing), a second execution never re-replying, the normal confirmed paths (exactly one send / exactly one reply), a confirmed `SENT` key remaining blocked, stale-claim reconciliation with zero search results / a search error / exactly one match, and confirming neither `nightlyRecon` nor `dailyDigest` ever converts an `AMBIGUOUS` key back to retryable.

## 5. Mutation coverage

`test-harness/mutation-test-N5.js` rewritten as a BEHAVIORAL (runtime-suite) mutation test — 4 mutations: AMBIGUOUS removed from the ledger-blocking check; the follow-up reply-throw handler downgraded back to `FAILED`; the Recon zero-result branch reverted to `ABANDONED`; and (the deepest one) the ledger CLAIM itself moved from before the risky Gmail call to after it succeeds, reproducing "no ledger protection exists while a Gmail operation that could have sent is in flight." All 4 independently caught by their intended test, none by accident overlap alone.

## 6. What AT-MOST-ONCE means here

Not a database transaction — Apps Script/Gmail offer no such thing. The guarantee: every code path that cannot prove a Gmail send/reply did or did not happen durably blocks that idempotency key **in the ledger**, the one place proven (by test) to hold regardless of any other write's success or failure. Combined with the pre-existing claim-before-attempt ordering and lock/idempotency-key machinery (unchanged, already correct), this is the practical, honest AT-MOST-ONCE bar for this architecture.

## 7. Files changed (round 2)

`Constants.gs` (AMBIGUOUS state), `Ledger.gs` (rename + AMBIGUOUS in the blocking check), `Mailer.gs` (both ambiguous-outcome sites), `Recon.gs` (stale-claim reconciliation rewrite), `test-harness/gas-mocks.js` (`draft.send()`, `search()`), `Tests.gs` (14 new tests + `withLiveModeEnabledForTest_`), `test-harness/mutation-test-N5.js` (rewritten), `test-harness/verify-static-findings.js` (round-1 checks replaced with a minimal structural sanity check — real tests now carry the actual proof).

## 8. Validation

Full local suite, static verifier, and every mutation suite (N7, ghost-row, N3, N4, N5, timezone) — all green, confirmed identically under `TZ=America/Chicago`, `TZ=UTC`, `TZ=Asia/Kolkata`. Exact counts in `AUTOPILOT_FIX_REPORT.md`.

## 9. Still Google-real only

Real concurrent Apps Script executions, real Gmail send/reply timing, and real `GmailApp.search()` behavior (indexing delay, query semantics) cannot be proven from this environment. The local mocks now model the HAPPY and the explicitly-specified failure paths faithfully, but this remains a code-level/logical proof, not a live-Gmail one — see `PRODUCTION_CHECKLIST.md`.
