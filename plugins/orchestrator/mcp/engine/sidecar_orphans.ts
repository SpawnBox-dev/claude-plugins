/**
 * WHICH EMBED SIDECARS CAN NOTHING REACH.
 *
 * This lives in its own module for one reason: the classification was already
 * correct and it did not matter, because the code that CALLED it was nested
 * inside `if (h.pid)` - the branch where /health answered. So on 2026-09-07 the
 * fleet ran `system_status` with four orphaned sidecars alive holding ~4.6 GB
 * on a memory-starved box, and got "/health did not answer" and no orphan list.
 *
 * 🔴 THE TESTING LESSON IS THE POINT OF THE FILE. A unit test on the old
 * `orphansOf` would have passed green through the entire defect, because the
 * predicate was never the broken part - its REACHABILITY was. Extracting the
 * classification means the fallback path (no /health, identify by port file)
 * is a thing a test can execute, rather than a branch that only runs during an
 * outage nobody is watching.
 *
 * See `identifyLive` for why there are two discriminators rather than one.
 */

export interface SidecarProc {
  pid: number;
  port: number;
  ageMs: number;
  rssMb: number;
}

/** How the live sidecar was identified - callers must SAY which, because the
 *  two claims carry different weight and a reader has to be able to tell. */
export type LiveBasis =
  /** /health answered and named its own pid. The strongest signal: it comes
   *  from the process we are actually talking to. */
  | { kind: "pid"; pid: number }
  /** /health did not answer, so the live one is whichever holds the port the
   *  port file names - the same discriminator the reaper uses. Weaker (a
   *  process can hold that port and not be serving) but ALWAYS AVAILABLE, which
   *  is what the pid basis is not. */
  | { kind: "port"; port: number }
  /** Neither is available. Classify nothing rather than guess: misnaming the
   *  live sidecar as an orphan is the expensive direction of this error. */
  | { kind: "unknown" };

export function identifyLive(
  healthPid: number | null | undefined,
  portFilePort: number | null | undefined,
): LiveBasis {
  if (typeof healthPid === "number" && healthPid > 0) return { kind: "pid", pid: healthPid };
  if (typeof portFilePort === "number" && portFilePort > 0) return { kind: "port", port: portFilePort };
  return { kind: "unknown" };
}

/**
 * Sidecars nothing can route to.
 *
 * `selfPid` is excluded unconditionally - this process is never its own orphan.
 * On `unknown` the result is EMPTY: with no way to tell the live one apart,
 * every process would be reported as an orphan, which is worse than silence
 * because it invites killing the one that works.
 */
export function classifyOrphans(
  all: SidecarProc[],
  live: LiveBasis,
  selfPid: number,
): SidecarProc[] {
  if (live.kind === "unknown") return [];
  return all.filter((r) => {
    if (r.pid === selfPid) return false;
    return live.kind === "pid" ? r.pid !== live.pid : r.port !== live.port;
  });
}

/** Total resident MB across a set - the figure that decides whether anyone cares. */
export function totalRssMb(procs: SidecarProc[]): number {
  return procs.reduce((a, r) => a + r.rssMb, 0);
}
