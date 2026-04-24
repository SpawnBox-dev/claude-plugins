# Orchestrator Decisions Log

Reverse-chronological. Each entry: date, change, rationale, what-was-rejected, where it shipped.

Pair with [DESIGN-PRINCIPLES.md](./DESIGN-PRINCIPLES.md) for the framework the R-series decisions are written against.

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

## Pending

**R5 - code as ground truth.** Not yet shipped. Deferred to a future planning session. Groundwork is in place (the tool surface can accommodate a `code_refs` field without breaking existing notes; the retrieval pipeline can accommodate a reverse-index lookup pattern). Remaining work includes schema migration for `code_refs`, auto-verification on retrieval, reverse-index query, and agent-side content-convention guidance. See DESIGN-PRINCIPLES.md R5 for the full intent.
