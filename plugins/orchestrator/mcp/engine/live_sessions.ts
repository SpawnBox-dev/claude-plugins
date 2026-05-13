import { existsSync } from "fs";
import { join } from "path";
import { readSessions, type SessionEntry } from "./agent_channel_state";

/**
 * Read the agent-channel session registry and return the set of session_ids
 * whose `last_heartbeat_at` is within the 90s stale threshold. This is the
 * authoritative real-time signal for "this MCP is currently alive" - much
 * tighter than session_tracker's 24h hook-event window, and it correctly
 * drops Ctrl+C'd / force-closed sessions whose MCP died before it could call
 * removeSession() cleanly.
 *
 * Returns `null` when the agent-channel state dir doesn't exist (e.g., a
 * project that isn't using agent-channel). Callers should fall back to the
 * DB-only 24h logic in that case rather than show an empty sibling list.
 *
 * 0.30.35: source switched from direct sessions.json file read to
 * `readSessions()` (SQLite-backed via agent_channel_state). Same liveness
 * contract, race-free under concurrent MCP writes.
 */
function getAgentChannelStateDir(): string | null {
  const projectDir =
    process.env.ORCHESTRATOR_PROJECT_ROOT ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const stateDir = join(projectDir, ".orchestrator-state", "agent-channel");
  // If the agent-channel state dir doesn't exist OR neither the new DB file
  // nor the legacy sessions.json exists, the project isn't using agent-channel.
  // We don't want to spuriously create the DB just to check liveness.
  if (!existsSync(stateDir)) return null;
  const dbExists = existsSync(join(stateDir, "agent_channel.db"));
  const legacyExists = existsSync(join(stateDir, "sessions.json"));
  if (!dbExists && !legacyExists) return null;
  return stateDir;
}

export function getLiveSessionIds(): Set<string> | null {
  const stateDir = getAgentChannelStateDir();
  if (!stateDir) return null;
  try {
    const entries = readSessions(stateDir);
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
 * ids (excluding self), or `null` if the agent-channel state isn't available
 * so the caller can fall back to its 24h DB-only logic.
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

/**
 * Read the agent-channel session registry and return the heartbeat-fresh
 * entries (within 90s). Same liveness contract as getLiveSessionIds, but
 * returns the full SessionEntry shape so callers can read auxiliary fields
 * (`kind`, `name`, `role`, `current_task`) without a second read.
 *
 * Returns `null` when the agent-channel state isn't available - callers
 * fall back to DB-only logic the same way they would for getLiveSessionIds.
 */
export function getLiveSessions(): SessionEntry[] | null {
  const stateDir = getAgentChannelStateDir();
  if (!stateDir) return null;
  try {
    const entries = readSessions(stateDir);
    const nowMs = Date.now();
    const STALE_MS = 90_000;
    return entries.filter((e) => {
      if (!e?.session_id || !e?.last_heartbeat_at) return false;
      const lastHbMs = new Date(e.last_heartbeat_at).getTime();
      return Number.isFinite(lastHbMs) && nowMs - lastHbMs <= STALE_MS;
    });
  } catch {
    return null;
  }
}
