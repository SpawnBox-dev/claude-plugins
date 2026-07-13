# Egress-death (MCP-outbound-drop) detection - design

- **WI:** `0f9dcd95` (HIGH). Anti-pattern: `6ef0c61f`. **Author:** SA-0c230dcf. **Reviewer/gate:** PA-69bba46e (design-decision checkpoint on the false-positive heuristic - PA's explicit rider).
- **File:** `plugins/orchestrator/mcp/engine/agent_channel.ts` (`detectSessionChanges`, the DEFENSE-C departed path).
- **Status:** DRAFT - awaiting PA nod on the heuristic before implementation.

## Problem

An MCP connection can drop OUTBOUND-only: the session still RECEIVES channel events, but its heartbeat + outbound messages die silently. `detectSessionChanges` then sees the session absent from the fresh roster (heartbeat stale) and, after `DEPART_GRACE_TICKS`, emits a hard `session_departed` - a FALSE departure for a session that is ALIVE and still working. Proven live 2026-07-13: 4 sessions reaped at once, lost messages, and PA made a staffing call on the wrong fleet picture. The victim CANNOT self-detect (its own hook is an MCP call, likely also dead), so detection MUST come from a peer, and the surface from a peer/PA.

## The discriminator (and PA's false-positive rider)

`detectSessionChanges` has NO clean-departure signal - a clean `stop()` (removeSession) and a mere heartbeat-lapse both present as "absent from the fresh roster." So the transcript is the only discriminator. But the naive signal ("transcript mtime is fresh") is FALSE-POSITIVE-prone (PA's rider): mtime can be touched without a new turn, and a lingering/leftover transcript can look fresh.

**Robust heuristic: transcript GREW *after* the heartbeat went stale.**
- A cleanly-departed session (Ctrl+C / window close / `/exit`) and a crashed session both have a DEAD process -> the transcript FREEZES at exit-time (no bytes appended after).
- An egress-dead session has a LIVE process still taking turns -> its transcript keeps GROWING (new turn JSON appended) AFTER its heartbeat stopped.
- So the signal is not "fresh" but "**byte-size increased since the moment the session left the fresh roster**." That is only possible if the process is alive and writing turns = egress-dead. A frozen transcript = genuinely gone -> normal `session_departed`.

This directly answers PA's rider - "a genuinely-departed session with a still-growing transcript" cannot occur: a departed (dead) process appends nothing. The `!`-local-command case is NOT a false positive either - running a local command requires a LIVE session, so growth from it correctly means the session is alive (egress-dead), not gone. Using SIZE-DELTA (not mtime) also immunizes against spurious mtime touches.

## Design

In the DEFENSE-C departed loop, per monitored peer track its transcript byte-size:
- `sizeAtStale: Map<sid, number>` - the transcript size captured the FIRST tick the peer left the fresh roster (its size "at the moment of going silent").
- Each subsequent grace tick, `statSync(<peer transcript>).size`. If it has GROWN beyond `sizeAtStale` by a non-trivial margin (a full new line, not a partial flush) -> **EGRESS-SUSPECT**: the peer is alive but unreachable.
  - Emit a NEW event `event_type: "egress_suspect"` (peer alive, can't send - needs `/mcp` reconnect) instead of the hard `session_departed`. Do NOT reap the row (it's alive). Hold it (like the grace) so a reconnect heals cleanly.
  - The warden's registry-vs-transcript cross-check (shipped 0.30.65) is the human-facing complement; this is the deterministic plugin-side half.
- If size stays CONSTANT across the grace -> genuinely gone -> `session_departed` + reap, exactly as today.

**Transcript path** for a peer: `~/.claude/projects/<project-hash>/<session_id>.jsonl` (the same `projectsHashDir` the filewatcher already tails - `this.projectsHashDir` + `<sid>.jsonl`).

## Surfacing (the reconnect question)

The victim can't self-nudge. The `egress_suspect` event is emitted to the channel so PA (and the warden) see "session X is egress-dead - it needs `/mcp` reconnect." The plugin cannot force the victim to reconnect (its MCP is dead); surfacing to a human/PA who can prompt the reconnect (or who runs `/mcp` for them) is the reachable fix. A future option: a healthy peer could write a well-known "reconnect-me" marker the victim's HARNESS might read - out of scope here; peer/PA alert is the shippable surface.

## Implementation notes
- New `event_type: "egress_suspect"` in the `emit` union + `agent_channel.ts` type; `hook_event.ts`/composer render it as an advisory to PA (not a departed).
- The size-growth check is a bounded `statSync` only for peers in the pending-departed path (already the rare case). No new hot-path cost.
- Extract the pure heuristic (`classifyAbsence({sizeAtStale, sizeNow, missCount}) -> "egress_suspect" | "departed" | "pending"`) for unit tests (the statSync/emit glue stays untested-for-live per convention).

## False-positive analysis (for PA's decision)
| case | process | transcript after heartbeat-stale | classified |
|---|---|---|---|
| clean exit (Ctrl+C / /exit) | dead | frozen | departed (correct) |
| crash | dead | frozen | departed (correct) |
| egress-death (MCP drop) | ALIVE | GROWS | egress_suspect (correct) |
| `!`-local-command run | ALIVE | grows | egress_suspect (correct - it IS alive) |
| spurious mtime touch, no new bytes | either | size unchanged | departed (size-delta ignores mtime) |

## Accepted edges (PA-noted - document so nobody mistakes them for bugs)
- **False-NEGATIVE (PA): an IDLE egress-dead session reads as departed.** With no user input / no self-fired cron it appends nothing, so `grewSinceStale` stays false and it classifies `departed` after the grace. Acceptable semantics: a mute idle session is harmless until it acts; the moment it takes a turn the transcript grows and (while still monitored) it flags `egress_suspect`. Not a bug.
- **Grew-once-then-crashed: held as `egress_suspect` until reconnect.** If a session grows once after going stale then its process truly dies, `sizeNow > sizeAtStale` stays true (transcripts only grow), so it is HELD (not reaped) indefinitely. Cost: PA treats it as recoverable; a failed `/mcp` reconnect reveals it is genuinely gone. Rare + benign; a session that was active-after-stale is far more likely egress-dead than crashed. (No extra hold-timer - monotonic size keeps this simple; revisit only if held-stale entries accumulate in practice.)
- **Recoverable MCP wedge reads as `egress_suspect` once, then self-heals (review finding #2, ACCEPTED).** A transient MCP stall >90s where the process kept taking turns, then the MCP recovers on its own, grows-while-stale and trips ONE `egress_suspect`. Deliberately tolerated: the event is advisory and NEVER reaps, and the present-branch clears `egressEmitted`/`sizeAtStale`/`pendingMisses` the instant the peer returns to the fresh roster - so recovery yields exactly one stale advisory then silence (no `session_departed`, no re-join), and a genuinely-new later absence re-arms fresh. Suppressing this one-off nudge would risk muting a REAL egress-death, so the benign "check on X" cost is accepted rather than gated. Locked by the `agent_channel_flap` "reconnects self-heals" integration test.

## Test plan (TDD)
Pure `classifyAbsence`: sizeNow>sizeAtStale within grace -> egress_suspect; sizeNow==sizeAtStale at grace end -> departed; below grace, no growth -> pending. Mixed-version: an old peer still hard-departs a growing victim; this fix stops FIXED peers from false-concluding (net improvement, full effect on adoption).

## Flow
PA nod on the heuristic (this doc) -> TDD implement -> code-review -> ship 0.30.66 under the standing grant -> validate (scratch: a "session" whose transcript grows while its heartbeat is stale -> classified egress_suspect not departed).
