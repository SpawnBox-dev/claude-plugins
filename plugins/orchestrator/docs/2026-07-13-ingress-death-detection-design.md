# Ingress-death (parked-loop) detection - design

- **WI:** `19294811` (HIGH). **Author:** SA-0c230dcf. **Reviewer/gate:** PA-69bba46e; adversarial code-review folded in (finding #1 below). Sibling of egress-death (`0f9dcd95`).
- **File:** `plugins/orchestrator/mcp/engine/agent_channel.ts` (`classifyIngress`, `parseIngressTail`, `detectIngress`, `readTranscriptTail`, `tick()` throttle).
- **Status:** SHIPPED (orchestrator 0.30.67).

## Problem

The INVERSE of egress-death. A session PRESENT in the fresh roster (heartbeat fresh) can have its event loop PARKED: the confirmed cause (Jarid, live 2026-07-13) is an **interactive menu/prompt left open** - an open `/mcp` menu parks the session's event loop. Other parking causes are possible (unproven, do not claim impossible). While parked:

- The session's bun keeps heartbeating (so the roster sees it healthy) and the filewatcher keeps ENQUEUEing channel deliveries into the transcript.
- NO turn runs to DEQUEUE + process them, so deliveries pile up unprocessed.

Both the heartbeat AND transcript-growth are false-negatives; neither existing detector fires (egress requires heartbeat DOWN). Live incident: session a3bb12a4 ran no turn 17:06:53->17:48Z; five channel deliveries (two addressed directly to it) enqueued with zero dequeues; caught only by PA transcript-tailing. The woken session self-reported "never stalled" - model-level self-detection is confabulation-prone by construction, so detection MUST be process-level.

## Forensic signature (Phase 0)

Through 17:06:53Z: healthy - every `queue-operation:enqueue` gets a matching `dequeue` and drives an assistant turn. After the last turn: 5 consecutive `enqueue`, zero `dequeue`, zero turns. So the signal is: **a channel delivery enqueued-but-never-dequeued since the last real (non-queue-operation) transcript entry, aged past a threshold, while the heartbeat stays fresh.** (Full Phase-0 forensics in WI 19294811.)

## Detection - PEER-SIDE ONLY

Each session's bun scans its PRESENT peers' transcript tails on a throttled cadence.

- `parseIngressTail(tail)` (pure): walks the last 128 KB of a peer transcript; tracks the last non-queue-op entry (which RESETS the orphan accounting - anything before it was processed), FIFO-matches dequeues to enqueues, and returns `oldestOrphanEnqueueTs` = the oldest UNMATCHED enqueue since the last real activity (or null).
- `classifyIngress({heartbeatFresh, oldestOrphanEnqueueTs, lastRealIsMidTurn, now, thresholdMs})` (pure): `ingress_suspect` when fresh + an orphan older than `INGRESS_STALE_THRESHOLD_MS` (3 min) + not mid-turn; `pending` when the orphan is still recent; `healthy` otherwise. See "The mid-turn discriminator" below.
- `detectIngress` emits `ingress_suspect` ONCE per parked episode (`ingressEmitted` set), advisory-only - it NEVER reaps a live session. Cleared on recovery (queue drains / real turn) and when the peer goes absent.
- Throttled to `INGRESS_CHECK_INTERVAL_MS` (30 s) in `tick()`; the 128 KB tail read is heavier than the egress statSync, and detection latency of tens of seconds is irrelevant against the 3-min threshold. Keeps per-tick I/O near the post-flap-fix floor (WI 8522c487).

### Why peer-side ONLY (self-emit cannot escape its own park)

The victim's bun is alive and CAN detect its own park (it reads its transcript from disk, no harness needed). But it cannot DELIVER the alarm: `emit` rides `server.server.notification({method:"notifications/claude/channel"})` -> the LOCAL harness transport -> the CC channel fabric. A parked harness does not drain the MCP transport until the park clears, so a self-emitted alert is trapped behind the very park it reports (verified in server.ts:~2277). Only a healthy peer can raise the alarm. `detectIngress` skips self.

## The mid-turn discriminator (code-review finding #1, CONFIRMED; both residuals fixed)

Adversarial review found a real false positive: a single long tool call (cargo build, `/deploytovm`, a VM op - all routine here and often >3 min) appends NOTHING between the `tool_use` (invocation) and its `tool_result` (return). A delivery enqueued mid-run then looks identical to a park, and the remediation ("go hit Enter on that terminal") would interrupt a healthy build. Review then flagged the same shape for **extended thinking** (a multi-minute reasoning span, no tool at all).

Empirically verified against a real 40 MB transcript:
- Timestamped entry types are only `assistant / user / system / attachment / queue-operation`. `tool_use` / `tool_result` are CONTENT BLOCKS inside `message.content[]`, not top-level entries.
- A tool in flight = an `assistant` entry carrying a `tool_use` block; its `tool_result` arrives later as a `user` entry, with nothing appended between (a real 180 s gap observed).
- Extended thinking appends nothing until it resolves, and the silent span ALWAYS follows a `user` entry (input or tool_result) - measured 21-49 s silent gaps, each preceded by a `user` entry.
- The real park (a3bb12a4) ended with a completed `assistant` text turn followed by a trailing `system` entry - neither is mid-turn - so it is still detected.

Fix: `parseIngressTail` computes `lastRealIsMidTurn` from the LAST real (non-queue-op) entry only:
- a `user` entry -> the model owes a response (input / tool_result / extended-thinking) -> mid-turn.
- an `assistant` entry carrying a `tool_use` block -> a tool is running now -> mid-turn.
- a completed `assistant` text turn or a trailing `system` entry -> idle -> park-eligible.

`classifyIngress` returns `healthy` when `lastRealIsMidTurn`, before the orphan-age check. Scoping to the LAST real entry (rather than a whole-window tool_use/tool_result balance) closes BOTH review residuals: the long-tool-call FP, the extended-thinking FP, AND the persistence FN a whole-window balance would have had (a stale unmatched tool_use earlier in the 128 KB window masking a later genuine park - now impossible, since only the last real entry is consulted).

## Accepted edges (document so nobody mistakes them for bugs)

- **A park entered mid-turn (residual FN).** If the loop parks while the last real entry is a `user` entry or a pending `tool_use` (e.g. the operator opens the menu right after typing, before the response), it reads as mid-turn and is not flagged. Rare (parks are typically entered from idle, i.e. after a completed turn); and in the "typed-then-park" case the operator's own hanging message is the more visible signal. Advisory-only; accepted.
- **Extended thinking that follows a NON-user real entry (rare residual FP).** The mid-turn guard keys off a `user` last-entry; a multi-minute think that somehow follows an `assistant` text entry mid-turn would not be suppressed. Not observed (thinking spans follow `user` entries); if it occurs, the cost is one benign self-healing "check on X" nudge. Accepted.
- **Multi-observer redundancy.** Every healthy peer detects independently and emits once per episode, so PA may see a few `ingress_suspect` advisories for one parked peer. Same shape as egress; redundant-safe (survives one observer also being wedged).

## Remediation surface

The `ingress_suspect` content tells a human/PA: *"heartbeat fresh but a channel delivery has sat unprocessed for >3min = the session loop is PARKED (an open menu/prompt is the confirmed cause; other causes possible). Fix: check that terminal for an open menu/prompt - Enter/Escape, then /mcp if still dead."* The only known wake lever is local terminal input, so surfacing to a human/PA who can poke the terminal is the reachable fix - same model as egress.

## Not a harness patch

The parked-loop cause (an open interactive menu) is a harness/UX behavior the plugin cannot fix in-process. This is DETECTION + a human-actionable surface, not a re-invoke patch. Document as a harness behavior; do not attempt to force a turn from the plugin.
