import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Read agent-channel `sessions.json` and return the set of session_ids whose
 * `last_heartbeat_at` is within the 90s stale threshold. This is the
 * authoritative real-time signal for "this MCP is currently alive" - much
 * tighter than session_tracker's 24h hook-event window, and it correctly
 * drops Ctrl+C'd / force-closed sessions whose MCP died before it could call
 * removeSession() cleanly.
 *
 * Returns `null` when sessions.json doesn't exist (e.g., a project that
 * isn't using agent-channel). Callers should fall back to the DB-only
 * 24h logic in that case rather than show an empty sibling list.
 */
export function getLiveSessionIds(): Set<string> | null {
  const projectDir =
    process.env.ORCHESTRATOR_PROJECT_ROOT ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const sessionsFile = join(
    projectDir,
    ".orchestrator-state",
    "agent-channel",
    "sessions.json",
  );
  if (!existsSync(sessionsFile)) return null;
  try {
    const data = JSON.parse(readFileSync(sessionsFile, "utf8"));
    // sessions.json shape can be either {sessions: [...]} or a bare array
    // (legacy). Handle both for read-side defensiveness.
    const entries: Array<{ session_id?: string; last_heartbeat_at?: string }> =
      Array.isArray(data) ? data : data?.sessions ?? [];
    const nowMs = Date.now();
    const STALE_MS = 90_000;
    const liveIds = new Set<string>();
    for (const entry of entries) {
      if (!entry?.session_id || !entry?.last_heartbeat_at) continue;
      const lastHbMs = new Date(entry.last_heartbeat_at).getTime();
      if (Number.isFinite(lastHbMs) && nowMs - lastHbMs <= STALE_MS) {
        liveIds.add(entry.session_id);
      }
    }
    return liveIds;
  } catch {
    return null;
  }
}

/**
 * Given the caller's own sessionId, return the heartbeat-fresh OTHER session
 * ids (excluding self), or `null` if sessions.json is unavailable so the
 * caller can fall back to its 24h DB-only logic.
 */
export function getLiveOtherSessionIds(sessionId: string): string[] | null {
  const live = getLiveSessionIds();
  if (live === null) return null;
  const others: string[] = [];
  for (const id of live) {
    if (id !== sessionId) others.push(id);
  }
  return others;
}
