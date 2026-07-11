# Connection-flap storms under load — fix design

- **WI:** `8522c487` (SpawnBox orchestrator DB). Evidence: anti-pattern `ae170796`, prior art `8f3730ca`, open_thread `6fb3b978`.
- **Author:** SA-0c230dcf (execution SA for this batch). **Reviewer/gate:** PA-69bba46e.
- **Status:** DRAFT — PA review pending. No code, no version bump, no publish until PA signs off.
- **Repo:** `claude-plugins @ 0.30.61`, file `plugins/orchestrator/mcp/engine/agent_channel.ts` (+ `live_sessions.ts`, `agent_channel_state.ts`).

## 1. Problem

Under load (cargo builds saturating cores + many sessions actively writing), live sessions get falsely emitted as `session_departed` then `session_joined`. The join/depart spam floods the channel; every peer burns turns narrating "N peers dropped and rejoined," which adds load and snowballs (Jarid's live complaint).

## 2. Root cause (source-grounded)

The heartbeat is a **30s process timer** (`heartbeatTimer = setInterval(this.heartbeat, HEARTBEAT_INTERVAL_MS=30_000)`, agent_channel.ts:72,217-220) sharing the **single bun event loop** with the **1.5s** filewatcher tick (`POLL_INTERVAL_MS=71`). A session is reaped/derived-departed when its `last_heartbeat_at` is **>90s** stale (`STALE_THRESHOLD_MS=73`) — only **3 beats** of tolerance.

`session_joined`/`session_departed` are **not persisted events**; they are per-session **roster-diff derivations** in `detectSessionChanges()` (281-349): each session diffs its in-memory `knownSessions` Map against the current 90s-fresh live-set and emits to its own channel. (DB-confirmed: 0 join/depart rows in `system_events`.) A **peer physically reaps** a stale row: `current.delete(sid); removeSession(sid)` (300-306); self is never self-reaped (289-299, the 0.30.32 fix).

**What starves the heartbeat timer — the dominant load vector:** `processFile()` reads the **ENTIRE file** every tick for any transcript that grew since last offset:

```
// agent_channel.ts:585-591 (current)
const raw = readFileSync(file);            // reads WHOLE file, always
buf = raw.subarray(lastOffset).toString("utf8");
```

Unchanged files are skipped (573 via `statSync`), but every **actively-growing** peer transcript is re-read in full, synchronously, every 1.5s, by every peer. With N active sessions and transcripts up to ~150MB, this is **≈ N² × full-file-size synchronous I/O per tick** → blocks the event loop → the co-resident 30s heartbeat timer fires late → `last_heartbeat_at` slips past 90s → a peer reaps + emits `session_departed`; the next recovered heartbeat re-adds the row → a peer's next tick emits `session_joined`. Flap.

**Acute variant (verified self-specimen):** a brand-new receiver has no offset rows → `lastOffset = offsets[file] ?? 0` = 0 (566) → its first ticks `readFileSync` every peer transcript **from byte 0** (gigabytes of history). This blocks the new session's own loop for ~minutes right after join, starving its own heartbeat. Session 0c230dcf joined 16:50:20Z and was false-departed 16:52:27Z (127s ≈ 3 missed beats) while fully alive. (My offsets are now at EOF of 150MB-scale files — DB-confirmed I read gigabytes on catch-up.)

## 3. Fix design

Three changes. **ROOT-A + ROOT-B kill the cause; DEFENSE-C ships anyway as flap-spam insurance** (addresses Jarid's snowball even in modes A/B don't anticipate). Implementation order: **A+B first, C second** (per PA). Prefer the minimal fix — delta reads alone likely shrink blocking I/O by orders of magnitude; no worker threads / async restructuring unless measurement shows deltas insufficient.

### ROOT-A — positional/partial read (biggest lever)

Read only `[lastOffset, size)` instead of the whole file. Semantics-preserving swap of the read; all downstream logic (split `\n`, `consumed`-accounting, offset advance) is unchanged.

```
let stat; try { stat = statSync(file); } catch { return false; }
// ROOT-B first-sight guard goes here (below)
const lastOffset = offsets[file];
if (stat.size === lastOffset) return false;
if (stat.size < lastOffset) { offsets[file] = 0; return true; } // truncation/rotation

let buf: string, fd: number | undefined;
try {
  fd = openSync(file, "r");
  const length = stat.size - lastOffset;
  const b = Buffer.allocUnsafe(length);
  const n = readSync(fd, b, 0, length, lastOffset);   // read ONLY the delta
  buf = b.subarray(0, n).toString("utf8");
} catch { return false; }
finally { if (fd !== undefined) closeSync(fd); }
// ...unchanged: split("\n"), process lines[0..n-1], consumed += byteLength+1, offsets[file] = lastOffset + consumed
```

New imports: `openSync, readSync, closeSync` from `fs`.

**Multibyte safety:** `lastOffset` always lands on a line boundary (the byte after a `\n`) because `consumed` only advances past **complete** lines; `\n` (0x0A) can't be part of a multibyte sequence. So the read never starts mid-character. The buffer's tail may end mid-line/mid-character, but that trailing partial line is **not** processed (`i < lines.length-1`) and is re-read next tick — exactly today's behavior. (This is PA's "read to the last complete newline, carry the partial-line remainder forward" — the current `consumed`-accounting already implements it; ROOT-A preserves it verbatim.)

**Concurrent append:** `statSync.size` is a snapshot; bytes appended after it are simply picked up next tick. Robust.

### ROOT-B — init new-receiver offsets to EOF (skip history)

When a receiver sees a transcript for the **first time** (no offset row → `offsets[file] === undefined`), initialize its offset to current EOF and process nothing, instead of reading from 0:

```
// immediately after statSync, before the size checks:
if (offsets[file] === undefined) {
  offsets[file] = stat.size;   // skip backlog; channel is real-time
  return true;                 // persist the EOF offset; nothing to emit
}
```

This distinguishes genuine first-sight (`undefined`) from a legitimate offset of 0. It fixes the acute new-join flap directly (a new session reads ~0 historical bytes → no catch-up stall). **It is also a correctness fix, not only perf:** addressing is parsed *now* against the current roster (processEvent:633,652-654), so a new session reading history from 0 re-delivers historical **@all** messages to itself, and a **new PA** (observes everything, 648-651) re-injects the entire historical channel. ROOT-B stops that.

**Accepted edge — the first-sight window (documented so it is not re-litigated as a lost-message bug):** EOF-init skips whatever was written to a transcript in the interval `[file-creation, this receiver's first-sight tick]`. For a *live* receiver this window is **at most ~one tick (1.5s)**: the receiver is already ticking, so it sees a newly-appeared transcript on the very next tick and EOF-inits at that point. The only content in that window is the peer's own session bootstrap (SessionStart banners, tool-loading) — **no addressed channel traffic** a receiver would need, because a peer's first addressed message is authored later, in its own turns, well after its transcript exists. For a *brand-new* receiver, EOF-init skipping the entire pre-join backlog of all peers is the **intended** behavior, not a loss: a joining session must not replay the fleet's history (that is the very starvation bug, and it also re-injects historical @all traffic). A **restarted** session gets a new session_id → new id8 → no offset rows → EOF-inits all files (same intended behavior: restarts don't replay history). Net: no addressed message is ever lost by EOF-init; the skipped bytes are bootstrap noise or intentionally-skipped history.

### DEFENSE-C — departure hysteresis + depart↔rejoin debounce (second)

Decouple **liveness-for-filtering** (keeps the 90s check in `live_sessions.ts` for roster/display) from the **departure announcement** (the channel event that costs peers turns). Add hysteresis to the announcement only:

- `private pendingDepartures = new Map<string, number>()` (sid → first-missed ms).
- In `detectSessionChanges`, a sid in `knownSessions` but absent from `current` is recorded pending (not announced) on first miss.
- Emit `session_departed` only once a pending sid has been absent ≥ `DEPART_GRACE` (tunable; a few ticks / +15-30s beyond 90s).
- If a pending sid **reappears** in `current` before grace elapses → it flapped: clear pending, emit **neither** departed nor joined. This is the snowball killer.
- Defer the physical `removeSession` reap to the same grace (a lingering dead row is already filtered by the 90s liveness check, so deferral is harmless) so a recovering session isn't churned in the table either.

Cross-session robustness: even if peer A physically reaps sid X, peer B's `pendingDepartures` recognizes X's re-add within grace and suppresses the pair. Because ROOT-A+B shrink the stall duration, a **modest** grace suffices for residual flaps — which is exactly why A+B land first and C second.

## 4. Mixed-version fleet safety (PA constraint 2)

Old sessions (full-file reads) and new sessions (positional reads) coexist against the same DB until each restarts. **Offsets are keyed by PK `(receiver_id8, jsonl_path)`** (agent_channel_state.ts:292-297) — each session only ever reads/writes its **own** rows; there is no cross-session row sharing to corrupt. The offset **value semantics are identical** in both versions (absolute byte position of the next unread byte), so an old session that later upgrades resumes seamlessly from wherever its offset sits. ROOT-B only changes a receiver's **own** first-sight default. Conclusion: safe in both directions, no corruption path.

## 5. OneDrive note (PA constraint 3 — with a correction)

The transcripts read by ROOT-A live under `C:\Users\Jarid\.claude\projects\...` — **not** an OneDrive-synced path (verified from the live `offsets.jsonl_path` values). The OneDrive-synced artifact is `agent_channel.db` itself (under the project dir). So the OneDrive size/mtime-lying concern applies to **DB writes** (heartbeat/offset/session UPSERTs), not to the positional transcript reads — and that write path is already hardened (atomicWrite retry + the 0.30.32 heartbeat try/catch, agent_channel.ts:234-278). ROOT-A does not touch the DB-write path. No new OneDrive exposure.

## 6. Test plan (TDD)

- **ROOT-A** (`tests/engine/agent_channel*.test.ts`): a large file with a small appended delta processes the delta correctly and advances `offset = lastOffset + consumed`; a trailing partial line is carried to the next read; truncation resets to 0. Assert the read length is bounded by the delta, not the file size.
- **ROOT-B**: a receiver with no offset row EOF-inits and processes **zero** historical lines, then processes only post-init appends; a new PA does not re-inject historical @all content (`tests/integration/agent_channel_routing.test.ts`).
- **DEFENSE-C**: absent < grace then reappear → neither event; absent ≥ grace → `session_departed`; reappear after departed → `session_joined`.
- **Regression:** full suite stays green (current baseline 618 pass / 0 fail per PA 2026-07-11); `agent_channel_routing_regress.test.ts` unaffected.

## 7. Verification / live repro

I am my own repro harness (I live on the channel). After A+B: instrument tick duration (stderr under a debug flag), run a cargo build + active fleet, confirm heartbeats stay fresh and **no false `session_departed`** appears for live sessions. **Measure, don't assume** — if delta reads alone don't provably end starvation, only then consider async/worker restructuring.

## 8. Rollout & follow-ups

1. TDD-implement A+B → suite green → code-reviewer → bring diff to PA. **PA gates version bump + publish** (sessions pick up on restart).
2. DEFENSE-C as a second ship (or same ship if PA prefers).
3. **Follow-up (non-gating, tracked on WI 8522c487):** trace the duplicate-`assistant_text` delivery (3 pairs PA logged 16:41-16:51) — hypothesis: offset not persisted before the next tick under WAL write-contention → same bytes reprocessed. Do **not** gate the flap fix on it.
4. **Minor doc reconciliation:** pa-bootstrap's "next heartbeat (~30s) restores the correct entry" should note the timer can be starved under load (restoration is not guaranteed within 30s). P3-adjacent.

## 9. Implementation outcome (as shipped to main, pre-publish)

- **Measured basis (rider 3):** with the REAL `AgentChannel` over 6 peers x 20MB transcripts, the old-equivalent full read (offset seeded to 0) blocked the tick for **1099ms**; the new steady-state delta read (16KB/peer) took **15.3ms** - a **~72x** reduction. At the real fleet's ~150MB transcripts x 7 sessions the old cost is far larger (multiples of the 30s heartbeat interval per 1.5s tick), which is the confirmed starvation mechanism; the delta read is bounded by transcript *growth* (KB-range), not size, so it stays low-ms regardless of file size.
- **DEFENSE-C final values:** `DEPART_GRACE_TICKS = 20` (~30s at the 1.5s nominal tick rate = one heartbeat interval). Field is `pendingMisses: Map<sid, count>` (per-peer consecutive stale-observation ticks). Grace is **uniform** for both the stale-but-present and row-absent cases - required for mixed-version safety (an older peer may still immediately reap a merely-stalled victim's row, so the observer cannot treat "row absent" as a definite clean stop). Departure is announced + the row reaped only at the grace; the physical reap is thus **deferred** from the old immediate-90s reap (a lingering stale row is already excluded everywhere by the 90s freshness filter). Routing now uses a separate `currentRoster` (fresh: self + heartbeat-fresh peers) so grace-held peers don't leak into sender/addressing resolution.
- **Observer-side only (rider 1):** the hysteresis lives entirely in each peer's `detectSessionChanges`; self is always in `currentRoster` and never in the departed path, so a flapping (blocked) victim never runs it for itself.
- **Tests / gates:** new `agent_channel_flap.test.ts` (5 tests: ROOT-B EOF-init, ROOT-A positional/multibyte/partial-line, DEFENSE-C within-grace / after-grace / flap-debounce). Routing + regress suites adapted via `deliver()` (append-after-init). Full suite **623 pass / 0 fail**, `tsc` clean. Two commits (A+B then C). No version bump, no publish - PA gates that after reviewing the combined diff.
