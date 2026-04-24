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
      schema.ts                  # 15 project migrations + 2 global
    engine/
      composer.ts                # briefing assembly, user profile composition
      linker.ts                  # FTS5 search, hybrid RRF+MMR, auto-linker
      deduplicator.ts            # Jaccard-based dedup, MIN_SHARED_KEYWORDS=3
      embeddings.ts              # ONNX sidecar client, backfill, embed-on-demand
      hybrid_search.ts           # pure-math RRF, MMR, cosine similarity
      scorer.ts                  # confidence promotion
      session_tracker.ts         # session_log / session_registry, cross-session
      signal.ts                  # pheromone deposit / decay / boost (ANTS)
    tools/
      remember.ts                # note() handler + R4 gate
      recall.ts                  # lookup() handler
      supersede.ts               # supersede_note() handler
      orient.ts                  # briefing() handler
      prepare.ts                 # plan() handler
      reflect.ts                 # retro() handler
      check_similar.ts           # check_similar() handler
      update_note_helpers.ts     # snapshotRevision, appendToNoteContent
  skills/                        # 13 proactive skill prompts
  agents/                        # memory-concierge, orchestrator-reflect
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

Migrations live in `mcp/db/schema.ts`, versioned 1-15 (project) and 100-101 (global-only).

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

Related tables:

- `notes_fts` - FTS5 virtual table, porter + unicode61 tokenizer, BM25 ranking with weights `content=1.0, context=0.5, keywords=2.0`. Triggers keep it in sync with `notes`.
- `links` - graph edges. Columns: `from_note_id`, `to_note_id`, `relationship`, `strength`. UNIQUE index on `(from_note_id, to_note_id, relationship)` added in v15.
- `note_revisions` - pre-mutation snapshots for R2. Added in v15. Holds content, context, tags, keywords, confidence, `revised_at`, `revised_by_session`.
- `embeddings` - bge-m3 vectors as BLOB, one row per note, CASCADE-deleted with the note.
- `session_log` - per-surfacing log: which note was shown to which session at which turn, `delivery_type` in {fresh, refresh}.
- `session_registry` - one row per session: `started_at`, `last_active_at`, `last_briefing_at` (v13), concierge handoff state.
- `migrations` - applied-version tracker.

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

Nineteen tools registered in `mcp/server.ts`. Grouped by verb class so their equal-priority intent is visible at a glance.

### Capture

| Tool | Purpose |
|---|---|
| `note` | Capture knowledge not already known. R4 gate: blocks for decision/convention/anti_pattern if similarity >= 0.75 without `resolution`. |
| `save_progress` | Write a `checkpoint`-type note with summary, in-flight, open questions, next steps. |
| `create_work_item` | Trackable task with priority/status/due/parent. |
| `breakdown` | Split a work_item into children via `part_of` links. |
| `user_profile` | View / set / remove structured user observations in the global `user_model` table. |

### Retrieve

| Tool | Purpose |
|---|---|
| `lookup` | Search by query, type, tag; or detail-mode by id. Supports `include_superseded`, `include_history`, `link_limit`. |
| `briefing` | Session-start / resume / clear / compact. Returns open threads, decisions, work, user profile, neglected areas, last checkpoint, cross-session activity, curation candidates. |
| `plan` | Domain-scoped context pack: conventions, anti-patterns, quality gates, architecture, recent decisions for a task. |
| `list_work_items` | Full inventory by status + priority + tag. Not keyword-searched. Signal as secondary sort within priority tier. |
| `list_open_threads` | Full open-thread inventory. Signal as secondary sort. |
| `check_similar` | Pre-implementation check: does this action overlap existing decisions / conventions / anti-patterns? |

### Maintain

| Tool | Purpose |
|---|---|
| `update_note` | `content` replaces (with revision snapshot); `append_content` adds a timestamped segment (no snapshot). Mutually exclusive. |
| `close_thread` | Mark `resolved = 1`, cascade: unblock dependents, auto-complete parent if all children done, auto-resolve superseded chain. Optional `resolution` creates a `decision` note. |
| `supersede_note` | Archive old, surface new. Accepts `new_id` (existing note) or `new_content + new_type` (inline new). |
| `delete_note` | Hard delete (cascades links). Used sparingly - prefer supersede or close_thread. |
| `update_work_item` | Status / priority / due / content / tags / context / confidence / blocked_by. Cascades on `status = done`. |

### Admin

| Tool | Purpose |
|---|---|
| `retro` | Decay confidence on stale notes, merge duplicates, identify orphans, queue revalidation, compute autonomy scores, analyze user-model trajectories. |
| `install_embeddings` | Check + install Python/uv/uvx for the embedding sidecar. |
| `system_status` | Knowledge base size, embedding coverage, active sessions, cross-session discovery health. |

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

## Skills and agents

### Skills (13)

Located in `skills/`. Each is a proactive prompt with activation criteria that Claude Code evaluates against the turn context.

- `every-turn` - dispatcher. MANDATORY every turn per its header. Evaluates which other orchestrator skills apply.
- `orchestrating` - always active. Positions the memory concierge as the default first-line thinking partner.
- `getting-started` - session onboarding / post-compact re-orientation.
- `wrapping-up` - end-of-task / session-end progress save.
- `made-a-decision` - fires after an architectural decision. Uses `note(type:"decision")`.
- `learned-something` - fires on discovery of a pattern / convention / gotcha.
- `closing-a-thread` - fires when an open question is resolved. Uses `close_thread`.
- `consult-concierge` - first-line routing for judgment-heavy work.
- `found-a-problem` - bug / footgun / security / limitation capture.
- `planning-approach` - pre-work context gather for complex tasks.
- `something-went-wrong` - post-debug capture of root cause + pivot.
- `user-preference` - workflow / style / tooling preference capture (global-scoped).
- `what-was-decided` - pre-change lookup for prior decisions.

### Agents (2)

Located in `agents/`.

- `memory-concierge` - the persistent session thinking partner. Rewritten in R3.6 with Shape A (structured artifact request) / Shape B (batch capture request) framing. Prior prompt biased toward save_progress-shaped handoffs and would return "nothing else to capture" after large batches of work.
- `orchestrator-reflect` - maintenance agent. Invoked manually or via `/orchestrator:reflect`. Wraps `retro()` and a structured analysis pass.

## Hook flow

Bash scripts under `hooks/`, registered in `hooks/hooks.json`. All hooks are best-effort and share `_lib.sh` for state-dir helpers. State dir is `$CLAUDE_PROJECT_DIR/.orchestrator-state/` - scoped to the project, not global.

| Hook point | Purpose |
|---|---|
| `SessionStart` | Writes `active-session` file (used by server.ts `getFallbackSessionId` when the agent forgets to pass session_id). Emits MANDATORY FIRST ACTIONS system-reminder text. |
| `UserPromptSubmit` | Emits rotating `[orch] ...` turn bridge reminders. |
| `PreToolUse` on Write/Edit/MultiEdit | Discipline nudge before edits. |
| `PostToolUse` on `mcp__plugin_orchestrator_memory__.*` | Post-capture confirmation / follow-up nudges. |
| `PostToolUseFailure` | Surface failure patterns. |
| `PreCompact` | Flush capture targets before context compaction. |
| `Stop` | Maintenance-verb prompt (R3.4) + session-activity nudge pulled from `session_log`. |
| `SubagentStop` | Sibling of Stop for subagent threads. |

State-dir marker files ensure once-per-session behavior for prompts that should not repeat.

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
       -> compose sections in parallel (filtered by `sections` param if given)
          work_items, open_threads, decisions, neglected, drift,
          user_model, cross_project, cross_session, checkpoint, curation_candidates
       -> update session_registry.last_briefing_at
    -> depositSignalBatch WEAK on every note surfaced in the briefing
    -> append "## Setup Available" when sidecar unavailable on startup event
    -> return formatted markdown
```

## Testing

`tests/` mirrors the engine / tools split. `bun test` runs the whole suite. Zod coercion means HTTP-style string inputs work from the MCP client without manual parsing in handlers.

## Build and install

- `bun run build` -> `dist/server.js` (Bun target). This is the file `dist/server.js` referenced by the plugin manifest when users `/plugin install orchestrator`.
- `bun run dev` -> runs `mcp/server.ts` directly for local iteration.
- `bun run typecheck` -> `tsc --noEmit`.
- `bun test`.

The sidecar is orthogonal - it runs outside of bun and is respawned on first tool call if missing. It is intentionally NOT killed on MCP server exit because sibling sessions share one sidecar via the port file.
