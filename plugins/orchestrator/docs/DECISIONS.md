# Orchestrator Decisions Log

Reverse-chronological. Each entry: date, change, rationale, what-was-rejected, where it shipped.

Pair with [DESIGN-PRINCIPLES.md](./DESIGN-PRINCIPLES.md) for the framework the R-series decisions are written against.

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
