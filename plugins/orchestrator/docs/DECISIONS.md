# Orchestrator Decisions Log

Reverse-chronological. Each entry: date, change, rationale, what-was-rejected, where it shipped.

Pair with [DESIGN-PRINCIPLES.md](./DESIGN-PRINCIPLES.md) for the framework the R-series decisions are written against.

---

## 2026-04-28 - R7.6 Stop-prompt trim + tightened loop-close heuristic

**Change.** Two related UX fixes triggered by field signal: a real spawnbox session (1a5a984f) hit Stop and saw a 3000+ char "Stop hook error" prompt with 5 in-flight work_items (3 of which it didn't actually work on, just saw via briefing) plus a duplicated R3.4 fresh-notes nudge listing 5 more entries.

1. **Trimmed Stop prompt** (`mcp/tools/hook_event.ts` `handleStop`). Removed the standalone `buildStopSessionNudge` function whose output duplicated section 1's "you surfaced N fresh notes" preamble. The R3.4 fresh-notes listing is now integrated directly into the Curate section. Caps lowered: loop-close 5->3, fresh-note list 5->3. Single-paragraph intro instead of two. Order: Loop-close (most actionable when present) -> Curate -> Capture -> Save progress.

2. **Tightened loop-close heuristic** (`listInFlightWorkItemsForSession`). Pre-R7.6 the SQL OR'd `source_session = me` with `EXISTS session_log WHERE session_id = me`, surfacing every work_item the session had ever LOOKED at via lookup. On a heavy spawnbox session that's 5+ items per Stop, mostly noise. R7.6 replaces the session_log amplifier with a per-session `wi_touched_<sid>_<id>` plugin_state marker that's only written when the session actively calls `update_work_item` on that id. Surfaces real intent (I edited this work_item) instead of incidental briefing surfacing.

**Wiring.** `hooks.json` PostToolUse adds `tool_input_id: "${tool_input.id}"` substitution; the `_hook_event` MCP tool gains a `tool_input_id` schema field; `handlePostToolUse` writes the marker when `tool_name === "mcp__plugin_orchestrator_memory__update_work_item"`. `SessionTracker.cleanup()` extended with `wi_touched_%` prefix so markers prune at the same 7-day cadence as other ephemeral hook state.

**Why now.** Jarid pasted a real Stop hook output from a parallel session as field evidence. The prompt was over the soft 5-10k char ceiling that DESIGN-PRINCIPLES.md mandates, AND the loop-close section had legitimate noise (work_items inherited via briefing). Both are exactly the failure modes the principles warn about.

**Rejected.**
- Suppressing the loop-close section entirely when there's no source_session match - throws away real signal for sessions that DID work on inherited items. The wi_touched marker captures "I actually updated it" which is the right boundary.
- Tracking ALL orchestrator tool calls per work_item for a richer touched-set - overkill. update_work_item is the canonical "I'm taking action on this" verb; lookup/note are weaker signals.
- Dropping the prompt to one section at a time over multiple commits - they're tightly coupled (loop-close is a section in the prompt). One commit is cleaner.
- Renaming "Stop hook error" to something less alarming - that's Claude Code's UX label for any decision:block return; we can't change it from the plugin side.

**Shipped:** v0.28.1.

---

## 2026-04-28 - R7.5 code-review-driven hardening pass

**Change.** Six independent fixes addressing findings from a code-review subagent pass over R6 → R7.4 (commit range `bb75f5f..b91dc21`). Plus expanded test coverage for each. Bumped to `0.28.0` since scope-filtering changes message delivery semantics (now matches what docs always claimed).

1. **APPROVAL_REGEX hardened** (`mcp/tools/hook_event.ts`). Anchored start, requires phrase to be the entire prompt (modulo trailing punctuation) OR the first clause split on `,.;!?`. Bare singletons `done`, `nice`, `thanks`, `great`, `perfect`, `sweet`, `yep` dropped; field-tested false positives ("everything you've done", "thanks for trying", "great pain", "perfect storm") all silenced. New tokens added: `lgtm`, `all done`, `i'm done`, `we're done`, `good to go`, `good to ship`, `let's ship`. Tightening matters because the false-positive escalation reverses direction (soft "Loop-close check" → strong "Close loops NOW"), exactly the failure mode CLAUDE.md "no prompt-layer shims" warns about.

2. **Scope filtering implemented in `drainInbox`** (`mcp/engine/messaging.ts`). Before R7.5, `MessageScope.code_ref` and `task_contains` were accepted, persisted, displayed, and explicitly documented as filters - but had no effect on delivery. R7.5 makes them real:
   - `scope.code_ref`: substring-match against recipient's `currentFilePath` (so `src/foo.ts` scope matches `/abs/path/src/foo.ts` edits).
   - `scope.task_contains`: case-insensitive substring against recipient's `current_task`.
   - Both fields: any-match (OR).
   - Unscoped messages always deliver.
   - Deferred (scope mismatch) messages stay unread for future drain in matching context.
   The dispatcher now passes `currentFilePath` from PostToolUse tool_input + `currentTask` from session_registry.

3. **plugin_state cleanup extended** (`mcp/engine/session_tracker.ts`). `SessionTracker.cleanup()` now prunes ephemeral hook keys older than 7 days. Pre-R7.5, `stop_*`, `subagent_stop_*`, `wi_drift_*`, `code_refs_hint_*` (and a few others written-once) leaked forever, accumulating ~1000 rows/week on an active project. Non-ephemeral keys (`last_retro_run_at`) don't match any prefix in the DELETE so they're safe.

4. **inboxCounter refresh interval 30s → 5s + opportunistic re-check** (`mcp/engine/messaging.ts`). The 30s window dropped fast-path delivery for up to 30s after a sibling-process write. R7.5 lowers the global refresh to 5s AND adds a per-call opportunistic check: when `peekInbox` sees a 0-entry already in the Map (i.e. polled before, saw empty), do a single indexed `LIMIT 1` SELECT to confirm. Truly idle sessions (no Map entry) skip the check; only polled-but-empty sessions eat the small cost. Cross-process drift window collapses from 30s to "next peek call".

5. **STOPWORDS extended with code-vocabulary** (`mcp/tools/hook_event.ts`). Added `function`/`class`/`error`/`update`/`test`/`code`/`file`/`type`/`value`/`state`/`return`/`import` and ~30 others. Pre-R7.5, two unrelated code-heavy tasks ("test the function that updates state") would share enough common-coding-words to trigger `*POTENTIAL OVERLAP*` falsely. Also deduped `"want"` (was listed twice).

6. **sanitizeSessionId helper** (`mcp/tools/hook_event.ts`). Defense-in-depth: dispatcher receives session_id from hook input unvalidated. Real Claude Code session_ids are UUID-shaped, but a malformed value with `_` or `%` could over-delete on `LIKE 'orch_active_<sid>_%'` cleanup. Helper strips non-`[a-zA-Z0-9_-]` characters before any string interpolation.

**Test additions:** 18 new tests in `tests/engine/messaging.test.ts` (scope filtering: deferred-not-delivered, code_ref substring match, task_contains case-insensitivity, any-match for both fields, malformed JSON treated as unscoped, deferred messages don't get marked read, counter reflects deferred count). 5 new tests in `tests/tools/hook_event.test.ts` (the exact false-positive prompt that bit Jarid in R7, multi-clause approval, anchored regex behavior, lgtm/all-done detection). Updated cross-session integration test to match new scope-filter semantics. Total: 440 tests, 0 fail.

**Rationale.** Jarid asked "do you need to exercise all the hooks and stuff to make sure there are no errors?" - R7.4 added schema-validation tests for envelope shape; R7.5 adds the same rigor to behavioral tests for the dispatcher's logic branches. Then asked "fix then ship" after I summarized findings, with full authorization. The code-reviewer subagent's verdict was "ship as-is, fix 2 items first" but consolidating into one commit is cleaner than four small ones (per the user's "complete removals in one pass" pattern).

**Rejected.**
- Demoting scope to display-label (the lighter alternative to implementing filtering) - docs already promised filtering, restoring honesty was preferred over revising the contract.
- Per-prefix DELETE counts in cleanup() - one batched DELETE with OR'd LIKE clauses scans the same index range as separate statements would. SQLite handles it fine at the expected cardinality.
- Splitting into per-fix R-shipments (R7.5, R7.6, R7.7, ...) - all 6 are independent and small. One coherent commit is more reviewable than six small ones.

**Shipped:** v0.28.0.

---

## 2026-04-28 - R7.4: schema-validated envelope tests + builder hardening

**Change.** Extracted the hook envelope builder from `mcp/server.ts` into `mcp/tools/hook_event.ts:buildHookEnvelope`. Added `tests/tools/hook_envelope.test.ts` which validates the envelope output for every hook event x every plausible payload combination against a copy of Claude Code's hook output schema. Hardened the builder per findings:

1. **Skip empty HSO**: when an HSO event has no additionalContext and no permissionDecision, the builder no longer emits `hookSpecificOutput: {hookEventName}` with nothing else. Empty HSO is wasteful (and for UserPromptSubmit, schema-invalid because additionalContext is required there).
2. **PreToolUse-only permissionDecision**: per the schema, permissionDecision in HSO is PreToolUse-only. The builder now strips it for any other HSO event (defensive against future dispatcher branches that might accidentally set it).

**Discovery.** Jarid asked "do you need to exercise all the hooks and stuff to make sure there are no errors?" - exactly the gap that bit R7.2 (server name) and R7.3 (HSO on non-HSO events). Wrote a per-event x per-payload schema-validation test pass. Caught two latent bugs the dispatcher never exposed in practice but would have if a future branch had returned a different combination.

**Lessons.** Schema-shape validation belongs at unit-test time, not at runtime via Claude Code's hook engine. The new test:
- Mirrors the schema as a small validator (no ajv runtime dep needed).
- Tests every event in `ALL_EVENTS` x every payload variant (`additionalContext only`, `permissionDecision ask`, `decision block`, `systemMessage only`, `additionalContext + decision block`).
- Has a "regression: would-have-caught past bugs" suite that synthesizes the broken envelope shape R7.3 fixed and verifies the validator catches it.
- Has a drift-guard: if `HSO_EVENTS` set ever falls out of sync with the schema's documented HSO event names, the test fires.

This is the right shape for any future plugin work: build the envelope through the same code path the runtime uses, validate against a schema check, run on every test pass.

**Shipped:** v0.27.4.

---

## 2026-04-28 - R7.3 hotfix: hookSpecificOutput limited to 4 events per CC schema

**Change.** The `_hook_event` envelope builder in `mcp/server.ts` now only includes `hookSpecificOutput` for events whose schema documents it: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolBatch`. For all other events (`Stop`, `SubagentStop`, `StopFailure`, `PreCompact`, `PostToolUseFailure`, `TaskCompleted`), the envelope uses top-level fields only (`decision`/`reason`/`systemMessage`). When the dispatcher returns `additionalContext` for a non-HSO event, the wrapper folds it into top-level `systemMessage` so the message still reaches the model.

**Discovery.** Stop hook fired and produced: `Hook JSON output validation failed — (root): Invalid input`. The error dump showed Claude Code's hook schema explicitly lists `hookSpecificOutput` shapes for only 4 events. The R6 dispatcher always wrapped responses in `hookSpecificOutput: { hookEventName: <event> }`, so any non-HSO event triggered schema validation failure regardless of payload.

**Lessons.** PostToolBatch IS real (it's in the schema after all - the earlier claude-code-guide claim wasn't entirely fabrication, just misattributed in their context). The orchestrator now has it ready for future use should we need it. Schema validation errors are loud and exact - they include the offending JSON and the expected schema right in the console output, which made this fix a one-pass diagnose vs the multi-iteration server-name bug.

**Shipped:** v0.27.3.

---

## 2026-04-28 - R7.2 hotfix: hooks.json `server` field uses colon-separated `plugin:<name>:<key>` form

**Change.** All 8 `mcp_tool` hooks change `"server": "plugin_orchestrator_memory"` to `"server": "plugin:orchestrator:memory"`. The canonical server name as Claude Code's hook engine sees it is the colon-separated form visible in `/mcp` output, NOT the underscore form embedded in the agent-tool prefix `mcp__plugin_orchestrator_memory__*`.

**Discovery.** R7.1 had switched from the local `.mcp.json` key (`memory`) to the agent-tool-prefix form (`plugin_orchestrator_memory`) on the assumption that the underscore-separated name was the canonical one. Both still failed at the hook engine. After Jarid pasted `/mcp` output:

```
Built-in MCPs (always available)
plugin:discord:discord · √ connected
plugin:docs-manager:docs-manager · √ connected
plugin:orchestrator:memory · √ connected
```

The user-visible server identifier in `/mcp` is the colon-separated `plugin:<plugin>:<server-key>` form. That is what `hooks.json server:` field expects. The underscores in the tool prefix `mcp__plugin_orchestrator_memory__*` are just JSON-RPC name encoding (colons aren't legal in tool names so they're substituted with underscores when surfacing as tools), but the underlying server name is colon-separated everywhere else in Claude Code.

**Lessons.** The earlier R7.1 entry's "lessons" applied here: I should have asked Jarid to paste `/mcp` immediately rather than guessing a second name. Two failed iterations could have been one. The correct fact for future plugin work: the `mcp_tool` hook `server` field expects the EXACT string shown in `/mcp` for that server, which for plugin-provided servers is `plugin:<plugin>:<server-key>` (colons, not underscores).

The orchestrator's docs (CLAUDE.md, README, ARCHITECTURE) already note this gotcha after R7.1; updating them again to use the correct colon form is part of this ship. Anti-pattern note in the global KB updated to record the correct convention.

**Shipped:** v0.27.2.

---

## 2026-04-28 - R7.1 hotfix: hooks.json `server` field uses namespaced MCP name

**Change.** All 8 `mcp_tool` hooks in `hooks.json` change `"server": "memory"` to `"server": "plugin_orchestrator_memory"`. The R6 ship had used the local `.mcp.json` registration key (`memory`), but Claude Code's hook lookup uses the canonical full server name visible to its MCP layer, which is `plugin_<plugin-name>_<server-key>` = `plugin_orchestrator_memory`. Result: every hook dispatch silently failed with "MCP server 'memory' not connected" - so R6 + R7 dispatcher behavior never actually fired in live sessions, even though the agent-callable MCP tools (`send_message`, `update_session_task`, etc.) worked fine because their lookup is done against the same canonical full name.

**Rationale.** Caught by Jarid in field testing 2026-04-28 immediately after the R7 ship, when the new dispatcher's loop-closure / variant rotation / etc. failed to appear in the user-visible additionalContext. Console output: `PostToolUse:... hook error MCP server 'memory' not connected` (8x in a single turn). The fix is a one-character-per-hook string change.

The R6 ship rationale included a "rejected alternative" line acknowledging this exact ambiguity ("the .mcp.json registers the server under the simple key memory, so server: 'memory' in hooks.json matches. Verified at runtime.") - but the verification was inferred, not actually tested with a live hook firing. The claude-code-guide subagent's earlier example used `"server": "my_server"` shape, which led me to use the local key. Should have constructed a minimal working example and confirmed the hook actually fired before claiming verification.

**Rejected.**
- A second name lookup fallback inside the dispatcher (try `memory`, then `plugin_orchestrator_memory`) - misses the point. The hook config is what tells Claude Code's hook engine which server to dispatch to; the dispatcher itself can't intercept the connection failure.
- Renaming the local `.mcp.json` key from `memory` to `plugin_orchestrator_memory` - would break the agent-visible tool names (`mcp__plugin_orchestrator_memory__*` would become `mcp__plugin_orchestrator_plugin_orchestrator_memory__*`). The local key and the canonical full name are different by design; the canonical name is the one hook config takes.
- Using `${MCP_SERVER}` substitution if Claude Code supported it - it doesn't, and a hardcoded string is simpler.

**Lessons captured for future plugin work**: (1) hooks.json `server` field uses the full namespaced name `plugin_<plugin>_<key>`, not the local `.mcp.json` key. (2) When changelog or docs don't show a runtime example, construct one and watch it fire end-to-end before assuming the config shape. The R6 ship had test coverage of the dispatcher logic but no end-to-end test that actually fired a hook through Claude Code's hook engine.

**Shipped:** v0.27.1.

---

## 2026-04-28 - R7 loop-closure, work-item drift, sibling overlap, expanded hook surface

**Change.** Six dispatcher additions in `mcp/tools/hook_event.ts` plus matching `hooks.json` and `_hook_event` schema updates:

1. **UserPromptSubmit receives `user_prompt`** (wired via `${prompt}` substitution in hooks.json) so the dispatcher can do user-signal detection.
2. **Loop-closure nudge** — every UserPromptSubmit checks for in-flight `work_item` notes scoped to this session (source_session = me OR session_log shows I surfaced them). When found, injects a one-line nudge listing IDs and explicitly authorizing the agent to ASK the user if completion is unclear. Approval-language regex on the user prompt (`/\b(looks?\s+good|ship\s+it|perfect|...)\b/i`, capped at 300 chars to avoid long-prompt false positives) escalates the nudge to "Close loops NOW".
3. **Sibling-overlap detection** — when a sibling's `current_task` shares ≥2 meaningful keywords (4+ chars, stopword-filtered) with the user's prompt, the sibling line marks them with `*POTENTIAL OVERLAP*` and adds a coordinate-via-send_message tail. Quiet otherwise.
4. **Work-item drift nudge** — PostToolUse on Edit/Write/MultiEdit/NotebookEdit looks up in-flight work_items whose `code_refs` contain the file_path; surfaces them with an "update_work_item if your edit advances or completes this" prompt. Once per session+work_item via plugin_state.
5. **PreToolUse code_refs hint** — when about to edit a file with extant code_refs-tagged notes, injects "this file has N notes tagged - lookup({code_ref}) first". Once per session+file_path. Pairs with Option-B escalation when relevant, fires standalone otherwise.
6. **SubagentStop split from Stop** (bug fix from R6) — R6 incorrectly merged them; SubagentStop was telling subagents to call `save_progress`, which is the parent's job. Now `handleSubagentStop` is its own branch with text that explicitly says "Do NOT call save_progress" and focuses on capture (note, update_note, close_thread) only.
7. **Stop prompt becomes surgical** — sections are conditionally numbered based on session state. `Curate` always present. `Loop-closure` only when in-flight work_items exist. `Save progress` always present. R3.4 fresh-notes nudge stays gated at ≥3.
8. **TaskCompleted hook added** — fires when a subagent task completes; injects "did you capture what the subagent discovered?" so patterns/decisions don't evaporate with subagent context.
9. **StopFailure hook added** — fires when a turn ends due to API error; emits a systemMessage suggesting strategy change if errors persist. Lightweight, no block.
10. **VARIANTS pool grows from 14 to 18**: added loop-closure, update-as-you-go, coordination-etiquette, and check-siblings-when-it-matters reminders.

**Rationale.** Live observation (Jarid, 2026-04-28): agents don't proactively close work items unless given an explicit signal that work is done. They also under-use cross-session messaging — they see siblings exist but don't message them when scope overlaps. The orchestrator's "deterministic vs judgment" principle says the plugin should detect signals and prompt; the agent decides what to act on. R7 implements detection at every relevant moment: turn boundaries (loop-closure + user-signal), edits (drift nudge + code_refs hint), task starts (sibling overlap), task completion (capture nudge), failure (strategy nudge).

The bash-merged Stop/SubagentStop bug from R6 was a real regression: subagents got told to checkpoint, which they shouldn't. R7 separates them. Stop prompt also gets surgical sections so routine sessions don't see the same long blockwall every time - the prompt now reflects what actually happened.

**Rejected.**
- Auto-marking work_items done when "looks good" detected - too aggressive. Plugin detects, agent decides. The escalated prompt asks the agent to act, including asking the user explicitly when uncertain. That preserves "deterministic-vs-judgment".
- TaskCreated hook (mirror of TaskCompleted) - agents already pass context to subagents OK; the failure mode is on capture, not setup. Skip until field signal says otherwise.
- PostCompact hook - briefing already auto-pulls on resume; adding PostCompact would just duplicate the same nudge. Skip.
- Editing distance / fuzzy match for sibling overlap detection instead of keyword intersection - keyword intersection at ≥2 shared 4+-char tokens is a good cheap filter; refine later if false-positive rate is high. False-negatives cost nothing (no overlap detected = silent), false-positives cost only one line of additionalContext.
- Lowering the approval-prompt length cap below 300 chars - tested examples like "ok cool, also can you fix..." (90 chars) which SHOULD escalate. 300 is a reasonable upper bound for quick-signal prompts.
- Per-edit code_refs hint repetition - once per session per file_path is enough; repetition becomes noise.
- Hardcoded approval phrase list with stricter punctuation requirements - regex with `\b` word boundaries handles punctuation naturally.

**Shipped:** v0.27.0.

---

## 2026-04-28 - R6.1 agent-facing text alignment for R6

**Change.** Text-only pass across `CLAUDE.md`, `README.md`, `agents/memory-concierge.md`, and skills `every-turn`, `orchestrating`, `getting-started`, `wrapping-up`, `planning-approach` to surface R6 (cross-session messaging + active-task broadcast) behaviors to the agent. Two new VARIANTS added to the rotating UserPromptSubmit reminders in `mcp/tools/hook_event.ts` so agents see messaging cues organically. README's tool table, file-structure tree, test count, hook count, and dist size updated to match v0.26.0 reality. No schema, no engine, no tool changes.

**Rationale.** R6 shipped capable-but-unprompted: `send_message`, `read_messages`, and `update_session_task` were registered and tested but no skill, hook reminder, or top-level CLAUDE.md instruction told agents when to use them. Same failure mode as R3.7-pre-R3.8 and R5-pre-R5.1 - if the prose doesn't catch up, the feature is stranded. The pattern this repo has settled on: ship code, then immediately ship the text. R6.1 closes the loop.

The user (Jarid) flagged the gap directly after R6 commit, so this is also a reaffirmation that the R-rhythm has prose alignment baked in - it is part of the R-shipment, not a deferred follow-up. Future R-class work should plan for the prose pass alongside the code, not behind it.

**Rejected.**
- Deferring R6.1 by 1-2 weeks via `/schedule` - the reason this pattern is canonical is that prose drift compounds: agents who don't know about a feature don't use it, lack of usage means no field signal, lack of field signal means no R-bumps. Deferring is exactly the failure mode R3.8 and R5.1 corrected.
- A heavy README rewrite around messaging - kept additions surgical, slotted next to existing R5 / R4.4 entries rather than restructuring. Same shape as the R5.1 pass.
- Adding messaging to EVERY skill (e.g. `closing-a-thread`, `learned-something`, `user-preference`) - the nudge has to fit a natural moment. Only skills whose moment overlaps with cross-session coordination got the prose.
- Removing the legacy `Cross-Session Activity` section from briefing in favor of inline messages - kept both. Briefing is the on-ramp; inline messages are the active channel. Different roles, both load-bearing.

**Shipped:** v0.26.1.

---

## 2026-04-28 - R6 cross-session inter-agent messaging

**Change.** Two new tables (migration 19): `session_messages` (one row per send, with optional `to_session`, `scope` JSON, `priority`, `expires_at`) and `session_message_reads` (per-recipient read tracking so broadcasts work uniformly). Three new agent-callable MCP tools: `send_message`, `read_messages`, `update_session_task`. One internal dispatcher tool: `_hook_event`. Seven of eight bash hooks migrate to `type: "mcp_tool"` and route through `_hook_event`; `session-start` stays bash for cold-start safety. The hook fast path uses an in-memory `inboxCounters` map (Map<sessionId, number>) so `peekInbox` answers in O(1) and the dispatcher returns no `additionalContext` on idle turns - zero token cost when nothing is pending. The `PostToolUse` matcher widens to `.*` so messages are delivered after every tool call, not just orchestrator MCP calls.

**Rationale.** Pre-R6, sibling sessions could see each other's *captured* notes via the `cross_session` section in briefing, but couldn't actively coordinate. The `session_registry.current_task` column existed but nothing wrote to it. There was no inbox primitive. Inter-session communication was passive and turn-boundary-only. R6 makes it active and dense: layering `PostToolUse` + `UserPromptSubmit` + `PreToolUse` + `Stop` + `SubagentStop` hits every model-think boundary, so a message left by session A becomes visible to session B at its next tool call (~milliseconds in practice). The in-memory counter keeps the per-hook cost at O(1) when nothing is pending, satisfying the load-bearing "token-light when idle" constraint - if a hook returns empty `additionalContext`, the model doesn't pay any token cost for the hook firing.

The bash-to-mcp_tool migration is bundled into R6 because (a) the new dispatcher logic belongs in TypeScript with shared DB access, (b) keeping bash hooks alongside mcp_tool hooks for the same plugin would be incoherent (one substrate, not two), and (c) per the user's "complete removals in one pass" pattern, decoupling-then-removing-later was rejected. `_lib.sh`, `run-hook.cmd`, and the seven migrated bash scripts were deleted as part of the same shipment.

**Rejected.**
- Migrating SessionStart to mcp_tool - cold-start race; the MCP server may not be connected yet at first session boot. The hook would produce a non-blocking error (per Claude Code hook docs), but losing the boot directive is a real UX regression. Keeping bash here costs 60 lines and has no downside. The state-dir cleanup that the old session-start did is now done at MCP boot via `loadInboxCounters` priming the counter map, so the bash version is purely the boot-directive emitter and fallback-file writer.
- Per-event MCP tools (`hook_user_prompt_submit`, `hook_pre_tool_use`, ...) - pollutes the agent-visible tool list with 7 internal tools. Single `_hook_event` dispatcher with `_` prefix and a clear "agents should not call this directly" description is cleaner.
- Per-message `read_at` column without a separate `session_message_reads` table - works for direct messages but breaks for broadcasts (one row, many recipients). The reads table normalizes both shapes under one query.
- WebSocket / pub-sub between MCP servers - over-engineered for the cardinality (handful of concurrent sessions per project). DB + in-memory counter is enough.
- Polling MCP server in a background loop - Claude Code agents have no event loop while idle; only hooks can deliver context to a thinking model, and only at hook boundaries.
- Forwarding via Claude Code's `SendMessage` primitive - confirmed via changelog and docs to be agent-teams-only and intra-session. Cannot cross between two separately-spawned Claude Code processes. Cross-session messaging MUST go through shared state, and SQLite is the canonical pattern.
- Dropping the legacy `PreToolUse` Option-B escalation (turn-counter-driven nag for sessions that haven't called any orchestrator tool by turn 4) - flagged in the plan as tangential, but ultimately preserved inline in the dispatcher as a regression-avoiding default. The behavior is unchanged from the bash hook.
- Per-tool MCP server name in hooks.json (e.g. `plugin_orchestrator_memory`) - the `.mcp.json` registers the server under the simple key `memory`, so `server: "memory"` in hooks.json matches. Verified at runtime.

**Shipped:** v0.26.0.

---

## 2026-04-23 - R5.1 agent-facing text alignment for R4.4 + R5

**Change.** Text-only pass across skills, hooks, agents, docs, README, CLAUDE.md, and commands to surface R4.4 (auto-retro gate) and R5 (code_refs breadcrumbs + reverse-index + retro verification) behaviors to the agent. Same pattern as R3.8 / R3.9 (agent text alignment after code ships). No code, no tests changed.

**Rationale.** R4.4 and R5 shipped significant behaviors, but prose across the plugin hadn't been updated to describe them. Without this pass, `code_refs` is a capable-but-unprompted feature - agents won't use it because no skill tells them to, no hook nudges about it, and the agent-facing docs still describe R5 as "not yet shipped." Field experience with prior R-shipments (R3.7 through R3.9) established this pattern: ship the code, then immediately ship the text. Skipping the text pass strands the feature.

**Rejected.**
- Batching the text update with a later R5.2 (broken-refs in curation_candidates) - that delays agent awareness of R5 features that are already functional today. Each shipped behavior deserves immediate prose.
- Adding R5 to EVERY skill (including user-preference, closing-a-thread) - the nudge has to fit a natural moment, or it becomes noise. Only the skills whose moment overlaps with "knowledge about code" get the nudge.
- Migrating /docs in-repo - still explicitly rejected. Prose enrichment of the orchestrator happens organically via agent usage; one-shot migration would duplicate effort and rot at different rates from the source code.

**Shipped:** v0.25.1.

---

## 2026-04-23 - R5 code_refs breadcrumbs + reverse-index + retro verification

**Change.** Notes gain a `code_refs TEXT` column (JSON array of path strings, nullable) via migration 17. All five write tools (`note`, `update_note`, `supersede_note`, `create_work_item`, `update_work_item`) accept `code_refs: string[]`. `lookup({code_ref: "path"})` reverse-index returns notes that contain that exact path in their breadcrumb array. `retro` gains a verification pass: when `CLAUDE_PROJECT_DIR` (fallback `ORCHESTRATOR_PROJECT_ROOT`) is set, it iterates notes with code_refs, checks path-existence at the project root, reports `code_refs verified: N checked, M broken` in its summary.

**Rationale.** Code is ground truth. The orchestrator stores WHY, not WHAT - and WHY questions are inherently neighborhood-scoped. An agent editing `mcp/server.ts` should find every note ever captured about that file, even when the note's keywords would never match. File/module-level breadcrumbs give agents a file-triggered retrieval path that complements keyword/semantic search. Without breadcrumbs, file-scoped knowledge is only findable by remembering the exact keywords someone else chose at capture time - a brittle, high-miss-rate path.

**Rejected.**
- Line-range precision (`{path, range}`) and symbol-name precision (`{path, symbol}`) - line numbers churn every commit, symbol names churn on rename. The precision would force constant maintenance and fight for authority with the agent's own code indexers (which already do line/symbol search well). The earlier design sketch (decision `ca47f251`) proposed this and was superseded by `50e4e67d`.
- A dedicated `note_code_refs(note_id, path)` table with SQL index - premature optimization. TS post-filter over a JSON array is fine at the cardinalities expected in the near term; a table-based index is the natural upgrade if breadcrumb-tagged notes become the dominant population.
- One-shot `/docs` -> orchestrator migration - explicitly ruled out. The orchestrator enriches organically as agents touch code and leave breadcrumb-carrying notes. A bulk migration would duplicate effort and produce low-signal entries the near-duplicate gate would then churn through.
- Auto-updating broken refs during retro - that's a judgment call (supersede? delete? update?), not a calculation. Retro counts; the agent decides.

**Shipped:** v0.25.0.

---

## 2026-04-23 - R4.4 auto-retro gate

**Change.** `handleOrient` (briefing) now inline-invokes `handleReflect` on a 7-day cadence. Gate fires only when `event=startup` and `plugin_state.last_retro_run_at` is missing or older than 7 days. When it fires, retro's summary is prepended to the briefing output as an `## Auto-Retro` section, and `plugin_state.last_retro_run_at` is stamped with the new time so the gate closes for another 7 days. Manual `retro` calls still work and also reset the clock.

**Rationale.** Pre-R4.4, `retro` was agent-triggered only. In practice, agents called it inconsistently - some sessions never ran it, some ran it multiple times. Stale signal accumulated (confidence not decayed, orphans not flagged, autonomy scores drifting) until a human noticed. This violated the "always-up-to-date" and "more-accurate-over-time" design pillars at the pacing layer. The fix is to make periodic maintenance automatic: the plugin owns the cadence; the agent owns the curation decisions that flow from the summary.

**Rejected.**
- External cron daemon or OS scheduler - adds infrastructure for a problem solvable in-process. The MCP server is always warm when an agent is working; the gate can piggyback on the session-start briefing.
- Hook-based trigger (e.g. SessionStart hook calls retro) - hooks don't invoke MCP tools. They emit text or block; they can't mutate the orchestrator's state directly. Would require an out-of-band MCP client just for this, which is more infrastructure.
- Weekly cron in an agent's skill ("every Monday call retro") - back to the agent-remembers-to-call-it failure mode that motivated R4.4.
- Shorter interval (1 day, 3 days) - too chatty; retro output in every briefing would add noise. 7 days matches the cadence at which confidence decay and signal decay produce observable shifts.
- Longer interval (30 days) - too stale; orphan detection and revalidation lose their value when they surface weeks late.

**Shipped:** v0.24.4.

---

## 2026-04-23 - R4.1 candidate rank buckets

**Change.** The R4 forced-resolution gate now prefixes each returned candidate with a rank bucket label: `HIGH MATCH` (>= 0.95), `LIKELY RELATED` (0.85-0.94), `ADJACENT` (0.75-0.84). Candidates are sorted descending by similarity so the strongest match is first.

**Rationale.** Live observation of the gate at 0.75 threshold showed agents treating a 97% match and a 78% match with the same weight in their resolution choices. The numbers are there but the agent does not "feel" the distance. A named bucket provides a stable visual anchor: HIGH MATCH reads "probably same", ADJACENT reads "probably different", and the agent resolves accordingly.

**Rejected.**
- Raising the threshold to 0.85 - would miss real duplicates in the 0.75-0.85 zone, which was the whole reason R4 exists.
- ANSI color coding - MCP clients vary in terminal rendering support; colors are not universal.
- Dropping the numeric similarity - the bucket is a summary, not a replacement; both carry signal.

**Chosen.** Bracketed text labels, terminal-agnostic, rendered as part of the blocked-gate response.

**Shipped:** v0.24.1.

---

## 2026-04-23 - R4 forced-resolution gate

**Change.** `note()` now BLOCKS writes for types `decision`, `convention`, `anti_pattern` when embedding similarity >= 0.75 against an existing note, unless the caller supplies a `resolution`. The blocked response returns top candidates with the four resolution actions: `accept_new`, `update_existing`, `supersede_existing`, `close_existing`.

**Rationale.** The R3 field test (see note 54e5c08d in the orchestrator DB) showed that warnings, informational alerts, and hook nudges do not reliably change agent behavior. Agents capture-bias through them. The only mechanism that reliably gets resolution attention is blocking the write and requiring an explicit choice. This makes the deterministic-vs-judgment split concrete: the plugin detects the near-duplicate (calculation); the agent picks the action (judgment).

**Rejected.**
- Stricter similarity threshold only - does not solve "cruise through duplicates" because the gate never fires as a block.
- Extending the gate to all types - too much friction on casual captures (insight, checkpoint, work_item). Concentrate on the types where near-duplicates are most corrosive.
- Deterministic auto-resolution - the plugin cannot know whether two semantically-similar notes are "the same knowledge" or "adjacent-and-both-valid". That is the judgment call.

**Shipped:** v0.24.0.

---

## 2026-04-23 - R3.7 auto-linker false-supersedes fix

**Change.** `inferRelationship` now returns `related_to` for decision <-> open_thread pairs (previously returned `supersedes`). `fetchSupersedeChain` filters rendered results to notes that share a content column with the seed note.

**Rationale.** Observed on note b12dc08c: the detail view showed "Superseded by" entries pointing at topically-unrelated notes. Root cause was the auto-linker's type-pair heuristic creating false supersede edges on any decision <-> open_thread insert, which then rendered as supersede-chain noise on lookup. The fix has two parts: stop creating them at the source, and filter the render path so the existing bad edges do not surface.

**Rejected.**
- One-shot migration to delete orphan supersede edges - more invasive than needed. The query-time filter handles it for rendering, and the UNIQUE edge index from v15 prevents new bad edges.
- Making the auto-linker never produce supersede edges under any type pair - too aggressive; the design is that `supersedes` is the output of `handleSupersede` only, not the auto-linker, and the fix already enforces that.

**Shipped:** v0.23.7.

---

## 2026-04-23 - R3.6 memory-concierge Shape A / Shape B

**Change.** The `memory-concierge` agent prompt was rewritten to distinguish two request shapes: Shape A (structured artifact request - "write me a decision note about X") vs Shape B (batch capture request - "save everything we just did"). The concierge now recognizes which shape it is in and adjusts its capture strategy accordingly.

**Rationale.** In session dcb897c8, after 82k tokens of work, the concierge returned "nothing else to capture" because its prompt biased toward save_progress-shaped handoffs. It was treating every handoff as Shape A (find the one thing to write) when it was actually Shape B (find the ten things that happened). This is a prompt-bias problem, not a model problem.

**Rejected.**
- Fixing this via model behavior tuning - not a model problem; the prompt was the constraint.
- A single unified prompt that handles both shapes implicitly - agents under-invest in ambiguous instructions; explicit is better.

**Shipped:** v0.23.6.

---

## 2026-04-23 - R3.5 Jaccard min-3 fix + alert reframe

**Change.** Two changes packaged together:

1. `deduplicator.ts` and `writeUserModel` (in `tools/remember.ts`) now require `intersection.size >= MIN_SHARED_KEYWORDS (3)` in addition to the Jaccard ratio threshold.
2. The post-insert similarity alert shows top-3 candidates with attribution framing ("You just wrote X; you may have been thinking of...") instead of a top-1 assertion.

**Rationale.**
- On short notes, 1-2 shared keywords can easily cross a 0.6 Jaccard ratio and trigger false-positive dedup or auto-links. Requiring 3 shared tokens guards against tiny-keyword-set coincidences. Exact content matches still bypass this gate because the similarity is 1.0 by other means.
- Top-1 informational alerts were not actionable because they lost the distribution. If similarity-1 is 0.62 and similarity-2 is 0.61, the agent has different context than if similarity-1 is 0.62 and similarity-2 is 0.35.

**Rejected.**
- Raising the Jaccard ratio threshold alone - does not fix the short-note false-positive case; a 2-of-2 match still hits ratio 1.0.
- Keeping top-1 alert - loses distribution information; agents can't make informed resolution choices.

**Shipped:** v0.23.5.

---

## 2026-04-23 - R3.4 Stop-hook maintenance symmetry

**Change.** The `Stop` and `SubagentStop` hook prompts now advertise update / close / supersede verbs with equal weight to capture. They also inject a session-activity nudge pulled from `session_log` - "you surfaced these N notes this session; did any need updating?".

**Rationale.** Sessions were growing the corpus without maintaining it. The hook was capture-biased ("what did you learn? what did you decide?") with maintenance as a footnote. Field observation showed agents complied with the capture side and ignored the maintenance side. Rebalancing the hook text is a prompt-layer change, but the rebalancing itself is a load-bearing design choice - it enforces cost symmetry (R1) at the end-of-session touch point where maintenance is most valuable.

**Rejected.**
- Silent Stop hook with only a data-model nudge - agents miss the prompt entirely.
- Forcing a blocking check at Stop - too intrusive, and Stop runs even on trivial sessions where maintenance is not warranted.

**Shipped:** v0.23.4.

---

## 2026-04-23 - R3.3 curation_candidates briefing section

**Change.** `briefing` gained a `curation_candidates` section. It surfaces stale-but-hot notes (age > threshold AND signal > threshold) and low-confidence-but-hot notes (confidence = low AND signal > threshold), each with inline maintenance handles.

**Rationale.** Agents cannot maintain what they do not see. Even with cost-symmetric CRUD (R1) and revision machinery (R2), the default retrieval paths were still only surfacing what the agent explicitly asked for. The briefing is the one place every session touches, and it was silent on curation load. Adding the section makes the maintenance queue visible.

**Rejected.**
- A separate `maintenance` tool - agents would not call it; it has to come to them.
- Surfacing every stale note - too noisy; rank by signal so only hot-but-rotting notes surface.

**Shipped:** v0.23.3.

---

## 2026-04-23 - R3.2 signal wired universally

**Change.** `signalBoost(s) = 1 + 0.1 * log(1 + max(0, s))` and `confidenceMultiplier` were wired into the ranking paths for `findRelatedNotes`, `findRelatedNotesHybrid`, briefing composition, and `list_work_items` / `list_open_threads` (as a secondary sort within priority tier / update time).

**Rationale.** `signalBoost` was defined in `engine/signal.ts` but never imported. Signal was being deposited on every surfacing (so the `signal` column was growing), but it was never being spent on retrieval. The pheromone system was working as a write-only audit log, not as a ranking signal. Wiring it in is what makes the ANTS model actually adaptive - hot notes float up in ranking.

**Rejected.**
- Keeping signal purely informational (displayed in envelopes but not used for ranking) - the whole point of pheromone reinforcement is that retrieval gets smarter as the graph walks get reinforced.
- A harder signal weighting (0.3 instead of 0.1 log) - would overpower BM25/vector relevance too quickly; the log curve keeps it as a tiebreaker rather than a dominant factor.

**Shipped:** v0.23.2.

---

## 2026-04-23 - R3.1 ranked link expansion

**Change.** `fetchLinkedNotes` caps at 20 by default with composite ordering (depth + signal + confidence + recency) and a tail message pointing at `link_limit:500` for the full neighborhood or `link_limit:0` to skip links entirely. The supersede-chain section does not count against this cap.

**Rationale.** Umbrella note 64301fd3 returned 110k chars of linked-note content via a single `lookup({id})` call, exceeding the context budget of the calling agent in one hop. Graph walks have to be unbounded internally (the breadcrumb invariant requires reachability), but the RENDERED neighborhood has to be bounded. Ranked cap + breadcrumb for the rest.

**Rejected.**
- `depth: 0` default - loses breadcrumb entirely; the agent cannot tell that linked notes exist unless they ask for them.
- No cap - the problem that caused this change.
- Hard cap with no recovery path - violates the breadcrumb invariant.

**Shipped:** v0.23.1.

---

## 2026-04-23 - R2 evolution-preserving rewrite

**Change.** Three related items:

1. `note_revisions` table added in migration 15. Stores pre-mutation snapshots (content, context, tags, keywords, confidence) with session attribution.
2. `update_note` now snapshots the current row before any field replacement. `append_content` path does not snapshot (it does not replace).
3. `supersede_note` tool hardened: archives old, surfaces new, creates `supersedes` edge. UNIQUE index on `links(from, to, relationship)` (migration 15) enforces one edge per pair.

**Rationale.**
- `update_note` pre-R2 destroyed old content. There was no way to trace WHY the current content is what it is - an essential capability for a knowledge base that is supposed to "get more accurate over time".
- `supersede_note` existed but was not hardened; duplicate supersede edges could accumulate, and the superseded note was still appearing in default lookup.

**Rejected.**
- Append-only notes - blocks true corrections; sometimes the old content is just wrong and needs replacement.
- Soft-delete instead of supersede - `superseded_by` column is cleaner because it carries the forward pointer; a soft-delete flag would require a separate way to find the replacement.

**Shipped:** v0.23.0.

---

## 2026-04-23 - R1 symmetric CRUD contract

**Change.** Four related items:

1. `supersede_note` added as a first-class tool (prior supersede path was a hidden side-effect of manual graph edits).
2. `update_note` gained `append_content` - avoids read-before-write for additive updates.
3. Tool descriptions harmonized: every maintenance verb explicitly says "Equal-priority to note() - curation is as important as capture."
4. `lookup` envelope now carries maintenance handles inline on every hit: `[maintain: update_note({id:...}) | close_thread({id:...}) | supersede_note({old_id:...})]`.

**Rationale.** Tool-surface asymmetry biases agent behavior. Pre-R1, `note()` was a 3-line call and `supersede_note` did not exist as a verb; agents defaulted to capturing new notes instead of curating existing ones. The result was an append-only log masquerading as a knowledge base. Equalizing the surface is the data-model-level change; inline maintenance handles ensure the agent does not have to do a second lookup to know the id.

**Rejected.**
- Keeping post-insert informational alerts as the only maintenance prompt - this path was revisited later in R4 after field-testing showed alerts do not reliably change behavior.
- Making `update_note` require a `reason` field - too much friction; curation has to be cheap or it will not happen.

**Shipped:** v0.22.0.

---

## 2026-04-22 - The R1-R5 framing

**Change.** Articulated a five-root architectural framework for the orchestrator: R1 symmetric CRUD, R2 evolution-preserving rewrite, R3 maintenance as first-class deliverable, R4 deterministic in plugin / judgment in agents, R5 code as ground truth. This became the organizing principle for subsequent shipments.

**Rationale.** Session dcb897c8 surfaced a stale-note-not-updated pattern originally flagged by session 9c4b0184. Jarid explicitly asked for orchestrator-level improvements rather than CLAUDE.md / prompt-layer shims (the "no prompt-layer shims" constraint in DESIGN-PRINCIPLES comes from this exchange). Framing the work as five architectural roots forced each shipment to be a data-model / tool-shape / envelope / decay change rather than a text nudge.

**Rejected.**
- The prior P1-P7 proposal in work item 83abac38 - seven principles was too long to hold in context, and several of them collapsed into each other under examination. The R1-R5 rewrite is tighter and more load-bearing.
- Describing the work as "knowledge-base hygiene features" - does not capture the architectural shift; hygiene features can be text nudges, and the whole point is that they cannot be.

**Shipped:** the framing itself went into the orchestrator as a decision note; the concrete R1 implementation landed a day later in v0.22.0.

---

## What's next

- **R5.2 - broken code_refs in curation_candidates.** R5 shipped verification via retro, but broken refs are only surfaced as a count in the retro summary - the agent has to read it and decide what to do. R5.2 will feed broken refs into `briefing.curation_candidates` so they appear alongside stale-but-hot and low-confidence-but-hot entries, with the same maintenance-handle inline envelope. Remaining work: data source in composer.ts, rendering in briefing envelope, rank alongside existing curation candidates.
- **Loose items.** Assorted ergonomics and polish - see open threads in the orchestrator DB under tag `curation`.
