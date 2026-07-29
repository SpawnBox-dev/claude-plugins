import { openSync, readSync, closeSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * 0.41.0: THE ALERT ASKED A QUESTION IT COULD ANSWER ITSELF.
 *
 * Both liveness alerts contain a triage step that says, in effect, "did
 * anything just restart the MCP servers? Then expect this and wait it out."
 * That is a real discriminator and it was correct - but it was addressed to a
 * HUMAN or a PEER, neither of whom can see a reload the user ran in someone
 * else's terminal. Meanwhile the answer sits in a log file on the same disk.
 *
 * WHAT IT COST, observed 2026-07-29: Jarid ran a rolling `/plugin update` +
 * reload across seven sessions. Each reload produced a benign egress_suspect
 * one second into the process handoff. The first one pulled four sessions into
 * a triage cycle - transcript sampling, 45-second re-reads, a relay to the
 * subject - to establish something the restart record states outright. Four
 * more reloads were still queued at the time. An alert that costs five
 * sessions a triage per benign firing, during a window that generates them
 * mechanically, spends more than it has ever saved - and the real firing then
 * arrives to an audience that has learned to skip it.
 *
 * THE SIGNATURE, from PA-d4c8dda8, and it is positive identification rather
 * than an absence:
 *     shutdown triggered=stdin-end  pid=OLD  session=S
 *     MCP server starting           pid=NEW  session=S
 * A clean shutdown immediately followed by a start is a RESTART, not a death.
 * That is strictly better evidence than inferring life from transcript growth,
 * because it names the cause instead of ruling out one alternative.
 *
 * WHY THIS IS NOT A BLINDFOLD (CLAUDE.md nudge-design rule 5 - a suppressor
 * whose trigger correlates with the failure mode is a blindfold, invented
 * twice in one day before being written down):
 * A RESTART writes a `MCP server starting` line. A GENUINE EGRESS DEATH DOES
 * NOT - the process stays up with its transport severed, which is exactly what
 * PA's 58-minute outage looked like: heartbeat fresh, no new start line, no
 * shutdown line either. So the signal here is emitted ONLY by the benign case.
 * That is the opposite of keying on something the failure itself produces.
 *
 * The residual is bounded and stated rather than hidden: a session that
 * restarts AND comes back with broken egress is suppressed for the window,
 * then alerts normally once it lapses. A few minutes of delay on a rare
 * compound case, against a mechanical false-positive source on every upgrade.
 */

/** How recently a start line counts as "this firing is that restart". Sized to
 *  cover a reload handoff plus clock skew, and short enough that a genuinely
 *  broken post-restart session alerts within a few minutes. */
export const RESTART_WINDOW_MS = 4 * 60 * 1000;

export function lifecycleLogPath(): string {
  return join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    "orchestrator",
    "mcp-lifecycle.log",
  );
}

/**
 * PURE: when did `sessionId` last shut down CLEANLY? Epoch ms, or null.
 *
 * KEYS ON THE SHUTDOWN LINE, NOT THE START LINE, and the reason is measured
 * rather than stylistic. The first version of this parsed `at=` off
 * `MCP server starting` lines. Checked against the real log: START LINES CARRY
 * NO TIMESTAMP AT ALL - 0 of 34 have an `at=` field, while 23 of 23 shutdown
 * lines do. So that version would have returned null forever and the
 * suppressor could never have suppressed: a guard that cannot fire, which is
 * the same defect that shipped inert in 0.37.0, caught here only because the
 * handoff-gap measurement came back empty and the emptiness did not add up.
 *
 * The shutdown line is also the better key on the merits. All 23 in the log
 * are `triggered=stdin-end`, which is written ONLY on the clean path - a
 * severed-transport session keeps running and writes nothing, and a hard kill
 * writes nothing either (work item a12d41c5). So it carries the benign-only
 * property the suppressor needs AND it has a clock. The start line has the
 * property but no clock; pairing them buys nothing the shutdown line lacks.
 *
 * Tolerant by design: an unparseable line is skipped, never fatal. A liveness
 * detector must not be brought down by its own diagnostic input.
 */
export function lastCleanShutdownMs(logTail: string, sessionId: string): number | null {
  let latest: number | null = null;
  for (const line of logTail.split("\n")) {
    if (!line.includes("shutdown triggered=")) continue;
    if (!line.includes(sessionId)) continue;
    const m = line.match(/at=(\S+)/);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (!Number.isFinite(ts)) continue;
    if (latest === null || ts > latest) latest = ts;
  }
  return latest;
}

/** PURE: is this firing explained by a restart? */
export function restartExplainsSilence(
  lastRestart: number | null,
  now: number,
  windowMs = RESTART_WINDOW_MS,
): boolean {
  if (lastRestart === null) return false;
  const age = now - lastRestart;
  // A FUTURE timestamp is clock skew, not evidence - treat it as in-window
  // rather than as a negative age that silently fails the comparison.
  if (age < 0) return true;
  return age < windowMs;
}

/**
 * Read the last `bytes` of the lifecycle log. Best-effort: any failure returns
 * "" so the caller degrades to pre-0.41.0 behaviour (alert anyway) rather than
 * silently suppressing. Failing OPEN is the correct direction for a
 * suppressor - a broken reader must not mute a watchdog.
 */
export function readLifecycleTail(bytes = 64 * 1024, path = lifecycleLogPath()): string {
  try {
    if (!existsSync(path)) return "";
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return "";
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}
