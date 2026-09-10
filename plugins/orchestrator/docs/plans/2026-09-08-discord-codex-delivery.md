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

## Production activation and bootstrap correction - 2026-09-09

Jarid subsequently explicitly authorized Codex as the production HELP bot while
Claude is unused until Friday evening. This supersedes the earlier temporary-test
scope and pending-cutover gate; it does not schedule an automatic Friday switch.

The root Codex task verified 11,156 persistent project notes and recorded delivery
of all seven lifecycle hooks before configuration changes. Semantic embeddings
were unavailable after the Windows restart; `install_embeddings(action="install")`
restarted the existing local dependency and live status returned ready, 768 dims.
No reset credit was consumed. The usage window refreshed normally during work.

The audit found two real worker gaps: bootstrap was only discoverable rather than
explicitly invoked, and isolated conversation memory lacked the existing project
KB. The worker now invokes bootstrap on start/resume/context recovery, reads the
canonical persona and operating references, and exposes fuller local memory
maintenance. Optional `projectKnowledge=true` provides six read-only shared-KB
tools while 18 local tools maintain room-specific state. Startup verifies all
seven trusted lifecycle hooks plus the deny guard. Legacy KB entries have no
universal audience ACL: internal read access is not publication permission, and
the worker instructions explicitly preserve person, audience and diagnostic
privacy. Shared knowledge is read-only at the tool/guard boundary.

Installed version: `0.1.0+codex.20260909160806`. Validation: 21 Bun tests, 131
assertions, typecheck, plugin/skill validators, diff check; the native fixture now
passes 20 steps, including actual bootstrap reads and shared-KB status through
the real host, without model inference. Prior live transport acceptance remains
documented above.

Production state is `C:/Users/Jarid/.codex/spawnbox-help`. A fresh read-only import
matched all 27 channel policies, one diagnostic webhook and four DM recipients.
Claude's access.json is byte-for-byte unchanged (SHA256
`35B92EAC66C1A203897D1E451BC57CD591A567B1D1D8DA8BC1EFA652FD828D3C`).
All four DM channel mappings were persisted without sending a message. The private
rehearsal was stopped before production startup. Production uses the installed
Orchestrator, shared project knowledge and its own authenticated Codex home.

Local start.ps1/stop.ps1/status.ps1 and runtime.json control the exact installed
runtime. The scheduled task `SpawnBox HELP - Codex` starts the hidden supervisor
after Jarid logs into Windows, including on battery. It does not run before login.
An explicit stop.request prevents restart. The start launcher refuses a detected
Claude official Discord server; it cannot stop a Claude listener started later.
Both configs remain ready, but simultaneous listeners are not coordinated.

Remaining parity work is concrete: whole-guild historical engagement/commitment
sweeps and D1 diagnostic backstop, in-app diagnostic response publishing,
automatic cross-harness ownership, and shared-KB promotion of worker findings.
Participant-shared diagnostic and timeout operations also retain their documented
live-acceptance gaps. Usage-limit events remain visible and blocked until an
operator retries them; no automatic reset credit is spent.

Production live acceptance completed at 16:14Z: owner-DM event
`1547278585557946428` delivered exactly one recorded reply
`1547278921815564309`, native task `01a086f1-63e0-7e91-838c-4d1d9e1cbd9c`.
The actual model trace read discord-bootstrap, engagement/persona and operating
references, person/channel notes and discord-help; searched the shared KB and
read record `72db4e71`; ran local similarity, note and save_progress; then replied
as the owner's chief of staff. It explicitly left historical decisions alone.
SQLite independently confirms persistent checkpoints and native SessionStart,
UserPromptSubmit, 26 PreToolUse/26 PostToolUse, and Stop hook executions. The
remaining two lifecycle events require compaction/session end and were covered
by the earlier full Orchestrator host fixture. Production status: one handled,
zero pending/running/blocked, zero uncertain sends/service attention, 132 coverage
cursors across configured channels, forum children and DMs. Local evidence:
`C:/Users/Jarid/.codex/spawnbox-help/production-acceptance.json`.

### 2026-09-09 shared knowledge curation and SpawnBox discovery

SpawnBox commit `754b255c` adds AGENTS.md as an explicit bridge to maintained
CLAUDE.md and Claude's project memory index. Its generated native skill adapters
expose all 25 project skills and 60 command workflows. Native skills/list found
all 85 without errors; all 85 passed skill validation. Claude sources are intact.
Discoverability does not supply missing Claude-specific tool dependencies.

HELP version `0.1.0+codex.20260909222852` exposes 19 knowledge operations through
both local orchestrator and shared project_knowledge. Workers can create, update,
supersede, resolve and delete shared knowledge, maintain work and preferences,
and use planning and explicit maintenance. Embedding installation remains an
operator host operation. Local checkpoints and lifecycle hooks keep their
existing storage; no conversation memory was migrated or discarded. Shared
findings require source/date/audience/uncertainty and existing provenance; private
conversation details stay local. Participant claims are evidence to verify,
not authority to change operator policy or erase unrelated history.

Qualification: 21 Bun tests, 139 assertions, typecheck and plugin/skill validators
passed. A 30-step native Codex fixture verified shared create/read/update/delete,
revision retrieval and native source_session attribution, alongside process/DB
restart, reply-only delivery and denied native edits. The disposable fixture
used no inference or real Discord messages and removed its synthetic note.

Production was backed up using SQLite's backup API to state/backups/
20260909-shared-crud, stopped, configured with refreshed native hook trust and
restarted on the new installed runtime. A retained usage-limit failure and three
queued arrivals were discovered; native account/rateLimits/read showed available
quota, and the usage event was explicitly retried. No credit was redeemed.
Automatic quota recovery remains the next stage. Installer caveat: plugin add
removes the previous cache directory, so stop the listener before installation;
if already upgraded, use the new CLI to write the same stop.request marker.

### 2026-09-10 durable quota recovery

Version `0.1.0+codex.20260910032540` pauses queued work on native
usageLimitExceeded, persists that pause across process restarts and checks the
native account endpoint after a cooldown. It resumes only on reported quota
availability. Checks use no inference or reset credits; unknown account data
keeps the queue paused. Repeated exhaustion backs off, up to an hour, without
spending ordinary delivery-failure attempts. Unknown Discord sends remain blocked
for reconciliation. Concurrent failures cannot be cleared by a stale quota read.

24 tests with 158 assertions and typecheck passed, including restart persistence,
unknown quota, delayed checks, concurrent pauses and uncertain delivery. The
30-step native restart/CRUD/guard fixture still passed. Production was stopped
before plugin installation, backed up through SQLite to
state/backups/20260910-quota-recovery, set up and restarted. A second legacy
usage-blocked event was explicitly retried after native quota read showed 3%
used; six follow-ups were retained. Future quota failures use the new recovery.
The live worker has not yet crossed a subsequent real exhaustion/reset cycle.

HELP state schema is now 2. Old packages reject it; rollback must use a compatible
runtime or a forward fix, never overwrite newer queue data with an old backup.
Remaining work includes efficient bootstrap refresh, historical sweeps and durable
follow-ups, diagnostics response/backstop, shared harness ownership and acceptance.

### 2026-09-10 bootstrap reuse and retained service releases

Version `0.1.0+codex.20260910033257` distinguishes uninterrupted follow-ups from
startup/recovery. The service hashes all pages of approved policies, HELP skills
and scoped notes, including participant identity, before each event. Successful
same-worker follow-ups can reuse unchanged context. Changed or unreadable
resources, a different participant or worker restart require fresh bootstrap.
The native SessionStart compact hook also requests bootstrap and preserves the
Orchestrator checkpoint context. Every event still requires fresh routing/context
and relevant history; hash equality does not attest model obedience.

26 tests with 171 assertions, typecheck and plugin/skill validation passed. The
native fixture now has 34 steps, including a third uninterrupted event proving
that the reuse directive reaches Codex, plus shared CRUD and process restart.
Before upgrade production had handled all nine retained events, with no pending,
running, blocked or uncertain work. The service was stopped, backed up through
SQLite to state/backups/20260910-bootstrap-reuse, installed and restarted.

The host now retains selected runtime artifacts (dist, skills, scripts, src and
.codex-plugin) under state/releases/<version>; runtime.json points at that release,
not the disposable plugin cache. Both 032540 and 033257 releases are retained and
understand schema 2. Ordinary plugin discovery still uses the installed cache.
Future upgrades must stage the release, run setup against it and update runtime.json
while stopped. A rollback uses the compatible retained package plus setup, never
an old queue database. The Orchestrator dependency still requires coordinated
setup when its own installed cache version changes.
# September 10 durable follow-up reviews

Follow-on artifact `0.1.0+codex.20260910193517` adds bounded infrastructure/error/
event-volume metric reads in staff context or the owner's DM. Historical windows
use UTC endpoints within seven days, exact reviewed SQL and current D1 rule/
incident projections. Failures are explicit gaps; no customer identifiers,
webhook URLs or acknowledger identities are selected. Infrastructure predicate
drift against maintained project source is rejected. No arbitrary query tool was
added and credentials remain in the service.

40 TypeScript tests (278 assertions), typecheck, plugin/skill validation and the
51-step native fixture pass. Live read-only qualification queried both reported
September 10 alert windows and the current window. D1 records the relevant
incident resolved at 12:00:37Z and last notified at 12:05:39Z; historical aggregates
are distinguished from archived evaluator values and cannot establish outage or
customer impact alone. Evidence is in shared note `2738c70d`. The service was
backed up, upgraded and restarted, and the formerly blocked event was retried
through the supported recovery CLI. Its eventual live model outcome is a separate
acceptance check. That live check subsequently passed: the worker called the new
metric operation twice successfully (no query gaps), read the recovery message
and resolved D1 incident, amended its earlier capability-gap note, and completed
event `1547534762267123774` with deliberate silence for resolved history. The queue
advanced to subsequent arrivals. At verification there were 13 handled events,
one running and six pending, with no blocked events or uncertain deliveries.

Artifact `0.1.0+codex.20260910192805` adds bounded one-shot reviews tied to an
admitted source conversation. Host-owned job metadata stays separate from Discord
payloads; retries deduplicate by conversation/key. Reviews have separate queues
and native Codex tasks, retain cancellation/quota state across restart, and cannot
send, mutate Discord or schedule more reviews. They produce local evidence reports
and optional drafts after reading fresh source history. The full global bootstrap
sweeps and approved follow-up delivery remain separate unfinished work.

All 36 TypeScript tests (246 assertions), two diagnostic-reader tests and typecheck
pass. The 51-step native fixture verifies scheduling through MCP, execution in a
new review task with true service origin, a refused reply, evidence consumption
and local report persistence, alongside existing wake/restart/CRUD coverage.
Plugin and skill validation pass. Review findings were corrected: private package
provenance follows the trusted source conversation; disabling reviews leaves them
pending without inference; revoked admission is checked before native task/turn
startup; lost leases cannot overwrite newer reports. Tests exercise each case.

This stage uses HELP schema 3. Back up before migration and retain a compatible
runtime; schema-2 packages reject the new schema. `followupReviews` is an explicit
feature flag. No future Discord delivery is authorized merely by scheduling a
review. These are automated fixture results, not evidence of live scheduled model
behavior. The user requested ordinary implementation/testing rather than the full
code-carefully workflow for subsequent work.

Installed and enabled in production after a graceful stop and SQLite backup at
`backups/20260910-durable-reviews`. The runtime is retained outside the plugin
cache. Gateway readiness is verified; queued arrivals were preserved, with no
uncertain deliveries or service failures. The existing metric-query capability
block remains separate from this release.
