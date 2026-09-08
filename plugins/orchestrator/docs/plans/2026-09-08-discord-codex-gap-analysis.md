**SpawnBox Discord workflows on Codex: compatibility and gap analysis**

Assessed 2026-09-08; revised after clarifying the target and inspecting community bridges. This covers repository files, the installed Claude Discord plugin artifact, community integration source, the Codex marketplace catalog, and official Codex documentation. No Discord messages were sent, no Discord API calls were made, no bot was started, and no live configuration or token was changed. Installed files do not establish which artifact every currently running Claude process loaded.

**Finding**

Codex can use Discord operations through a suitable MCP server or custom integration. I found no Discord integration in the marketplace response available to this machine: `codex plugin list --available --json` returned 19 installed and 3,596 available entries, with no Discord match. No Discord tools are exposed to this task. This is a bounded catalog observation, not a claim that no community implementation exists anywhere.

The existing Claude Channels plugin is not a verified drop-in Codex integration. Reading/posting messages is the smaller port. Receiving Discord messages and waking a persistent support agent requires a host integration beyond ordinary MCP tool calls. OpenAI's Claude plugin conversion guidance explicitly identifies inbound channels as requiring additional support. Local Codex stdio MCP support is separate from that guide's restrictions on public plugin submissions.

**Confirmed target and recommendation**

The target is relative behavioral parity for the SpawnBox.help agent: incoming Discord messages initiate Codex work while idle, conversation continues across messages, and Codex uses the HELP workflows and standalone orchestrator memory without a PA. An operator-driven tools-only plugin is not an acceptable delivered endpoint. The SpawnBox.app production bot and HELP Worker interaction endpoints are outside this host migration.

Use an existing community integration as the foundation. The first candidate to qualify is [Openclaw-Metis/codex-discord-mcp](https://github.com/Openclaw-Metis/codex-discord-mcp), because it already combines automatic inbound execution with a Discord MCP surface and access behavior close to the current plugin. It is a community Codex integration, not an official OpenAI Discord channel plugin. Its bot mode invokes actual Codex CLI sessions. Its MCP mode alone queues messages without waking Codex.

An integration originally designed for remote owner control is not disqualified. The current Claude Discord plugin was repurposed for HELP in the same way. Selection should turn on reusable transport, usable tools, session behavior, and the size of the adaptation. Differences in intended audience identify work to do, not a reason to build a replacement from scratch.

**What the current system consists of**

| Layer | Evidence and purpose | Codex relevance |
| --- | --- | --- |
| SpawnBox.app production bot | Worker routes, application interactions, server cards, guild integration, and customer-facing functionality. | No host port required for this analysis. Keep its credentials and production behavior separate. |
| SpawnBox.help Worker endpoints | `worker/src/routes/help-interactions.ts` handles preview-code redemption and helper applications independently of a coding-agent session. | Remains in the Worker. Migrating the support agent does not imply moving these interaction endpoints. |
| SpawnBox.help agent connection | Installed `discord@claude-plugins-official` 0.0.4, a Bun/discord.js MCP server with five Discord tools and Claude channel notifications. | Reuse or replace the Discord operations; adapt packaging and inbound transport. |
| SpawnBox engagement workflows | Project commands for bootstrap, help, triage, roadmap posting, and helper-application review; per-user/per-channel notes and engagement policies. | Good workflow reuse candidates, with host-specific commands and outdated sections revised. |
| Orchestrator continuity | Engagement notes, tracked work, decisions, checkpoints, and historical context. | Uses the proposed standalone orchestrator port. No PrimeAgent is necessary for this memory layer. |
| Bot execution restrictions | Project role-gate hook, Claude classifier settings, environment inheritance, and PA escalation instructions. | Requires explicit Codex policy design and verification. File presence alone does not prove a classifier configuration is active. |

The checked installed Discord artifact is under `~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4`. Its package.json reports 0.0.1, while the installation registry reports 0.0.4. Track artifact contents and local patches as well as these version labels. The registry currently lists user scope, whereas the older bootstrap documentation describes project scope.

**Compatibility matrix**

| Capability | Reuse potential | Main gap |
| --- | --- | --- |
| Fetch messages; reply; react; edit own messages; download attachments | High for the underlying API operations | Codex MCP package, correct schemas, host-neutral instructions, token handling, and destination checks. Ordinary final assistant text is not a Discord reply. |
| Forum/thread/channel administration and rich embeds | Medium | The installed Channels server exposes only five tools. Triage and management need additional explicit operations; do not assume all REST-based recipes are covered by those tools. |
| Discord Gateway reception | High for discord.js plumbing | Replace `notifications/claude/channel` delivery with a durable handoff that actually starts Codex work. |
| DM pairing, channel allowlists, mention rules, thread inheritance | High for policy logic | Adapt `/discord:access` and pairing instructions. Keep admission of a message distinct from granting the sender operational authority. |
| Per-user and per-channel behavior context | High for note content | Replace source-tag parsing with trusted event metadata; resolve project paths outside the installed package cache. |
| Support, triage, roadmap, application-review skills | Medium | Convert `.claude/commands` to Codex skills and replace concierge/PA/Claude-tool dependencies with direct workflows. |
| Engagement memory and checkpoints | High after orchestrator port | Correct task identity and durable conversation routing, with explicit audience boundaries. |
| Push-driven autonomous replies while idle | Existing community implementations available | Qualify the selected bot/worker mode; MCP tools alone do not establish a session wakeup path. Preserve a supervised listener and reliable queue. |
| Offline catch-up and restart recovery | Medium | Preserve high-water marks and deduplication; separate received, processed, and replied states. |
| Permissions and restricted support-bot role | Significant adaptation | Claude `autoMode.hard_deny` is not a Codex policy file. Normalize tools and enforce boundaries through host/service controls. |
| PA permission relay and PA escalation | Exclude from initial port | Escalate unresolved operator decisions to an authenticated operator review path. Do not substitute community Discord messages for operator approval. |
| Packaging and updates | Supported pattern | A separate Codex package in the same marketplace repository; pin/vendor reusable upstream code with its license and tested patches. |

**Concrete gaps verified in the current files**

1. **Incoming messages use Claude's custom channel protocol.** The plugin declares `claude/channel`, handles discord.js `messageCreate`, and emits `notifications/claude/channel` with channel, author, message, and timestamp metadata. SpawnBox's launcher enables both Discord Channels and the orchestrator's development channel. Changing the model name or copying the manifest does not replace that harness behavior.

2. **The audience hook is tied to a specific rendered tag.** `.claude/hooks/inject-discord-user-notes.py` exits unless `prompt` contains `plugin:discord:discord`, then parses `<channel source="plugin:discord:discord" ...>` to choose user/channel notes and room context. A normal Codex prompt or differently named source would skip that context. The adapter should construct trusted metadata from Discord event fields, not recognize apparent authority from markup typed by a Discord user. Outbound sends also need destination-aware context, including sends initiated from a terminal rather than an inbound message.

3. **The bot role gate misses Codex edits.** A harmless stdin-only fixture test exercised the existing `.claude/hooks/discord-bot-gate.cjs` with `ORCHESTRATOR_SESSION_KIND=discord-bot`. Claude `Edit` targeting an application source file returned a denial; Codex `apply_patch` targeting the same file returned no denial; a `Bash` payload containing `wrangler deploy` returned a denial. No edits or deploys were executed. Codex's Edit/Write matcher aliases do not rewrite the canonical payload to Claude's single-file Edit shape. This is a proven adapter gap, not a claim of an exploit against the running bot.

4. **Bot/webhook alerts are not handled by the inspected inbound path.** The installed plugin returns immediately for `msg.author.bot`. Its inbound notification construction includes text and attachment metadata, but not embed fields. Its `fetch_messages` implementation renders `m.content` and attachment counts, excluding embeds. The project bootstrap already documents the empty-content diagnostic-alert problem. Thus this inspected artifact does not substantiate the claim that webhook diagnostic alerts wake the agent. A different running patch/path might exist, but it was not verified. The port must explicitly handle selected trusted webhook/bot alerts, embeds, attachment-only events, and self-message loop suppression.

5. **The plugin's actual tools differ from older examples.** In the inspected server, `fetch_messages` receives `channel`, while older bootstrap tables describe `chat_id`. The five-tool surface also does not provide all forum, permission, and rich-card operations used by the project workflows. Generate adapters from inspected schemas and test the exact documented calls. Include real history pagination in the selected implementation; do not silently treat one latest-page fetch as a complete catch-up.

6. **Local patches are part of deployed behavior.** `scripts/fix-discord-plugin.ps1` repairs a documented Windows dependency-install problem, changes startup to avoid reinstalling dependencies on every run, and disables the Discord plugin's permission-relay capability. The disabled capability patch is present in the installed source. The SpawnBox launcher separately enables the orchestrator permission relay; these are different mechanisms. A Codex port must preserve the intended operator boundary without copying either protocol blindly or modifying the live Claude cache.

7. **Scheduling instructions contain retired behavior.** Bootstrap still includes older CronCreate/ScheduleWakeup explanations, but its later 2026-07-23 directive explicitly retires recurring cron jobs in favor of pushes plus one-time startup catch-up. The Codex port should preserve that intent. Recurring Codex automations are not a substitute for a verified incoming-message trigger and should not be added merely because old paragraphs describe polls.

8. **The support bot's credential boundary needs an explicit host design.** The current gate itself documents that file restrictions do not prevent access to secrets inherited in environment variables. For Codex, give the Discord connector/gateway only the SpawnBox.help credential it needs and give the agent narrowly scoped operations. Do not copy the entire development environment into a public-input worker. The production SpawnBox.app bot remains outside agent credentials. Preserve the intended read/support role using actual Codex/service permissions; regex hooks and instructions are supplementary controls.

**Community foundations inspected**

These are source snapshots, not certifications of operational reliability. Repository head dates below are commit dates observed on 2026-09-08.

| Candidate | Reusable foundation | Adaptation or qualification needed | Position |
| --- | --- | --- | --- |
| [Openclaw-Metis/codex-discord-mcp](https://github.com/Openclaw-Metis/codex-discord-mcp) — `6d0813b`, July 11 | Node/TypeScript, discord.js, MCP operations resembling the Claude plugin, DM pairing, channel/mention policy, forum-parent admission, automatic Codex exec/resume, persisted message queue. MIT license file. | Queue/delivery durability, active-turn steering, one shared connection for bot and MCP, HELP context/policy, richer history and forum tools. Git reports 0.2.0; the npm registry currently exposes only through 0.1.2. | Preferred first qualification target; pin the inspected source, not an unqualified npm latest. |
| [chadingTV/codex-discord](https://github.com/chadingTV/codex-discord) — `dc1afb8`, May 8 | Direct stdio app-server client, session resume, streaming, approvals/questions, Windows command resolution, SQLite channel/session mapping. | Source rejects DMs and bot authors; busy messages need a queue-confirmation button; pending work is in memory. Add MCP actions and HELP routing. LICENSE adds visible attribution for modified distributions beyond ordinary MIT text. | Strong app-server alternative/reference if replacing the preferred candidate's CLI runner is too costly. |
| [simdorei/codex-discord-remote](https://github.com/simdorei/codex-discord-remote) — `d1c2372`, August 30 | Windows-oriented runtime, mapped start/steer, persisted mirror claims/cursors, approval/input handling, actual Codex plugin and local marketplace packaging. | Larger Desktop integration, rollout-file mirroring and optional UI fallbacks. Normal mapped delivery does use app-server; it is inaccurate to call this purely UI automation. No repository-wide license grant was located in the inspected checkout; NOTICE covers a bundled upstream skill. | Viable richer alternative if Desktop participation is a requirement; clarify reuse terms before adopting its code. |
| [yhdesai/codex-toolbox](https://github.com/yhdesai/codex-toolbox) — `3ede73a`, June 26 | Codex app-server bridge, Discord input routing, approvals, persisted mappings; direct stdio fallback documented. | Creates project categories/text channels for Codex tasks. Discord mirroring defaults to all supported activity, so HELP needs explicit output routing. No license file was located in the inspected checkout. | Secondary option; more change to conversation presentation and reuse terms need clarification. |
| [NathanZane/codex-mobile](https://github.com/NathanZane/codex-mobile) — `f79e680`, April 27 | Windows-oriented Desktop/CLI mirror, queue/steer and approval paths; MIT license file. | Public beta uses explicit `/codex send` from a controller; needs ordinary inbound conversation admission. | Additional remote-control base, with less matching behavior out of the box. |

Also screened [cafitac/codex-channels](https://github.com/cafitac/codex-channels): its documented focus is routing approvals, user input, and MCP elicitation. A project named channels is not by itself evidence of an ordinary inbound HELP conversation loop. Tools-only Discord MCP servers can supplement operations, but cannot be the complete solution to the requested wakeup behavior.

**Source findings for the preferred foundation**

The anchors below refer to commit `6d0813bfce26ffedf0a0d090802113fbe57e6754` of codex-discord-mcp.

- `src/discord.ts:70`, `:219` and `src/relay.ts:32`: Gateway messages pass admission, enter a persisted queue, then trigger a Codex run through a per-channel promise chain. This is a real event-driven automatic path. `src/codex.ts:77` can reuse a saved Codex thread when resume-by-channel is enabled; that option defaults off and must be on for HELP continuity.
- `src/codex.ts:124`: execution uses `codex exec --json` and optional resume, with a fresh subprocess per message. The listener remains running between messages. A new process does not inherently mean lost conversation, but this runner has no active-turn steer path. Defaulting to a new conversation per message would fail the target.
- `src/mcp.ts:28`, `:309` and `src/relay.ts:16`: MCP mode and bot mode each construct and start their own DiscordBridge. Simply enabling both would create multiple listeners and queue writers. Introduce a single connection owner with an authenticated local operations interface; MCP adapters should call that owner rather than log into Discord independently for every Codex session.
- `src/state.ts:172-224`: queue and thread maps use JSON read/modify/write with atomic file replacement, without a transaction covering concurrent operations. Atomic replacement alone does not prevent lost updates. The queue retains only the last 500 entries even if older entries remain pending; startup loads at most 100 pending entries. Replace these limits and update races with a durable transactional inbox and explicit retention policy.
- `src/relay.ts:83-96`: failure handling marks a message handled even when reporting the failure also fails. Send IDs are not persisted as an outbox ledger. Repeated Gateway delivery is deduplicated in the stored array, but the inbound handler still emits the event. Add processing claims, retryable failure states, and send reconciliation; do not treat the current queue as a proven reliable delivery system.
- `src/discord.ts:71`, `:154`, `:308`: all bot authors are dropped; queued messages and history omit embeds; history has only a latest-page limit. Extend selected webhook/bot admission, embed rendering, pagination, and thread metadata. Existing forum-parent policy inheritance is useful and should be retained.
- `src/codex.ts:148` promises automatic final-answer posting, while `src/mcp.ts:42` instructs the model to use explicit reply tools. With the existing HELP skills, these paths can duplicate replies. Use one outbound authority: explicit Discord actions with receipts, plus a deliberate no-reply outcome. Keep normal task commentary, tool output and operator diagnostics out of public message delivery.
- `src/codex.ts:44` strips DISCORD_BOT_TOKEN from the child environment, a useful starting point. It still inherits other environment values; the MCP path can also read its state .env file. Complete the HELP process and filesystem boundary rather than equating this filter with isolation. The inspected send path also needs explicit allowed-mention policy.

Validation completed in a temporary source checkout: `npm ci --ignore-scripts --no-audit --no-fund`, `npm run typecheck`, and `npm test` succeeded; **77 tests across 9 files passed on this Windows host**. These tests principally cover helpers, access policy, files, and argument construction. They do not establish live Gateway-to-Codex-to-Discord behavior, hook/plugin loading in the spawned session, or recovery under concurrent traffic. No package was installed globally or into Codex, and no bot login or agent inference was run.

**Delivery plan: full conversation parity**

The intended delivered architecture is:

```text
Discord Gateway event
  -> sender/channel admission and trusted event metadata
  -> durable inbox, deduplication, and conversation routing
  -> Codex worker starts or resumes the appropriate task
  -> audience context + support skills + orchestrator memory
  -> explicit Discord reply/action tool
  -> delivery receipt and persisted processing checkpoint
```

A local Codex app-server client is the preferred runner for active-turn conversation behavior: the documented protocol can start/resume tasks, begin turns, steer active work, and stream completion events. Qualify this behind the chosen integration's runner boundary; chadingTV provides an existing stdio implementation to compare or reuse under its license. The Codex exec/resume runner is useful for initial qualification, but is not a reason to drop active-turn behavior from the acceptance criteria. This is a proposed adaptation, not something a bundled MCP server automatically gains. Use a dedicated supervised local worker; joining an arbitrary open Desktop task is not required. Confirm app-server version compatibility; its WebSocket transport is documented as experimental, so start with stdio.

1. **Qualify the upstream foundation end to end.** Pin the inspected Git commit and dependency lockfile. In an isolated test setup, prove an inbound message while idle starts work, a follow-up resumes context, Codex loads the actual HELP and standalone-orchestrator package, and Discord receives the intended reply. Exercise app-server start/resume/steer with the installed Codex version. No production cutover until these work. Compare the app-server alternative if adapting the preferred foundation would replace most of it.
2. **Unify connection, execution and delivery.** One supervised Gateway owner, one transactional inbox/outbox and conversation map, and a thin MCP operations client. Keep state outside plugin caches. Serialize or deliberately steer messages within a conversation; bound cross-conversation concurrency. Implement graceful stop, restart/backoff, missed-event catch-up and operator-visible failures. Preserve received messages across process and machine restarts. A powered-off or sleeping machine still needs to be brought online; neither plugin installation nor Discord can make an unavailable host run.
3. **Adapt the HELP behavior.** Convert help/bootstrap/triage/helper-review/roadmap commands into Codex skills using existing policy and notes. Replace Claude source tags with trusted sender/guild/channel/thread context. Preserve conversation and audience boundaries, mention/reply behavior, permitted DMs, human handoff and the ability to decide no reply is needed. Use standalone orchestrator memory and work tracking; replace only PA-dependent escalation with operator review. Support required forum actions, edits, reactions, files and rich alerts.
4. **Verify parity and package it.** Deliver `spawnbox-discord-codex` through the same repository's separate Codex marketplace, with the upstream version/commit, license, reviewed patch set, runner compatibility and state migrations recorded. Plugin installation handles skills/MCP/hooks; separately managed setup/start/status/stop handles the persistent service. An installed plugin is not proof that its listener is running. Keep all Claude manifests, skills, launchers, cache patches and state paths intact.
5. **Rehearse and cut over.** Run recorded-event comparisons against current HELP behavior, then a designated test Discord identity or disjoint test routing, then restart/disconnect/duplicate-send drills. Production cutover is a final explicitly authorized step with a single responding owner and a tested rollback to Claude. Keep the existing Worker interactions and their registered commands; do not let a bridge installer bulk-replace the HELP application's command set.

These are implementation milestones toward one parity release. A tools-only demo is an internal check, not a substitute deliverable. The engineering work is a bridge adaptation plus a skill port; it is more than changing tool names, but the Discord transport and Codex session foundations already exist.

Route work by Discord conversation and audience rather than pouring every private DM, staff discussion, and public thread into an unrestricted coding task. Use verified Discord IDs; preserve forum-parent context and the actual reply destination. Decide how simultaneous messages queue or batch, how edits/deletions affect pending work, and which operator owns unresolved approvals.

Persist both ingress and send receipts. At-least-once delivery needs deduplication, and a crash after Discord accepted a reply but before receipt persistence needs reconciliation. Do not claim exactly-once replies without solving that ambiguous-send case. Show failures to the operator, keep pending work, and avoid silent cursor advancement.

Use one active responding owner per conversation during rollout. A second Claude or Codex listener should not independently auto-reply using the same bot account. A shadow Codex run should use recorded events and suppressed sends, or disjoint test routing; the existing Claude bot remains the production owner until cutover is explicitly authorized. Discord platform interactions already served by the Worker continue there.

**Suggested package boundary and reuse**

Keep Discord adjacent to the standalone orchestrator port, not embedded into it. A proposed `spawnbox-discord-codex` package in the same repo marketplace can contain Codex skills, policy adapters, and the MCP client for the selected community bridge/service. Keep reviewed upstream Discord code and patches in version control, preserve license notices, and test the packaged artifact. Do not rely on the mutable Claude installation cache as a production dependency.

The durable community notes can remain project-owned. Share the useful policy content through explicit configured roots or a generated reviewed package; do not fork private user notes into an upstream/general-purpose plugin. Adapt the few PA/concierge procedures to direct retrieval and operator escalation. Live agent-to-agent coordination remains unnecessary.

**Acceptance evidence before calling it equivalent**

- A known human message, a forum-thread message, a DM, an attachment-only message, and an authorized embed-only webhook alert each take the intended path. Unauthorized sources and the bot's own replies do not trigger responses.
- The correct user/channel context appears before response generation; a fake channel tag inside message text cannot alter sender or authority. Private/staff context does not appear in public replies.
- Real message reads cover pagination, embeds, and attachments. Replies, edits, reactions, forum actions, and file sends use the correct target and return Discord IDs. Test rate limiting and partial sends.
- The Codex bot cannot write application source or perform prohibited production mutations through either patches, nested tools, or shell paths under its configured policy. Test permitted support operations as positive controls too.
- Restart, compaction, disconnect, duplicate delivery, and crash-after-send preserve engagement continuity without duplicate public replies or lost pending work.
- An idle worker actually begins work on an incoming event. A logged/queued notification alone is not success. Verify supervisor startup/shutdown and operator-visible failure handling.
- A follow-up sent during an active turn is deliberately steered or queued without a mandatory queue-confirmation button, lost context, or a duplicate reply. The agent can participate in a multi-person conversation and can intentionally remain silent. Real Codex hooks, skills and orchestrator memory are loaded in the bridge-owned task, not merely in the operator's Desktop task.
- Installing, updating, disabling, and rolling back the Codex package leaves the Claude plugin, allowlists, production Worker endpoints, and existing bot ownership intact.

**Sources**

Local files inspected: SpawnBox `.claude/discord.md`, `.claude/discord-engagement.md`, `.claude/discord-channels-bootstrap.md`, Discord command files, `.claude/hooks/inject-discord-user-notes.py`, `.claude/hooks/discord-bot-gate.cjs`, `.claude/settings.json` hook configuration, `.claude/bot-strict.json`, `discord-start.ps1`/`.bat`, `scripts/fix-discord-plugin.ps1`, and the Worker Discord route headers. Installed plugin source: `~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts`, package.json, and .mcp.json. Secret values and private conversation histories were not needed for this assessment.

Official support boundaries: [Claude plugin conversion and channels](https://developers.openai.com/plugins/guides/submit-claude-plugin), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Codex hooks](https://learn.chatgpt.com/docs/hooks), and [Codex app-server](https://learn.chatgpt.com/docs/app-server). These establish extension mechanisms rather than endorsing a community bridge. No full bot integration test was performed. Execution validation comprised the earlier three-input role-gate fixture plus the community candidate's typecheck and 77 tests described above.

Community source anchors: [preferred bridge runner](https://github.com/Openclaw-Metis/codex-discord-mcp/blob/6d0813bfce26ffedf0a0d090802113fbe57e6754/src/relay.ts), [Codex invocation](https://github.com/Openclaw-Metis/codex-discord-mcp/blob/6d0813bfce26ffedf0a0d090802113fbe57e6754/src/codex.ts), [Discord operations](https://github.com/Openclaw-Metis/codex-discord-mcp/blob/6d0813bfce26ffedf0a0d090802113fbe57e6754/src/discord.ts), [MCP entrypoint](https://github.com/Openclaw-Metis/codex-discord-mcp/blob/6d0813bfce26ffedf0a0d090802113fbe57e6754/src/mcp.ts), [state implementation](https://github.com/Openclaw-Metis/codex-discord-mcp/blob/6d0813bfce26ffedf0a0d090802113fbe57e6754/src/state.ts), [npm registry metadata](https://registry.npmjs.org/codex-discord-mcp), [alternative stdio app-server client](https://github.com/chadingTV/codex-discord/blob/dc1afb8e81077fc3e0cbac02c13c69a27d573b8b/src/codex/app-server-client.ts), and [Desktop bridge route map](https://github.com/simdorei/codex-discord-remote/blob/d1c23726e02ef95d67e9789975aa693c6846818b/docs/architecture-route-map.md).
