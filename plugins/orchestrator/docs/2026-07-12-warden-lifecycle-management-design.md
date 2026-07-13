# Context-warden lifecycle management - fix design

- **WI:** `6430ebf6` (child of `9c01fb36`). Gaps from live-use note `9d9a448d`.
- **Author:** SA-0c230dcf. **Reviewer/gate:** PA-69bba46e. **Status:** DRAFT - PA review pending.
- **Standing constraint:** Jarid's ban on *running* any live warden holds until this ships. Editing brief/skill/plugin is regular P4 development and is the "proper lifecycle management" his gate requires.
- **Files:** `agents/context-warden.md`, `skills/pa-bootstrap/SKILL.md`, `mcp/tools/hook_event.ts`, `agents/prime-agent.md`, `skills/every-turn/SKILL.md`.

## What live use exposed (9d9a448d)

The canonical 0.30.63 warden ran on a live PA and failed in four ways: it wrote its ledger to the PA's **session scratchpad** instead of the stable path (so recovery state died with the session); it went long stretches without writing (so `mtime` couldn't tell alive from dead); a respawn **auto-suffixed to `context-warden-2`** and two wardens ran concurrently; and a non-compacting PA ran **~11h warden-less** because spawn is bootstrap-only. Content was excellent - the *lifecycle* was unmanaged. Jarid: no warden runs until this is designed.

## Design

### Constants (initial, tunable)
- `WARDEN_HEARTBEAT_MAX_INTERVAL = 150s` - the warden MUST write the ledger at least this often, even on a no-change pass (a heartbeat-only write).
- `WARDEN_STALE_THRESHOLD = 420s` (~2.8x interval) - a ledger whose heartbeat/mtime is older than this is **presumed dead**. Used by both the singleton guard and the plugin liveness nudge. The multiple absorbs a slow pass + timer jitter without false-positive "dead".

### FIX 1 - Ledger path OVERRIDES scratchpad (brief + spawn-prompt)
The warden's ONE sanctioned non-scratchpad write is the ledger at
`$CLAUDE_PROJECT_DIR/.orchestrator-state/warden-ledger.md`. The brief states it now, but the live warden preferred the harness's "always use your scratchpad" guidance. Fix: the brief says **explicitly** that this path OVERRIDES scratchpad guidance and is mandatory (the whole recovery property depends on it: the ledger must outlive the PA session). pa-bootstrap step 5.8's spawn prompt restates the **absolute** path so the warden can't default. **RULED (PA): NO scratchpad mirror** - a second copy reintroduces last night's exact ambiguity (the scratchpad copy became the live one by mistake). Canonical is the ONLY warden-written ledger; if anything ever appears at a scratchpad path it must be a dead-stub redirect pointing at the canonical path, never a live copy.

### FIX 2 - Heartbeat contract: `mtime` IS liveness (brief)
Every pass writes the ledger, including a top-of-file **heartbeat line**:
```
Warden heartbeat: instance=<agent/session id> | ts=<ISO-8601> | pass=<N> | re-armed=<interval>s
```
- Even a no-change pass writes the heartbeat (refreshes `mtime`). So `mtime` older than `WARDEN_STALE_THRESHOLD` reliably means "not writing = dead/stuck".
- The turn-final report must state "re-armed for `<interval>`s"; a missing/failed re-arm is stated LOUDLY (the doorbell may be empty, so the ledger self-declares its own liveness intent).

### FIX 3 - Singleton guard: the ledger is the file-mutex (brief + spawn-prompt)
The Agent tool auto-suffixes a name collision (`context-warden-2`) rather than rejecting, so it is **not** a usable guard. The ledger heartbeat (FIX 2) becomes the mutex. On startup, before doing anything, the warden reads the canonical ledger's TOP heartbeat line and applies these rules in order:
- **Fresh (ts within `WARDEN_STALE_THRESHOLD`) AND a DIFFERENT `instance`** -> another warden is alive -> **HARD-STOP** (see LOUD stop below).
- **Fresh AND MY OWN `instance`** -> normal self-re-invocation -> proceed.
- **Stale or absent** -> no live warden -> take over, hardening the near-simultaneous race: write my heartbeat line, wait a small random jitter (2-5s), then **re-read the top heartbeat line**. **EXPLICIT DETERMINISTIC TIEBREAK: if the surviving top heartbeat line's `instance` is NOT exactly mine -> HARD-STOP; proceed ONLY if it IS mine.** The predicate is literally "top-line instance == my instance" - no "settle the race" ambiguity (that is how TOCTOU holes survive review).

**LOUD hard-stop (PA adjustment 2):** a stood-down / losing spawn writes **NOTHING** to the ledger, but MUST emit one final message to its spawner - `stood down: instance <winner-id> alive, heartbeat <ts>` - and then **exit its loop entirely (never re-arm the timer)**. Silent stand-down is banned: it makes the spawner (PA) believe it has a warden it does not.

No plugin change needed - pure brief/spawn-prompt logic keyed on the heartbeat line.

### FIX 4 - Recurring liveness check, NOT compaction-gated (plugin, deterministic)
A PA that never compacts never re-checks the warden; the post-compact payload's spawn-if-absent only covers the compaction path. The finding is explicit that PA self-checking is unreliable (11h warden-less), so this is **deterministic plugin-side**, in `hook_event.ts` `handleUserPromptSubmit`:
- Gate: `getSelfRole(sid) === 'prime'` AND active fleet (`getLiveSessions()` has >=1 other live session) AND the canonical ledger is **absent OR its mtime is older than `WARDEN_STALE_THRESHOLD`**.
- Anti-noise: de-duped like the cadence nudge - fire at most once per M turns (track `warden_nudge_turn_<sid>` in `plugin_state`), and reset the moment a fresh ledger reappears (so a spawn silences it immediately).
- Text - STALE case: "[orch] Your context-warden ledger's last write was instance `<X>` at `<ts>` (`<age>` ago) while N sessions are active - a healthy warden writes every <=150s, so it is PRESUMED DEAD/STUCK. Respawn: /pa-bootstrap step 5.8 (background, Opus)." Text - ABSENT case: "[orch] No context-warden ledger at the canonical path while N sessions are active - you have NO context redundancy. Spawn one: /pa-bootstrap step 5.8." Both append: "TaskList does NOT list background agents; the ledger mtime IS the liveness signal." Semantics note (PA adjustment 2): a stale ledger ALWAYS means the last live *writer* stopped - a duplicate that STOOD DOWN never writes to the ledger (it reports to its spawner), so "stale" is never a stand-down artifact; the nudge says "presumed dead/stuck," not "may have stood down."
- Ledger path resolved from `ORCHESTRATOR_PROJECT_ROOT || CLAUDE_PROJECT_DIR` (same as `getAgentChannelStateDir`). TDD.

### FIX 5 - Cosmetic: step-7 model/effort interpolation (skill)
pa-bootstrap step 7 hardcodes "PA ready (Opus 4.7, max effort)" - both stale. The skill can't reliably introspect its own model, so make it a fill-in instruction: "PA ready (`<your actual model>`, `<your actual effort - xhigh default>`). `<N>` SAs in orchestration." Removes the stale assertion.

### FIX 6 - Doc: enumeration + kill discipline (prime-agent.md + brief + every-turn)
- **TaskList is blind to named background agents** (returned "No tasks found" while two wardens ran). The liveness signal is the **ledger heartbeat/mtime**, not TaskList.
- **Teardown is `TaskStop` by name** (worked: `tnraz1a0g` / `tmes00xtq`).
- prime-agent.md "Your context-warden" section + every-turn PA beat gain a one-liner: check the ledger mtime for liveness (not TaskList); a stale ledger during a hot fleet = presume dead, respawn (the plugin nudge backstops this deterministically).

## Test plan (TDD)
- FIX 4 (plugin): prime + active fleet + absent ledger -> nudge; + stale-mtime ledger -> nudge; + fresh ledger -> silent; non-prime -> silent; single-session -> silent; de-dup within M turns; reset when a fresh ledger appears. (Create/stat a temp ledger under a temp CLAUDE_PROJECT_DIR.)
- FIX 1/2/3/5/6 are brief/skill/doc; no unit tests (they are agent-runtime behavior), validated by the scratch-ledger live run after ship.

## Flow
TDD FIX 4 -> full suite green -> code-reviewer -> **design + diff to PA** -> PA-gated version bump + publish. Then, on Jarid's clear, the scratch-ledger validation runs against the FIXED version: spawn one (scratch ledger, watched, torn down), attempt a second spawn and confirm the singleton hard-stop, confirm the per-pass heartbeat refreshes mtime, tear down via TaskStop-by-name. That satisfies `9d9a448d` gaps 5a-5d by demonstration, not by documenting their absence.
