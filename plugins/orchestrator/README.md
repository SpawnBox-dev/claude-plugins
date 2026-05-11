# Orchestrator

A Claude Code plugin that acts as a persistent product co-pilot. Learns your project and you. Makes every agent interaction better.

## Architecture

Orchestrator maintains three evolving models across sessions:

- **Product model** - Systems, architecture, dependencies, conventions, anti-patterns
- **User model** - Intent patterns, decision style, strengths, blind spots
- **Work model** - In-flight items, commitments, decisions, neglected areas

Everything is stored in two SQLite databases (project-scoped + global) with FTS5 full-text search and vector embeddings for semantic retrieval. Notes are linked into a knowledge graph with typed relationships (depends_on, conflicts_with, supersedes, etc.).

### Search & Retrieval

Hybrid search combines two paths:

- **FTS5 BM25** - keyword matching with weighted fields (keywords 2x, content 1x, context 0.5x)
- **Vector cosine similarity** - 1024-dimensional embeddings via ONNX bge-m3 sidecar

Results are merged via **Reciprocal Rank Fusion** (RRF), then diversified with **Maximal Marginal Relevance** (MMR) to prevent similar notes from clustering. **ANTS** (Adaptive Note Temperature System) gives a signal boost to frequently-accessed notes.

When the embedding sidecar is unavailable, search degrades gracefully to FTS5-only.

### Embedding Sidecar

A Python HTTP server (`sidecar/embed_server.py`) runs the ONNX bge-m3 model locally on CPU. Managed automatically:

- Spawned via `uvx` on MCP server startup (handles Python env + deps)
- Falls back to direct `python`/`python3` if uvx unavailable
- Model cached after first download (~1.5GB from HuggingFace)
- Health check: `GET /health` - Embed: `POST /embed`
- Graceful degradation: if sidecar doesn't start, all features work via FTS5

### Cross-Session Orchestration: PrimeAgent + agent-channel (0.29.0+)

The plugin's MCP server declares the `claude/channel` capability (the same primitive the official Discord channels plugin uses). When multiple Claude Code sessions run against the same project, cross-session events are routed in real-time via `notifications/claude/channel` - no polling, no hook drain, no `send_message` tool.

**Roles:**
- **PrimeAgent (PA)** - persistent orchestrator session, role=prime, runs Opus at max effort. Singleton per project. Authoritative observer of all events.
- **Subordinate Agent (SA)** - any other Claude Code session in the project, role=subordinate. Sees events addressed to it; treats PA's directives as the user's voice unless overridden.

**How sessions communicate:**
- Type `@PA` / `@PrimeAgent` in your terminal output to address the prime.
- Type `@SA-<id8>` (8-char prefix) to address a specific subordinate.
- Type `@SA-<id8>,@SA-<id8>` for multiple, or `@all` to broadcast.
- The conversational form `PA, ...` also addresses PA.
- Free-form text without an `@` prefix is private dialogue with the user; PA still observes by default; no SA receives it.

**Addressing parser semantics (0.30.11+):**
An `@SA-<id8>` token only counts as addressing when it sits in an addressing context: at the start of a line (optionally after a list bullet `-` / `*`), after a comma (recipient chain - `@A, @B sync up`), or after `and` / `&` with whitespace. Mentions in the middle of prose ("my warm tick addresses @SA-95e6890e every 50min", `"@PA warm" reply`) no longer trip routing. Without this, PA's private dialogue with the user would leak into SAs' contexts every time it described addressing.

**Filewatcher routing:**
Each session's MCP server instance runs a filewatcher that polls `~/.claude/projects/<hash>/*.jsonl` every 1.5s, parses new events, applies the addressing parser, and emits `notifications/claude/channel` for events that should reach its session. PA receives all events by default; SAs receive only what's explicitly addressed to them.

**Ghost-session filter (0.30.8+):**
"Active siblings" comes from two sources: the project DB's 24h hook-event window (`session_log` / `session_registry`) and `sessions.json`'s 90s heartbeat. Pre-0.30.8 the DB window was authoritative on its own and surfaced sessions whose MCP had died (Ctrl+C, force-close, crash) but hadn't had time to fall off the 24h window. The 0.30.8 / 0.30.9 fix intersects the two: a sibling only counts as live if it shows up in BOTH lists. `getLiveOtherSessionIds()` (`mcp/engine/live_sessions.ts`) is the helper; AgentChannel and the `briefing.cross_session` section both call through it. When `sessions.json` doesn't exist (project not using agent-channel), the helper returns `null` and callers fall back to the DB-only 24h window.

**Override controls:**
- `/pa-pause` in an SA terminal pauses PA's posture toward that SA only.
- `/pa-pause` in PA's terminal sets a global pause across all SAs.
- `/pa-resume` clears the corresponding pause.
- `/pa-takeover` (in a new PA window) forcibly claims primacy from an orphaned previous PA.
- Natural-language equivalents are recognized: "PA, back off / stand down / take five / pause" and "PA, come back in / resume".

**Launchers:**
The orchestrator plugin doesn't ship the launchers - they're per-project conventions. In SpawnBox the convention is `pa-start.bat` (gold tab, Opus, max effort, singleton check) and `sa-start.bat` (default tab, optional `--name`). Both pass `--channels plugin:orchestrator@<marketplace>` so the channel capability is attached.

### PrimeAgent's Two Missions (0.30.12 - 0.30.14)

PA is not just a coordinator. It has two defining duties, both spelled out at length in [agents/prime-agent.md](agents/prime-agent.md) and loaded automatically by `/pa-bootstrap`.

**Mission 1: artificial-user identity.** PA is "an artificial version of the user this orchestrator instance serves". Its most important duty is to most intimately understand what the user would do, want, decide, and refuse - and then act consistently with that. `user_pattern` notes in the global DB are PA's primary user-knowledge source; they persist across every project and encode preferences, work habits, communication style, decision biases, values, and explicit dislikes. PA loads them at bootstrap (Step 5.5) and reloads them whenever it's about to act on the user's behalf in a non-trivial moment. When an SA hits a decision point that maps onto a captured user-pattern, PA speaks with the user's authority - "don't use em-dashes" is a settled preference, no need to check.

**Mission 2: ultra-macro forest view.** PA holds the whole-project macro model so SAs don't make tree-level decisions that break the forest. "Forest" here is NOT just code architecture - it spans:

- Code architecture (subsystem relationships, conventions, design constraints)
- Product strategy (vision, target audience, value proposition, quality bar)
- Business model (revenue mechanism, pricing tiers, cost structure, growth strategy)
- Market context (competitors, ecosystem, positioning)
- People (the user, collaborators, named community members, individual engagement threads)
- Operations (deployment pipeline, release channels, on-call posture, hibernation flows, telemetry, infrastructure providers)
- Project memory (open initiatives, in-flight work, accumulated anti-patterns, captured conventions)

SAs tunnel-vision into the file/function/test they're working on. They make decisions that look locally correct but conflict with the macro - sometimes the code-architecture macro, just as often the business macro (recommending a solution that erodes the product's positioning), the operations macro (proposing a flow that breaks the deployment pipeline), or the people macro (drafting outreach to a user whose engagement note documents a different ongoing thread). PA's job is to surface those conflicts before the SA proceeds. Step 5.6 in `/pa-bootstrap` loads `architecture` / `decision` / `convention` / `anti_pattern` notes into PA's working context so it can apply them during SA coordination.

**Multi-repo awareness (0.30.14).** "The project" is often delivered by several coordinating repos (app + landing-page + worker + plugins + docs). PA's macro model spans the union, not just the cwd repo. Step 5.7 in `/pa-bootstrap` scans CLAUDE.md and `architecture` notes for cross-repo references and surfaces gaps. Today the orchestrator MCP only reads `project.db` from the running session's cwd; auto-union across related repos' DBs is a future feature. PA holds the multi-repo map in working context and applies it proactively.

### PA-Gated Permission Relay (0.30.15 - 0.30.18, opt-in)

When `ORCHESTRATOR_PA_PERMISSION_RELAY=1` is set in the SA's environment, Claude Code's tool-permission prompts are routed through PA instead of stopping at the SA's terminal. PA evaluates the request against captured user-patterns, project conventions, and risk posture, then emits `allow` / `deny` / `defer_to_human`. The mechanism is opt-in (default off) because it changes the trust boundary for tool execution and is gated by the user's deliberate decision.

**Why this exists.** Many tool calls SAs make are uncontroversial (read a file, list a directory) but Claude Code prompts on each one. Routing the prompt to PA lets the orchestrator approve low-risk reads silently while still surfacing high-risk writes to the human. PA holds the project's risk model (user-patterns + conventions + anti-patterns) in working context, so its judgment is better-calibrated than a per-prompt human decision made out of macro context.

**Protocol (cross-MCP, file-bus mediated):**

```
SA's MCP receives inbound notifications/claude/channel/permission_request from CC
  -> PermissionRelay.registerPending(request_id, ...)
       writes permission_audit row, returns a Promise
  -> appendSystemEvent("permission_request_pending", to=PA's session_id)
  -> await Promise

PA's MCP filewatcher sees the bus event on its next tick
  -> emits a channel notification to PA's session inline
PA reads it, decides verdict
  -> calls respond_to_permission(request_id, verdict, reason)
       which appendSystemEvents("permission_verdict", to=SA's session_id)

SA's MCP filewatcher sees the verdict event on its next tick
  -> permissionRelay.resolveVerdict(request_id, ...) resolves the Promise

SA's notification handler awakes
  -> for allow/deny: emits notifications/claude/channel/permission back to CC
  -> for defer_to_human: emits nothing - CC's protocol treats response
                          absence as the signal to fall back to terminal prompt
```

The bus is `<project>/.orchestrator-state/agent-channel/system_events.jsonl` - an append-only JSONL bus, offset-tracked, malformed-line-tolerant, truncation-recovering (see `mcp/engine/system_events.ts`). The bus was added because the JSONL filewatcher reads session transcripts (events authored by sessions), but PermissionRelay needs to emit events authored by the MCP itself - hence a separate bus.

**Audit trail.** Every request gets a row in the project DB's `permission_audit` table (migration 21) with `request_id`, `source_session`, `tool_name`, `description`, `input_preview`, `verdict`, `pa_session`, `pa_reason`, `resolved_at`, `resolved_by` (`pa` / `timeout` / `shutdown`). Non-allow verdicts MUST carry a reason (the tool refuses without one) so the audit log stays comprehensible.

**Risk-tier framing for PA.** When PA receives a `permission_request_pending`, it should treat the verdict choice as a tiered judgment:
- **Allow silently** for low-risk reads aligned with captured patterns (Read, Grep, Glob on project paths).
- **Allow with reason** for medium-risk operations on tracked code paths.
- **Deny with reason** when the request contradicts a known anti-pattern, convention, or user-pattern.
- **Defer to human** when uncertain or when destructive (force-push, mass delete, prod write).

The Promise resolves on first verdict (allow / deny / defer_to_human / timeout / shutdown). Timeout default is 30 seconds; on timeout the audit row is marked `resolved_by="timeout"` and the SA's response handler returns nothing (so CC falls back to the terminal prompt). Same for shutdown - `PermissionRelay.cleanup()` settles all in-flight pending Promises with `defer_to_human` so the Node event loop can exit cleanly.

### MCP Tools

| Tool | Purpose |
|------|---------|
| `briefing` | Session startup briefing - open threads, recent decisions, work items, user profile, drift warnings, plus a `curation_candidates` section surfacing stale-but-hot and low-confidence-but-hot notes with maintenance handles. R4.4 auto-retro gate: on the first `event=startup` of a week (7-day cadence), inline-invokes `retro` and prepends the summary as `## Auto-Retro` |
| `note` | Persist knowledge - decisions, patterns, anti-patterns, conventions. Auto-embeds, auto-links, dedup-checks. Accepts `code_refs: string[]` for file/module breadcrumbs |
| `lookup` | Query the knowledge graph with hybrid search (FTS5 + vector). Supports `id`, `query`, `code_ref` (reverse-index), `include_superseded`, `include_history`, `link_limit` |
| `plan` | Curated context package for tasks and subagent hydration |
| `check_similar` | Find prior art before implementing - semantic similarity against decisions/conventions/anti-patterns |
| `system_status` | Health check - note counts, embedding coverage, sidecar status, active sessions |
| `install_embeddings` | First-run setup - detect/install Python and uv dependencies for embedding support |
| `save_progress` | Checkpoint for next session - what was done, open questions, next steps |
| `close_thread` | Resolve an open thread with cascade |
| `update_note` | Modify note content/tags/confidence in place. Re-embeds on content change. Supports `append_content` mode for lightweight timestamped additions |
| `supersede_note` | Replace an old note with a new one; preserves history. Hidden from default lookup; graph-linked for traceability |
| `delete_note` | Remove wrong/outdated knowledge (last resort - prefer `supersede_note` or `close_thread`) |
| `user_profile` | View/set/remove structured user observations by dimension |
| `create_work_item` | Track a concrete task with priority and optional due date |
| `update_work_item` | Change status/priority/content/due date/tags/context/confidence/code_refs |
| `breakdown` | Split complex work into parent + children work items |
| `retro` | Knowledge maintenance - consolidation, signal decay (ANTS), gap analysis, dedup, code_refs verification |
| `list_open_threads` | List all open threads with status and signal |
| `list_work_items` | List work items filtered by status/priority |
| `update_session_task` | Broadcast `current_task` so peer sessions see what you're working on as the `from_task` field on every channel notification you generate |
| `respond_to_permission` | **PA-only, conditional** (registered only when `ORCHESTRATOR_PA_PERMISSION_RELAY=1`). Respond to a routed `permission_request_pending` channel event with `verdict` (`allow` / `deny` / `defer_to_human`) and optional `reason` (required for non-allow verdicts). Emits a `permission_verdict` event onto the system_events bus so the originating SA's relay can resolve its pending Promise. |

**Cross-session communication is via terminal output, not a tool.** The `send_message` / `read_messages` / `peek_inbox` tools that existed in 0.28.x and earlier (R6/R7 messaging) were deleted in 0.29.0 in favor of agent-channel notifications. Type `@PA` / `@SA-<id8>` / `@all` in your terminal output and the filewatcher routes the addressing automatically.

### Engine

The engine layer handles the intelligence behind the tools:

- **Hybrid Search** (`hybrid_search.ts`) - Cosine similarity, RRF fusion, MMR diversity, ANTS signal boost
- **ANTS Signal** (`signal.ts`) - Adaptive Note Temperature System: pheromone-inspired signal deposit/decay, vacation-safe (14-day cap)
- **Embeddings** (`embeddings.ts`) - Sidecar client, embed on insert/update, batch backfill, graceful fallback
- **Session Tracker** (`session_tracker.ts`) - Session registration, surfacing log, cross-session annotations, cleanup
- **Agent Channel** (`agent_channel.ts`) - Filewatcher polling JSONLs + system_events bus, addressing parser, channel notification emission. Per-instance: each Claude Code session's MCP server spawns its own AgentChannel
- **Addressing Parser** (`addressing.ts`) - Pure function: parses event content for `@PA` / `@SA-<id8>` / `@all`, conversational PA prefix, slash commands, natural-language overrides. 0.30.11: addresses only count in addressing context (line-start, after comma, after `and` / `&`)
- **Channel Filter** (`agent_channel_filter.ts`) - Decides which JSONL events warrant forwarding (user input + assistant text + mutating tools; drops tool_result, system, read-only tools)
- **Channel State** (`agent_channel_state.ts`) - Atomic-write helpers for sessions.json, state.json, per-receiver offset files
- **Live Sessions** (`live_sessions.ts`) - 0.30.8+: reads `sessions.json` heartbeats (90s stale threshold) and returns the heartbeat-fresh OTHER session_ids. Intersected with the DB's 24h window to drop ghost siblings whose MCP died without clean unregister
- **System Events** (`system_events.ts`) - 0.30.16+: append-only JSONL bus at `<project>/.orchestrator-state/agent-channel/system_events.jsonl`. Offset-tracked, malformed-line tolerant, truncation-recovering. Carries cross-MCP events (`permission_request_pending`, `permission_verdict`) that the session-JSONL filewatcher can't see because they're emitted by MCPs, not sessions
- **Permission Relay** (`permission_relay.ts`) - 0.30.15+: PA-gated tool-permission engine. `registerPending` writes an audit row + sets a 30s timeout-to-`defer_to_human` fallback + returns a Promise. `resolveVerdict` updates the audit row + resolves the Promise. First-verdict-wins guard against double-resolution. `cleanup()` settles all pending Promises with `defer_to_human` on shutdown so the event loop can exit
- **Composer** - Assembles briefings with context budgeting
- **Linker** - FTS5 search + hybrid search path, auto-links notes by keyword overlap
- **Deduplicator** - Jaccard similarity (0.6 threshold + min 3 shared keywords) at insert time, batch merge in retro
- **Scorer** - Ranks notes by relevance (recency, access frequency, keyword overlap, confidence)

### PrimeAgent (replaces the per-session memory concierge)

`agents/prime-agent.md` defines PA's operating contract: when to act, when to observe, override etiquette, how to use `note()` and `create_work_item()` for self-improvement of the orchestrator plugin itself. PA is launched per-project via the project's `pa-start.bat` (or equivalent), primed by `/pa-bootstrap`, and runs continuously until the user closes its window.

The Sonnet `memory-concierge` subagent that existed in 0.28.x is gone. The persistent-thinking-partner pattern is now PA itself - a full Claude Code session with full tool access, not a subagent.

## How It Works

1. **Session start** - The session-start hook fires, calling `briefing` for orientation. The MCP server's `agent_channel.ts` registers the session in `<project>/.orchestrator-state/agent-channel/sessions.json` with role from `SPAWNBOX_AGENT_ROLE` env (or default `subordinate`). The hook also writes the session_id to `active-session-<ppid>` (per-claude-PID, 0.30.19+) AND `active-session` (legacy single-file fallback). When the MCP boots and the agent calls a tool without passing `session_id`, `getFallbackSessionId()` walks the process tree to find the claude.exe ancestor PID and reads the per-PID file - eliminating the impostor-MCP race where concurrent claude sessions stomped each other's session_id in the shared `active-session` file (closes work_item ea1bec63).

2. **Cross-session awareness** - The filewatcher in each MCP instance watches every active session's JSONL. Events arrive in your context as inline `<channel source="agent-channel" ...>content</channel>` injections. PA observes everything; SAs see only addressed events plus their own dialogue.

3. **During work** - The `orchestrating` and `every-turn` skills guide agents to `lookup` and `check_similar` before acting. `note` captures decisions, patterns, and commitments with auto-embedding and similarity alerting. **Reverse-index by file:** notes about specific code carry `code_refs` breadcrumbs; `lookup({code_ref: 'path/to/file'})` filters to notes referencing that exact path.

4. **Cross-session coordination** - When you need to talk to a peer session, type `@SA-<id8>` (or `@PA` / `@all`) in your terminal output. The filewatcher routes it via channel notification. No tool call required.

5. **Session end** - The Stop hook pushes maintenance verbs (`update_note`, `close_thread`, `supersede_note`) with equal priority to capture. Notes are classified by type with specific guidance. **Retro is automatic** (R4.4 auto-fires from briefing on a 7-day cadence).

6. **Maintenance** - `retro` runs automatically (weekly gate) to consolidate duplicates, decay stale confidence, identify gaps, and verify `code_refs` point at files that still exist.

## Quick Start

### Install

```
/plugin marketplace add SpawnBox-dev/claude-plugins
/plugin install orchestrator
```

### Bootstrap

Run the `/orchestrator-init` command to bootstrap the knowledge graph from your project's existing CLAUDE.md and documentation.

### Start working

The plugin activates automatically on every session. The session-start hook orients Claude. The orchestrating + every-turn skills ensure knowledge is captured and surfaced throughout your work.

### PA + SA orchestration (optional)

If your project has `pa-start.bat` and `sa-start.bat` launchers (per-project convention), running `pa-start.bat` spawns the PrimeAgent in a dedicated window. From PA, run `/pa-bootstrap` to set Opus + max effort and verify agent-channel is wired. Then launch SAs via `sa-start.bat [--name SA-<label>]` for any participating session. PA observes all SAs and can drive them via `@SA-<id8>` addressing.

### Slash Commands

| Command | Purpose |
|---------|---------|
| `/orchestrator-init` | Bootstrap knowledge graph from existing project docs |
| `/status` | Show knowledge graph stats and health |
| `/knowledge` | Browse and search stored knowledge |
| `/reflect` | Trigger maintenance - consolidation, decay, gap analysis |
| `/pa-bootstrap` | Prime a fresh PA session (in PA window only) |
| `/pa-pause` | Override - pause PA on this SA (or globally if run from PA terminal) |
| `/pa-resume` | Clear the corresponding pause |
| `/pa-takeover` | Force-claim PA primacy when an orphaned PA already holds it |

### Embedding Setup

Embeddings enable semantic search (finding notes by meaning, not just keywords). On first run:

1. The plugin tries to start the embedding sidecar automatically
2. If Python/uv aren't installed, it logs guidance and degrades to keyword-only search
3. Call `install_embeddings` tool to check/install dependencies
4. Call `system_status` to verify embedding coverage

Requirements: Python 3.10+ and uv (auto-installed via `pip install uv` if Python is available).

## Development

```bash
# Type check
bun run typecheck

# Run tests
bun test

# Build (bundles to dist/server.js)
bun run build

# Start MCP server (stdio)
bun run dev
```

## File Structure

```
orchestrator-plugin/
  .claude-plugin/plugin.json    # Plugin metadata + version (CANONICAL version source for /plugin update)
  .mcp.json                     # MCP server config
  mcp/
    server.ts                   # MCP tool registrations, sidecar lifecycle, claude/channel capability + AgentChannel startup
    types.ts                    # Note types, dimensions, interfaces
    utils.ts                    # Keyword extraction, formatting, IDs
    db/
      connection.ts             # Project + global DB connections
      schema.ts                 # 21 migrations (notes, FTS5, embeddings, sessions, permission_audit; messaging dropped in v20)
    engine/
      embeddings.ts             # Sidecar client (EmbeddingClient, blobToVector)
      hybrid_search.ts          # Cosine, RRF, MMR, activation boost
      session_tracker.ts        # Session log, registry, annotations, getActiveSiblings (live-filter aware)
      agent_channel.ts          # Filewatcher subsystem - polls JSONLs + system_events.jsonl, fires notifications/claude/channel
      agent_channel_filter.ts   # Pure filter: which JSONL events warrant forwarding
      agent_channel_state.ts    # sessions.json / state.json / per-receiver offsets - atomic temp+rename
      addressing.ts             # Pure parser: @PA / @SA-<id8> / @all, slash commands, NL overrides (line-anchored)
      live_sessions.ts          # 0.30.8+: heartbeat-fresh session_ids from sessions.json; ghost-session filter
      system_events.ts          # 0.30.16+: append-only JSONL bus for cross-MCP events (permission routing)
      permission_relay.ts       # 0.30.15+: PA-gated permission engine - registerPending/resolveVerdict/timeout fallback
      composer.ts               # Briefing assembly
      deduplicator.ts           # Jaccard similarity, merge duplicates
      linker.ts                 # FTS5 search, hybrid search, auto-linking
      signal.ts                 # ANTS: deposit, decay, vacation protection
      scorer.ts                 # Confidence decay, promotion
    tools/
      orient.ts                 # Briefing handler
      remember.ts               # Note insert with embedding + similarity alert
      recall.ts                 # Search with session annotation
      prepare.ts                # Context package for subagent hydration
      reflect.ts                # Maintenance handler
      check_similar.ts          # Similarity check handler
      session_task.ts           # update_session_task handler
      permission.ts             # 0.30.15+: respond_to_permission handler (PA-only, conditional)
      hook_event.ts             # _hook_event dispatcher (per-event hook logic)
  sidecar/
    embed_server.py             # Python ONNX embedding server
    requirements.txt            # Python deps
  agents/
    prime-agent.md              # PA operating contract (replaces deleted memory-concierge.md)
    orchestrator-reflect.md     # Reflect agent definition
  skills/                       # Skills for orchestrated workflow + PA bootstrap/override
  hooks/                        # 1 bash hook (session-start) + mcp_tool dispatches in hooks.json
  commands/                     # Slash commands
  tests/                        # 497 tests across 38 files
  dist/
    server.js                   # Bundled MCP server
```
