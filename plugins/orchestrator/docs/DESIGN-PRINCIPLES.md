# Orchestrator Design Principles

## The problem the plugin solves

Agents operate across sessions. Context windows are ephemeral. Without persistent shared memory, every session starts from zero: prior decisions get re-litigated, solved problems get re-solved, established conventions get re-invented, and the user's preferences get re-learned turn after turn.

The orchestrator is that persistent memory. It is a living knowledge base where agents capture decisions, patterns, insights, gotchas, user preferences, and architectural intent, and then retrieve them across session boundaries. The goal is cross-session continuity: what one agent learns, every future agent starts with.

Two first-order consequences fall out of that framing:

1. The knowledge base has to remain trustworthy as it grows. Stale, duplicated, or contradicted entries corrode trust. An agent that cannot trust retrieval will not retrieve.
2. The cost of using it must stay low. If briefing grows unboundedly, if lookup returns 100k characters, if every capture requires a ceremony, agents will default to not using it.

Everything downstream in this document is a response to those two constraints.

## The design-intent test

Three dimensions. Any proposed change is tested against all three. If a change helps one but hurts another, something is wrong with the shape of the change, not the test.

### 1. Always-up-to-date

Stale data competing with fresh truth is a first-order quality problem, not a second-order nice-to-have. When an agent searches and gets back a 90-day-old decision that has quietly been superseded by a 3-day-old one, the agent cannot tell the difference from headline text alone, and will confidently act on the wrong answer. The plugin fails its job the moment that happens.

Mechanisms:

- Current-truth surfaces first. Superseded notes are hidden from default `lookup`.
- `updated_at` is rendered as age in every retrieval envelope so freshness is visible at a glance.
- Signal (pheromone reinforcement) promotes recently-touched notes within their tier.
- Confidence decays over time via the retro pass.
- `supersede_note` exists as a first-class verb so evolution is captured, not paved over.

### 2. More-accurate-over-time

Agents must MAINTAIN the knowledge base, not just grow it. Maintenance is co-equal to capture. Every session should leave the KB more coherent than it found it - fewer duplicates, fewer unresolved threads, sharper content on the notes that matter.

Mechanisms:

- `update_note`, `close_thread`, `supersede_note`, `delete_note` have the same tool-surface footprint as `note`.
- Every `lookup` hit envelope advertises the maintenance verbs inline with the ID already in context.
- `briefing` surfaces `curation_candidates` - stale-but-hot and low-confidence-but-hot notes - so agents see what needs attention, not just what's new.
- The Stop and SubagentStop hooks ask "what did you UPDATE / CLOSE / SUPERSEDE?" with equal weight to "what did you SAVE?".
- The R4 forced-resolution gate prevents `note()` from silently growing the corpus when a near-duplicate already exists.

Append-only log thinking is rejected. The knowledge base is a rewriting surface.

### 3. Faster-to-traverse-over-time

Default retrieval must stay small and fast even as the corpus grows. Soft ceilings on tool response size, signal-quality filters, and opt-in-for-depth patterns hold the line against context bloat.

BUT traversal speed never comes at the cost of reachability. Every hidden datum has a one-flag or one-lookup recovery path. This is the breadcrumb invariant, called out explicitly below. Compression without escape is not allowed; that is how knowledge bases lose the ability to be audited.

Mechanisms:

- Soft target of 5-10k chars per tool response; a warning appended when exceeded.
- `lookup` linked-notes cap at 20 by default; `link_limit: 500` opens the full neighborhood.
- `include_superseded: true`, `include_history: true` reveal archived and revision data on demand.
- Signal boosts promote hot notes so default ranking keeps surfacing what matters.
- Composite ordering (primary semantic + signal + recency) on search, briefing, and list retrieval.

## R1-R5: five architectural roots

Each R is a shipped (or planned) architectural move. They compound. R2 depends on R1's surface, R3 depends on R2's history, R4 depends on R3's candidate machinery, R5 rides on top of all four.

### R1 - Symmetric CRUD contract

**Principle.** All verbs that act on notes have equal param count, equal token cost, equal cognitive load. Maintenance is not a heavier tool than capture.

**Rationale.** Tool-surface asymmetry biases agents. If `note()` is a 3-line call and `supersede_note` is a 12-line ceremony with required fields the agent doesn't have in context, the agent will `note()`. The result is an append-only log masquerading as a knowledge base.

**Mechanisms.**
- `note`, `update_note`, `close_thread`, `supersede_note`, `delete_note` all take the same shape.
- Every `lookup` hit envelope carries `id`, `updated_at`, `confidence`, `source_session`, and maintenance handles inline. Update is one tool call with fields already in context.
- Tool descriptions advertise maintenance verbs alongside capture verbs ("Equal-priority to note() - curation is as important as capture").
- `append_content` on `update_note` avoids read-before-write for additive updates.

**Shipped:** v0.22.0.

### R2 - Evolution-preserving rewrite

**Principle.** Every write that replaces content creates a revision. The current note surfaces on `lookup`. History is preserved but gated behind `include_history: true` so it doesn't bloat default retrieval.

**Rationale.** Without history, `update_note` destroys the record of why we landed where we did. Without supersede, there is no way to mark "this was right at the time, and now it is not." Wholesale deletion loses the ability to audit evolution.

**Mechanisms.**
- `note_revisions` table (migration 15) holds pre-mutation snapshots of content, context, tags, keywords, confidence, with session attribution.
- `update_note` snapshots the current row before any field replacement; `append_content` does not snapshot because it does not replace.
- `supersede_note` is a first-class verb. It sets `superseded_by` + `superseded_at` on the old note and creates a `supersedes` graph edge.
- Superseded notes are archived from primary retrieval but still reachable via explicit id lookup or `include_superseded: true`.
- UNIQUE index on `links(from_note_id, to_note_id, relationship)` added in migration 15 is a load-bearing dependency for R2 and R3.

**Shipped:** v0.23.0.

### R3 - Maintenance as first-class deliverable

**Principle.** Maintenance work is surfaced proactively, ranked, and hinted at every point of contact. Signal (pheromone) is spent on retrieval, not just deposited.

**Rationale.** Agents cannot maintain what they do not see. A maintenance-capable tool surface (R1) and revision machinery (R2) are necessary but not sufficient - the plugin must actively surface the curation load.

**Mechanisms.**
- `briefing` includes a `curation_candidates` section: stale-but-hot and low-confidence-but-hot notes with maintenance handles.
- Stop-hook prompts (v0.23.4) ask for update/close/supersede with the same weight as save.
- Every `lookup` result includes per-result maintenance hints: `[maintain: update_note | close_thread | supersede_note]`.
- Signal was wired universally into search, briefing, and list retrieval (v0.23.2). Previously the `signalBoost` helper existed but was never imported - signal was being deposited but never spent.
- `fetchLinkedNotes` ranks by composite score (primary semantic + signal + recency) and caps at 20 with a tail message pointing at `link_limit:500` or `link_limit:0` (R3.1).
- `note()` on near-duplicate by Jaccard (MIN_SHARED_KEYWORDS = 3 after R3.5) surfaces the existing match and prompts resolution via auto-promotion or an informational alert.

**Shipped:** v0.23.1 through v0.23.9.

### R4 - Deterministic in plugin, judgment in agents

**Principle.** The plugin owns the deterministic work. The agent owns the judgment. The forced-resolution gate is the clearest expression of this: the plugin detects the near-duplicate, the agent decides what to do about it.

**Rationale.** Warnings do not reliably change agent behavior - this was field-tested in v0.10.1 with HARD-GATE red-flag warnings and the informational alert in R3.5. Both failed to stop agents from cruising through duplicates. The plugin has to detect and block. But the plugin must not make the judgment call itself - "are these really duplicates?" is a semantic question that requires understanding what both notes mean, which is exactly what the agent is good at and the plugin is not.

**Mechanisms.**
- `note()` for types `decision`, `convention`, `anti_pattern` with embedding similarity >= 0.75 against an existing note BLOCKS the write unless a `resolution` is supplied.
- The blocked response returns top candidates with rank buckets (HIGH MATCH / LIKELY RELATED / ADJACENT per R4.1), ages, and the four resolution actions: `accept_new`, `update_existing`, `supersede_existing`, `close_existing`.
- The agent re-calls with its chosen resolution; the plugin then executes the deterministic operation.
- `resolution` handlers share `insertNote` and cascade logic with the normal path so semantics are identical.

**Shipped:** v0.24.0 with R4.1 UX polish in v0.24.1.

### R4.4 - Auto-maintenance gate

**Principle.** Periodic maintenance shouldn't require the agent to remember. The plugin owns the cadence; the agent owns the curation decisions that flow from it.

**Rationale.** Pre-R4.4, `retro` was agent-triggered only. In practice, agents called it inconsistently - some sessions never ran it, some ran it multiple times. Stale signal accumulated (confidence not decayed, orphans not flagged, autonomy scores drifting) until a human noticed. This violated the "always-up-to-date" and "more-accurate-over-time" pillars at the pacing layer. Hooks can't fix it: hooks don't invoke MCP tools, and a cron daemon would add infrastructure for a problem solvable in-process.

**Mechanisms.**
- `plugin_state` table (migration 16): generic key/value surface for future ephemeral plugin state. First consumer is `last_retro_run_at`.
- `handleOrient` (briefing) checks `shouldAutoRetro()` - returns true when `last_retro_run_at` is missing or older than 7 days, and only when `event=startup`.
- When true, briefing inline-invokes `handleReflect` and prepends the output with an `## Auto-Retro` section. `recordAutoRetroRun()` writes the new timestamp so the gate closes for the next 7 days.
- Manual `retro` calls remain supported. Calling retro manually also resets the 7-day clock.
- Agents see the auto-retro summary on their first-of-week briefing. The skills (getting-started, wrapping-up) now describe this as expected, not a surprise.

**Shipped:** v0.24.4.

### R5 - Code is ground truth; orchestrator stores what code cannot

**Principle.** Notes are agent-facing insights: why decisions were made, what was rejected, scars, evolution, patterns, gotchas, architectural intent. They do not duplicate code-level detail (signatures, schemas, implementations) - the code itself is authoritative on those. Notes that are about code carry **breadcrumbs** - file or module paths pointing at the neighborhood the note concerns.

**Rationale.** Today, most projects that use the orchestrator also carry a `/docs` tree inside their own repo: design docs, architecture notes, decision logs. That split duplicates effort and rots at different rates. The end state is that `/docs` in consumer projects retires - the orchestrator replaces it as a richer, typed, embedded, auto-linked, evolution-preserving knowledge base. To get there, notes need a structured `code_refs` field with auto-verification on retrieval and a reverse-index so an agent looking at a file can ask "what notes are about this?".

**Breadcrumbs, not indexes (R5 refinement).** An earlier design sketch (see decision `ca47f251`) proposed line-range and symbol-name precision on code_refs. That was rejected and superseded by `50e4e67d`: the orchestrator tracks file and module paths only. Rationale:

- **Division of labor.** Code indexers (the model's own navigation tools + the host harness) already do line-level and symbol-level search well. The orchestrator would duplicate that work badly and fight for authority with tools that are closer to the code.
- **Churn.** Line numbers drift every commit. Symbol names drift on rename. Breadcrumbs at file/module granularity survive refactors that would invalidate precise refs daily.
- **Purpose fit.** The orchestrator's job is to answer "why does this neighborhood exist?" - a question that is inherently file-scoped, not line-scoped. The neighborhood is the unit of insight; lines are the unit of code.

So code_refs is a `string[]` of path strings. Agents add paths at the granularity that fits the note's scope (a single file for a file-specific gotcha, a module directory for a subsystem convention). The agent chooses granularity; the plugin stores what the agent gave it.

**Mechanisms.**
- `code_refs` column on `notes` (migration 17): `TEXT` holding a JSON array of path strings, nullable.
- All five write tools accept `code_refs`: `note`, `update_note`, `supersede_note`, `create_work_item`, `update_work_item`. `update_note` and `update_work_item` treat `[]` as clear-to-null; `undefined` as leave-unchanged.
- Reverse-index: `lookup({code_ref: "path/to/file.ts"})` filters results to notes whose `code_refs` array contains that exact string (TS post-filter; no wildcards).
- Envelope rendering: `lookup` detail + search branches render `code_refs: [path1, path2]` inline when present.
- Retro verification: when `CLAUDE_PROJECT_DIR` (fallback `ORCHESTRATOR_PROJECT_ROOT`) is set, `retro` iterates notes with code_refs, checks path-existence at the project root, and reports `code_refs verified: N checked, M broken` in its summary. Broken refs are not auto-updated - that's a judgment call (supersede? delete? update?) for the agent.
- `/docs` migration NOT performed. Jarid explicitly ruled out a one-shot migration: the orchestrator enriches organically as agents touch code and leave breadcrumb-carrying notes, and the R4 near-duplicate gate prevents sludge accumulation. The end state emerges from usage, not from an upfront sweep.

**Shipped:** v0.25.0.

## Load-bearing constraints

These apply across all R-shipments. Every change must respect them.

### No CLAUDE.md / prompt-layer shims

Warnings do not reliably change agent behavior. This was field-tested in v0.10.1 with HARD-GATE red-flag enforcement language in hook text, and again in R3.5 with post-insert informational alerts. Both failed.

Changes must land at:
- The data model (new columns, new tables, new indexes).
- The tool shape (new verbs, new params, new response envelopes).
- The return envelope (what text is always rendered, what text is gated).
- The decay policy (what gets demoted without explicit action).

Text-only nudges in prompts, CLAUDE.md hints, or hook messages are not a substitute.

### Breadcrumb invariant

Every hidden datum has a one-flag or one-lookup recovery path. Examples:

| Hidden by default | Recovery |
|---|---|
| Superseded notes hidden from default lookup | `include_superseded: true` |
| Revision history hidden from default detail view | `include_history: true` |
| Linked notes capped at 20 | `link_limit: 500`, or `link_limit: 0` to skip |
| Large responses truncated with a warning | Concierge referral, explicit id lookup |

Graph walks are NEVER filtered (unlike query-time result filtering). A supersede chain or a linked-notes traversal always returns the full chain; filtering happens only at query-result assembly. This matters because breadcrumb recovery via lookup-by-id must always work.

### Cost symmetry

All CRUD verbs have comparable friction. `update_note` is as cheap as `note()`. `supersede_note` takes the same shape of params. `close_thread` is as easy as `note()`. A user listing the tool descriptions should not be able to tell which verbs the plugin "prefers" - they are all first-class.

### Soft ceilings on tool response size

Target: 5-10k chars per response. The budget is "a few paragraphs of detail plus the top-N results", not a firehose of the full graph neighborhood. When a response exceeds the ceiling:

- Append a concierge-referral footer suggesting curated analysis rather than direct reading.
- Keep the top-N; do not try to compress by shortening every entry.

`lookup` today appends a referral at 15k chars; briefing sections are individually budgeted.

### Cross-project patterns in global DB, project-local in project DB

Routing is a schema-level decision, not a per-call choice.

- Always global: `user_pattern`, `tool_capability` (see `GLOBAL_TYPES` in `mcp/types.ts`).
- Can be either, agent-selectable via `scope` param: `anti_pattern`, `autonomy_recipe`, `quality_gate`, `convention` (see `MAYBE_GLOBAL_TYPES`).
- Always project-local: `decision`, `commitment`, `insight`, `architecture`, `open_thread`, `risk`, `dependency`, `checkpoint`, `work_item`.

This is what keeps the user model portable across projects while project-specific decisions do not leak sideways.

## The deterministic-vs-judgment dividing line

This is the architectural principle that separates plumbing from decisions. When a new feature is proposed, classify it before implementing.

### Deterministic (plugin owns)

- Staleness scoring: age + signal + citation velocity.
- Contradiction similarity: embedding distance + keyword overlap + polarity.
- Curation candidate ranking: staleness x citation x contradiction.
- Revision snapshot before mutation.
- Supersedes bookkeeping: column + graph edge consistency.
- Pheromone decay math.
- Response envelope construction.
- Near-duplicate detection on write: embedding similarity threshold check.
- Column-graph consistency filter for supersede chain rendering.
- Jaccard dedup, keyword extraction, auto-link inference.
- Cross-session discovery: who created what since when.

### Judgment (agent owns)

- Which resolution to pick when a near-duplicate is detected.
- Whether two notes really contradict vs. are adjacent-and-both-valid.
- When a thread is semantically complete (call `close_thread`).
- How to rewrite a superseded note's body to reflect current truth.
- Whether to act on a surfaced curation candidate this session.
- What the user actually means when they express a preference.
- Which dimension of the user model a new observation belongs under.
- Whether to capture something as `decision` vs `convention` vs `architecture`.

### How to use this list

When proposing a feature, ask: is the work here a calculation, or is it a choice? If it is a calculation, the plugin does it, and the result shows up in the envelope. If it is a choice, the plugin surfaces the context and lets the agent decide.

The R4 gate is the cleanest illustration. Embedding similarity >= 0.75 is a calculation (plugin). "These two notes are actually the same knowledge" is a choice (agent). The plugin does not ever try to make the second call - it surfaces the match, presents the four resolution actions, and waits.

Anti-pattern to avoid: a feature that tries to guess the agent's intent in deterministic code. Whenever "the plugin should figure out what the agent means" appears in a proposal, stop - that is a judgment call, and the plugin is the wrong place for it. Push the surface up to the agent.

## Relationship to the rest of these docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) - how the above principles land in actual code: data model, tool surface, engine, hooks, retrieval pipeline.
- [DECISIONS.md](./DECISIONS.md) - the reverse-chronological log of shipments that implement the principles above, with what-was-rejected preserved inline.
