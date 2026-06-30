# Agent Getting Started

You are a Claude Code agent. The orchestrator plugin was just installed in your session. This doc tells you what you now have and how to use it. Read it once, then proceed.

Target audience: an AI agent (you) that needs to discover its new capabilities and explain them to its user.

## You just installed orchestrator. Here's what you have.

A persistent product co-pilot that survives across sessions:

- **Two SQLite databases.** Project-scoped (`<project>/.orchestrator/project.db`) for everything tied to this codebase. Global (`~/.claude/orchestrator/global.db`) for things that persist across all projects (user patterns, tool capabilities).
- **A knowledge graph.** Notes typed as `decision` / `convention` / `anti_pattern` / `architecture` / `risk` / `commitment` / `insight` / `open_thread` / `work_item` / `user_pattern` / `tool_capability` / `checkpoint`. Linked via `depends_on` / `conflicts_with` / `supersedes` / `related_to` / `blocks` / `enables` / `part_of`.
- **Hybrid search.** FTS5 keyword matching + ONNX bge-m3 vector embeddings + RRF fusion + MMR diversification + ANTS signal boost. Falls back to FTS5-only if the Python sidecar isn't available.
- **MCP tools** (24 total - 22 always available, plus 1 internal hook dispatcher, plus 1 conditional PA-only tool).
- **Skills.** Proactive prompts that fire on relevant turns: `every-turn`, `orchestrating`, `getting-started`, `wrapping-up`, `planning-approach`, capture skills (`made-a-decision`, `learned-something`, `closing-a-thread`, `found-a-problem`, `something-went-wrong`, `user-preference`, `what-was-decided`), PA skills (`pa-bootstrap`, `pa-pause`, `pa-resume`, `pa-takeover`), `install-launchers`.
- **Hooks.** Wired into Claude Code's session/turn lifecycle to inject curated context at the right moment.
- **Cross-session communication.** Real-time `notifications/claude/channel` MCP capability. Multiple Claude Code sessions in the same project see each other's events and can address each other by `@PA` / `@SA-<id8>` / `@all`.
- **PA-gated permission relay** (opt-in via env var). Routes tool-permission prompts through PA instead of the SA's terminal.

## Discover the plugin via these calls

Run these in order. Each tool will tell you something concrete about the current state:

```
briefing({event: "startup"})
```

Returns the session-startup orientation: open threads, recent decisions, work items, user profile, neglected areas, drift warnings, last checkpoint, cross-session activity, curation candidates. On the first startup of the week (7-day cadence) it inline-invokes `retro` and prepends an `## Auto-Retro` section. Read this in full before anything else.

```
list_work_items({status: "in_progress"})
```

Shows what's actively being worked on. If empty, the project is between tasks. If non-empty, those are the threads that need attention or closure.

```
list_open_threads()
```

Unresolved investigations + commitments. Things the user (or a prior agent) flagged as "we'll come back to this."

```
system_status()
```

Health check: note counts by type, embedding coverage, sidecar status, active sibling sessions, database paths, last retro time. If sidecar status is `unavailable`, semantic search is degraded to FTS5-only (call `install_embeddings()` to remedy).

## Two ways to use it: single-agent vs multi-agent (PA + SA topology)

**Single-agent (default).** One Claude Code session per project. The orchestrator MCP runs in that session, captures knowledge as you work, surfaces it on the next session. All the value: knowledge persistence, hybrid search, `code_refs` reverse-index, auto-retro maintenance. Nothing required beyond `briefing` at start and `note` / `update_note` as you go.

**Multi-agent (PA + SA topology).** A persistent **PrimeAgent (PA)** in its own dedicated Claude Code window, plus one or more **Subordinate Agents (SAs)** in other windows. PA observes all events from all SAs, coordinates them, intervenes when work overlaps or contradicts established patterns. PA loads user-pattern knowledge at bootstrap and acts as an "artificial user" for routine judgment calls.

The PA + SA topology is opt-in. Use it when:
- The project has 3+ independent workstreams that benefit from a coordinator.
- The user has captured user-pattern knowledge that should shape decisions across sessions.
- Cross-session communication ("two agents touching the same file") is happening in this project.
- Tool-permission gatekeeping should be routed through a single judgment point (with `ORCHESTRATOR_PA_PERMISSION_RELAY=1`).

## How to spawn PA + SAs (per-project launcher convention)

The orchestrator plugin does NOT ship the launchers - they're per-project conventions. The plugin's `install-launchers` skill installs canonical launchers into the project root:

- `pa-start.bat` (Windows) / `pa-start.sh` (Unix) - launches PA in a dedicated terminal tab. Singleton-enforced (refuses to launch if a PA is already running; suggests `/pa-takeover` to force-claim). Passes `--channels plugin:orchestrator@<marketplace>` so the channel capability is attached. Sets `SPAWNBOX_AGENT_ROLE=prime` env var.
- `sa-start.bat` (Windows) / `sa-start.sh` (Unix) - launches an SA in a default terminal tab. Optional `--name SA-<label>` argument; auto-generates `SA-<timestamp>` if absent.
- `discord-start.bat` (Windows) / `discord-start.sh` (Unix) - launches an SA with both Discord + agent-channel.

Run the `install-launchers` skill once after `/plugin install orchestrator` to drop these into your project root.

**First-time PA flow:**

1. Run `pa-start.bat` (gold/amber terminal tab launches).
2. In PA's window, run `/pa-bootstrap`. This:
   - Confirms PA is on the latest Opus (or Fable when available) + `/effort xhigh` (PA needs a top-tier model for orchestration judgment; xhigh not max since 2026-06-30).
   - Verifies role=prime in `sessions.json`.
   - Reads active SAs from `sessions.json`.
   - Verifies agent-channel is wired.
   - Loads PA's operating contract (`agents/prime-agent.md`).
   - Loads user-pattern context (artificial-user grounding).
   - Loads forest-view context (project macro model).
   - Discovers multi-repo scope.
   - Checks for any existing global pause.
   - Prints readiness.

3. From PA, launch SAs with `sa-start.bat [--name SA-<label>]`. Each SA appears in PA's `sessions.json` and is addressable as `@SA-<id8>`.

## Capture knowledge as you work

Maintenance is co-equal to capture. The plugin treats `note` / `update_note` / `close_thread` / `supersede_note` / `delete_note` with the same priority. Don't append-only.

**Capture (note).** When you discover something worth keeping:

```
note({
  type: "decision",       // or convention, anti_pattern, architecture, risk, ...
  content: "<the insight>",
  context: "<optional context the insight applies to>",
  tags: "<comma-separated tags>",
  code_refs: ["path/to/file.ts", "path/to/dir/"],  // breadcrumbs - files / modules this note is about
  confidence: "medium",   // low / medium / high
})
```

The R4 gate intercepts: for types `decision` / `convention` / `anti_pattern`, if there's an existing note with embedding similarity >= 0.75 the write is BLOCKED. The response returns top candidates with rank buckets (`HIGH MATCH` >= 0.95, `LIKELY RELATED` 0.85-0.94, `ADJACENT` 0.75-0.84) and four resolution actions: `accept_new` / `update_existing` / `supersede_existing` / `close_existing`. Re-call with `resolution: "<action>"` to proceed.

**Update (update_note).** When an existing note is partially stale or needs sharpening:

```
update_note({
  id: "<note_id>",
  content: "<full new content>",   // OR
  append_content: "<segment to add>", // mutually exclusive
})
```

`content` snapshots the current row to `note_revisions` before replacing. `append_content` does not snapshot (no replacement). Either path re-embeds.

**Supersede (supersede_note).** When a note was right at the time but is now stale:

```
supersede_note({
  old_id: "<old note id>",
  new_id: "<existing replacement note>",     // OR
  new_content: "...", new_type: "decision",  // inline replacement
})
```

Old note is archived (hidden from default lookup). New note surfaces. `supersedes` graph edge created. Old note still reachable via `lookup({id})` or `include_superseded: true`.

**Close (close_thread).** When an open_thread / commitment is resolved:

```
close_thread({
  id: "<thread id>",
  resolution: "<short note about how it was resolved, optional>",
})
```

Cascade: unblocks dependents, auto-completes parent if all children done, auto-resolves superseded chain. Optional `resolution` creates a `decision` note linked back.

**Track (create_work_item).** For concrete tasks with priority / status / due dates:

```
create_work_item({
  content: "<what needs doing>",
  priority: "high",  // low / medium / high / critical
  status: "open",    // open / in_progress / blocked / done / cancelled
  due_date: "2026-05-15",  // optional ISO date
  parent: "<parent_work_item_id>",  // optional, creates part_of link
  code_refs: ["..."],
  tags: "...",
})
```

`breakdown({id, children})` splits a work_item into parent + children (creates `part_of` links).

## Retrieve knowledge before acting

The plugin is most valuable when you query it BEFORE writing new code or making decisions. Two main retrieval verbs:

**lookup** is the workhorse. Three modes:

```
// Search mode (semantic + keyword)
lookup({query: "auth token refresh flow", limit: 10})

// Detail mode (single note + links + supersede chain)
lookup({id: "<note_id>"})

// Reverse-index mode (notes about a specific file/module)
lookup({code_ref: "src/auth/token-refresh.ts"})
```

`lookup` augments each result with maintenance handles inline (`[maintain: update_note | close_thread | supersede_note]`) and "hot across sessions" annotations when peers have touched the note recently. Use `include_superseded: true` / `include_history: true` to unhide archived data.

**check_similar** is the pre-implementation check. Before writing a new function / convention / decision, ask the orchestrator:

```
check_similar({
  content: "<draft text of what you're about to capture>",
  type: "decision",
})
```

Returns prior art with rank buckets. If `HIGH MATCH` appears, you're about to duplicate; you probably want `update_existing` or `supersede_existing` instead of a fresh `note`.

**plan** packages context for a complex task:

```
plan({task: "implement wsl ghost-distro recovery", domain: "wsl"})
```

Returns conventions / anti-patterns / quality gates / architecture / recent decisions scoped to the task. Useful for handing off to a subagent.

## Address other sessions (@PA / @SA-<id8> / @all)

Cross-session communication is via your terminal output - there is NO `send_message` tool (deleted in 0.29.0). Type addressing tokens in your output and the filewatcher routes them.

**Recognized forms:**
- `@PA` / `@PrimeAgent` - the prime
- `@SA-<id8>` - a specific subordinate (8-char prefix of session_id)
- `@SA-<id8>,@SA-<id8>` - multiple subordinates
- `@all` - every active session except yourself
- `PA, ...` / `PrimeAgent, ...` - conversational PA prefix (also addresses PA)

**Addressing context required (0.30.11+).** An `@`-token only counts as addressing when it's at:
- The start of a line (optionally after a list bullet `-` / `*`)
- After a comma (recipient chain)
- After `and` / `&` with whitespace (recipient chain)

Mentions in mid-prose ("my warm tick addresses @SA-X every 50min", `"@PA warm" reply`) are NOT routed. If you need to describe addressing semantics without triggering the router, write it in mid-prose.

**Override controls:**
- `/pa-pause` (in SA terminal): PA stops directing this SA until `/pa-resume`. PA still observes; doesn't act.
- `/pa-pause` (in PA terminal): PA stands down across ALL SAs (global pause).
- `/pa-resume`: clears the corresponding pause.
- `/pa-takeover` (in new PA window): forcibly claims PA primacy from an orphaned previous PA.
- Natural-language equivalents: "PA, back off / stand down / take five / pause" / "PA, come back in / resume".

**Free-form text without `@`-prefix** is private dialogue with the user. PA still observes (it observes every event); no SA receives it.

**Broadcast `update_session_task`** so peers see what you're working on:

```
update_session_task({task: "refactoring wsl registration"})
```

This writes to `session_registry.current_task` and `sessions.json`. Peers see it as `from_task` on every channel notification you generate, and in their briefing's Cross-Session Activity section.

## Enable PA permission gating (env var)

Off by default. To enable, set `ORCHESTRATOR_PA_PERMISSION_RELAY=1` in the SA's environment before launch. This activates:
- The `claude/channel/permission` capability on the SA's MCP.
- A notification handler that catches inbound `notifications/claude/channel/permission_request` from CC.
- The flow: SA's relay writes the request to the system_events bus, awaits PA's verdict (max 30s), then emits `allow` / `deny` / silence-for-defer back to CC.
- PA gets the request as an inline channel notification. PA calls `respond_to_permission({request_id, verdict, reason})` to respond. Non-allow verdicts MUST have a reason.

**When to use:**
- You want PA to approve routine tool calls (low-risk reads aligned with captured patterns) silently so the SA doesn't keep pausing on permission prompts.
- You want PA to deny tool calls that contradict known anti-patterns / conventions / user-patterns.
- You want a permission audit trail (per project, in `permission_audit` table).

**When NOT to use:**
- Single-agent project (no PA running) - the routing has no destination.
- You want every permission prompt to surface to the human terminal - just leave the env var unset.

PA's verdict policy is judgment, not configuration. PA reads user-patterns + conventions + anti-patterns at bootstrap and applies them per-request.

## Pitfalls to avoid

**`lookup({type, limit})` without `query` returns an error in 0.30.19.** The lookup tool requires `query` or `id` for search-mode; type-only enumeration is queued for 0.30.20. Workaround in the meantime:

```
// Doesn't work in 0.30.19:
lookup({type: "user_pattern", limit: 25})
// Returns: "Provide either a query or an id to recall notes."

// Workaround 1 - pass a broad query:
lookup({query: "preferences habits style", type: "user_pattern", limit: 25})

// Workaround 2 - use list_open_threads if applicable
list_open_threads()

// Workaround 3 (best) - wait for 0.30.20 which extends lookup to support
// {type, limit} as a recent-N enumeration mode.
```

Affects `/pa-bootstrap` Step 5.5 and 5.6 which use the broken pattern. Treat the bootstrap script's empty returns as expected on 0.30.19; the manual workaround above gets you the data.

**Don't manually edit `bindings.ts`-equivalent generated files.** This is a TS/MCP project; there are no auto-generated files yet, but be aware.

**Don't `delete_note` casually.** `supersede_note` or `close_thread` preserve the audit trail; `delete_note` cascades links and loses the why. Last-resort verb.

**Don't capture without checking.** `check_similar` is cheap. Use it before any `note({type: "decision" | "convention" | "anti_pattern"})` to avoid hitting the R4 gate. The gate is recoverable but slower than asking first.

**Don't address sessions you haven't seen.** `sessions.json` is the registry. If a session_id isn't there, your `@SA-<id8>` is dropped silently (with a warning flag in the addressing result). Use `system_status()` or read `sessions.json` directly to verify active sessions.

**Don't ignore the briefing's `curation_candidates` section.** Stale-but-hot and low-confidence-but-hot notes are surfaced because they need maintenance. If you skip them, the knowledge base loses trust over time. Update, supersede, or close.

**Don't expect `briefing` to retro on every call.** Auto-retro fires only on `event=startup` and only on a 7-day cadence. If you need a fresh maintenance pass, call `retro()` directly.

**PA-specific:** Don't spawn subagents from PA. PA is itself a Claude Code session with full tool access. The Sonnet `memory-concierge` subagent that existed in 0.28.x was deleted in 0.29.0. PA's persistent-thinking-partner role IS PA.

**PA-specific:** Don't call deleted messaging tools. `send_message` / `read_messages` / `peek_inbox` no longer exist. Type `@PA` / `@SA-<id8>` / `@all` in your terminal output.

**PA-specific:** During global pause, don't rationalize "but this is important". Wait for `/pa-resume`. Observe and remember context.

**PA-specific:** Don't auto-confirm destructive actions for SAs. Force-push, mass delete, prod modifications - surface to the user in private dialogue first.

## Where to read more

- [README.md](../README.md) - top-level plugin overview, MCP tools table, quick-start, file structure.
- [ARCHITECTURE.md](./ARCHITECTURE.md) - data model, engine internals, hook flow, retrieval pipeline, permission relay architecture, per-PID session-id resolution.
- [DECISIONS.md](./DECISIONS.md) - reverse-chronological log of every architectural shipment with rationale and rejected alternatives. Skim the most recent entries when something looks unexpected.
- [DESIGN-PRINCIPLES.md](./DESIGN-PRINCIPLES.md) - the design-intent test (always-up-to-date / more-accurate-over-time / faster-to-traverse), R1-R5 architectural roots, the deterministic-vs-judgment dividing line.
- [agents/prime-agent.md](../agents/prime-agent.md) - PA's operating contract: artificial-user identity, forest-view duty, authority, communication, patterns, override discipline, self-improvement. Required reading for any PA session.
- The plugin's own knowledge graph - the orchestrator captures notes about itself. `lookup({code_ref: "mcp/engine/permission_relay.ts"})` will show every note ever captured about that file, including the rationale captured during shipment.

Once you've read briefing + this doc, you're oriented. Start working.
