# F1 Google closure plan

For Gregor, once N3 V3 (and this session's other local fixes) have been Codex-audited and are approved for push. Each step: what Gregor does, what I (Claude) can verify from here, the PASS condition, and the STOP condition. **Nothing in this plan is executed by this session — it is the checklist for the NEXT session that has explicit push/Google authorization.**

| # | Step | Gregor's action | What I can verify | PASS | STOP if |
|---|---|---|---|---|---|
| 1 | Verify remote files | none (I run `clasp status`/`clasp push` output review) | `clasp push` output lists exactly the 16 `.gs` + `appsscript.json` = 17 files, `Tests.gs` absent | Matches exactly | Any unexpected file listed, or `Tests.gs` present |
| 2 | `repairSendLedgerColumns()` | Run it from the Apps Script editor's function dropdown | Ask Gregor to paste the function's return string | Returns `"Added SendLedger headers N1:P1..."` (first run) or `"...already has...nothing to repair."` (idempotent re-run) | Any error thrown |
| 3 | Inspect N:P | Open SendLedger, screenshot or read out row 1 columns N-P | Compare against expected headers `Draft_Fingerprint`, `Human_Edit_Preserved`, `Human_Edit_Detected_At` | Exact match | Any other text, or blank |
| 4 | Verify A:M untouched | Same screenshot | Compare column A-M headers against the pre-existing 13 (`Run_ID`...`Error`) and spot-check a few known data rows (Rosa/Acme) for unchanged values | Byte-identical | Any existing header or data cell changed |
| 5 | First post-migration Preview | Run "Preview today's queue" from the menu | Ask Gregor to report the outcome + read the **SendLedger** sheet's superseded row for Rosa/Acme's `Error` column (NOT the Log sheet — `LEGACY_BASELINE_PRESERVED`/`HUMAN_EDIT_PRESERVED` are ledger `Error`-column markers written by `preserveDraftDurably_`, they are not `LOG_EVENT` tokens; the Log sheet instead shows a `DRAFT_SUPERSEDED` row with a plain-English message) | No delete, no new draft for Rosa/Acme; SendLedger's superseded row for the key shows `LEGACY_BASELINE_PRESERVED:` or `HUMAN_EDIT_PRESERVED:` at the start of its `Error` column | Rosa or Acme's draft disappears, or TEST EDIT is gone |
| 6 | Rosa preserved | Open Rosa's draft in Gmail | Ask Gregor to confirm Draft_ID matches what SendLedger now shows as the active row | Same Draft_ID as before the push | Draft_ID changed, or draft missing |
| 7 | TEST EDIT intact | Read Rosa's draft body | Ask Gregor to paste/confirm the body still contains "TEST EDIT" | Present, unchanged | Missing or altered |
| 8 | Same Draft_ID Rosa | SendLedger active row for Rosa | I read the value Gregor reports | Matches step 6 | Mismatch |
| 9 | Zero duplicate | Count Gmail drafts for Rosa's address | Ask Gregor to confirm count | Exactly 1 | 2+ |
| 10 | Acme legacy safe | Open Acme's draft | Ask Gregor to confirm it exists, unchanged, Draft_ID stable | Preserved (durably, per legacy policy), not deleted | Deleted or duplicated |
| 11 | Fingerprint stability on an UNTOUCHED Gmail draft | Run Preview a second time on a prospect whose draft nobody touched | Ask Gregor for the outcome | Normal CASO 1 regeneration (old deleted, new created) — proves the fingerprint does NOT false-positive on a genuinely untouched draft | It gets flagged as "edited" when nothing was touched — would mean N3-5 (Gmail read stability) needs revisiting |
| 12 | Second Preview | Run Preview again on Rosa (already preserved) | Ask Gregor to confirm status | `SKIPPED_DRAFT_PRESERVED_HUMAN_EDIT`, no new draft, no ledger growth | Any new draft or new ledger row appears |
| 13 | Third Preview | Run Preview a third time on Rosa | Same | Same result, still no growth | Any change |
| 14 | Outsider draft | Manually create a personal (non-Klinner) draft in the same Gmail account, run Preview/Validate/bulk cleanup | Ask Gregor to confirm it's untouched | Never touched, never deleted | Touched at all |
| 15 | Follow-up preview | Preview a step-2+ prospect (needs a LIVE Thread_ID — likely N/A until F2; skip if no such prospect exists yet) | Ask Gregor | Reply-style draft created correctly, or cleanly skipped if no eligible prospect | Wrong thread used |
| 16 | `dailyDigest` PENDING_F0 behavior | Run `dailyDigest()` manually | Ask Gregor for the returned object/Log entry | `sent: false, reason: 'ADMIN_EMAIL_PENDING_F0'` — no email sent | Any email actually sent |
| 17 | Triggers absent | Check Apps Script's Triggers page | Ask Gregor to confirm empty (or list what's there) | Zero managed triggers installed | Any of the 4 managed triggers present |
| 18 | `DRY_RUN` TRUE | Read Config | Ask Gregor to confirm | `TRUE` | `FALSE` |
| 19 | `MAX_PER_DAY=5` | Read Config | Ask Gregor to confirm | `5` (or whatever Gregor has deliberately set — just confirm it's a real, intended value) | Blank or unexpected |
| 20 | Zero LIVE sends | Check SendLedger for any `Mode=LIVE` row | Ask Gregor to confirm none exist, or that any that do predate this session and are already understood | Zero unexplained LIVE rows | Any new, unexplained LIVE row |

## Overall gate

Steps 1-4 must fully PASS before step 5 (the first real Preview run against the migrated schema) proceeds. Steps 5-15 are the N3 V3 real-world proof — if ANY of them fail, treat it as a live incident: stop, do not run further Preview/Validate/cleanup actions, and bring the exact failure back for analysis before continuing. Steps 16-20 are the standing F1 invariants — they should already be true and are a final confirmation, not new work.
