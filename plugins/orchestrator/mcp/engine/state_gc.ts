import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Garbage-collect the orchestrator state directory (backlog item M, open since
 * 2026-07-27; ledger rotation is item N).
 *
 * WHY: nothing in this plugin has ever deleted a marker. Measured three times
 * on the same machine - 448 files, then 535, then 730 (76 MB), with debris
 * dating to 2026-04-21. The dominant class is 445 `active-session-<pid>`
 * anchors, each read exactly ONCE at MCP startup and inert forever after.
 *
 * It is worse than untidiness because this directory lives inside a
 * ONEDRIVE-SYNCED project folder, so every dead marker is replicated to the
 * cloud and re-synced across machines indefinitely.
 *
 * SAFETY IS THE DESIGN, because this deletes files:
 *
 *  1. ALLOWLIST, NEVER A DENYLIST. Only the known-ephemeral prefixes below are
 *     even considered. A file type introduced after this code was written
 *     survives untouched - the failure mode of an unknown file is "kept", not
 *     "deleted". A denylist would invert that and eventually eat something.
 *  2. AGE FLOOR that cannot race a live write. A running session's marker is
 *     seconds-to-minutes old; the floor is days. And these markers are read
 *     once at startup, so a marker older than the floor cannot still be needed
 *     by the process that wrote it - a restart rewrites it.
 *  3. BEST-EFFORT, NEVER THROWS. It runs off a startup path; a locked file or
 *     a racing peer must not break MCP boot. Every failure is swallowed and
 *     retried next process start.
 *  4. RETURNS WHAT IT DID. A sweep that reports nothing cannot be distinguished
 *     from a sweep that failed - the same "check that cannot say no" this
 *     codebase has been bitten by repeatedly.
 */

/** Ephemeral marker prefixes. EXPLICIT allowlist - see safety note 1. */
const EPHEMERAL_PREFIXES = [
  "active-session-",   // one-shot startup anchor, read once at boot
  "preuse-warn-",      // PreToolUse dedupe marker
  "turn-",             // per-turn hook dedupe
  "stop-",             // Stop hook dedupe
  "subagent-stop-",    // SubagentStop hook dedupe
  "struggle-",         // struggle-detector dedupe
  "bridge-",           // pre-R6 vestigial
  "orch-active-",      // pre-R6 vestigial
] as const;

/**
 * Age before an ephemeral marker is eligible. Deliberately generous: the cost
 * of keeping one too long is a few bytes, the cost of deleting one too early
 * is a confused liveness check.
 */
export const MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many warden-ledger backups to retain (item N). The ledger is
 * recovery-critical and its backups had no rotation - 92 copies of a 138KB
 * file. Recovery value concentrates in the most recent snapshots, so keep the
 * newest N and drop the tail.
 */
export const WL_BACKUP_KEEP = 20;

const WL_BACKUP_PREFIX = ".wl-backup-";

export interface SweepResult {
  /** Files considered (whole directory listing). */
  scanned: number;
  /** Stale ephemeral markers unlinked. */
  removed: number;
  /** Ledger backups dropped beyond WL_BACKUP_KEEP. */
  rotated: number;
  /** True when this directory was already swept in this process. */
  skipped: boolean;
}

/** One sweep per directory per process - this is a startup task, not a loop. */
const sweptDirs = new Set<string>();

/** Exposed for tests; production never needs to re-run within a process. */
export function __resetSweepGuardForTests(): void {
  sweptDirs.clear();
}

export function sweepStateDir(stateDir: string): SweepResult {
  const result: SweepResult = { scanned: 0, removed: 0, rotated: 0, skipped: false };
  if (sweptDirs.has(stateDir)) {
    result.skipped = true;
    return result;
  }
  sweptDirs.add(stateDir);

  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return result; // not created yet, or not readable - nothing to do
  }
  result.scanned = entries.length;

  const now = Date.now();
  const backups: Array<{ name: string; mtime: number }> = [];

  for (const name of entries) {
    const full = join(stateDir, name);

    if (name.startsWith(WL_BACKUP_PREFIX)) {
      try {
        backups.push({ name, mtime: statSync(full).mtimeMs });
      } catch {
        /* vanished under us */
      }
      continue;
    }

    if (!EPHEMERAL_PREFIXES.some((p) => name.startsWith(p))) continue;

    try {
      if (now - statSync(full).mtimeMs < MARKER_MAX_AGE_MS) continue;
      unlinkSync(full);
      result.removed++;
    } catch {
      // Best-effort: a peer may have unlinked it, or it is briefly locked
      // (Windows/AV/OneDrive). Missing one costs nothing - next start retries.
    }
  }

  // Ledger rotation: newest first, drop everything past the keep count.
  if (backups.length > WL_BACKUP_KEEP) {
    backups.sort((a, b) => b.mtime - a.mtime);
    for (const b of backups.slice(WL_BACKUP_KEEP)) {
      try {
        unlinkSync(join(stateDir, b.name));
        result.rotated++;
      } catch {
        /* best-effort, as above */
      }
    }
  }

  return result;
}
