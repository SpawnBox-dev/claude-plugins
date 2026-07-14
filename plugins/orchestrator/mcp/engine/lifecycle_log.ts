import { existsSync, mkdirSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append a single MCP lifecycle line to a durable file, bounded and crash-safe.
 *
 * WHY THIS EXISTS: the MCP server's startup / shutdown / crash / heartbeat
 * events are written to `process.stderr`, which Claude Code does NOT persist
 * anywhere readable (the ~/.claude debug + mcp-servers dirs come up empty). So
 * when an MCP disconnects, the crash/shutdown line it dutifully logged vanishes
 * with the process, and the disconnect leaves no post-hoc trail. Mirroring
 * those events here gives the NEXT disconnect a durable, greppable evidence
 * file (crash stack = plugin bug to harden; a heartbeat that just stops with no
 * following shutdown line = the process was killed by OOM / the harness = env).
 *
 * INVARIANTS (both load-bearing):
 *  - NEVER throws. This runs inside the MCP's uncaughtException /
 *    unhandledRejection handlers; a logger that throws would compound a crash
 *    instead of recording it. Every error (bad path, permission, full disk) is
 *    swallowed.
 *  - Bounded. When the file exceeds `capBytes` it is truncate-rotated: a single
 *    "rotated" marker replaces the old content, then the triggering line is
 *    appended (so the event that tripped rotation is never lost). Recent events
 *    are what matter for diagnosing a disconnect; the 5-min heartbeat must not
 *    grow the file without bound.
 *
 * `nowIso` is passed in (not read via `new Date()`) so callers control the
 * timestamp and the function stays deterministic under test.
 */
export function appendLifecycleLine(
  filePath: string,
  line: string,
  capBytes: number,
  nowIso: string,
): void {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    try {
      if (statSync(filePath).size > capBytes) {
        writeFileSync(
          filePath,
          `[orchestrator] --- log rotated (>${capBytes}B) at=${nowIso} ---\n`,
        );
      }
    } catch {
      // file may not exist yet - the append below creates it
    }
    appendFileSync(filePath, line);
  } catch {
    // Persistent logging must NEVER crash the MCP. Swallow all errors.
  }
}

/**
 * Fan a lifecycle line to the durable file (primary) and stderr (best-effort).
 *
 * ORDER IS LOAD-BEARING: the durable file is written FIRST because `writeFile`
 * (appendLifecycleLine) never throws, so the evidence is captured even when
 * stderr is a dead/closed pipe. A `process.stderr.write` on a broken pipe CAN
 * raise (EPIPE-class, especially under Bun) - and that happens during transport
 * death, which is precisely the disconnect scenario this log exists to
 * diagnose. Writing stderr first (as the original inline code did) would let an
 * EPIPE skip the file write in exactly the case we most need it. So: file
 * first, then stderr wrapped in its own try/catch as strictly best-effort.
 *
 * Sinks are injected so the ordering + swallow guarantees are unit-testable
 * without a live stderr pipe.
 */
export function emitLifecycleLine(
  writeStderr: (line: string) => void,
  writeFile: (line: string) => void,
  line: string,
): void {
  writeFile(line);
  try {
    writeStderr(line);
  } catch {
    // stderr may be a dead pipe during transport death - best-effort only.
  }
}
