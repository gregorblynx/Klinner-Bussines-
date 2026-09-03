# F0 — production Config values (spec, not applied)

Status: **spec only**. `Config` on the real Sheet still has all 5 `PENDING_F0` values — untouched tonight, per the hard stop ("NO modificar Config Google real"). This is the exact list Gregor needs to fill in before `DRY_RUN` can ever go `FALSE` (`assertLiveAllowed_`/I21 blocks LIVE on any of them).

## Mailbox decision

**Rule applied**: one dedicated outreach mailbox, on the existing verified domain (`klinnercleaning.com` — confirmed already live and DNS-verified, since it's the site's own domain). No new domains purchased or configured. The existing public contact address, `info@klinnercleaning.com` (already established — see git history), is the "critical main inbox" this rule says not to reuse for cold outreach: front-desk/customer traffic and cold-outreach replies should not mix in the same inbox.

**Recommendation**: create `outreach@klinnercleaning.com` as a real Gmail mailbox (or a Workspace alias with its own inbox, if Klinner is on Google Workspace for this domain — confirm which before creating) on the same domain. This is the ONE new thing needed; everything else below reuses it or points to an already-existing address.

## The 5 keys

| Key | Recommended value | Why |
|---|---|---|
| `SENDER_EMAIL` | `outreach@klinnercleaning.com` | The dedicated mailbox above — this IS the Gmail account the Apps Script project must be bound to / run as (Apps Script sends as the account running the script; confirm the project's owning account is this mailbox, or reconfigure — see Validation below). |
| `REPLY_TO` | `outreach@klinnercleaning.com` (same as SENDER_EMAIL) | Replies land in the SAME dedicated inbox the outreach system already monitors (`syncReplies` reads from this account's Gmail). Using a different Reply-To would split replies away from where the system looks for them — a real functional requirement, not just a preference. |
| `ADMIN_EMAIL` | Gregor's own existing working email (not a new mailbox — this is only a destination for the daily digest / failure alerts) | **TBD — needs Gregor's actual address**; not invented here since it's a real personal/business inbox choice. |
| `PHYSICAL_ADDRESS` | Klinner Cleaning & Maintenance's real business mailing address | **CAN-SPAM requirement** (US law) — every commercial email must include a real postal address. Must be Klinner's actual registered/mailing address, not a placeholder. **TBD — needs Gregor's input**, not invented here. |
| `UNSUBSCRIBE_LINE` | e.g. `"To stop receiving these emails, reply with 'unsubscribe' or contact outreach@klinnercleaning.com."` | Must describe a REAL, working opt-out mechanism. This codebase's actual unsubscribe path is a human reply that `syncReplies`/`classifyInboundMessage_` (ReplySync.gs) detects and routes through `applyUnsubscribeEffects_` — so the line's promised mechanism (reply to unsubscribe) must match what the code actually honors. Confirm the exact classification keywords `classifyInboundMessage_` looks for before finalizing this exact wording, so the promise and the implementation agree. |

## Validation checklist (before setting any of these for real)

1. Confirm which Google account the Apps Script project is bound to / executes as (`Session.getEffectiveUser()` — already used defensively in `SheetRepo.gs`'s protection setup). `SENDER_EMAIL` should match that account, or the project needs to be re-bound/shared appropriately — a real Google-side step, not a code change.
2. Confirm `outreach@klinnercleaning.com` (or whatever mailbox is chosen) actually exists and can send/receive before setting `SENDER_EMAIL`/`REPLY_TO` — a config value pointing at a mailbox that doesn't exist yet would make `syncReplies()` and LIVE sending fail loudly on the first real run.
3. Confirm domain-level deliverability basics for `klinnercleaning.com` (SPF/DKIM/DMARC) are in reasonable shape for cold outreach — this is a DNS/domain-admin task, outside this codebase and outside tonight's scope, but worth flagging: cold outreach from a domain with no SPF/DKIM record is likely to land in spam regardless of how correct the code is.
4. `PHYSICAL_ADDRESS` and the unsubscribe mechanism are legal requirements (CAN-SPAM) — get these exactly right before the first real LIVE send, not approximately right.

## What this spec deliberately does NOT do

Does not set any Config value on the real Sheet (hard stop, respected). Does not invent Gregor's personal email or Klinner's mailing address (real facts only he can supply). Does not decide Workspace-vs-plain-Gmail account structure for `outreach@klinnercleaning.com` — that depends on how Klinner's domain email is currently hosted, unknown from this repo alone.
