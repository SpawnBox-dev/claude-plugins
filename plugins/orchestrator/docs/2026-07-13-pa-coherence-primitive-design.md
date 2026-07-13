# PA-coherence primitive: queryable fleet warm-context + repurposing candidates - DESIGN (gate before build)

- **Author:** SA-0c230dcf. **Gate:** PA-69bba46e (design-first per PA's explicit rider - registry-schema surface, don't implement until approved). **Charter:** "build the thing that keeps PA coherent about its own fleet."
- **Motivation:** user_pattern `4b9b8d52` - context engineering is a PA prime responsibility; PA must staff by STEERING warm SAs before spawning, weighed against context-pollution. Today PA does this from working memory + the hook's `current_task` line, which is thin and lossy across compaction. This primitive makes fleet-context QUERYABLE so PA staffs from data, not recall.
- **Sibling:** the warden's human-readable "Fleet - per-SA context & adjacency map" ledger section (context-warden.md, shipping in this batch). Same model, two surfaces: the warden's is narrative + PA-facing; this is the deterministic, always-on, machine-queryable half that survives warden death.

## What PA needs to answer

1. **"Who is warm on X?"** - given a subsystem/file/tag, which live SAs already have that context loaded (fast, high-quality fit for adjacent work)?
2. **"Who is idle-and-adjacent to Y?"** - which SAs are winding-down/idle AND warm on Y (a repurposing window before their context cools)?
3. Every candidate must be **LIVE** (not egress-dead, not ingress-dead) - an idle-looking session that's actually parked/unreachable is a false candidate.

## Design (3 touchpoints)

### 1. Registry schema (`agent_channel.db` `sessions` table)
Add two columns (both nullable, backward-compatible - old rows read as NULL = "unknown", not an error):
- `warm_context TEXT` - the subsystems/files/tags this session is deep in. JSON array of short tags (e.g. `["telemetry-broker","anonymizer.rs","egress-detection"]`). Kept small + curated, not a raw file dump.
- `liveness_state TEXT` + `liveness_ts TEXT` + `liveness_expires_at TEXT` - `healthy`|`egress_suspect`|`ingress_suspect`, the observation timestamp (freshest wins), and a TTL for `suspect` states so a recovered session doesn't stay stuck. NULL = healthy-by-default (pre-0.30.x rows).
- `hot_path_status TEXT` - self-declared intent: `driving` | `holding-for-<X>` | `idle-available` | `parked`. The load-bearing distinction is `idle-available` vs `holding-for-<X>` - both look like transcript-silence but only the former is repurposable, and only the SA knows which.
- `keep_clean INTEGER` (0/1) - self-declared **pollution flag**: "do NOT steer me, keeping context clean for delicate in-flight work." Operationalizes the anti-pollution counter-force (user_pattern `4b9b8d52`); an SA raises it mid-delicate-work so PA's repurposing query skips it.

Migration: additive `ALTER TABLE ... ADD COLUMN`. The schema module already versions the DB; add a migration step. No backfill needed.

### 2. Population - through-line (PA-ruled): AUTO-derive the OBSERVABLE, SELF-declare the INTENTIONAL
- **`warm_context` = HYBRID: auto-derived FLOOR + self-declared override [A].** Auto is the always-present, burden-free baseline: the agent-channel filewatcher already tails every transcript for routing - extend it to harvest touched file-paths/subsystems from `tool_use` events and aggregate (with decay) into `warm_context`. An SA MAY sharpen/correct via a self-declared tag (`update_session_task` gains optional `warm_context`), but self-declaration is NEVER primary - discipline-dependent fields fail under load, which is the exact failure this primitive fixes.
- **`liveness_state` = FRESHEST-OBSERVATION-wins + suspect-TTL + subject-turn-override [B].** ANY peer's detector (`detectSessionChanges` egress / `detectIngress` ingress) writes - NO single designated observer (that SPOF would kill the peer-redundancy that makes egress/ingress detection work). The registry keeps the FRESHEST-timestamped observation (`liveness_ts`), not bare last-writer. A `suspect` verdict carries a TTL (`liveness_expires_at`). STRONGEST signal = the subject's OWN fresh assistant-turn: a real turn clears `suspect` immediately (self-evidence beats peer-observation) - the 3-check heuristic productized into the write path.
- **`hot_path_status` = SELF-declared primary + inference fallback + mismatch-flag [C].** SAs self-declare (`driving`/`holding-for-<X>`/`idle-available`/`parked`) - only the SA knows idle-AVAILABLE vs holding-for-a-dependency. The warden INFERS as a fallback from transcript+checkpoint and FLAGS mismatches (self-say vs observed). Machine observes the observable; the SA declares intent.
- **`keep_clean` = self-declared only.** Pure intent; nothing to auto-derive.

### 3. Query API - new MCP tool `repurposing_candidates`
```
repurposing_candidates({
  warm_on?: string,       // subsystem/file/tag to match against warm_context
  adjacent_to?: string,   // alias/expansion of warm_on for "adjacent" semantics
  require_live?: boolean,  // default true - exclude egress/ingress_suspect + stale-heartbeat
  prefer_idle?: boolean,   // rank winding-down/idle SAs first (the steering window)
  limit?: number
}) -> ranked [{ id8, name, role, current_task, warm_context, liveness_state,
                heartbeat_age_s, overlap_score, idle_hint }]
```
- `overlap_score`: token/substring overlap between `warm_on` and each session's `warm_context` (simple, deterministic; upgrade to embedding-similarity later if the orchestrator's embeddings sidecar is available).
- `idle_hint`: the self-declared `hot_path_status` (primary), with the warden's inference + any mismatch-flag as fallback. `idle-available` is the repurposable state; `holding-for-<X>` is NOT (it looks silent but is reserved).
- Candidates with `keep_clean=1` are EXCLUDED by default (the SA has asked to stay unpolluted); an explicit override flag can include them, clearly marked, for the rare case PA judges the steer worth it.
- **Never auto-acts.** Returns candidates; PA decides + applies the steer-vs-pollute weighting (the tool surfaces data, the judgment stays PA's - mirrors the warden's advisory-only contract).

## Explicitly NOT in scope
- No auto-steering / auto-spawn. PA staffs; this only informs.
- No change to how work is assigned (still PA channel directives).
- The context-pollution weighting (keep-in-lane vs steer) is PA JUDGMENT, not encoded in the query - the tool can flag `current_task` + `idle_hint` so PA sees "this SA is mid-task" vs "idle", but the lane-purity call is PA's.

## Rollout
Batched (no board-wide reload; accumulates on main per PA + Jarid). Schema migration + tool ship in the same version. Backward-compatible so mixed-version fleets don't break (old sessions just have NULL warm_context = not-a-candidate, which is safe).

## Status / flow
Design APPROVED by PA 2026-07-13 with refinements folded in (A hybrid, B freshest-observation + TTL + subject-turn-override, C self-declared hot-path + mismatch-flag, plus the `keep_clean` pollution flag). Next: I implement schema migration + population (auto-derivation in the filewatcher + self-declare via `update_session_task` + detector writes) + the `repurposing_candidates` tool, TDD -> code-review -> ship batched (next bump) under the standing bump+push. The warden's human-readable coherence-map (context-warden.md, shipping in 0.30.68) is the narrative sibling of this machine-queryable half.
