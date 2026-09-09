# Discord HELP implementation and qualification

The adjacent `plugins/spawnbox-discord-codex` package is implemented on
`codex/orchestrator-discord`. It adapts the pinned MIT community transport rather
than replacing the Discord client foundation. Claude source, plugin manifests,
allowlists, launchers, installed Discord cache and Worker commands remain intact.

Implemented: transactional inbox/outbox and leases, persistent native tasks,
one Gateway owner, explicit replies with receipts, automatic queued follow-ups,
DM recipient persistence, admission of selected webhook embeds, bounded history
and attachments, public forum filing, private support creation, scoped moderation,
HELP skills, read-only diagnostics, lifecycle memory and a local supervisor.

Qualification so far:

- 20 Bun tests and 115 assertions cover delivery/retry, deduplication, room ordering,
  access boundaries, real upstream chunking and DM restart behavior, historical
  pagination, source/skill-read restrictions, private support permissions and
  visible operator-blocked outcomes.
- Two Python tests cover split zstd chunks, inventory/paged logs and refusal to
  follow archive links. No archive paths are extracted onto the host.
- Typecheck and four distributable bundles pass. Five skills and the plugin
  manifest pass their validators.
- Native Codex 0.153.3 deterministic fixtures pass with the configured
  `gpt-6-astra` model profile: inbound wake, task continuity across process restart,
  explicit reply only, deliberate silence, scoped orchestrator memory and a
  blocked actual `apply_patch`. The 17-step fixture also reads the actual installed
  HELP skill through MCP. No inference or Discord sends occur in that test.
- Actual marketplace installation initializes all 18 HELP tools and explains the
  disconnected service without failing MCP startup.
- Read-only Discord verification confirms HELP application `1493368365354582206`,
  27 existing admitted channels (13 public, five staff, eight private, one helper),
  four DM recipients and one telemetry webhook. Claude state was only read.
- The fixed remote D1 version query succeeds with the existing local Cloudflare
  credentials, returning ten release rows. Credentials stay out of model workers.

Native differences found during qualification: MCP root placeholders need an
exact-version cache bootstrap; dynamically imported MCP modules need their explicit
startup function; this host rejects PreToolUse `allow` but accepts `deny`, so allowed
tools return no hook override; dedicated read-only workers require explicit policy
for their enumerated MCP operations. No ordinary user profile safety settings were
changed to configure the bot worker.

Live rehearsal uses private channel `1546955350035529851`, private fixture text
channel `1546957684098596884` and private fixture forum `1546957682748039219`, with
DMs disabled. The latter two use the stricter public audience policy internally,
while Discord permissions keep the test private. Local state is
`C:/Users/Jarid/.codex/spawnbox-help-rehearsal`. Labelled webhooks provide synthetic
inputs. The production HELP cutover has not happened.

The first live event completed through the real model and Gateway: probe
`1546955636607164557` produced reply `1546955833794109500`, "Codex HELP bridge is
awake". The owner's human follow-up `1546955931135377498` was admitted and
deliberately acknowledged with a no-reply outcome. The worker used the configured
`gpt-6-astra` account/profile.

Live acceptance receipts (verified against Discord and the durable journal):

| Behavior | Evidence |
| --- | --- |
| Offline arrival and restart | Event `1546956278788661279` arrived while stopped; reply `1546956490097557606` remembered the earlier marker "cedar" in the same native task |
| Embed-only input | Empty-text event `1546956861238943806` produced reply `1546956912505917531` |
| Text attachment, queued while busy | Event `1546956864149921803` produced reply `1546957036267503687`, reading "quartz" from the actual CDN attachment |
| Image attachment | Event `1546957045574410392` produced reply `1546957153800294460`, correctly identifying the blue PNG |
| Generated file and reaction | Event `1546958501144698982` received a check reaction; message `1546958654110957701` contains `transport-proof.txt`, 34 bytes |
| Forum creation | Event `1546957947878379611` created fixture thread `1546958142557130792` and link reply `1546958170067574845` |
| Forum reply, tag and archive | Follow-up `1547049204956930139` produced reply `1547049384078741535`; REST confirms Resolved tag `1546957682748039221` and archived=true |
| Edit own recorded reply | Event `1547049710647513249` changed the file caption to "File delivery verified (edited)" and preserved its attachment |

The first forum follow-up exposed a missing skill-file reader. The worker had the
native catalog but no allowed way to open SKILL.md. The fix adds a bounded installed
skill reader, verifies symlink containment and tests the actual native tool path.
The failed attempt had incorrectly chosen `no_reply`; `needs_operator` now records
capability failures as blocked events instead. Operator retry clears that outcome
after reconciliation while preserving previous delivery receipts.

At the end of this round: 11 journal events marked handled, including that recorded
failed first forum attempt and its successful follow-up; no pending/running events,
uncertain deliveries or service errors. Do not interpret the handled count alone
as 11 successful behavioral checks. The supervisor is left running in private
rehearsal scope. Current installed development version is `0.1.0+codex.20260909102425`.

An additional explicit local REST fixture passed private support-room creation,
permission overwrite checks and reuse, then removed its empty test room/category.
It also archived evidence before deleting labelled disposable bot message
`1547051196576043028`; a GET confirmed 404 afterward. This exposed and fixed a
legacy numeric bot permission mask missing ViewChannel and ReadMessageHistory.
Named permissions now grant the intended conversation capabilities without
unrelated webhook/access administration. A regression test covers the template.

Remaining live gates: a real participant-shared diagnostic package and member timeouts. The D1 release query,
archive fixtures and disposable deletion check cover part of these workflows;
full live acceptance is not claimed. The supervisor does not register Windows logon startup.
Publishing the branch to the shared marketplace and changing production channel/DM
ownership remain separate release steps.

Known intentional operator boundaries: helper approval/rejection and role changes,
bans/kicks, arbitrary access changes, cross-audience publication, code edits,
deployment and binary diagnostic database analysis. Conversation memory is isolated;
the full private fleet KB is not automatically injected into public rooms.

## Owner DM acceptance and recovery fixes — 2026-09-09

Jarid explicitly approved a temporary handover of only user `1471274334474600710`
in HELP DM `1496232181578600469`, followed by restoration. Test messages were sent
through his signed-in Discord browser session. Claude's other three DM recipients
and all guild routing stayed unchanged. A local snapshot and bounded rollback
watchdog protected the temporary handover across interruption.

The initial event `1547063681957761086` hit account usage exhaustion. A native
`error` notification had been forwarded as EventEmitter's fatal `error`, crashing
the listener. The watchdog restored Claude routing during the interruption.
The fix routes it as `turn/error` and waits for actual `turn/completed`. Usage
exhaustion now blocks the event for explicit retry without restarting the service.

After usage became available, the same event delivered reply
`1547188779666898984`, "DM received: juniper". An ancillary similarity call exposed
the mismatch between advertised memory tools and disabled embeddings. Production
workers now use the existing shared local embedding sidecar with conversation-
isolated databases; `memoryEmbeddings=false` explicitly disables the similarity
tool and explains keyword retrieval. The first delivered event was acknowledged
locally after verifying its receipt, so it was not resent.

The listener was fully stopped before browser message `1547189851886198834` was
sent. On restart it recovered that offline event, resumed native task
`01a083e3-941b-7440-8560-e96af0b8f1b1` and delivered reply
`1547190110049669180`, recalling "juniper". The native tool trace independently
confirms `check_similar` found two saved checkpoints (97.4% and 88.3%).

Both events finished handled, with one recorded reply each and no uncertain
deliveries. Claude's four-entry DM allowlist was restored in its original order;
the entire parsed access file matched the snapshot. Codex DM admission returned
to empty. Remembered but no-longer-admitted DMs are now excluded from catch-up
reads and reference fetches. Private guild rehearsal can continue independently.
