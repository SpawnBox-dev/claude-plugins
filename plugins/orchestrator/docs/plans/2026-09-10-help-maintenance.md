# HELP global recovery and durable follow-up jobs

Status: stages 1-2 deployed as commit 7663640; stages 3-5 remain to implement.
The scoped metric reader 1197995 also supplies live operational evidence.
Continues the user-approved
operational-parity work item dbfca67d. Preserve the existing Claude implementation,
live admitted conversations, shared knowledge CRUD and quota recovery.

## Existing behavior and boundaries

Gateway catch-up already preserves missed admitted messages, embeds, attachments,
DM mappings and coverage cursors. It does not perform the record-side bootstrap
checks in SpawnBox's maintained discord-bootstrap command: tracked engagements,
shared KB changes, orphaned commitments and the diagnostic-upload backstop.
Normal workers can read only their audience's permitted channels and can speak
only in their admitted conversation. A global review needs a distinct trusted
origin and broader internal reads; it must not pretend an owner sent a message.

The maintained playbook remains authoritative for behavior: check actual channel
history before claiming somebody was contacted; silence does not prove resolution;
do not re-nudge a properly discharged, unanswered follow-up. Unsolicited third-party
DM nudges require operator review. Routine polling crons are retired. In-app
diagnostic writes were gated in the Claude bot, so a port must not silently turn
that denied operation into an unrestricted mutating HTTP tool.

## Delivery stages

1. Add durable review jobs with trusted metadata outside participant payloads.
   Keep review queues separate from incoming conversations so a review needing
   operator attention cannot block a human's next message. Reuse existing leases,
   receipts, quota pause and persistent Codex task identity. Synthetic event IDs
   are explicit local identifiers, never presented as Discord message IDs.
2. Add bounded scheduling from an admitted conversation: stable key, due time,
   reason, source message and linked work. No recurring model polling and no
   self-rescheduling loops. A due job rechecks admission, current channel history
   and whether the obligation is still outstanding. Cancellation and state survive
   restart. Review by itself is not permission to send a new third-party DM.
3. Add an explicitly configured bootstrap review after Gateway catch-up. It reads
   configured channels/DMs, shared project records and complete embed-aware history.
   Only this host-created review has global admitted-scope read access. It produces
   a local structured A-F coverage report, evidence, gaps and actionable drafts.
   Its Discord mutation tools are denied. Normal conversation workers receive no
   additional read or write authority from this feature.
4. Add diagnostic-upload bootstrap catch-up with a separate Codex high-water mark,
   pagination and an external timestamp cross-check. Preserve Claude's marker.
   Only verified new packages or active engagements warrant deeper inspection.
   Unknown uploaders are not cold-contacted. Read any existing in-app response
   before preparing an evidence-based, PII-free replacement for operator action.
5. Qualify concrete follow-up delivery separately from review: present an exact
   destination and draft for any required operator approval, recheck current
   admission/history, and preserve per-message delivery receipts. No broad send
   capability, audience override or arbitrary endpoint is added.

## Required verification

- Participant text and forged payload fields cannot create a privileged review.
- Global review can read only the configured admitted population; ordinary public
  and private workers retain their existing audience restrictions.
- Review jobs cannot post, react, edit, moderate or create a Discord destination.
- A blocked review does not block subsequent human arrivals in that conversation.
- Due jobs survive process/DB reopen, deduplicate, cancel, respect quota pause and
  never multiply through retries or self-rescheduling.
- No permission widening when a participant or destination is removed or changes
  audience. Incomplete scans report gaps and retain their previous watermarks.
- Native Codex sees the true origin, scoped tools and policy. Fixtures use no
  inference, real messages, real diagnostic responses or production KB mutations.
- Inspect the change and run targeted boundary/recovery tests before enabling
  broader read access. The user requested ordinary coding/testing instead of the
  code-carefully procedure on September 10; separate reviewers are optional.

## Acceptance and rollout

Keep production on its last qualified release while this stage is built. Back up
HELP state through SQLite's backup API before migration, retain a compatible
runtime outside plugin caches, refresh exact native hook trust through setup and
preserve all queued arrivals. Report automated and native results separately from
real behavioral acceptance. Global catch-up is complete only when each sweep has
actual coverage evidence or an explicit unresolved gap.
