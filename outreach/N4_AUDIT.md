# N4 — SYSTEM-origin unsubscribe guard (blocker before F3)

Status: **CLOSED**.

## 1. Definition (recovered from source, not invented)

Per `Constants.gs` (comment above `OPERATION_PERMISSIONS[OPERATION.SYSTEM_REPLY_SYNC]`, before tonight's fix) and `README.md`'s "Two known items to close before going further" section:

> Neither `SYSTEM_REPLY_SYNC` nor `SYSTEM_NIGHTLY_RECON` had a `restrictedValues` entry for `Do_Not_Contact_Reason`, unlike `ADMIN_VALIDATE`/`ADMIN_STOP` (Codex findings #2/#3), which are structurally forbidden from ever setting `DNC="unsubscribe"`.

`ADMIN_VALIDATE` and `ADMIN_STOP` both carry `restrictedValues: { Do_Not_Contact_Reason: [...] }` excluding `"unsubscribe"` — because setting that specific value has a side effect (a permanent `Suppression(email)` record) that only `applyUnsubscribeEffects_()` (Recon.gs) is allowed to guarantee. `SYSTEM_REPLY_SYNC`/`SYSTEM_NIGHTLY_RECON` had no such restriction — a future SYSTEM-origin write path touching that column could set `"unsubscribe"` without ever creating the Suppression record, silently breaking the unsubscribe guarantee.

## 2. Impact / reproduction

**Latent, not active** at the time of the original finding — verified then (and re-verified tonight) via `grep -n "Do_Not_Contact_Reason" ReplySync.gs Recon.gs`: `SYSTEM_REPLY_SYNC` only ever wrote `"bounce"` (bounce classification) and `"manual"` (the `KLINNER/Stop` label escape hatch); `SYSTEM_NIGHTLY_RECON` never wrote that column at all (it only reads it in `syncDncToStopContact_`). No exploit existed in F1/F2 code. The risk was purely structural: **the permission list had a gap that F3 work could fall into without anyone noticing**, since nothing would reject it.

Reproduction (pre-fix, confirmed by first running the new test against the old Constants.gs): calling
```js
writeRowById_(prospectId, { Do_Not_Contact_Reason: 'unsubscribe' }, { origin: ORIGIN.SYSTEM, operation: OPERATION.SYSTEM_REPLY_SYNC });
```
succeeded silently — no Suppression record created, no error.

## 3. Dependency with N3/N5

None. N4 is isolated to `Constants.gs`'s permission tables and `Recon.gs`/`ReplySync.gs`'s existing write patterns — it does not touch Gmail, drafts, the SendLedger, or LIVE sending. Verified no overlap with the N3/N5 changes made tonight.

## 4. Fix

Added the same `restrictedValues` pattern `ADMIN_STOP` already used to both operations in `Constants.gs`:
```js
restrictedValues: {
  Do_Not_Contact_Reason: DNC_REASON_VALUES.filter(function (r) { return r !== DNC_REASON.UNSUBSCRIBE; })
}
```
No other code changed — `authorizeWrite_`'s `restrictedValues` enforcement (SheetRepo.gs) is already generic and column-driven; adding the config entry alone activates real rejection. Confirmed via `grep -n "restrictedValues"` in SheetRepo.gs that the check only fires `if (fields.hasOwnProperty(col) && fields[col] !== '')`, so it cannot affect any existing write that doesn't touch `Do_Not_Contact_Reason` (e.g. `syncDncToStopContact_`, `closeFinishedSequences_`, `reconcileStaleLiveClaims_`).

## 5. Tests

`test_N4_systemOperationsCannotSetUnsubscribeReason_` (Tests.gs) — negative cases (both operations rejected when attempting `"unsubscribe"`) AND positive cases (both operations' actual production values — `bounce`, `manual`, `duplicate` — still succeed, proving the guard is precise, not a blanket lockout).

## 6. Mutation test

`test-harness/mutation-test-N4.js` — removes each operation's `restrictedValues` entry independently; both mutations are caught exclusively by `N4_systemCannotSetUnsubscribe`.

## 7. Validation

Suite 56/56, static 16/16, mutation N4: PASS (2/2). Full regression (N7, ghost-row, N3 V3, N5) unaffected.

## 8. Google-real gate

None — this is a pure permission-table hardening with no Google-real dependency. Nothing further required before F3 on this specific item.
