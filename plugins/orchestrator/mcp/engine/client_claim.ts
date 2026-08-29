/**
 * Client claims (WI ca509bb7) - "which server is Claude Code actually talking to?"
 *
 * WHY THIS EXISTS. `killOlderDuplicateMcps` used to pick its victim by AGE, on
 * the assumption that the newest server is the real one and older siblings are
 * stale debris from the plugin manager's duplicate race. That assumption failed
 * in the field on 2026-08-29: during reload/reconnect churn a freshly spawned
 * copy killed the incumbent that was serving PA, twice in ten minutes.
 *
 * The structural reason is worse than a weak proxy. Dedup ran at MODULE LOAD -
 * before `main()`, before `server.connect()`, before any client handshake could
 * occur - so at the instant of the kill NO server in the window held a client,
 * including the killer. Age was not merely a poor signal; it was the only
 * signal available at a point in the lifecycle where the property that matters
 * could not yet exist for anybody.
 *
 * THE SIGNAL. The MCP SDK's `oninitialized` fires only when a client completes
 * the `initialize` handshake. A server with no client cannot emit it, and
 * therefore cannot forge a claim - which is the bar anti-pattern 501675ba sets
 * after two guards this session failed it (a column both contenders wrote, and
 * an inherited env var mistaken for a relationship).
 *
 * ACCEPTED RESIDUAL, stated per PA rather than solved here: a HUNG-but-alive
 * server whose client has gone away keeps a live-pid claim, so a newcomer will
 * decline to kill it. That is the deliberate trade - heartbeat staleness
 * surfaces that case, stdin-end clears the normal one, and killing live servers
 * was demonstrably the worse error.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

export interface ClientClaim {
  pid: number;
  /** ISO creation time of the claiming process - PID-reuse defense. */
  processCreatedAt: string | null;
  /** When the client handshake completed. */
  claimedAt: string;
}

export function claimPath(stateDir: string, pid: number): string {
  return join(stateDir, `mcp-client-${pid}.claim`);
}

/** Record that THIS process holds a live client. Best-effort by design. */
export function writeClientClaim(
  stateDir: string,
  pid: number,
  processCreatedAt: Date | null,
): void {
  try {
    const claim: ClientClaim = {
      pid,
      processCreatedAt: processCreatedAt ? processCreatedAt.toISOString() : null,
      claimedAt: new Date().toISOString(),
    };
    writeFileSync(claimPath(stateDir, pid), JSON.stringify(claim), "utf8");
  } catch {
    // Never block the handshake on housekeeping.
  }
}

export function readClientClaim(
  stateDir: string,
  pid: number,
): ClientClaim | null {
  try {
    const p = claimPath(stateDir, pid);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (typeof raw?.pid !== "number") return null;
    return raw as ClientClaim;
  } catch {
    return null;
  }
}

export function removeClientClaim(stateDir: string, pid: number): void {
  try {
    unlinkSync(claimPath(stateDir, pid));
  } catch {
    // Already gone, or never written.
  }
}

/** One enumerated sibling, as reported by the process scan. */
export interface SiblingCandidate {
  pid: number;
  /** ISO creation time from the process table; null when unavailable. */
  createdAt: string | null;
}

export interface KillDecision {
  kill: number[];
  /** pid -> why it was spared. Logged, so a no-op is never silent. */
  spared: Array<{ pid: number; reason: string }>;
}

/**
 * Decide which enumerated siblings may be killed.
 *
 * `isPidLive` is injected so this is testable without a process tree - and so
 * the rule itself can be exercised, which the age-based version never was.
 *
 * RULES, in order:
 * 1. Never kill ourselves.
 * 2. Never kill a sibling holding a LIVE client claim: the claim exists, its pid
 *    is alive, and the recorded creation time matches the live process. That
 *    last check is the PID-reuse defense - without it a claim file outliving its
 *    process would protect whatever inherits the number.
 * 3. Anything else with a verified shared ancestor is stale debris and killable.
 *
 * Note what is NOT here: age. It decides nothing now. It was never evidence
 * about which server holds the client, only about which started first.
 */
export function decideDuplicateKills(
  selfPid: number,
  candidates: SiblingCandidate[],
  readClaim: (pid: number) => ClientClaim | null,
  isPidLive: (pid: number, expectedCreatedAt: string | null) => boolean,
): KillDecision {
  const kill: number[] = [];
  const spared: Array<{ pid: number; reason: string }> = [];

  for (const c of candidates) {
    if (c.pid === selfPid) {
      spared.push({ pid: c.pid, reason: "self" });
      continue;
    }
    const claim = readClaim(c.pid);
    if (claim) {
      if (isPidLive(c.pid, claim.processCreatedAt)) {
        spared.push({
          pid: c.pid,
          reason: `holds a live client claim (claimed ${claim.claimedAt})`,
        });
        continue;
      }
      // Claim exists but the process is gone or the pid was reused: the claim is
      // stale and protects nothing. Fall through to kill.
    }
    kill.push(c.pid);
  }

  return { kill, spared };
}
