# Orchestrator Decisions Log

Reverse-chronological. Each entry: date, change, rationale, what-was-rejected, where it shipped.

Pair with [DESIGN-PRINCIPLES.md](./DESIGN-PRINCIPLES.md) for the framework the R-series decisions are written against.

---

## 2026-06-11 - TURN-FINAL channel rule + SA launch hardening (0.30.55)

**Change.** (1) The MCP boot instructions (`mcp/server.ts`) now carry the **TURN-FINAL RULE**: on CC 2.1.172 the harness persists ONLY the turn-final assistant text to the session transcript the channel routes from - text emitted mid-turn (before a tool call in the same turn) never reaches disk and is therefore silently undeliverable. Every @-addressed message (envelopes included) must be the LAST text of its turn. (2) `skills/install-launchers/scripts/sa-start.ps1`: scrubs inherited `CLAUDECODE`/`CLAUDE_CODE_*`/`CLAUDE_EFFORT`/`AI_AGENT` env before launch (a claude spawned with them degrades to a nested child session: no transcript at all, no `~/.claude/sessions/<pid>.json`, unresumable, channel-invisible outbound); gains `-Seed` (positional first prompt - a virgin SA otherwise idles forever since channel injection needs an existing conversation) and `-BypassPermissions`; the PA permission relay env flips to DEFAULT OFF with `-PermissionRelay` to opt in (relay is inert on CC 2.1.17x - `permission_audit` shows working rows 2026-05-12 and zero since; CC stopped delivering `permission_request` notifications). (3) New regression suite `tests/integration/agent_channel_routing_regress.test.ts` locks the three live-incident message shapes (multi-paragraph mid-message address, prose-then-envelope, sender-transcript shrink-regrow) - all PASS, proving the routing engine was never at fault.

**Why.** Full fleet comms outage during the 2026-06-11 *.1 relaunch: SAs launched by PA ran turns yet wrote no transcripts (nested-env degradation), and even healthy SAs received no PA dispatches. Transcript forensics on the PA's own jsonl settled it: every failed delivery was mid-turn text with no corresponding text event on disk; every success was turn-final. The same mechanism retro-solves the unexplained 2026-05-23 muted-outbound-SA incident (KB `e21bc20f`). Full verified matrix: KB anti-pattern `77c5d231`; tracker WI `f0d66029`.

**Rejected.** Engine surgery on `filterParagraphsForReceiver`/`splitContentUnits`/`parseAddressing` - disproven by the repro suite (all suspect shapes deliver correctly when the event exists). The interim "relay capability kills channel injection" theory - RETRACTED: the A/B that suggested it was confounded (both probe messages were mid-turn); the PA itself declares the capability and injects fine; commit messages amended same-night to correct the claim (relay default-off ships anyway on inertness grounds). Plugin-side capture of mid-turn text - impossible by construction: it never reaches any surface the plugin can read (hook payloads carry `transcript_path`, not message content; mid-turn text is not in the transcript).

**Test additions.** 3 integration repros as above (the shrink-regrow case also locks truncation-reset recovery). Routing-adjacent suites green: 91 pass / 0 fail across integration + addressing + filter tests; full `bun run build` clean.

**Shipped:** v0.30.55 (commits `0938cf3` launcher hardening, `58e0c71` relay default-off, `2abd357` turn-final rule + suite + bump). Spawnbox project-root launcher mirrored (`91dbd9ff`, `b68ce656`). Operational protocol until all fleets run >=0.30.55: PA seeds SAs with the turn-final rule explicitly; rich dispatches go note-ID-indirect (content in an orchestrator note, one-paragraph turn-final `@SA-<id8> lookup <id8> and execute`).

> **Precision correction (2026-06-11, same session, post-ship):** the turn-final persistence limit is MODEL/SESSION-SCOPED, not universal to CC 2.1.172. Verified on a Fable 5 session (interleaved thinking): mid-turn text never persists. DISCONFIRMED on Opus 4.8: an SA emitted three texts within one turn and all persisted + routed. So Opus-model SAs are unconstrained (PA sees everything they write); the rule is load-bearing for Fable-like sessions and remains the documented universal practice because it costs nothing where unneeded. The 2026-05-23 muted-SA attribution is correspondingly softened back to plausible-not-proven (that SA was likely Opus). KB matrix `77c5d231` carries the corrected statement; the boot-instruction wording ships as-is and gets the scoping nuance at the next code version.

> **Log-completeness note:** versions **0.30.52 through 0.30.54** (shipped earlier 2026-06-10 by a prior session: permission-relay PA-lookup fix via agent_channel.db; PA proactive-mandate contract; anti-gating contract) are not yet logged here - first-hand entries belong to their authoring sessions' commits (`187fc17`, `543911a`, `d62cbe9`). Not silently absorbed; backfill remains open.

---

## 2026-05-19 - Cross-agent messaging default flipped to the explicit envelope (0.30.51)

**Change.** The EXPLICIT ENVELOPE (`@@@ @SA-<id8>` ... bare `@@@`; WI `eabc89b6`, shipped 0.30.46/0.30.47) is now the DOCUMENTED DEFAULT for any multi-paragraph/markdown cross-agent message, flipped across all three steering surfaces: `mcp/server.ts` MCP instructions, `agents/prime-agent.md`, and orchestrator-KB canonical convention `872e0f2d`. The prior "trap-safe single-paragraph is the safe default until the fleet is uniformly >=0.30.46" posture is RETIRED; "unsure -> use the envelope" (the old "unsure -> trap-safe" is inverted). The version concern is demoted to a narrow "only if you positively know a specific receiver is pre-0.30.46" edge-case backstop. WI `81903c51` re-scoped: its item-2 (standing-instruction bake-in) is fulfilled by this flip; item-1 (sender-side loud truncation warning) demoted to optional.

**Why.** The envelope existed and worked since 0.30.46 but was gated behind a conservative mixed-version-rollout hedge. Both un-gate conditions are now met + verified: (a) the live fleet is uniformly >=0.30.46 - per-session MCPs each boot from the installed version, enumerated all 0.30.49 (topology note `70d2f7a0`); (b) the markdown-aware `isColonHeader` fix (0.30.45, WI `7ff34714`) is shipped AND bilaterally live-confirmed (PROBE-1). First-hand evidence that the steering, not any code, was the sole constraint: a PA operated trap-safe an entire session and never used the envelope purely because the doc said so, though the envelope was provably safe fleet-wide the whole time.

**Rejected.** Deleting the version caveat entirely - a future breaking envelope change or a very-long-lived pre-0.30.46 session reintroduces mixed-version risk, so the edge-case backstop (item-1) is retained, just demoted. Building item-1's sender-side warning now - deferred (low value once the envelope is the default; it only guards hand-rolled non-envelope multi-part messages), left as an optional Jarid-gated item.

**Test additions.** None - the flip is doc/instruction/convention text only (`server.ts` instructions string, `prime-agent.md`, KB note); no test asserts on the wording (verified by grep). Full suite 590 pass / 0 fail unchanged.

**Shipped:** v0.30.51 (commit `c1f0758`). Re-scopes WI `81903c51`. Supersedes the re-instated trap-safe mandate in KB convention `872e0f2d` (recorded via the dated-trail update fallback - `supersede_note` fails on that heavily-linked note; that tooling defect is tracked as WI `0d060c1f`).

---

## 2026-05-19 - Skill/doc reconciliation with post-0.30.35 SQLite reality + tmp-debris sweep (0.30.50)

**Change.** (1) `skills/pa-bootstrap/SKILL.md` (steps 2/3/4/6 + frontmatter + hard-rules + idempotency) and `skills/getting-started/SKILL.md` step-3 rewritten: the primary signal for role/roster/pause is now the always-present version-independent evidence (env `ORCHESTRATOR_AGENT_ROLE` + the injected `[orch] sibling sessions` block + live `<channel>` events), with `sqlite3 agent_channel.db` as the authoritative *optional* confirm; the retired flat `sessions.json`/`state.json` `cat` reads are removed. Step-4's abort clause re-keyed off ABSENCE of live channel evidence (never flat-file absence). (2) `pa-bootstrap` steps 5.5/5.6 add `output_mode:"summary"` to the type-only enumeration lookups. (3) `mcp/engine/agent_channel_state.ts` gained a one-time-per-process, age-gated (>5min), best-effort sweep of pre-0.30.35 `*.tmp.*` atomicWrite debris.

**Why.** The 0.30.35 SQLite migration retired the flat state files, but the skill/doc layer still instructed `cat sessions.json`/`state.json` - a literal-following fresh PA hits dead reads, and step-4's abort clause would make it wrongly ABORT a healthy session (the exact hazard a fresh PA hit at bootstrap this session; insight `86cc8894`). The type-only enumeration lookups returned 80-124K-char payloads exceeding the tool-output cap. The `*.tmp.*` debris (~30 files) was pre-0.30.35 atomicWrite residue the SQLite path never produces but nothing reclaimed.

**Rejected.** Swapping the flat-file read for a *mandatory* `sqlite3` read - that just trades one fragile dependency for another (exact DB schema); primary signal is the always-injected harness evidence, DB query is the optional backstop. A "GC guard in the atomic-write path" (original WI framing) - corrected after reading the producer: there is NO atomic-write path post-0.30.35, so the fix is a one-time debris sweep, not an ongoing guard.

**Test additions.** 3 new lock tests in `tests/engine/agent_channel_state.test.ts` (sweep deletes stale `*.tmp.*` >5min, preserves fresh tmp + the SQLite DB files, once-per-process guard). Full suite 590 pass / 0 fail. Schema producer-verified against `agent_channel_state.ts` CREATE TABLE DDL.

**Shipped:** v0.30.50 (commit `bd877e5`). Source: orchestrator-KB insight `86cc8894` (PA-relayed). Closes WI `603dc765` at the shipped level (live-confirm pending a fresh PA bootstrapping on >=0.30.50).

> **Log-completeness note:** DECISIONS.md has a backlog gap - versions **0.30.40 through 0.30.49** (prior sessions) are not yet logged here. This entry and the 0.30.51 entry cover only this session's first-hand ships; the 0.30.40-0.30.49 backfill is tracked separately (WI noted in the orchestrator KB), NOT silently absorbed.

---

## 2026-05-17 - Routing/gate/budget hardening + post-compaction handoff + PA-delegable convention (0.30.39)

**Change.** Seven-workstream release (one commit):

1. **Agent-channel paragraph-routing trap.** `filterParagraphsForReceiver` rewritten as a **colon-gated sticky cascade** + a fenced-code-block-aware tokenizer (`splitContentUnits`, CommonMark closer-length rule). A colon-headed addressed paragraph cascades its continuation paragraphs/code-blocks to the same SA until another address redefines routing; a non-colon addressed paragraph opens NO cascade. `@SA-<id8>` inside a fenced block is literal.
2. **Type-aware dup-gate.** Flat 0.75 → per-type (`anti_pattern` 0.85; `decision`/`convention` 0.75; genuine dupes ≥0.90 still block all). Sub-threshold near-matches surface a NON-blocking consolidation advisory on the normal AND `accept_new` paths.
3. **Briefing token budget.** `briefing()` (mandatory first call) overflowed the model tool-output limit and returned an ERROR. Now bounded by construction: hard per-section caps + provably-total `capWithMarker` + a defense-in-depth tail clamp, every truncation honestly signposted.
4. **Decision-surfacing UI-tool visibility.** `agent_channel_filter` now forwards a bounded summary of `AskUserQuestion`/`ExitPlanMode` (non-mutating `tool_use`, previously dropped) so channel observers (PA) see an SA's question/plan.
5. **Tag normalization.** `parseTagList`/`normalizeTagString` heal JSON-array-stringified tags at every read+write chokepoint (briefing Neglected/drift no longer char-splits).
6. **PA-delegable-question convention (pure, no code).** SA-side (`orchestrating` skill): a decision classified PA-delegable per orchestrator-KB note `c90610f1` is addressed to a *live* PA on the channel; no live PA / ambiguous / Jarid-only → native `AskUserQuestion`. PA-side (`prime-agent.md`): may answer as artificial-user only on an independently VERIFIED premise.
7. **Post-compaction handoff + peer-backstop.** A second `SessionStart` `matcher:"compact"` hook → `_hook_event` (`handleSessionStartCompact`) injects a bounded re-orientation digest (latest checkpoint + current_task) as a top-level `systemMessage`, and — when a live PA exists — instructs the just-compacted SA to post one non-blocking `@PA` peer-backstop solicitation. The universal `SessionStart` stays the bash hook.

**Why.** 1, 4, 5 were live-reproduced cross-session content-loss/observability defects (the routing trap constrained every PA↔SA message; PA was blind to an SA's `AskUserQuestion`, causing a misattributed-silence incident). 3 broke cold-start for the heaviest briefing consumer (reproduced independently by an SA and PA same-day). 2 was a compounding daily friction (over-blocking the granular-by-design `anti_pattern` type). 6 leverages PA-as-artificial-user for delegable decisions while reserving the user's attention. 7 leverages that peers generally don't compact simultaneously, so a non-compacted peer can backstop what a lossy compaction summary dropped — without re-inventing compaction.

**Rejected.**
- Pure "address sticks until next address" cascade (note `25566c45`'s recommendation) — provably breaks the locked `b4c37849` mixed-audience regression test; the colon-gate is the discriminator that fixes the trap while preserving no-leak.
- Generic-tool-result interception for #6 — authoritatively verified impossible: Claude Code exposes no surface to inject a built-in tool's result (PreToolUse is input-only; CC `PostToolUse` has no `updatedToolOutput`; `canUseTool` is allow/deny). So #6 is necessarily a plugin convention, not interception.
- Structural verify-then-answer gate (#6 spectrum #2/#3) — deferred per the KISS/reuse call; #1 leaves verify-then-answer behavioral with the residual recorded (revisit-trigger: any observed propagated-premise PA answer).
- `SessionStart` as an HSO event — refuted by the plugin's own `hook_envelope.test.ts` `ALLOWED_HSO_EVENT_NAMES` (a recorded-design self-correction); delivers via top-level `systemMessage` like `PreCompact`.
- Re-inventing compaction in #7 — explicitly out; the digest is a targeted gap-check, not a re-sync.

**Test additions.** TDD throughout. New: `tests/integration/agent_channel_routing.test.ts` (colon-cascade/code-block/b4c37849-lock), `tests/engine/tag-normalization.test.ts`, `tests/engine/agent_channel_filter.test.ts` (UI-tool forwarding), `tests/tools/orient.test.ts` (briefing-budget ACs + c658ce38), `tests/tools/remember.test.ts` (type-aware threshold + advisory), `tests/tools/hook_event.test.ts` (pure `composePostCompactReorientation` livePA branches + hermetic handler + the SessionStart-not-HSO envelope guard). Three independent code-review findings verified+fixed+locked. Full suite 556 pass / 0 fail, typecheck clean. Research (compaction-hook surface + generic-relay feasibility) independently WebFetch-verified; two subagent overclaims caught and corrected.

**Shipped:** v0.30.39 (commit `5bc8049`). Closes work_items `7ff34714`, `fc7fcb0d`, `05f072d3`, `167ffbaf`, `e4774e4b`, `7d689ed7`; `ecbea9ac`/`45be9ba6` closed obsolete; `dd5d81d8`/`c658ce38` resolved in-place.

---

## 2026-05-11 - Per-PID active-session resolution closes impostor-MCP race (0.30.19)

**Change.** The session-start hook now writes the current session_id to BOTH `active-session-<ppid>` (per-claude-PID) AND `active-session` (legacy single-file fallback). The MCP's `getFallbackSessionId()` walks the process tree (WMIC on Windows, `/proc/<pid>/stat` on Linux) to find the claude.exe ancestor PID, then reads `active-session-<that_pid>` preferentially. Falls back to the legacy single-file with an explicit stderr warning when per-PID is missing.

**Why.** Pre-0.30.19, concurrent Claude Code sessions in the same project all wrote to one shared `active-session` file. Last writer won. If session B's hook ran milliseconds after session A's hook, A's MCP read B's session_id and registered the WRONG session_id in `sessions.json`. Subsequent 30s heartbeats kept overwriting the wrong entry - "impostor MCP". A PA expecting role=prime might find itself appearing as role=subordinate. The race was diagnosed in note `120b8e59-fbef-4847-8c04-6bc7aa3ad378` (orchestrator KB) and tracked as work_item `ea1bec63`.

Per-PID files are race-free because each claude process writes its own file. The legacy single-file remains so old hooks (pre-0.30.19) still work, with a visible warning so operators correlate impostor symptoms with stale hook installs.

**Rejected.**
- Env var (`CLAUDE_SESSION_ID`) - Claude Code doesn't reliably set it on MCP spawn. Defense-in-depth only.
- Lockfile-based serialization on the shared file - adds complexity for a problem that goes away with per-PID. Locks also fail badly under crash.
- Renaming the file scheme without back-compat - users with mid-version hooks would lose fallback resolution entirely. Dual-write covers the migration window.
- Walking only the immediate parent (process.ppid). The MCP child's parent is bun, not claude. Need to walk up to 8 ancestors looking for claude.exe / claude.

**Test additions.** Existing session_tracker tests + a new manual VM repro (concurrent claude windows) confirm per-PID isolation. The cached resolution prevents repeated WMIC calls on every tool invocation.

**Shipped:** v0.30.19. Closes work_item `ea1bec63`.

---

## 2026-05-11 - Defer_to_human -> no-emit (permission relay Phase 2b review fix, 0.30.18)

**Change.** When PA emits a `defer_to_human` verdict, the SA's notification handler now returns WITHOUT emitting `notifications/claude/channel/permission` to CC. Pre-fix (v0.30.17), `defer_to_human` was silently mapped to `behavior: "deny"` on emit.

**Why.** Code-review caught it: CC's tool-permission protocol uses response ABSENCE as the signal to fall back to the terminal prompt. Emitting `behavior: "deny"` would have foreclosed that fallback and trapped the SA at the permission gate with no escape path. `defer_to_human` is supposed to mean "PA opts out; let the human decide" - it must produce silence, not a deny verdict, for the fallback to fire.

Also in this ship: `setNotificationHandler` with the `as any` cast does NOT runtime-validate params (the SDK uses the schema only for method dispatch). The handler now does explicit `z.safeParse` at entry and logs + drops malformed inbound shapes, instead of propagating `undefined` fields downstream into the relay and bus.

**Rejected.**
- Adding a `behavior: "defer_to_human"` value to CC's protocol - not under our control; CC's permission protocol shape is fixed.
- Logging defer_to_human as a soft warning but still emitting deny - same trap, with a misleading log.

**Shipped:** v0.30.18.

---

## 2026-05-11 - Permission relay design: file-bus over direct MCP-to-MCP, env-var opt-in, audit table (0.30.15 - 0.30.17)

**Change.** PA-gated tool-permission routing. When `ORCHESTRATOR_PA_PERMISSION_RELAY=1` is set in the SA's environment, Claude Code's `notifications/claude/channel/permission_request` notifications go to PA instead of stopping at the SA's terminal. PA reads the request inline, calls `respond_to_permission({request_id, verdict, reason?})`, and the SA's pending Promise resolves with the verdict. The SA's notification handler emits the verdict back to CC for `allow` / `deny`, or returns silently for `defer_to_human` (so CC falls back to terminal).

Three new modules implement this in three phases:

- **Phase 1 (0.30.15):** `mcp/engine/permission_relay.ts` (PermissionRelay class with `registerPending` / `resolveVerdict` / `cleanup` / `listSourceFor`), `mcp/tools/permission.ts` (the `respond_to_permission` MCP tool with non-allow-requires-reason contract), migration 21 (`permission_audit` table).
- **Phase 2a (0.30.16):** `mcp/engine/system_events.ts` (append-only JSONL bus at `<project>/.orchestrator-state/agent-channel/system_events.jsonl`). AgentChannel extended with `processSystemEvents()` that drains the bus on every tick alongside JSONL transcripts.
- **Phase 2b (0.30.17):** server.ts wiring. Conditional `claude/channel/permission` capability declaration gated by the env var. SA-side notification handler. PA-side tool registration. Routing both directions through the bus.

**Why file-bus instead of direct MCP-to-MCP.** The agent_channel filewatcher reads JSONL transcripts (events authored by sessions). Permission routing needs to emit events authored by MCPs themselves (the SA's MCP wrote no JSONL line when CC sent it a permission_request notification, and the verdict event has to traverse from PA's MCP process to the SA's MCP process). A direct MCP-to-MCP notification doesn't exist - each MCP runs as a separate stdio child of Claude Code; they don't connect to each other. The append-only file bus is the simplest cross-process mechanism that survives crashes (file persists), supports offset tracking (each MCP advances its own offset), tolerates malformed lines (one bad entry doesn't break the bus), and rides on the same filewatcher tick that already exists.

**Why audit table over write-only audit log.** Permission decisions are durable: someone may want to review what PA approved last week. SQLite gives us indexed queries on `source_session`, `tool_name`, `verdict`, `requested_at`. Migration 21 adds `permission_audit` to the project DB - project-scoped (each project's permission decisions stay with that project).

**Why env-var opt-in (default off).** Permission routing changes the trust boundary for tool execution. Defaulting to PA-gating without explicit opt-in would surprise users who installed the orchestrator plugin for memory/coordination but not for tool gatekeeping. Env-var lets the user decide per-session whether to route through PA. Tested with `ORCHESTRATOR_PA_PERMISSION_RELAY=1` in spawnbox; default-off for everyone else.

**Why non-allow verdicts require a reason.** Audit log needs to stay comprehensible weeks later. "PA denied tool X for SA Y at time Z" with no reason is a debugging dead end. Allow verdicts can be implicit (low-risk read, aligned with patterns) but deny and defer must say WHY. The respond_to_permission handler refuses without a reason on non-allow verdicts.

**Why first-verdict-wins guard.** A double-resolve race exists between PA's verdict arriving and the 30s timeout firing. Without the `resolved: boolean` flag, both paths could fire `entry.resolve()` and `entry.timer` could trigger after the verdict landed. The guard is one field and one early-return in `resolveVerdict`.

**Why timeout to defer_to_human (not deny).** PA might be unresponsive (crashed, paused, slow). Defaulting to deny would trap the SA. Default to defer_to_human so CC falls back to terminal - the user keeps agency.

**Code-review fixes during ship.**
- **cleanup() Promise leak (0.30.17 fix).** Without `cleanup()`, pending Promises from `await registerPending(...)` would never settle on MCP shutdown. The Node event loop would stay alive, preventing clean exit. Fixed by `cleanup()` iterating pending entries, clearing timers, and resolving all unresolved Promises with `{verdict: "defer_to_human", pa_session: "<shutdown>"}`.
- **Duplicate request_id orphan (0.30.17 fix).** If CC retries on transient failure with the same request_id, `map.set()` would overwrite the existing PendingEntry. The original Promise's `resolve` closure becomes orphaned - first caller's await would hang forever. Fixed by detecting collision in `registerPending`, returning a new Promise that mirrors the existing entry's resolve so both callers settle together.
- **Phase 2b silent-deny on defer (0.30.18 fix).** See separate entry above.
- **Phase 2b unvalidated notification params (0.30.18 fix).** See separate entry above.

**Rejected.**
- TCP / Unix socket bus between MCPs - more infrastructure for cross-platform compatibility; file bus is enough and works identically on Windows, Linux, macOS.
- D-Bus / IPC mechanism - heavyweight; the throughput is one event per permission decision (very low).
- PA polling a SQLite table for pending requests - polling latency vs. push-on-bus. The filewatcher already polls on a 1.5s tick; piggybacking is free.
- PA writing verdicts directly to a shared DB column on the request row - same throughput shape but requires the SA's relay to poll the DB. Bus is event-shaped; polling is wrong for event delivery.
- Per-request file (write a `request-<id>.json`, delete on resolve) - filesystem churn, dir-listing races, more state to GC. JSONL append is simpler.
- Per-tool risk classification in the orchestrator - that's PA's judgment. Plugin provides the channel; PA decides per-request.

**Shipped:** v0.30.15 (Phase 1), v0.30.16 (Phase 2a), v0.30.17 (Phase 2b), v0.30.18 (review fixes).

---

## 2026-05-11 - PA's second mission: ultra-macro forest view + multi-repo awareness (0.30.13, 0.30.14)

**Change.** Expanded `agents/prime-agent.md` to formalize PA's second defining duty: hold the whole-project macro model so SAs don't make tree-level decisions that break the forest. "Forest" was expanded from "code architecture" (the initial framing in 0.30.13) to ultra-macro in 0.30.14: code architecture + product strategy + business model + market context + people + operations + project memory. Also expanded to multi-repo: "the project" is often delivered by several coordinating repos (app + landing-page + worker + plugins + docs), and PA's macro model spans the union, not just the cwd repo. Step 5.6 (load forest-view context) and Step 5.7 (discover multi-repo scope) added to `/pa-bootstrap`.

**Why.** Live observation: SAs tunnel-vision into the individual file/function/test they're working on. They make decisions that look locally correct but conflict with the macro. Sometimes the code-architecture macro, but just as often:
- The BUSINESS macro - SA recommends a feature that contradicts the product's positioning ("non-technical teens / parents / educators" target audience), or refactors a flow that destabilizes a paying-tier path.
- The OPERATIONS macro - SA proposes a flow that breaks the deployment pipeline, or contradicts an on-call posture, or violates a data-retention contract.
- The PEOPLE macro - SA drafts outreach to a community user whose engagement note documents a different in-flight thread, contradicting an active conversation PA opened two days ago.
- The COMMITMENT macro - SA touches code that intersects a commitment (hibernation-restore SLA, deadline, stakeholder expectation) without knowing the commitment exists.

This is a recurring failure mode. PA exists in part to prevent it. The single-repo framing of 0.30.13 understated the scope; the ultra-macro + multi-repo expansion of 0.30.14 captured what was already true in practice (SpawnBox spans app + landing-page + worker + plugins + docs repos, all coordinating around a single business).

**Mechanism.** PA loads `architecture` / `decision` / `convention` / `anti_pattern` / (eventually) `risk` / `commitment` / `insight` notes into working context at bootstrap. When an SA proposes work, PA's reflex check is:
- Does this conflict with a decision I know about?
- Does this duplicate a convention I know about?
- Does this walk into an anti-pattern I know about?
- Does this overlap with another SA's in-flight task?
- Does this touch a commitment, risk, or open engagement thread?
- Does this have cross-repo blast radius (landing-page download links, worker API contracts, plugin source compat)?

If yes to any: surface the macro context to the SA via channel addressing BEFORE they proceed.

**Limitation.** The orchestrator MCP today reads `project.db` from the running session's cwd only - it does NOT auto-union across multiple project DBs from related repos. The user must explicitly describe the multi-repo map in CLAUDE.md or `architecture` notes, and PA holds the map in working context and applies it proactively. A future feature could auto-discover or be configured with related repo paths.

**Rejected.**
- Treating forest-view as optional / deferred capture - SAs were already breaking the forest in field testing. Capturing the duty in `prime-agent.md` + `/pa-bootstrap` makes it operational immediately.
- Constraining forest-view to "code architecture" (the 0.30.13 initial scope) - business / operations / people errors were just as common in field testing. The 0.30.14 expansion captures observed reality.
- Auto-union project DBs across repos - more infrastructure for a problem solvable today by PA holding the multi-repo map in working context. The MCP today reads one cwd-bound DB; cross-repo awareness lives in PA's loaded knowledge until the auto-union work happens.

**Shipped:** v0.30.13 (forest-view, code-architecture framing), v0.30.14 (ultra-macro + multi-repo).

---

## 2026-05-11 - PA-as-artificial-user identity (0.30.12)

**Change.** Added "Your fundamental identity: artificial user" section to `agents/prime-agent.md`, and Step 5.5 (load user-pattern context) to `/pa-bootstrap`. PA's defining duty - above coordination, above tool-redirection, above self-improvement - is to be an artificial version of the user this orchestrator instance serves. `user_pattern` notes in the global DB (`~/.claude/orchestrator/global.db`) persist across every project and encode the user's preferences, work habits, communication style, decision biases, values, and explicit dislikes. PA loads them at bootstrap and reloads them whenever it's about to act on the user's behalf in a non-trivial moment.

**Why.** Pre-0.30.12 framing: PA was "the orchestrator's persistent thinking partner". That described WHAT PA does but not WHY PA can act with authority. The artificial-user framing makes the authority explicit: when an SA hits a decision point that maps onto a captured user_pattern, PA speaks with the user's authority - "don't use em-dashes" is a settled preference, PA can directly correct an SA without checking. Without this framing, PA hedges on judgment calls that should be settled.

The user_pattern knowledge compounds. The orchestrator's long-term value to a user is largely the user-pattern knowledge it accumulates over time. PA needs to be the active loader + curator of that knowledge so it shapes every interaction. The briefing's `cross_project` section surfaces some patterns, but an explicit lookup at bootstrap guarantees PA is loaded.

**Mechanism.** `lookup({type: "user_pattern", limit: 25})` at bootstrap, plus reload at judgment points (addressing an SA on a judgment call, approving a destructive action, proposing a design, framing a question). When the user corrects PA, expresses a preference, calls out an assumption, or shows a value through reaction, capture as `note({type: "user_pattern", ...})`.

**Rejected.**
- Framing PA as "the orchestrator's persistent thinking partner" without the artificial-user duty - leaves PA's authority ambiguous. The whole point of routing SA decisions through PA is that PA can speak for the user; that needs to be explicit in PA's contract.
- Capturing user-pattern knowledge only when prompted, not proactively - the value of pattern accumulation compounds with capture rate. Proactive capture is the load-bearing default.
- Loading only project-scoped patterns at bootstrap - user_pattern is a GLOBAL_TYPE (always written to the global DB) for exactly this reason: patterns persist across every project the user works in. Loading from project DB would miss most of the corpus.

**Discovery (lookup tool gotcha).** While writing the bootstrap steps, `lookup({type: "user_pattern", limit: 25})` was discovered to return "Provide either a query or an id to recall notes." in version 0.30.19 - the lookup tool did not support type-only enumeration. The bootstrap skill ships with the broken pattern. Fix queued for 0.30.20: extend `handleRecall` to treat `{type, limit}` (no query, no id) as a recent-N enumeration mode. See `agent-getting-started.md` for the workaround pattern in the meantime.

**Shipped:** v0.30.12.

---

## 2026-05-11 - Addressing parser requires addressing context (0.30.11)

**Change.** `ADDRESS_RE` in `mcp/engine/addressing.ts` tightened. An `@PA` / `@SA-<id8>` / `@all` token only counts as addressing when it sits in an addressing context:
- start of content or line (optionally after a list bullet `-` / `*`)
- after a comma (recipient chain: `@A, @B sync up`)
- after `and` / `&` with whitespace (recipient chain: `@A and @B sync up`)

Mentions in the middle of prose ("my warm tick addresses @SA-95e6890e every 50min", `"@PA warm" reply`) no longer trip routing.

**Why.** Field bug (work_item `b4c37849`): PA's private dialogue with the user contained descriptive references to addressing semantics ("the warm tick addresses @SA-X every 50min"). The pre-0.30.11 regex matched `@SA-X` anywhere in content. Result: PA's musing about its own architecture leaked into SA-X's context via the channel router, because the regex treated the descriptive mention as an actual address.

Addressing is intentional in human communication: it appears at the start of a directive ("@SA-X do Y"), at the start of a recipient chain ("@A, @B sync up"), or as the head of a list item. Mid-prose mentions are descriptive, not addressing. The regex now reflects that.

**Rejected.**
- Stopword-filtering verbs preceding `@` ("addresses @X" -> ignore) - brittle; verbs change ("mentions @X", "refers to @X", "talks to @X" all describe rather than address). Anchoring to the syntactic context is more robust.
- Requiring trailing punctuation after `@<tag>` - too restrictive; `@SA-X do this thing.` would have lost the address (the period attaches to "thing", not to `@SA-X`).
- Treating ANY `@SA-<id8>` reference as addressing, with a "did you mean to address?" hint in the channel notification - that's user-hostile UX for the common case (false trip from prose) and noisier than the fix.

**Test additions.** `tests/engine/addressing.test.ts` updated with prose-mention cases that should NOT trip and addressing-context cases that should. Covers list bullets, comma chains, "and" / "&" chains, mid-sentence mentions, quoted strings.

**Shipped:** v0.30.11.

---

## 2026-05-11 - Shutdown observability + 5-min liveness heartbeat (0.30.10)

**Change.** MCP server in `mcp/server.ts` now logs WHY it's shutting down (`stdin-end` / `stdin-close` / `SIGTERM` / `SIGINT` / `SIGHUP` / `uncaughtException`) with pid, uptime, session_id, and timestamp to stderr. Also emits an "alive" heartbeat to stderr every 5 minutes with the same fields.

**Why.** Field bug (2026-05-11): an idle SA's MCP child silently died (sessions.json showed `session_departed`) while claude.exe stayed alive. The user had to manually `/plugin reconnect`. We have no Claude Code MCP supervision logs accessible - the only handle is the MCP server's own stderr. Pre-0.30.10 there was no exit trace, so the failure was invisible. The new logging:
- Captures the exact trigger (stdin close vs signal vs exception) so we can correlate with Claude Code's behavior.
- Captures pid + uptime + timestamp + session_id so multi-session crashes are disambiguable.
- Emits "alive" every 5 minutes so when an MCP goes silent, the last "alive" line bounds the failure window upper.

`unhandledRejection` is logged but does NOT shutdown - rejections aren't always load-bearing, and killing the MCP on every transient rejection would cause user-visible churn. Load-bearing rejections will surface in the next operation.

**Rejected.**
- Sending shutdown traces to an orchestrator log file - the stderr stream is captured by Claude Code into its plugin log surface, which is what operators check. Writing to a separate file would split the trail.
- More frequent heartbeat (30s, 1min) - cheap but accumulates noise in the plugin log without proportional debug value. 5min is a good bracket for "MCP went silent" without flooding.
- Letting `uncaughtException` propagate (default behavior - process exits) - we want the exit logged before the process dies, hence the explicit shutdown call.

**Shipped:** v0.30.10.

---

## 2026-05-11 - Ghost-session filter via sessions.json heartbeat intersection (0.30.8, 0.30.9)

**Change.** Added `mcp/engine/live_sessions.ts` with `getLiveSessionIds()` and `getLiveOtherSessionIds()`. Both read `<project>/.orchestrator-state/agent-channel/sessions.json` and return the set of `session_id`s whose `last_heartbeat_at` is within 90s. Returns `null` when sessions.json doesn't exist (project not using agent-channel; caller falls back to 24h DB-only behavior).

AgentChannel's sibling list and the briefing's `cross_session` SQL both intersect against this set:
- `null` -> 24h DB-only behavior (preserves single-agent users + projects without agent-channel).
- `[]` -> short-circuit to zero matches (live filter is authoritative AND empty).
- Otherwise -> `WHERE n.source_session IN (?, ?, ...)` with one placeholder per live id.

`session_log` (the historical "I surfaced this note" record) is NOT intersected. A session that surfaced a note an hour ago is still a real "I saw this" signal even if the session has since died. The ghost-session problem is specifically about who counts as a CURRENT sibling source, not who has touched a note historically.

**Why.** "Active siblings" was deriving solely from the DB's 24h window over `session_log` / `session_registry`. Sessions that exited cleanly removed their own entries; sessions that died (Ctrl+C, force-close, crash) kept showing up as active for up to 24 hours until the cleanup pass reaped them. PA / SA briefings listed ghost siblings whose MCP had been dead for hours, and `cross_session` attributed notes to long-departed sessions.

The 30s heartbeat in `sessions.json` was already there (the agent-channel heartbeat tick keeps it fresh). The fix was wiring it into the sibling discovery path: a sibling only counts as live if it shows up in BOTH the 24h DB window AND the 90s heartbeat-fresh set. 0.30.8 wired it into AgentChannel; 0.30.9 extended it to briefing's `cross_session`.

**Rejected.**
- Replacing the DB window entirely with the heartbeat set - loses single-agent users and projects not using agent-channel. The null-fallback preserves them.
- Shorter heartbeat threshold (30s, 60s) - generous threshold accommodates slow Windows IO. 90s = 3 missed heartbeats at 30s cadence; if all three drop, the MCP is genuinely gone.
- Reaping the DB row on heartbeat-stale - destroys the historical record (`session_log` should still show "this session surfaced these notes"). The fix is filtering at query time, not deleting state.
- Synchronous heartbeat write on every tool call - more writes, more lock contention. The 30s tick is sufficient.

**Shipped:** v0.30.8 (AgentChannel sibling list), v0.30.9 (briefing cross_session).

---

## 2026-04-30 - R7.9 Roll back scope-as-filter; messaging is single-path

> **Superseded by R8 (0.29.0, 2026-05-09).** The entire messaging system - `send_message`, `read_messages`, `peek_inbox`, the `session_messages` table, `MessageScope`, `drainInbox`, `DrainContext`, all of it - was deleted. This entry is preserved as historical record of the contract that existed pre-R8; do not treat any of its claims as currently active.

**Change.** Scope filtering on `drainInbox` (introduced R7.5, patched R7.8 with a `bypassScope` flag) is removed entirely. `MessageScope.code_ref` and `MessageScope.task_contains` survive as display labels rendered inline (`{scoped to src/foo.ts}`) so the recipient understands the sender's intent, but they DO NOT gate delivery. Every queued message delivers on the recipient's next drain - whether that's the auto-drain at a hook boundary or an explicit `read_messages` call.

`DrainContext.bypassScope`, `currentFilePath`, `currentTask`, and the `matchesScope` helper are gone. `DrainContext` is kept as a placeholder for forward-compat. Hook callsites in `hook_event.ts` (`handleUserPromptSubmit`, `handlePostToolUse`) no longer build a context object before calling `drainInbox`. `handleReadMessages` no longer passes a `bypassScope` flag.

**Why.** Field signal was unambiguous. R7.5 silently dropped scoped messages whose recipients never matched the scope (`be30d33d`, `61deff24`). R7.8 patched explicit-read to bypass, but auto-drain still silently held them. After I described the resulting two-path system, Jarid pushed back: *"is there a reason we have two vectors? does that seem like a good system?"* That was the moment to step back.

A messaging system where the sender can't know whether their message will be delivered (because it depends on recipient context the sender can't observe) has lied to the sender. The "Message sent" receipt becomes meaningless. Scope-as-filter sounded clever but the use case (opportunistic context-aware delivery) was theoretical and not field-validated; the field bugs all came from the silent-drop side. Cross-session coordination messages are low-volume and almost always "I want this person to see this now" - the value of conditional delivery is near zero.

**Single-path contract (now).**
1. Drain (any path) returns every queued message for the recipient and marks them all read.
2. Scope is metadata. Renders inline. Doesn't filter.
3. Sender gets a real "delivered on next drain" guarantee.
4. Noise control belongs to `priority` and `ttl_seconds`, both sender-observable.

**Rejected.**
- Keeping R7.8's bypass flag and just documenting the two paths better - the documentation can't paper over the underlying contract failure. If the sender can't predict delivery, no amount of doc warning fixes it.
- Always-deliver-eventually with a TTL "give up after X minutes" - more state to track and a worse user model. Better to deliver immediately and let TTL handle obsolescence.
- Promoting scope to a sender-side priority signal (e.g. "low priority unless context matches") - same problem in a hat.
- Removing `MessageScope` entirely from the type - unnecessary; the metadata is harmless and useful. Keeping it as a label preserves senders' ability to communicate context without forcing recipients into conditional delivery.

**Doc updates.**
- `CLAUDE.md` Cross-Session Coordination section rewritten: single-path contract, scope as label, noise via priority/ttl.
- `ARCHITECTURE.md` `session_messages` table description and `send_message`/`read_messages` tool rows rewritten.
- DECISIONS.md R7.5 and R7.8 entries kept as historical record (don't rewrite history; this entry replaces them functionally).

**Test changes.** Removed: 7 tests for R7.5 scope filtering (deferred-not-delivered, code_ref match, task_contains match, any-match, deferred unread, etc.) + 4 R7.8 bypass tests. Replaced with: 3 R7.9 tests (scoped messages always deliver, idempotent re-drain, malformed JSON delivers as unscoped). Integration test rewritten: PostToolUse on unrelated file STILL delivers + explicit read works without auto-drain. Total: 441 tests / 0 fail (was 449 with the deleted scope-filter tests).

**Stale notes (will close after ship).** This work resolves work_item `be30d33d` (already closed in R7.8, still correct). Convention note `1f5a...` (the two-path delivery contract) becomes stale immediately - need to update to "single-path delivery contract" pointing at this entry.

**Shipped:** v0.28.4.

---

## 2026-04-30 - R7.8 Explicit read_messages bypasses scope filter

> **Superseded by R8 (0.29.0, 2026-05-09).** `read_messages`, `drainInbox`, the `bypassScope` flag, and the entire scope-filter mechanism were deleted along with the rest of the messaging system. Historical record only.

**Change.** `handleReadMessages` (`mcp/tools/messaging.ts`) now calls `engineDrain` with `{ bypassScope: true }`. New flag added to `DrainContext` in `mcp/engine/messaging.ts`; when set, messages with non-matching scopes are still delivered. Default `bypassScope: false` preserves R7.5 auto-drain semantics on the PostToolUse / UserPromptSubmit path.

**Why.** Field bug from work_item `be30d33d` (sessions 38efb838 -> 46673070, 2026-04-30): sender called `send_message` with `scope_code_ref` set; recipient never edited that path. R7.5's auto-drain correctly deferred them. But when the recipient called `read_messages` directly to manually inspect its inbox, that tool ALSO called `drainInbox` with no context - and R7.5's `matchesScope` returns false when context is undefined. Result: every scoped message was deferred AGAIN on explicit read, the tool returned "Inbox empty.", and the bot had no path to ever see scoped messages without somehow editing the matching file path first.

That's a contract violation. Auto-drain on hook boundaries is opportunistic and context-aware (correct). Explicit user-driven `read_messages` is "show me everything queued" (was broken). The fix lets the two paths diverge cleanly without compromising either.

**Rejected.**
- Removing scope filtering entirely (revert R7.5) - the auto-drain context-aware path is genuinely useful and was implemented intentionally per docs that always promised it. Removing it loses real signal.
- Threading `tracker` into `handleReadMessages` so it can pass the recipient's `current_task` as context - solves task_contains-scoped messages but not code_ref-scoped ones (no current file_path on an explicit read), and makes the tool surface more complex for no benefit. Bypass is the cleaner contract.
- Promoting bypass to a sender-side `force_deliver` flag - puts the lever on the wrong side of the conversation. The recipient knows when they're doing a manual inbox sweep; the sender can't predict it.
- New separate `flush_inbox` tool - splits a coherent capability across two tools. One tool with a documented behavior is simpler than two tools with overlapping behavior.

**Doc updates.** `CLAUDE.md` line about auto-drain extended with an R7.8 paragraph clarifying the explicit-read bypass. `ARCHITECTURE.md` `read_messages` row updated to mention bypass and the auto-drain vs. explicit-read distinction.

**Test additions:** 4 new unit tests in `tests/engine/messaging.test.ts` (R7.8 bypassScope flag: bypass delivers without context, bypass delivers all scoped types on a fresh inbox, bypass marks read idempotently, bypass:false preserves R7.5 deferral). 1 integration test in `tests/integration/cross_session_messaging.test.ts` reproducing the exact field scenario (auto-drain defers, explicit read surfaces). Total: 449 tests, 0 fail (was 444 + 5).

**Stale notes flagged for closure** (separate maintenance pass): `e4675e9c` (open_thread, "scope filters are display labels only") - was correct pre-R7.5, now stale post-R7.5+R7.8. `61deff24` (anti_pattern, "scope_code_ref silently drops messages") - root cause now fixed; the silent-drop is no longer the explicit-read path. Both should be `close_thread`/`update_note`'d to point at this entry.

**Shipped:** v0.28.3.

---

## 2026-04-30 - R7.7 Suppress Stop block during /compact

**Change.** A real spawnbox session (46673070) ran `/compact` and saw both the PreCompact `systemMessage` ("capture knowledge NOW...") AND the Stop hook fire and BLOCK with the full housekeeping prompt ("Before ending: complete orchestrator housekeeping... 27 fresh notes surfaced...") on the same boundary. Jarid pasted it as a field error. Two problems: (a) redundant capture prompts back-to-back at exactly the moment context is most fragile, (b) `decision: "block"` from Stop derails the compact flow with a "Stop hook error" surface.

Fix: `handlePreCompact` writes a `compacting_<sid>` plugin_state marker with the current epoch ms. `handleStop` checks for that marker; if it exists and is fresher than 60s, the Stop returns `{}` (no block) and consumes the marker so the NEXT real Stop blocks normally. PreCompact's `systemMessage` is the one capture nudge that lands at the compact boundary.

**Why now.** Pure UX bug, easy to verify, easy to fix. The two prompts were saying overlapping things at the worst possible moment.

**Rejected.**
- Removing the Stop block entirely - real Stop (end-of-session) DOES need the housekeeping prompt; only the compaction-driven Stop is redundant.
- Detecting compaction by looking at the registry's `compaction_count` increment - that field updates on `briefing(event:"recover")` calls, not at PreCompact time. PreCompact is the canonical signal.
- Suppressing PreCompact's `systemMessage` and keeping Stop's block - Stop's block is louder and shows as "Stop hook error", a worse surface during /compact.
- Window of 30s instead of 60s - real PreCompact-then-Stop delta is sub-second; 60s gives generous slack for slow IO without bleeding into legitimate post-compact stops.

**Test additions:** 4 new tests in `tests/tools/hook_event.test.ts`: PreCompact stamps marker -> Stop suppressed; second Stop after consumption blocks normally; stale marker (>60s) does NOT suppress; PreCompact still emits its capture systemMessage. Total: 444 tests, 0 fail.

**Wiring.** `SessionTracker.cleanup()` extended with `compacting_%` prefix so any orphaned markers prune at the 7-day cadence with the rest of the ephemeral hook state.

**Shipped:** v0.28.2.

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

> **Partially superseded by R8 (0.29.0, 2026-05-09).** Items #2 (scope filtering in `drainInbox`) and #4 (`inboxCounter` refresh) are dead - the messaging engine they hardened was deleted. Items #1 (APPROVAL_REGEX), #3 (plugin_state cleanup), #5 (STOPWORDS), and #6 (sanitizeSessionId) survive in the dispatcher. Read with that filter.

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

> **Superseded by R8 (0.29.0, 2026-05-09).** All agent-facing prose about `send_message`, `read_messages`, `update_session_task` as a messaging primitive, and the cross-session messaging VARIANTS was either deleted or rewritten to point at the agent-channel model. Historical record only.

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

> **Superseded by R8 (0.29.0, 2026-05-09).** This entire architecture - `session_messages` + `session_message_reads` tables (migration 19), `send_message` / `read_messages` / `_hook_event` tools, the `inboxCounters` fast path, the bash-to-mcp_tool hook migration's messaging-delivery pieces - was ripped out and replaced with the agent-channel filewatcher + `notifications/claude/channel` MCP capability. The `session_messages` and `session_message_reads` tables are dropped in migration 20. The PostToolUse `.*` matcher widening survives (other R7 dispatcher logic still uses it). Historical record only for the messaging primitive itself.

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

> **Superseded by R8 (0.29.0, 2026-05-09).** The `memory-concierge` subagent and the entire concierge-spawn pattern were removed. The Shape A vs Shape B framing no longer applies to any active code path. Historical record only.

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

## 2026-05-09 - R8 Cross-session messaging supersedes R6/R7 (0.29.0)

**Change.** Kill R6/R7's cross-session messaging system entirely. Replace with a real-time **agent-channel** architecture: a persistent **PrimeAgent (PA)** Claude Code session, plus a `notifications/claude/channel` MCP capability that delivers cross-session events inline as `<channel source="agent-channel" ...>` injections. No tools to call, no inbox to drain, no polling - the filewatcher reads each session's JSONL transcript, parses addressing (`@PA` / `@SA-<id8>` / `@all`), and fires channel notifications directly into the recipient's prompt stream within ~1-2s.

Reference design: `docs/superpowers/specs/2026-05-09-prime-agent-channel-architecture-design.md` (in the spawnbox repo - the project where R8 was brainstormed and dogfooded).

**Deleted.**
- Tools: `send_message`, `read_messages`, `peek_inbox`.
- Engine: `mcp/engine/messaging.ts` (entire file), `mcp/tools/messaging.ts` (entire file).
- Subagent: `agents/memory-concierge.md` and the per-session Sonnet concierge spawn pattern.
- Skill: `consult-concierge` (the "talk to your memory concierge" entry point).
- Tables: `session_messages` and `session_message_reads` (migration 20 drops both). `inboxCounters` map and `loadInboxCounters` priming code gone with the engine.
- Dispatcher pieces: `_hook_event`'s message-injection paths, the `MessageScope` type, `DrainContext`, `bypassScope`, `matchesScope`, the R7.5 scope-filter logic, the R7.8 bypass flag, the R7.9 single-path drain - all gone with messaging.ts.
- Tests: `tests/integration/cross_session_messaging.test.ts` and the messaging-engine unit tests.

**Added.**
- MCP capability declaration: `experimental: { 'claude/channel': {} }` on the orchestrator plugin's MCP server (alongside `tools: {}`).
- Empty `setNotificationHandler` for `notifications/claude/channel/permission_request` (refuses to opt into the discord-style permission-DM-fanout - tool-permission prompts stay in their owning terminal).
- `mcp/engine/agent_channel.ts` - filewatcher subsystem. Watches `~/.claude/projects/<project_hash>/*.jsonl`, maintains per-file offsets, polls every 1-2s, reads new events, applies filter rules, parses addressing, emits `mcp.notification(...)` to its owning session.
- `mcp/engine/addressing.ts` - pure addressing parser. Rules: slash-command override (`/pa-pause`, `/pa-resume`), natural-language override (`PA, back off` / `PA, come back`), explicit `@PA` / `@SA-<id8>` / `@all`, conversational `PA,` prefix, default fanout (PA observes everything).
- State files under `<project>/.orchestrator-state/agent-channel/`: `offsets.json` (per-file last-read), `sessions.json` (session registry with id8, role, name, heartbeats), `state.json` (override flags - `pa_global_pause` and per-SA `sa_pauses`).
- Skills: `pa-bootstrap` (sets `/model claude-opus-4-7` and `/effort max`, prints active SA roster, verifies filewatcher), `pa-pause`, `pa-resume`, `pa-takeover`.
- `agents/prime-agent.md` - PA's operating contract (when to act vs observe, how to address SAs, override etiquette, how to use `note()` and `create_work_item()` for self-improvement tagged `area:orchestrator-plugin` + `agent-channel-improvement`).
- Bootstrap launchers (live in the consuming project): `pa-start.bat` (gold/amber tab, singleton-enforced, refuses with takeover hint if PA already running), `sa-start.bat` (default tab, auto-generates `SA-YYYY-MM-DD-HH-MM-SS` name if `--name` not supplied, both pass `--channels plugin:orchestrator@spawnbox-dev-claude-plugins`).
- Project-level CLAUDE.md addendum describing the SA contract (treat PA-addressed messages as if Jarid said them, observe-don't-execute during pause, `@`-syntax for addressing peers).

**Rationale.** Real-time delivery via channel notifications eliminates the entire pacing/polling problem the messaging system tried to solve with hooks. No more inbox-drain on every PostToolUse, no more `inboxCounters` fast-path-when-idle gymnastics, no more "hook fired but the model didn't see the message because the session_id mismatched". One mechanism (channel notifications) covers every cross-session communication shape: PA-to-SA directives, SA-to-PA reports, SA-to-SA peer coordination, three-way (Jarid in SA addressing PA), broadcasts (`@all`), per-SA pauses, global pauses. The R6/R7 system tried to do all this through SQLite + hooks and accreted bug classes the whole way - the prefix-bug work item (`ecbea9ac`), the R7.5/R7.8/R7.9 scope-filter saga, the R7.1/R7.2 hooks.json `server` field misadventure. Channel notifications sidestep all of it because they ride the same primitive the official Discord plugin uses for real-time message delivery, and Claude Code already validates that primitive end-to-end.

Chat is also genuinely ephemeral - knowledge worth keeping goes into orchestrator notes (durable). That justifies dropping the persistent inbox: there was never a real durability requirement, just an inferred one because we'd built a database table.

**Historical R-entries now superseded.** Each has an inline `> **Superseded by R8**` marker:
- **R6** (cross-session messaging primitive itself) - the table, tools, hook dispatcher messaging paths, all gone.
- **R6.1** (agent-facing prose for R6) - all messaging-related prose deleted or rewritten.
- **R7.5** (partial - the scope-filter and inboxCounter parts; APPROVAL_REGEX, STOPWORDS, plugin_state cleanup, sanitizeSessionId all survive).
- **R7.8** (`bypassScope` flag) - mechanism deleted with messaging.
- **R7.9** (scope-as-display-label, single-path drain) - mechanism deleted with messaging.

R7 itself (loop-closure, work-item drift, sibling overlap, expanded hook surface) mostly survives - those are dispatcher behaviors that don't depend on messaging delivery. The `_hook_event` dispatcher is still the entry point; its message-injection branches are gone but its loop-closure / drift / overlap / TaskCompleted / StopFailure logic stays.

R7.1 / R7.2 (hooks.json `server` field, namespaced MCP names) are still load-bearing - they apply to ANY MCP-tool hook in the orchestrator plugin, not just the deleted messaging ones.

**Discovery captured 2026-05-10.** When attempting to ship 0.29.0 via `/plugin update`, found that **`plugin.json` is the canonical version source** that Claude Code's plugin updater reads. `plugin.json` + `package.json` + `marketplace.json` all need to agree on the version string, or `/plugin update` reports a mismatch and refuses to update cleanly. Earlier R-shipments only bumped `package.json` and got away with it because the marketplace cache was rebuilt manually; for R8 we hit the failure mode in the field. Codified in the orchestrator plugin's release checklist: bump all three together, verify with `/plugin update <plugin>`.

**Shipped:** v0.29.0.

---

## What's next

- **R5.2 - broken code_refs in curation_candidates.** R5 shipped verification via retro, but broken refs are only surfaced as a count in the retro summary - the agent has to read it and decide what to do. R5.2 will feed broken refs into `briefing.curation_candidates` so they appear alongside stale-but-hot and low-confidence-but-hot entries, with the same maintenance-handle inline envelope. Remaining work: data source in composer.ts, rendering in briefing envelope, rank alongside existing curation candidates.
- **Loose items.** Assorted ergonomics and polish - see open threads in the orchestrator DB under tag `curation`.
