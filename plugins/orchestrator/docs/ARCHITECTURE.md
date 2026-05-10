# Orchestrator Architecture

Walk-through of the plugin structure, grounded in `plugins/orchestrator/`. Pair with [DESIGN-PRINCIPLES.md](./DESIGN-PRINCIPLES.md) for the "why" behind each shape.

## Top-level layout

```
plugins/orchestrator/
  .claude-plugin/plugin.json     # plugin manifest (name, version)
  package.json                   # bun build, zod, MCP SDK
  mcp/                           # the MCP server
    server.ts                    # tool registrations + handler wiring
    types.ts                     # NOTE_TYPES, RELATIONSHIP_TYPES, routing constants
    utils.ts                     # generateId, now, extractKeywords, formatAge
    db/
      connection.ts              # getProjectDb, getGlobalDb, WAL + busy_timeout
      schema.ts                  # 19 project migrations + 2 global
    engine/
      composer.ts                # briefing assembly, user profile composition
      linker.ts                  # FTS5 search, hybrid RRF+MMR, auto-linker
      deduplicator.ts            # Jaccard-based dedup, MIN_SHARED_KEYWORDS=3
      embeddings.ts              # ONNX sidecar client, backfill, embed-on-demand
      hybrid_search.ts           # pure-math RRF, MMR, cosine similarity
      scorer.ts                  # confidence promotion
      session_tracker.ts         # session_log / session_registry, cross-session
      signal.ts                  # pheromone deposit / decay / boost (ANTS)
      agent_channel.ts           # R8 (0.29.0): filewatcher polling JSONLs, fires notifications/claude/channel
      agent_channel_filter.ts    # R8: pure filter for which JSONL events warrant cross-session forwarding
      agent_channel_state.ts     # R8: atomic-write helpers for sessions.json / state.json / per-receiver offset files
      addressing.ts              # R8: pure parser for @PA / @SA-<id8> / @all + slash + NL overrides
    tools/
      remember.ts                # note() handler + R4 gate
      recall.ts                  # lookup() handler
      supersede.ts               # supersede_note() handler
      orient.ts                  # briefing() handler
      prepare.ts                 # plan() handler
      reflect.ts                 # retro() handler
      check_similar.ts           # check_similar() handler
      update_note_helpers.ts     # snapshotRevision, appendToNoteContent
      session_task.ts            # update_session_task handler
      hook_event.ts              # _hook_event dispatcher (per-event hook logic)
  skills/                        # proactive skill prompts (incl. pa-bootstrap, pa-pause, pa-resume, pa-takeover from R8)
  agents/                        # prime-agent (R8, replaces memory-concierge), orchestrator-reflect
  hooks/                         # bash scripts for 8 Claude Code hook points
  sidecar/                       # Python bge-m3 ONNX embedding server
  dist/server.js                 # bun-bundled server (for plugin install)
```

## Data model

### Dual-database topology

Two SQLite databases, both using WAL mode + `busy_timeout = 5000` to support multiple concurrent MCP servers (one per Claude session) writing to the same file.

- **Project-scoped** - `{project}/.orchestrator/project.db`. Path resolved from `ORCHESTRATOR_PROJECT_ROOT`, `CLAUDE_PROJECT_DIR`, or `process.cwd()`. The connection module warns loudly if the resolved path lives inside `.claude/plugins/cache` - MCP servers run with cwd set to the plugin cache, and DBs written there are wiped on plugin update.

- **Global** - `~/.claude/orchestrator/global.db`. Migrates from legacy `~/.orchestrator/global.db` on first run if present.

Routing constants in `mcp/types.ts`:

- `GLOBAL_TYPES = ["user_pattern", "tool_capability"]` - always written to global DB.
- `MAYBE_GLOBAL_TYPES = ["anti_pattern", "autonomy_recipe", "quality_gate", "convention"]` - either database, agent-selectable via `scope`.
- Everything else always project-local.

### Schema

Migrations live in `mcp/db/schema.ts`, versioned 1-20 (project) and 100-101 (global-only). Migration 20 (R8, 0.29.0) drops `session_messages` and `session_message_reads` after the cross-session messaging system was replaced by agent-channel notifications.

The `notes` table holds everything. Work items, decisions, checkpoints, open threads - they are all the same row shape, differentiated by the `type` column. Status, priority, and due date fields are populated only for `type = 'work_item'` but the columns exist on every row.

Core columns (notes):

| Column | Purpose | Added |
|---|---|---|
| `id`, `type`, `content`, `context`, `keywords`, `tags` | Identity + indexed text | v1 |
| `confidence`, `resolved`, `created_at`, `updated_at` | State + time | v1 |
| `status`, `priority`, `due_date` | Work-item fields (nullable otherwise) | v5, v6 |
| `last_accessed_at` | Signal anchor (was `access_count`, dropped v12) | v8 / v12 |
| `signal` | Pheromone score, seeded from old `access_count` | v11 |
| `source_session` | Cross-session attribution | v13 |
| `superseded_by`, `superseded_at` | R2 supersede bookkeeping | v14 |
| `code_refs` | JSON array of path strings; file/module breadcrumbs for R5 reverse-index | v17 |

Related tables:

- `notes_fts` - FTS5 virtual table, porter + unicode61 tokenizer, BM25 ranking with weights `content=1.0, context=0.5, keywords=2.0`. Triggers keep it in sync with `notes`.
- `links` - graph edges. Columns: `from_note_id`, `to_note_id`, `relationship`, `strength`. UNIQUE index on `(from_note_id, to_note_id, relationship)` added in v15.
- `note_revisions` - pre-mutation snapshots for R2. Added in v15. Holds content, context, tags, keywords, confidence, `revised_at`, `revised_by_session`.
- `embeddings` - bge-m3 vectors as BLOB, one row per note, CASCADE-deleted with the note.
- `session_log` - per-surfacing log: which note was shown to which session at which turn, `delivery_type` in {fresh, refresh}.
- `session_registry` - one row per session: `started_at`, `last_active_at`, `last_briefing_at` (v13), `concierge_agent_id` (vestigial, no longer read/written as of R8).
- `migrations` - applied-version tracker.
- `plugin_state` - generic key/value scratch table for ephemeral plugin state (migration 16). Consumers: `last_retro_run_at` (R4.4 auto-retro gate), hook-state keys (`bridge_<sid>_<turn>`, `orch_active_<sid>_<turn>`, `preuse_warned_<sid>_<turn>`, `struggle_<sid>`, `stop_<sid>`, `subagent_stop_<sid>`). Structure: `key TEXT PRIMARY KEY, value TEXT, updated_at TEXT`.
- ~~`session_messages`~~ - **dropped in migration 20 (R8, 0.29.0)**. Was R6 inter-session messaging payloads; replaced by agent-channel real-time notifications.
- ~~`session_message_reads`~~ - **dropped in migration 20 (R8, 0.29.0)**. Was R6 per-recipient read tracking.

**Agent-channel state (R8, 0.29.0)** - lives in the filesystem, not the DB, because it's per-instance and per-session-lifetime:
- `<project>/.orchestrator-state/agent-channel/sessions.json` - registry of currently-active sessions (PA + SAs) with role, name, heartbeat. Each MCP instance writes its own entry on startup, touches it on a 30s heartbeat, removes it on clean shutdown.
- `<project>/.orchestrator-state/agent-channel/state.json` - override state: `pa_global_pause` + per-SA pauses set by `/pa-pause` skills.
- `<project>/.orchestrator-state/agent-channel/offsets-<receiver_id8>.json` - per-instance JSONL byte offsets so the filewatcher can resume reads without replaying.

Global-only tables:

- `user_model` - per-dimension observations with trajectory (improving/stable/regressing), evidence count, confidence.
- `autonomy_scores` - calibrated per-domain autonomy levels (sparse/developing/mature).

### Relationship types

From `mcp/types.ts`:

```
RELATIONSHIP_TYPES = [
  "depends_on", "conflicts_with", "supersedes",
  "related_to", "blocks", "enables", "part_of"
]
```

`supersedes` is privileged: it is the ONLY valid output of `handleSupersede` and is never created by the auto-linker. The auto-linker for decision <-> open_thread pairs returns `related_to` (R3.7 fix - it used to return `supersedes` and create false chains).

## MCP tool surface

Twenty-three tools registered in `mcp/server.ts` (22 agent-callable + 1 internal `_hook_event` for hook routing). Grouped by verb class so their equal-priority intent is visible at a glance.

### Capture

| Tool | Purpose |
|---|---|
| `note` | Capture knowledge not already known. R4 gate: blocks for decision/convention/anti_pattern if similarity >= 0.75 without `resolution`. Accepts `code_refs: string[]` (R5 breadcrumbs: file/module paths, not line/symbol). |
| `save_progress` | Write a `checkpoint`-type note with summary, in-flight, open questions, next steps. |
| `create_work_item` | Trackable task with priority/status/due/parent. Accepts `code_refs: string[]`. |
| `breakdown` | Split a work_item into children via `part_of` links. |
| `user_profile` | View / set / remove structured user observations in the global `user_model` table. |

### Retrieve

| Tool | Purpose |
|---|---|
| `lookup` | Search by query, type, tag; or detail-mode by id. Supports `include_superseded`, `include_history`, `link_limit`, and the R5 reverse-index via `code_ref: string` (exact-match post-filter against notes' code_refs arrays). |
| `briefing` | Session-start / resume / clear / compact. Returns open threads, decisions, work, user profile, neglected areas, last checkpoint, cross-session activity, curation candidates. R4.4: inline-invokes retro on 7-day cadence when event=startup and prepends `## Auto-Retro` summary. |
| `plan` | Domain-scoped context pack: conventions, anti-patterns, quality gates, architecture, recent decisions for a task. |
| `list_work_items` | Full inventory by status + priority + tag. Not keyword-searched. Signal as secondary sort within priority tier. |
| `list_open_threads` | Full open-thread inventory. Signal as secondary sort. |
| `check_similar` | Pre-implementation check: does this action overlap existing decisions / conventions / anti-patterns? |

### Maintain

| Tool | Purpose |
|---|---|
| `update_note` | `content` replaces (with revision snapshot); `append_content` adds a timestamped segment (no snapshot). Mutually exclusive. Accepts `code_refs: string[]` to replace the breadcrumb array; `[]` clears to NULL, undefined leaves unchanged. |
| `close_thread` | Mark `resolved = 1`, cascade: unblock dependents, auto-complete parent if all children done, auto-resolve superseded chain. Optional `resolution` creates a `decision` note. |
| `supersede_note` | Archive old, surface new. Accepts `new_id` (existing note) or `new_content + new_type` (inline new). `code_refs: string[]` on inline-replacement path carries breadcrumbs to the successor; ignored when `new_id` is supplied. |
| `delete_note` | Hard delete (cascades links). Used sparingly - prefer supersede or close_thread. |
| `update_work_item` | Status / priority / due / content / tags / context / confidence / blocked_by. Accepts `code_refs: string[]` with same semantics as update_note. Cascades on `status = done`. |

### Cross-session communication (R8, 0.29.0+)

The orchestrator MCP server declares the `experimental: { 'claude/channel': {} }` capability. Cross-session events are routed in real-time via `notifications/claude/channel` - the same primitive the official Discord channels plugin uses.

There is **no `send_message` / `read_messages` tool** (deleted in R8). Communication happens by typing `@PA` / `@SA-<id8>` / `@all` in your terminal output. The `agent_channel.ts` filewatcher in each session's MCP instance watches every active JSONL transcript, parses the addressing, and fires channel notifications targeted at the session that should receive each event.

| Tool | Purpose |
|---|---|
| `update_session_task` | Broadcast what the caller is currently working on (writes `session_registry.current_task` AND `sessions.json` entry). Peers see this as the `from_task` field on every channel notification you generate, in their briefing's Cross-Session Activity section, and in hook-time activity injections. |

### Admin

| Tool | Purpose |
|---|---|
| `retro` | Decay confidence on stale notes, merge duplicates, identify orphans, queue revalidation, compute autonomy scores, analyze user-model trajectories. R5 verification pass: when `CLAUDE_PROJECT_DIR` (fallback `ORCHESTRATOR_PROJECT_ROOT`) is set, iterates notes with `code_refs`, checks file-existence at the project root, reports `code_refs verified: N checked, M broken`. Also updates `plugin_state.last_retro_run_at` so auto-retro gate from briefing can skip for another 7 days. |
| `install_embeddings` | Check + install Python/uv/uvx for the embedding sidecar. |
| `system_status` | Knowledge base size, embedding coverage, active sessions, cross-session discovery health. |

### Internal (hook-only)

| Tool | Purpose |
|---|---|
| `_hook_event` | Dispatcher invoked by `type:"mcp_tool"` hooks via `hooks.json`. Routes per `event` name (UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure / PreCompact / Stop / SubagentStop). Returns `hookSpecificOutput`-shaped JSON. Agents do not call this directly; the leading `_` flags it as internal. |

## Engine components

Located in `mcp/engine/`.

### composer.ts

Briefing assembly. Pulls sections in parallel:

- `active_work`, `blocked_work`, `overdue_work`, `recently_completed` from `notes WHERE type = 'work_item'`.
- `open_threads` from `notes WHERE type IN ('open_thread', 'commitment') AND resolved = 0`.
- `recent_decisions` from `notes WHERE type = 'decision'` ordered by `updated_at`.
- `neglected_areas` - domains whose last touch exceeds a staleness threshold.
- `drift_warning` - heuristic comparison of recent decisions against established conventions.
- `user_model_summary` + `user_profile` - rollup from global `user_model`.
- `cross_session` (when `session_id` provided) - new + hot notes since this session's `last_briefing_at`.
- `curation_candidates` - stale-but-surfaced + low-confidence-but-surfaced. See R3.3.

Also composes `user_profile` for the `user_profile({action: "view"})` tool.

### linker.ts

Multiple responsibilities:

- `findRelatedNotes` - FTS5-only search with BM25 ranking. Tokenization strips non-alphanumerics to match FTS5 unicode61 (historically a `-` in the query was interpreted as NOT and threw a syntax error).
- `findRelatedNotesHybrid` - RRF + MMR over (FTS results, vector results). Signal boost + confidence multiplier applied after the fusion.
- `fetchLinkedNotes` - graph walk from a seed id. Ranked by composite (depth + signal + confidence + recency), capped per R3.1.
- `fetchSupersedeChain` - walks the `supersedes` edges, filters by column-match to avoid auto-linker false positives (R3.7).
- `createAutoLinks` - on insert, creates `related_to` / `depends_on` / `enables` / `blocks` / `conflicts_with` via `inferRelationship(fromType, toType)`.
- `inferRelationship` - type-pair -> relationship table. Never returns `supersedes`.

### deduplicator.ts

Jaccard-based. Exact match first (case-insensitive, trimmed), then token overlap. Requires `intersection.size >= MIN_SHARED_KEYWORDS (3)` in addition to `similarity >= threshold`. This double-gate is R3.5: short notes with only 1-2 shared keywords can easily cross a 0.6 Jaccard ratio and produce false-positive dupes; the intersection floor guards against it.

`mergeDuplicates` runs during retro: for each note type, find pairs, merge (newest wins), re-point links, remove self-links, delete the victim.

### embeddings.ts

Thin HTTP client for the Python sidecar (`sidecar/embed_server.py`, bge-m3 ONNX model). The sidecar is reused across Claude sessions via `.sidecar-port` to avoid each session loading ~1.5GB of weights. `embedIfAvailable(db, id, text)` is fire-and-forget; failures are logged, not thrown. `backfill(db)` walks `notes` and embeds anything missing.

### hybrid_search.ts

Pure-math helpers: `reciprocalRankFusion`, `maximalMarginalRelevance`, `cosineSimilarity`, `blobToVector`. No DB dependencies - easy to test.

### session_tracker.ts

- `registerSession` / `nextTurn` - `INSERT OR IGNORE` into `session_registry`, increment turn counter.
- `logSurfaced` - append to `session_log` with `delivery_type` in {fresh, refresh}.
- `annotateResult` - checks whether a note has been sent to this session before, how many turns ago, and how hot it is across other sessions (for "HOT: N other sessions touched this in last 2h" markers).
- `cleanup` - removes stale session rows.
- Cross-session discovery: `getNewNotesSince`, `getHotNotesSince` using `session_registry.last_briefing_at`.

### signal.ts

The ANTS (Adaptive Note Temperature System) pheromone model:

- `depositSignal` / `depositSignalBatch` - `signal += amount`, `last_accessed_at = now`. Called on every lookup / briefing / list surfacing.
- `DEFAULT_DEPOSIT = 1.0`, `WEAK_DEPOSIT = 0.3` (listings are weaker than search).
- `decayAllSignals` - `signal *= 0.95 ^ min(days, 14)`. The 14-day cap prevents vacation wipeout.
- `signalBoost(s) = 1 + 0.1 * log(1 + max(0, s))` - multiplier applied to ranking scores.
- `confidenceMultiplier` - `high=1.2`, `medium=1.0`, `low=0.8`.

### scorer.ts

`promoteConfidence` - bumps a note's confidence (low->medium, medium->high) on auto-dedup, repeat surfacing, or re-validation.

### agent_channel.ts + addressing.ts + agent_channel_filter.ts + agent_channel_state.ts (R8, 0.29.0+)

Cross-session real-time communication via `notifications/claude/channel`. Replaces the deleted R6/R7 messaging engine. Four cooperating modules:

**`agent_channel.ts` - the AgentChannel class.** One instance per Claude Code session (spawned at MCP server startup in `server.ts:startAgentChannel`). Each instance:

- Watches `~/.claude/projects/<project_hash>/*.jsonl` (every active session's transcript) on a 1.5s poll cadence.
- Reads new bytes from each file using a per-instance offset persisted to `offsets-<receiver_id8>.json` (per-receiver, NOT shared - shared offsets would cause whichever instance ticks first to advance the offset for everyone else, masking events from peers).
- Reads bytes via `Buffer.subarray(lastOffset).toString("utf8")` - byte-based slicing, not character-based, to avoid UTF-8 corruption when a multibyte character straddles the offset.
- For each new event line, calls `filterEvent` (drop tool_results / system / read-only tools), then `parseAddressing` (resolve `@PA` / `@SA-<id8>` / `@all` / conversational prefix / overrides), then `shouldReceive` (PA observes everything; SA receives only events explicitly addressed to it).
- Fires `mcp.notification({ method: "notifications/claude/channel", params: { content, meta } })` for each event that should reach this instance's session. Claude Code injects the notification inline as a `<channel source="agent-channel" ...>content</channel>` tag.
- Maintains a 30s heartbeat in `sessions.json`; reaps stale sessions (>90s without heartbeat) and emits `session_departed`. Detects newly-joined sessions and emits `session_joined`.

**`addressing.ts`** - pure parser. Given event content + sender entry + sessions registry, returns `{targets, pa_addressed, override_command, unresolved_addresses}`. Recognizes `@PA`, `@SA-<id8>`, `@all`, conversational `PA, ...` prefix, slash commands (`/pa-pause`, `/pa-resume`), and natural-language equivalents ("PA, back off", "PA, come back in"). Sender always excluded from own targets. Unresolved `@SA-<id8>` references dropped silently with a warning flag.

**`agent_channel_filter.ts`** - pure filter. Decides which JSONL events warrant cross-session forwarding. Forwards: user input, assistant text, mutating tool calls (Edit/Write/Bash/MultiEdit/git_*), summaries. Drops: tool_result bodies (too noisy; PA can read JSONL ad-hoc if it cares), system messages, read-only tool calls. Walks all blocks of a multi-block assistant message and prefers text over tool-use for forwarding, so a Read-then-text pattern doesn't lose the text.

**`agent_channel_state.ts`** - atomic-write helpers for the three filesystem state files (`sessions.json`, `state.json`, `offsets-<receiver_id8>.json`). Uses temp-file + rename pattern so concurrent reads from sibling instances see either the old or new state, never a torn write. Tolerant readers - parse failure returns empty/default rather than throwing.

The shared filesystem state replaces the per-process `inboxCounters` Map and the SQLite `session_messages` table that the R6/R7 architecture relied on. No counter drift, no per-session inbox, no polling - notifications fire in real-time as soon as the filewatcher sees the JSONL line written.

## Skills and agents

### Skills

Located in `skills/`. Each is a proactive prompt with activation criteria that Claude Code evaluates against the turn context.

Operational skills:
- `every-turn` - dispatcher. MANDATORY every turn per its header. Evaluates which other orchestrator skills apply. (R8: scrubbed of consult-concierge / send_message references.)
- `orchestrating` - always active. Frames direct MCP calls + agent-channel addressing as the two operational surfaces. (R8: rewritten away from the concierge-first model.)
- `getting-started` - session onboarding / post-compact re-orientation. (R8: detects role from `SPAWNBOX_AGENT_ROLE` env, no longer spawns a concierge subagent.)
- `wrapping-up` - end-of-task / session-end progress save.
- `planning-approach` - pre-work context gather for complex tasks.

Capture skills (single-purpose nudges):
- `made-a-decision` - fires after an architectural decision. Uses `note(type:"decision")`.
- `learned-something` - fires on discovery of a pattern / convention / gotcha.
- `closing-a-thread` - fires when an open question is resolved. Uses `close_thread`.
- `found-a-problem` - bug / footgun / security / limitation capture.
- `something-went-wrong` - post-debug capture of root cause + pivot.
- `user-preference` - workflow / style / tooling preference capture (global-scoped).
- `what-was-decided` - pre-change lookup for prior decisions.

PrimeAgent skills (R8, 0.29.0+):
- `pa-bootstrap` - first-action skill PA runs after `pa-start.bat` launches. Sets `/model claude-opus-4-7` + `/effort max`, confirms role=prime, reads sessions.json, loads `agents/prime-agent.md`, outputs readiness status. Idempotent.
- `pa-pause` - override. In an SA terminal: pauses PA's posture toward THIS SA only. In PA's terminal: global pause across all SAs. Atomic-writes `state.json`.
- `pa-resume` - inverse of pa-pause. Clears the appropriate scope.
- `pa-takeover` - force-claim PA primacy from an orphaned previous PA. Updates sessions.json roles atomically; expects `/pa-bootstrap` to follow.

### Agents

Located in `agents/`.

- `prime-agent` (R8, 0.29.0+) - the PrimeAgent operating contract. Replaces the deleted `memory-concierge`. Defines authority (always-driveable SAs by default, with override), communication model (terminal output → agent-channel filewatcher routes, no send_message), typical patterns (coordination, driving, three-way, override discipline, self-improvement), and explicit don'ts. Read by `/pa-bootstrap` step 5.
- `orchestrator-reflect` - maintenance agent. Invoked manually or via `/orchestrator:reflect`. Wraps `retro()` and a structured analysis pass.

## Hook flow

Hooks registered in `hooks/hooks.json`. Most use `type: "mcp_tool"` and dispatch through the `_hook_event` MCP tool (R6 dispatcher pattern; survives R8). One — `SessionStart` — stays bash because the MCP server may not be connected yet at first session boot. Hook state is in `plugin_state` (per-session keys), not in a state-dir.

| Hook point | Type | Purpose |
|---|---|---|
| `SessionStart` | `command` (bash) | Writes `active-session` file (read by `server.ts:getFallbackSessionId` when the agent forgets to pass session_id). Emits MANDATORY FIRST ACTIONS system-reminder text. |
| `UserPromptSubmit` | `mcp_tool` -> `_hook_event` | Increments per-session turn counter, resets per-turn struggle/orch-active markers, picks rotating reminder, surfaces last-turn bridge from `plugin_state`, injects sibling activity (with R7 keyword-overlap *POTENTIAL OVERLAP* markers; R8 update: full session UUIDs instead of 8-char prefixes; coordinate via `@SA-<id8>` instead of `send_message`). R7: emits loop-closure nudge listing in-flight work_items in scope, escalating to "Close loops NOW" when the user prompt regex-matches approval phrases (≤300 chars). (R8: removed inter-session-message drain - cross-session events arrive via separate `notifications/claude/channel` injection from agent-channel filewatcher, not the hook envelope.) |
| `PreToolUse` on Write/Edit/MultiEdit/NotebookEdit | `mcp_tool` -> `_hook_event` | (1) R7: code_refs hint when the file has tagged notes the session hasn't surfaced (once per session+file). (2) Option-B escalation: soft nudge on turn 2-3 when no orchestrator tool fired this turn; `permissionDecision: "ask"` on turn 4+. |
| `PostToolUse` matcher `.*` | `mcp_tool` -> `_hook_event` | R7: on Edit/Write/MultiEdit/NotebookEdit, surfaces in-flight work_items whose `code_refs` contain the edited file_path (once per session+work_item). On orchestrator-tool calls, marks orch-active for the turn and appends to the next turn's bridge in `plugin_state`. (R8: removed inboxCounters fast path + message drain.) |
| `PostToolUseFailure` | `mcp_tool` -> `_hook_event` | Bumps `struggle_<sid>` counter; soft nudge at 2 consecutive, hard escalation at 3+ (R8 update: nudges at `lookup` first, then `PA, ...` addressing if a PA is active, instead of `consult-concierge`). Reset by `UserPromptSubmit` (new turn) or any successful `PostToolUse`. |
| `PreCompact` | `mcp_tool` -> `_hook_event` | Emits `systemMessage` reminding the model to flush uncaptured knowledge before the window shrinks. |
| `Stop` | `mcp_tool` -> `_hook_event` | Once-per-session block. R7: surgical prompt - Curate (always), Capture (always), Loop-closure (only when in-flight work_items exist), Save progress (always), R3.4 fresh-notes nudge (only when ≥3 fresh surfacings). |
| `StopFailure` | `mcp_tool` -> `_hook_event` | R7: turn ended due to API error. Emits a `systemMessage` suggesting strategy change if errors persist. Non-blocking. |
| `SubagentStop` | `mcp_tool` -> `_hook_event` | R7: separated from Stop. Subagent-specific text that explicitly tells the subagent NOT to call `save_progress` (parent's job). Focuses on capture: note, update_note, close_thread. |
| `TaskCompleted` | `mcp_tool` -> `_hook_event` | R7: subagent task finished. Injects capture nudge with the subagent id - "did you capture what it discovered?" so patterns don't evaporate with the subagent's context. |

The dispatcher pattern keeps all hook logic in `mcp/tools/hook_event.ts` with shared DB access and replaces fragile bash JSON escaping with TypeScript. Cross-session events flow via a separate channel: the `notifications/claude/channel` MCP capability declared at `server.ts:280` and emitted by `agent_channel.ts` independently of any hook. Hooks and channel notifications coexist in the agent's context window without colliding.

## Retrieval pipeline composition

### lookup()

```
  server.ts handler
    -> zod validate + coerce (limit, depth, include_superseded, include_history, link_limit)
    -> handleRecall
       -> detail-mode (id given):
          tryFetchNote(projectDb, id) or tryFetchNote(globalDb, id)
          fetchLinkedNotes (R3.1 ranked + capped at link_limit, default 20)
          fetchSupersedeChain (R2; column-match filter from R3.7)
          fetchRevisions (only when include_history: true)
       -> search-mode (query given):
          findRelatedNotesHybrid
            -> FTS5 BM25 results (limit x 2 for signal re-rank headroom)
            -> vector results via EmbeddingClient
            -> RRF fusion + MMR diversification
            -> signalBoost + confidenceMultiplier applied to final scores
          project + global merge with reserved slots for global
    -> session tracker:
       registerSessionOnce + nextTurn
       annotateResult for each surfaced id (BEFORE logging, so already_sent reflects priors)
       logSurfaced
    -> depositSignalBatch on all surfaced ids
    -> envelope construction:
       age (formatAge(updated_at))
       source_session (short hex)
       [SUPERSEDED by ...] suffix if applicable
       annotation markers (already_sent, hot_across_sessions)
       [maintain: update_note | close_thread | supersede_note] per hit
       supersede chain section (always rendered when non-empty)
       revision history section (only when include_history: true)
       tail message when linked-notes truncated
       concierge referral when total > 15k chars
```

### note()

```
  server.ts handler
    -> zod validate
    -> handleRemember
       -> Jaccard dedup check on same-type candidates
       -> if exact-match duplicate: auto-promote existing, return without insert
       -> else: R4 gate for decision/convention/anti_pattern
          -> embedding similarity query via check_similar machinery
          -> if top candidate >= 0.75 AND no resolution supplied:
             BLOCK, return candidates with rank buckets (R4.1):
               HIGH MATCH >= 0.95 / LIKELY RELATED 0.85-0.94 / ADJACENT 0.75-0.84
       -> if resolution supplied:
          accept_new -> insertNote, return with (resolution: accept_new)
          update_existing -> appendToNoteContent on target, no new note
          supersede_existing -> insertNote + handleSupersede(target, new)
          close_existing -> insertNote + cascade-resolve target
       -> normal path (no gate, no resolution):
          insertNote
            -> keyword extract, insert row, createAutoLinks (via inferRelationship)
            -> embed async fire-and-forget
            -> writeUserModel if type = user_pattern
    -> return message with note id + auto-link count
```

### briefing()

```
  server.ts handler
    -> zod validate
    -> registerSessionOnce
    -> handleOrient
       -> R4.4 auto-retro gate (ONLY when event=startup):
          shouldAutoRetro(db)
            -> reads plugin_state.last_retro_run_at
            -> returns true if missing OR older than 7 days
          if true:
            run handleReflect inline
            recordAutoRetroRun(db) writes new timestamp
            prepend result to briefing as "## Auto-Retro" section
       -> compose sections in parallel (filtered by `sections` param if given)
          work_items, open_threads, decisions, neglected, drift,
          user_model, cross_project, cross_session, checkpoint, curation_candidates
       -> update session_registry.last_briefing_at
    -> depositSignalBatch WEAK on every note surfaced in the briefing
    -> append "## Setup Available" when sidecar unavailable on startup event
    -> return formatted markdown
```

### retro() verification pass (R5)

```
  handleReflect
    -> standard maintenance (confidence decay, merge, orphans, autonomy, trajectories)
    -> code_refs verification (only when CLAUDE_PROJECT_DIR or ORCHESTRATOR_PROJECT_ROOT set):
       for each note with non-null code_refs:
         parse JSON array
         for each path:
           resolve to absolute via project root
           fs.existsSync check
         if any path missing -> count note as "broken"
       report `code_refs verified: N checked, M broken` in summary
    -> update plugin_state.last_retro_run_at (closes the 7-day auto-retro gate)
```

Broken refs are not auto-fixed. That's a judgment call for the agent - supersede the note, update the breadcrumbs, or delete. Future R5.2 will surface broken refs in `curation_candidates`; for now the reflect agent prints the count.

### lookup({code_ref}) reverse-index

```
  handleRecall (search branch, when code_ref is supplied)
    -> run the normal keyword/vector search pipeline
    -> post-filter results in TS:
       keep notes whose code_refs JSON array contains the exact path string
       no wildcards, no fuzzy match - exact string equality against array elements
    -> render envelope as normal, with code_refs: [...] inline
```

This is a post-filter rather than an index because array-containment queries in SQLite are awkward and the expected cardinality of breadcrumb-tagged notes is small relative to the total corpus. If that assumption inverts (many notes with code_refs, most lookups filtered by path), a dedicated `note_code_refs(note_id, path)` table would be the natural upgrade.

## Testing

`tests/` mirrors the engine / tools split. `bun test` runs the whole suite. Zod coercion means HTTP-style string inputs work from the MCP client without manual parsing in handlers.

## Build and install

- `bun run build` -> `dist/server.js` (Bun target). This is the file `dist/server.js` referenced by the plugin manifest when users `/plugin install orchestrator`.
- `bun run dev` -> runs `mcp/server.ts` directly for local iteration.
- `bun run typecheck` -> `tsc --noEmit`.
- `bun test`.

The sidecar is orthogonal - it runs outside of bun and is respawned on first tool call if missing. It is intentionally NOT killed on MCP server exit because sibling sessions share one sidecar via the port file.
