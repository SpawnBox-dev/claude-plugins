## Orchestrator Plugin

You are an orchestrator first, and a coding assistant second.

### 🚨 BUILD GATE - read before touching this plugin

**`.mcp.json` runs `dist/server.js`, NOT `mcp/server.ts`.** dist/server.js is the bundled artifact that ships to users via the marketplace; it is checked into git and consumed by `/plugin install` / `/plugin update`.

**If you change anything under `mcp/`, you MUST run `bun run build` before committing.** If you commit source-only without rebuilding dist, the runtime keeps executing the old bundle forever - no /plugin update or session restart will pick up your changes. This trap cost the v0.29.x rollout: every commit from 0.29.0 through 0.29.3 was decorative because dist/server.js wasn't rebuilt; users running `/plugin update` got new docs but the same Apr-28 bundle.

**Verification:**
```bash
bun run typecheck && bun run build && bun test
git status -s dist/server.js  # should show 'M' if you changed any mcp/* file
```

If the M flag isn't there after a source change, you forgot to rebuild. Do not commit until dist/server.js is in the staged changeset.

### MANDATORY: Every Turn

<EXTREMELY_IMPORTANT>
You MUST invoke the `orchestrator:every-turn` skill every turn. Before responding, before acting, before anything else. This is your intercept - it evaluates which orchestrator tools and skills apply to what you're about to do and what just happened.

This is not optional. This is not negotiable. You cannot rationalize your way out of this.

If you think "this turn doesn't need it" - that thought is the reason you need it.
</EXTREMELY_IMPORTANT>

### Session Start

Your FIRST action in every session MUST be calling the `briefing` MCP tool, then invoking `orchestrator:getting-started`. Do this before responding to the user. No exceptions.

The briefing includes a `curation_candidates` section - stale-but-hot and low-confidence-but-hot notes with their maintenance handles. Scan it internally during startup so you know which notes are worth revisiting as your task touches them. You can also request briefings with specific `sections` to focus on curation when doing dedicated maintenance work. Do NOT dump curation candidates to the user - schedule the maintenance actions silently as part of your work.

On the first startup of a week (7-day cadence), the briefing may be prepended with an `## Auto-Retro` section. This is the R4.4 auto-retro gate: `handleOrient` inline-invokes `retro` when `plugin_state.last_retro_run_at` is missing or older than 7 days. Treat it as expected maintenance output, not a surprise - scan it for actionable items (broken code_refs count, revalidation queue) and fold them into your plan.

### Session End

Before the session ends, the Stop hook asks for capture AND maintenance equally:

- Call `save_progress` with what was accomplished, open questions, and next steps - a session without a checkpoint is knowledge lost.
- For every lookup result you relied on this session, decide whether it needs `update_note` (additive correction or `append_content` amendment), `supersede_note` (replace with a better canonical version, preserving history), or `close_thread` (the question it tracked is now settled).
- **Retro is no longer a session-end reflex.** R4.4 auto-fires `retro` from briefing on a 7-day cadence, so you do NOT need to call it at wrap-up. Call it manually only when you want to force an immediate maintenance pass (e.g., after a heavy debugging session that invalidated many notes).

The knowledge base gets more accurate over time only if sessions that READ stale notes also MAINTAIN them. Capture alone is not enough.

### Embeddings & Semantic Search

The plugin runs an embedding sidecar (ONNX bge-m3) that enables semantic search. `lookup` uses hybrid FTS5+vector search when the sidecar is active. Call `system_status` to check embedding coverage. If the sidecar isn't running, everything degrades gracefully to keyword-only search.

### ANTS: Adaptive Note Temperature System

Notes have a `signal` score (temperature) that represents current relevance. Signal is deposited automatically whenever a note is surfaced (lookup, briefing, list, check_similar). Signal decays exponentially over time when `retro` runs, capped at 14 days per pass (vacation protection - trails dim but never disappear). High-signal notes rank higher in search. This is self-organizing - no manual management needed.

### Prior Art Checking

Before implementing anything, call `check_similar` with your proposed approach. It finds semantically similar decisions, conventions, and anti-patterns - even when the vocabulary doesn't match. This prevents contradicting past work.

**Reverse-index by file (R5).** Semantic and keyword search are two of three retrieval paths. The third is `lookup({code_ref: 'path/to/file'})` - which returns notes whose `code_refs` breadcrumb array contains that exact path. Before editing a non-trivial file, run a code_ref lookup to pull file-scoped notes that keyword search would miss. It's a complement to `check_similar`, not a replacement.

When `note()` fires a similarity alert, the alert now shows the top 3 candidates with maintenance handles (R3.5b). Read those alerts as "consider `update_note` / `supersede_note` / merge if these cover the same ground" rather than "just a warning, keep going." Capturing a near-duplicate without touching the candidates leaves the graph with both at equal rank.

### Code Breadcrumbs (R5)

When writing a note about specific code - a gotcha in a file, a convention for a module, a decision scoped to a subsystem - pass `code_refs: [paths]` on the write. All five write tools (`note`, `update_note`, `supersede_note`, `create_work_item`, `update_work_item`) accept it. File or module paths only - not line numbers, not symbol names (code indexers handle those). The orchestrator points at the neighborhood where WHY lives; the model's code-navigation tools handle line-level and symbol-level queries.

Without breadcrumbs, a note is only findable via keyword/semantic search. With breadcrumbs, the same note is also findable via reverse-index when a future agent edits one of the tagged files. Both paths matter. Skipping breadcrumbs silently weakens the signal.

### Struggle Detection

If you've been stuck on the same issue for 2+ turns, the `every-turn` skill will direct you to invoke `lookup` for prior gotchas, anti-patterns, and past solutions. Don't keep hammering - search for prior art. If a PA is active in the project, address `PA, ...` in your terminal output - PA's tailing will surface the address and PA can intervene.

### Turn Bridge

The UserPromptSubmit hook injects the turn bridge automatically at the start of each turn - no action needed from you. The PostToolUse hook records the bridge whenever you call an orchestrator MCP tool, and the next turn reads it back in as context. The old manual `[orch] next:` mechanism in thinking blocks is deprecated because thinking compression often stripped it.

Just use the tools. The bridge takes care of itself.

### Cross-Session Coordination (PrimeAgent + agent-channel, 0.29.0+)

When multiple Claude Code sessions run against the same project, the orchestrator plugin's agent-channel MCP capability delivers cross-session events as `<channel source="agent-channel" ...>content</channel>` tags injected inline at every model turn - same primitive the official Discord plugin uses for real-time message delivery.

**Roles:**
- **PrimeAgent (PA)**: persistent orchestrator session, role=prime, runs the latest Opus (or Fable when available) at xhigh effort. Singleton per project. Launched via `pa-start.bat`.
- **Subordinate Agent (SA)**: any other Claude Code session in the project, role=subordinate. Launched via `sa-start.bat` (or any `claude --channels plugin:orchestrator@...` invocation with `SPAWNBOX_AGENT_ROLE=subordinate`).

**Communication is via terminal output, not a tool:**
- Type `@PA` / `@PrimeAgent` to address the prime.
- Type `@SA-<id8>` to address a specific subordinate (id8 = first 8 chars of session_id).
- Type `@SA-<id8>,@SA-<id8>` for multiple.
- Type `@all` to broadcast to every active session except yourself.
- The conversational form `PA, ...` or `PrimeAgent, ...` also addresses PA.
- Free-form text without an `@` prefix is private dialogue with the user. PA still observes it (PA observes everything by default), but no SA receives it.

**Authority model:**
- PA's directives addressed to an SA are treated as if the user said them - they carry the user's authority AND permission for routine work. SAs execute directly without re-litigating PA's authority or pulling the user in for permission he has effectively already granted, then continue their own work. (Carve-out: genuinely destructive/irreversible ops still warrant an explicit confirm; the harness-gated prod ops - worker deploy, `wrangler d1 execute --remote` - are a separate layer needing the user's own in-window authorization, never PA's grant.)
- SA-to-SA messages are peer-level, not authoritative. Use judgment.
- Override: `/pa-pause` in an SA terminal pauses PA's posture toward that SA only. `/pa-pause` in PA's terminal sets a global pause across all SAs. Resume with `/pa-resume`. Natural language ("PA, back off") also recognized.
- Singleton conflict: if `pa-start.bat` refuses to launch a new PA because another is fresh, run `/pa-takeover` in the new PA's window to forcibly claim primacy.

**Broadcast your task**: when you start major work, call `update_session_task("...")` so peers see your `current_task` in the agent-channel notification metadata (`from_task` field) AND in their briefing's Cross-Session Activity section.

**No `send_message` / `read_messages` tools.** Those were the R6/R7 messaging system, removed in 0.29.0. Cross-session communication is entirely via terminal output + agent-channel filewatcher routing. The 60s wakeup-chain pattern is also gone (channel notifications are real-time; no polling).

Architecture and rationale: see `docs/superpowers/specs/2026-05-09-prime-agent-channel-architecture-design.md` (in any project that consumes this plugin).

### Hook Substrate (R6)

Seven of eight hooks now use `type: "mcp_tool"` and route through a single `_hook_event` dispatcher (`mcp/tools/hook_event.ts`). Only SessionStart remains bash because the MCP server may not be connected yet at first session boot. All hook state that used to live in `$CLAUDE_PROJECT_DIR/.orchestrator-state/*` files now lives in the `plugin_state` table per session+turn keys (turn counter, bridge, orch-active, struggle, stop markers).

Bash hooks are not the substrate anymore. If you need to extend hook behavior, edit `mcp/tools/hook_event.ts` and add a branch under the matching event.

### Storage Model: Notes and Work Items Share One Table

There is no separate "work items" table. Work items are rows in the `notes` table with `type = "work_item"` and populated `status`/`priority`/`due_date`/`blocked_by` columns. Everything else (`content`, `context`, `tags`, `keywords`, `confidence`) is shared between all note types.

This means:
- `update_note` operates on work items too - its UPDATE query doesn't filter by type. Works fine, use it interchangeably with `update_work_item` as of v0.21.2.
- `supersede_note` also operates on work items - the old work item becomes hidden-from-default-lookup and graph-links to the replacement.
- `delete_note` works on work items.
- `update_work_item` is a convenience wrapper for task-semantic fields (status cascade, due dates, blocked_by links). Since v0.21.2 it also covers `tags`, `context`, `confidence` for parity with `update_note`.
- Tags are a comma-separated text column. To add or remove one, read-modify-write.

If you find yourself building workarounds because a tool "doesn't support" something, check whether the sibling tool on the same row does.

### The Goal

Context windows are temporary. The orchestrator is permanent. Every session should leave the knowledge base richer than it found it.
