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
      schema.ts                  # 20 project migrations + 2 global, +1 (v21) for permission_audit (0.30.15+)
    engine/
      composer.ts                # briefing assembly, user profile composition
      linker.ts                  # FTS5 search, hybrid RRF+MMR, auto-linker
      deduplicator.ts            # Jaccard-based dedup, MIN_SHARED_KEYWORDS=3
      embeddings.ts              # ONNX sidecar client, backfill, embed-on-demand
      hybrid_search.ts           # pure-math RRF, MMR, cosine similarity
      scorer.ts                  # confidence promotion
      session_tracker.ts         # session_log / session_registry, cross-session, ghost-session aware (0.30.8+)
      signal.ts                  # pheromone deposit / decay / boost (ANTS)
      agent_channel.ts           # R8 (0.29.0): filewatcher polling JSONLs, fires notifications/claude/channel; 0.30.16+: also drains system_events.jsonl
      agent_channel_filter.ts    # R8: pure filter for which JSONL events warrant cross-session forwarding
      agent_channel_state.ts     # R8: atomic-write helpers for sessions.json / state.json / per-receiver offset files
      addressing.ts              # R8: pure parser for @PA / @SA-<id8> / @all + slash + NL overrides; 0.30.11: line-anchored ADDRESS_RE
      live_sessions.ts           # 0.30.8+: heartbeat-fresh session_ids from sessions.json (90s threshold); getLiveOtherSessionIds()
      system_events.ts           # 0.30.16+: append-only JSONL bus for cross-MCP events (permission_request_pending, permission_verdict)
      permission_relay.ts        # 0.30.15+: PA-gated permission engine; PermissionRelay class with registerPending/resolveVerdict/cleanup
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
      permission.ts              # 0.30.15+: respond_to_permission handler (PA-only; conditional on ORCHESTRATOR_PA_PERMISSION_RELAY=1)
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

Migrations live in `mcp/db/schema.ts`, versioned 1-21 (project) and 100-101 (global-only). Migration 20 (R8, 0.29.0) drops `session_messages` and `session_message_reads` after the cross-session messaging system was replaced by agent-channel notifications. Migration 21 (0.30.15+) creates `permission_audit` for the PA-gated permission relay - one row per request_id with `source_session`, `tool_name`, `description`, `input_preview`, `verdict`, `pa_session`, `pa_reason`, `resolved_at`, `resolved_by`. Project-scoped: each project's permission decisions stay with that project's DB.

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

**Agent-channel state (R8 0.29.0; migrated to SQLite in 0.30.35)** - lives in the filesystem (not the project DB) because it's per-instance and per-session-lifetime. Originally three flat JSON files written via a temp-file+rename atomicWrite; **0.30.35 consolidated all of it into ONE SQLite DB** `<project>/.orchestrator-state/agent-channel/agent_channel.db` (WAL mode) to kill a concurrent read-modify-write stomping race (N MCPs heartbeating + per-tick offset writes could clobber each other, making a live MCP invisible to the fleet for 60-120s). Tables (authoritative DDL in `agent_channel_state.ts`):
- `sessions` - registry of active sessions (PA + SAs): `session_id, id8, role, name, started_at, last_heartbeat_at, current_task, kind`. Each MCP upserts its own row on startup, touches it on a 30s heartbeat, deletes it on clean shutdown.
- `global_pause` (singleton `id=1`) + `sa_pause` - override state (`/pa-pause`): global pause + per-SA pauses.
- `offsets` (`receiver_id8, jsonl_path, offset_bytes`) - per-receiver JSONL byte offsets so the filewatcher resumes without replaying.
- `system_events` (0.30.36+) - cross-MCP event bus (permission request/verdict, post-compact peer-backstop); auto-increment `id`, receivers track `lastSeenId` in memory.
The retired flat `sessions.json` / `state.json` / `offsets-*.json` are migrated-then-deleted on first access (idempotent, mixed-version-tolerant); their pre-0.30.35 `*.tmp.*` atomicWrite debris is reclaimed by a one-time best-effort age-gated sweep added in 0.30.50.

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

Twenty-three tools registered in `mcp/server.ts` (22 agent-callable + 1 internal `_hook_event` for hook routing), plus one conditional PA-only tool (`respond_to_permission`, registered only when `ORCHESTRATOR_PA_PERMISSION_RELAY=1` and role=prime). Grouped by verb class so their equal-priority intent is visible at a glance.

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

**Multi-part messages: the EXPLICIT ENVELOPE is the default (0.30.51).** Routing/splitting is parsed RECEIVER-side. A bare `@SA-<id8>` one-liner needs nothing special. For ANY multi-paragraph / markdown message, wrap it: a line `@@@ @SA-<id8>` (or `@@@ @PA` / `@@@ @SA-a,@SA-b` / `@@@ @all`), the content in any shape (blank lines, bold/colon headers, bullets, ``` fences), then a bare `@@@` closer - delivered whole and verbatim to those targets only, inner `@`-mentions literal, cascade-transparent. The envelope tokenizer (`splitContentUnits`) shipped 0.30.46 (WI eabc89b6); it became the documented default in 0.30.51 once the fleet was uniformly >=0.30.46 and the markdown-aware colon-header fix (0.30.45, WI 7ff34714) was bilaterally live-confirmed. The legacy implicit path - a bare one-liner, or a colon-header (`@SA-<id8> ...:`) opening a sticky cascade over following unaddressed paragraphs (a non-colon addressed paragraph opens NO cascade: the b4c37849 mixed-audience invariant) - is retained only as the fallback for a positively-known-pre-0.30.46 receiver. Full rationale: `DECISIONS.md` 0.30.51; canonical convention orchestrator-KB `872e0f2d`.

| Tool | Purpose |
|---|---|
| `update_session_task` | Broadcast what the caller is currently working on (writes `session_registry.current_task` AND `sessions.json` entry). Peers see this as the `from_task` field on every channel notification you generate, in their briefing's Cross-Session Activity section, and in hook-time activity injections. |
| `respond_to_permission` | **PA-only, conditional** (registered when `ORCHESTRATOR_PA_PERMISSION_RELAY=1` and role=prime). Args: `request_id`, `verdict` (`allow` / `deny` / `defer_to_human`), `reason?`. Non-allow verdicts require a non-empty reason. Emits a `permission_verdict` event onto the `system_events.jsonl` bus targeted at the originating SA (looked up in `permission_audit`); the SA's filewatcher reads the bus on its next tick and calls `permissionRelay.resolveVerdict` to unblock the pending Promise. See "Permission relay architecture" below. |

### Admin

| Tool | Purpose |
|---|---|
| `retro` | Decay confidence on stale notes, merge duplicates, identify orphans, queue revalidation, compute autonomy scores, analyze user-model trajectories. R5 verification pass: when `CLAUDE_PROJECT_DIR` (fallback `ORCHESTRATOR_PROJECT_ROOT`) is set, iterates notes with `code_refs`, checks file-existence at the project root, reports `code_refs verified: N checked, M broken`. Also updates `plugin_state.last_retro_run_at` so auto-retro gate from briefing can skip for another 7 days. |
| `install_embeddings` | Check + install Python/uv/uvx for the embedding sidecar. |
| `system_status` | Knowledge base size, embedding coverage, active sessions, cross-session discovery health. |

### Internal (hook-only)

| Tool | Purpose |
|---|---|
| `_hook_event` | Dispatcher invoked by `type:"mcp_tool"` hooks via `hooks.json`. Routes per `event` name (UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure / PreCompact / **SessionStart** [0.30.39, compact-matcher only] / Stop / StopFailure / SubagentStop / TaskCompleted). Returns the event-appropriate envelope: `hookSpecificOutput`-shaped for HSO events (`HSO_EVENTS`: UserPromptSubmit / PreToolUse / PostToolUse), top-level fields (`systemMessage` / `decision`) for the rest — emitting `hookSpecificOutput` for a non-HSO event is a schema-validation failure (`hook_envelope.test.ts` guards this). Agents do not call this directly; the leading `_` flags it as internal. |

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

**Line-anchored address regex (0.30.11+).** `ADDRESS_RE` requires the `@`-tag to be in an addressing context:
- start of content or line (optionally after a list bullet `-` / `*`)
- after a comma (recipient chain: `@A, @B sync up`)
- after `and` / `&` with whitespace (recipient chain: `@A and @B sync up`)

Descriptive mentions in mid-prose ("my warm tick addresses @SA-95e6890e every 50min", `"@PA warm" reply`) no longer trip routing. Pre-0.30.11 these falsely addressed PA's private dialogue with the user into SA contexts via channel routing (work_item b4c37849).

**`agent_channel_filter.ts`** - pure filter. Decides which JSONL events warrant cross-session forwarding. Forwards: user input, assistant text, mutating tool calls (Edit/Write/Bash/MultiEdit/git_*), summaries. Drops: tool_result bodies (too noisy; PA can read JSONL ad-hoc if it cares), system messages, read-only tool calls. Walks all blocks of a multi-block assistant message and prefers text over tool-use for forwarding, so a Read-then-text pattern doesn't lose the text.

**`agent_channel_state.ts`** - SQLite-backed state layer (0.30.35+) over the single `agent_channel.db` (WAL): `sessions` / `global_pause` / `sa_pause` / `offsets` / `system_events` (0.30.36). WAL + `INSERT OR REPLACE` upserts give atomic, race-free concurrent access by N MCPs (no read-modify-write window) - this replaced the prior temp-file+rename atomicWrite over flat JSON, whose stomping race + orphaned `*.tmp.*` debris were the reason for the migration. Legacy flat files are migrated-then-unlinked on first access; a one-time age-gated best-effort `*.tmp.*` sweep (0.30.50) reclaims the pre-migration debris. Tolerant readers - failure returns empty/default rather than throwing.

The shared filesystem state replaces the per-process `inboxCounters` Map and the SQLite `session_messages` table that the R6/R7 architecture relied on. No counter drift, no per-session inbox, no polling - notifications fire in real-time as soon as the filewatcher sees the JSONL line written.

### live_sessions.ts + ghost-session filter (0.30.8+)

`session_tracker`'s "active siblings" used to derive from the project DB only: a 24h window over `session_log` / `session_registry`. That worked when sessions terminated cleanly, but Ctrl+C'd / force-closed / crashed sessions left their `session_registry` row behind - they kept showing up as "active" for up to 24 hours until the cleanup pass reaped them. Field reports: PA / SAs hearing about ghost siblings whose MCP had been dead for hours, and briefing's `cross_session` section listing notes attributed to long-departed sessions.

`live_sessions.ts` adds the live signal: `sessions.json`'s 90s heartbeat is authoritative on "this MCP is currently alive". The 30s heartbeat tick is written by AgentChannel; anything more than 90s stale (3 missed heartbeats) is treated as dead.

`getLiveOtherSessionIds(sessionId)` returns the heartbeat-fresh OTHER session_ids (excluding self), or `null` when `sessions.json` doesn't exist (project not using agent-channel). The session_tracker's `getActiveSiblings` and the briefing composer's `cross_session` SQL both intersect against this set:

- If `getLiveOtherSessionIds()` returns `null`: fall back to the 24h DB-only behavior (no live filter available).
- If `getLiveOtherSessionIds()` returns `[]`: short-circuit to zero matches (the live filter is authoritative AND empty).
- Otherwise: `WHERE n.source_session IN (?, ?, ...)` against the live-other list, building one placeholder per id.

Tests pass `() => null` to the SessionTracker constructor so the live-filter path stays inert and 24h DB-only behavior is exercised - same path users without agent-channel see.

`session_log` (the "I surfaced this note before" history) is NOT intersected with live sessions. A session that surfaced a note an hour ago is still a real "I saw this" signal even if that session has since died. The ghost-session problem is specifically about who counts as a current sibling source, not who has touched a note historically.

### Permission relay architecture (0.30.15+, opt-in)

PA-gated tool-permission routing. When `ORCHESTRATOR_PA_PERMISSION_RELAY=1` is set in the SA's environment, Claude Code's tool-permission prompts go to PA instead of the SA's terminal. PA evaluates against user-patterns / conventions / anti-patterns and emits a verdict; the SA's permission_relay resolves a pending Promise; the SA's notification handler emits the verdict back to CC.

**Three cooperating modules:**

**`mcp/engine/permission_relay.ts`** - the `PermissionRelay` class. Owned by SAs only (PAs never instantiate one; they only respond). Stores pending requests keyed by `request_id`. Methods:
- `registerPending(input)` - writes a `permission_audit` row (verdict `NULL` until resolved), sets a 30s timeout that fires `defer_to_human` if PA hasn't responded by then, returns a Promise. Collision handling: if the same `request_id` is registered twice (CC retry on transient failure), the existing Promise is mirrored - both callers settle together when the verdict lands, preventing orphaned `resolve` closures.
- `resolveVerdict(request_id, verdict_input)` - first-verdict-wins guard. Updates the audit row + clears the timeout + resolves the Promise. Double-resolve is a no-op.
- `listSourceFor(request_id)` - lookup helper. Checks in-memory pending first, then queries `permission_audit` for past requests.
- `cleanup()` - shutdown helper. Settles all in-flight pending Promises with `defer_to_human` (so the SA's notification handler returns sensibly to CC) and clears their timers. Without this, `await registerPending(...)` would hang forever and the Node event loop would stay alive, preventing clean MCP exit.

**`mcp/engine/system_events.ts`** - the cross-MCP file bus. `<project>/.orchestrator-state/agent-channel/system_events.jsonl`, append-only JSONL. Each event has `event_type` (discriminator), `from_session`, `to_session` (single target; broadcast not supported on this bus), `ts`, plus event-type-specific payload fields. `appendSystemEvent` ensures parent dir exists and emits one JSON-per-line. `readNewSystemEvents` reads from a caller-tracked byte offset, handles truncation (size < offset -> reset to 0), skips malformed lines (one bad entry doesn't break the bus), and returns parsed events + the new offset. The bus exists because the regular JSONL filewatcher reads events authored by sessions; permission routing emits events authored by MCPs themselves, which the session filewatcher can't see.

**`mcp/tools/permission.ts`** - the `respond_to_permission` MCP tool. PA-only. Args: `request_id`, `verdict` (`allow` / `deny` / `defer_to_human`), `reason?`. Contract: non-allow verdicts MUST have a non-empty reason - the handler refuses without one to keep the audit log comprehensible. Emits a `permission_verdict` event via an injected `emitChannelEvent` callback (which `server.ts` wires to `appendSystemEvent` - the verdict MUST traverse to the SA's MCP process via the bus; an in-process notification would stay local to PA).

**The cross-MCP flow (server.ts wiring, Phase 2b):**

```
1. CC -> SA's MCP: notifications/claude/channel/permission_request (request_id, tool_name, ...)
2. SA's notification handler (registered conditionally on PERMISSION_RELAY_ENABLED && role=="subordinate"):
   - Defense-in-depth: zod safeParse on raw params (the SDK's setNotificationHandler with `as any`
     cast does NOT runtime-validate). Malformed -> stderr log + drop.
   - Resolve PA's session_id from sessions.json. No PA active -> log + return (CC falls back
     to terminal prompt).
   - relay.registerPending(...) -> writes audit row, returns Promise.
   - appendSystemEvent("permission_request_pending", to=PA's session_id).
   - await Promise.
3. PA's MCP AgentChannel filewatcher: processSystemEvents() on next tick reads new bus events.
   - Sees event addressed to PA -> emit a channel notification to PA's session inline
     (event_type="permission_request_pending", pa_addressed=true).
4. PA reads the inline notification, evaluates, calls respond_to_permission({request_id, verdict, reason}).
5. respond_to_permission handler:
   - Look up source_session from permission_audit table (the SA's MCP wrote the row).
   - emitChannelEvent callback -> appendSystemEvent("permission_verdict", to=source SA).
6. SA's MCP AgentChannel filewatcher: processSystemEvents() on next tick reads the verdict event.
   - permissionRelay.resolveVerdict(request_id, ...) -> resolves the awaiting Promise.
7. SA's notification handler (back from await):
   - For allow/deny: server.notification("notifications/claude/channel/permission", {behavior, message}).
   - For defer_to_human: DO NOT emit. Absence is CC's signal to fall back to terminal prompt.
     (Emitting deny would foreclose that fallback. Caught by code-review 2026-05-11.)
```

The defer_to_human + no-emit contract is load-bearing. CC's protocol treats response absence as the fallback signal; if we silently mapped `defer_to_human` to `behavior: "deny"` (which the v0.30.17 code initially did) we'd trap the SA at the permission gate with no escape. The v0.30.18 fix removes the silent mapping.

### Per-PID session-id resolution (0.30.19+)

`getFallbackSessionId()` in `mcp/server.ts` resolves the current session_id when a tool handler is called without an explicit `session_id` argument. Resolution order:

1. Explicit param to the handler.
2. `CLAUDE_SESSION_ID` env var (Claude Code doesn't reliably set this; defensive only).
3. **Per-claude-PID file** (0.30.19+): walk the process tree to find the claude.exe ancestor PID, then read `<project>/.orchestrator-state/active-session-<claude_pid>`. Race-free because each claude session writes its own per-PID file; concurrent siblings can't collide.
4. **Legacy single-file**: `<project>/.orchestrator-state/active-session`. Last-writer-wins across concurrent siblings; included for back-compat with pre-0.30.19 hooks.

The session-start hook (`hooks/session-start`) writes BOTH files - per-PID AND legacy single - so new MCPs prefer the per-PID path and old MCPs fall back to legacy.

**Process tree walk.** `findClaudeAncestorPid()` walks up to 8 ancestors looking for `claude` / `claude.exe`. Windows: WMIC `process where processid=N get name,parentprocessid`. Unix: `/proc/<pid>/stat` field 2 (comm in parens) and field 4 (ppid). Cached on first successful resolution (the MCP server is per-session by stdio design - its session_id cannot change during its lifetime).

**Why this exists.** Pre-0.30.19, concurrent Claude Code sessions in the same project all wrote to a single `active-session` file. Last writer won. If session B started seconds after session A and B's hook ran first, A's MCP read B's session_id from the shared file and registered the wrong session_id in `sessions.json`. Subsequent heartbeats kept overwriting the entry with the wrong role - "impostor MCP". Diagnosed in `120b8e59-fbef-4847-8c04-6bc7aa3ad378` (orchestrator KB) and tracked as work_item `ea1bec63`.

The legacy single-file path is still tried if per-PID read fails, with an explicit stderr warning when claude_pid is known but per-PID file is missing:

```
[orchestrator] resolved session_id from LEGACY active-session file
(claude_pid=N but per-PID file missing): xxxxxxxx...
(if you have multiple concurrent claude sessions, this read is racy)
```

This makes the racy fallback visible in plugin logs so operators can correlate impostor symptoms with stale hooks.

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
- `pa-bootstrap` - first-action skill PA runs after `pa-start.bat` launches. Confirms PA is on the latest Opus (or Fable when available) + `/effort xhigh`, confirms role=prime, reads the agent-channel SQLite registry, loads `agents/prime-agent.md`, outputs readiness status. Idempotent.
- `pa-pause` - override. In an SA terminal: pauses PA's posture toward THIS SA only. In PA's terminal: global pause across all SAs. Atomic-writes `state.json`.
- `pa-resume` - inverse of pa-pause. Clears the appropriate scope.
- `pa-takeover` - force-claim PA primacy from an orphaned previous PA. Updates sessions.json roles atomically; expects `/pa-bootstrap` to follow.

### Agents

Located in `agents/`.

- `prime-agent` (R8, 0.29.0+) - the PrimeAgent operating contract. Replaces the deleted `memory-concierge`. Defines authority (always-driveable SAs by default, with override), communication model (terminal output → agent-channel filewatcher routes, no send_message), typical patterns (coordination, driving, three-way, override discipline, self-improvement), and explicit don'ts. Read by `/pa-bootstrap` step 5.
- `orchestrator-reflect` - maintenance agent. Invoked manually or via `/orchestrator:reflect`. Wraps `retro()` and a structured analysis pass.

## Hook flow

Hooks registered in `hooks/hooks.json`. Most use `type: "mcp_tool"` and dispatch through the `_hook_event` MCP tool (R6 dispatcher pattern; survives R8). The **universal** `SessionStart` (`matcher:"*"`) stays bash because the MCP server may not be connected yet at first session boot. 0.30.39 adds a **second** `SessionStart` entry, `matcher:"compact"`, that DOES route to `_hook_event` — post-compaction the MCP is already connected, so the compact-only re-orientation can be a normal mcp_tool dispatch (it does not regress first-boot, which the bash `matcher:"*"` entry still owns). Hook state is in `plugin_state` (per-session keys), not in a state-dir.

| Hook point | Type | Purpose |
|---|---|---|
| `SessionStart` `matcher:"*"` | `command` (bash) | Writes `active-session` file (read by `server.ts:getFallbackSessionId` when the agent forgets to pass session_id). Emits MANDATORY FIRST ACTIONS system-reminder text. |
| `SessionStart` `matcher:"compact"` (0.30.39) | `mcp_tool` -> `_hook_event` (event `"SessionStart"`) | Post-compaction only (auto + manual; the universal bash entry above still owns first-boot). `handleSessionStartCompact` returns a **bounded top-level `systemMessage`** (SessionStart is NOT an HSO-valid `hookEventName` — verified vs `hook_envelope.test.ts`; mirrors `PreCompact`) re-orienting the just-compacted session from the latest checkpoint + `current_task` (167ffbaf self-handoff), and — only when a live PA exists — instructing the SA to post one non-blocking `@PA [post-compact recovery]` peer-backstop solicitation (e4774e4b). Pure core `composePostCompactReorientation` carries the test coverage; the `getLiveSessions()` disk read is the impure shell. |
| `UserPromptSubmit` | `mcp_tool` -> `_hook_event` | Increments per-session turn counter, resets per-turn struggle/orch-active markers, picks rotating reminder, surfaces last-turn bridge from `plugin_state`, injects sibling activity (with R7 keyword-overlap *POTENTIAL OVERLAP* markers; R8 update: full session UUIDs instead of 8-char prefixes; coordinate via `@SA-<id8>` instead of `send_message`). R7: emits loop-closure nudge listing in-flight work_items in scope, escalating to "Close loops NOW" when the user prompt regex-matches approval phrases (≤300 chars). (R8: removed inter-session-message drain - cross-session events arrive via separate `notifications/claude/channel` injection from agent-channel filewatcher, not the hook envelope.) |
| `PreToolUse` on Write/Edit/MultiEdit/NotebookEdit | `mcp_tool` -> `_hook_event` | (1) R7: code_refs hint when the file has tagged notes the session hasn't surfaced (once per session+file). (2) Option-B escalation: soft nudge on turn 2-3 when no orchestrator tool fired this turn; `permissionDecision: "ask"` on turn 4+. |
| `PostToolUse` matcher `.*` | `mcp_tool` -> `_hook_event` | R7: on Edit/Write/MultiEdit/NotebookEdit, surfaces in-flight work_items whose `code_refs` contain the edited file_path (once per session+work_item). On orchestrator-tool calls, marks orch-active for the turn and appends to the next turn's bridge in `plugin_state`. (R8: removed inboxCounters fast path + message drain.) |
| `PostToolUseFailure` | `mcp_tool` -> `_hook_event` | Bumps `struggle_<sid>` counter; soft nudge at 2 consecutive, hard escalation at 3+ (R8 update: nudges at `lookup` first, then `PA, ...` addressing if a PA is active, instead of `consult-concierge`). Reset by `UserPromptSubmit` (new turn) or any successful `PostToolUse`. |
| `PreCompact` | `mcp_tool` -> `_hook_event` | Emits `systemMessage` reminding the model to flush uncaptured knowledge before the window shrinks, and stamps the `compacting_<sid>` marker so `handleStop` suppresses its block on the compaction-driven Stop. 0.30.39: the *post*-compaction half of this story is the new `SessionStart matcher:"compact"` hook above, which auto-injects the re-orientation digest (so re-orient no longer depends solely on the model remembering to call `briefing`). |
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

`tests/` mirrors the engine / tools split. `bun test` runs the whole suite (497 tests across 38 files as of 0.30.19, 0 fail). Zod coercion means HTTP-style string inputs work from the MCP client without manual parsing in handlers.

New 0.30.x test files cover the new modules: `tests/engine/live_sessions.test.ts`, `tests/engine/permission_relay.test.ts`, `tests/engine/system_events.test.ts`, `tests/engine/agent_channel_permission.test.ts` (integration of filewatcher with permission routing), `tests/tools/permission.test.ts`, and updated `tests/engine/addressing.test.ts` covering the line-anchored regex.

## Build and install

- `bun run build` -> `dist/server.js` (Bun target). This is the file `dist/server.js` referenced by the plugin manifest when users `/plugin install orchestrator`.
- `bun run dev` -> runs `mcp/server.ts` directly for local iteration.
- `bun run typecheck` -> `tsc --noEmit`.
- `bun test`.

The sidecar is orthogonal - it runs outside of bun and is respawned on first tool call if missing. It is intentionally NOT killed on MCP server exit because sibling sessions share one sidecar via the port file.
