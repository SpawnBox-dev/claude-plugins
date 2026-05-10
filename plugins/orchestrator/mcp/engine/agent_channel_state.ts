/**
 * State file helpers for the agent-channel subsystem.
 *
 * Three files under <project>/.orchestrator-state/agent-channel/:
 *   sessions.json - registry of active sessions (PA + SAs)
 *   state.json    - override state (pa_global_pause, per-SA pauses)
 *   offsets.json  - per-JSONL last-read byte offset
 *
 * Atomic writes (temp file + rename). Tolerant readers (parse failure → empty).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";

export interface SessionEntry {
  session_id: string;
  id8: string;
  role: "prime" | "subordinate";
  name: string;
  started_at: string;
  last_heartbeat_at: string;
  current_task?: string | null;
}

export interface OverrideState {
  pa_global_pause: {
    active: boolean;
    since: string | null;
    set_by_session: string | null;
  };
  sa_pauses: Record<string, { since: string; set_by_session: string }>;
}

const SESSIONS_FILE = "sessions.json";
const STATE_FILE = "state.json";
const OFFSETS_FILE = "offsets.json";

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function atomicWrite(dir: string, name: string, content: string): void {
  ensureDir(dir);
  const tmp = join(dir, `${name}.tmp.${process.pid}.${Date.now()}`);
  writeFileSync(tmp, content);
  renameSync(tmp, join(dir, name));
}

function safeRead<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// --- sessions.json ---

export function readSessions(stateDir: string): SessionEntry[] {
  const data = safeRead<{ sessions: SessionEntry[] } | SessionEntry[]>(
    join(stateDir, SESSIONS_FILE),
    [],
  );
  if (Array.isArray(data)) return data;
  return data.sessions ?? [];
}

export function writeSession(stateDir: string, entry: SessionEntry): void {
  const sessions = readSessions(stateDir);
  const idx = sessions.findIndex((s) => s.session_id === entry.session_id);
  if (idx >= 0) sessions[idx] = entry;
  else sessions.push(entry);
  atomicWrite(stateDir, SESSIONS_FILE, JSON.stringify({ sessions }, null, 2));
}

export function removeSession(stateDir: string, session_id: string): void {
  const sessions = readSessions(stateDir).filter(
    (s) => s.session_id !== session_id,
  );
  atomicWrite(stateDir, SESSIONS_FILE, JSON.stringify({ sessions }, null, 2));
}

// --- state.json ---

const DEFAULT_STATE: OverrideState = {
  pa_global_pause: { active: false, since: null, set_by_session: null },
  sa_pauses: {},
};

export function readOverrideState(stateDir: string): OverrideState {
  return safeRead<OverrideState>(join(stateDir, STATE_FILE), DEFAULT_STATE);
}

export function setSAPause(
  stateDir: string,
  sa_session_id: string,
  set_by: string,
): void {
  const st = readOverrideState(stateDir);
  st.sa_pauses[sa_session_id] = {
    since: new Date().toISOString(),
    set_by_session: set_by,
  };
  atomicWrite(stateDir, STATE_FILE, JSON.stringify(st, null, 2));
}

export function clearSAPause(stateDir: string, sa_session_id: string): void {
  const st = readOverrideState(stateDir);
  delete st.sa_pauses[sa_session_id];
  atomicWrite(stateDir, STATE_FILE, JSON.stringify(st, null, 2));
}

export function setGlobalPause(stateDir: string, pa_session_id: string): void {
  const st = readOverrideState(stateDir);
  st.pa_global_pause = {
    active: true,
    since: new Date().toISOString(),
    set_by_session: pa_session_id,
  };
  atomicWrite(stateDir, STATE_FILE, JSON.stringify(st, null, 2));
}

export function clearGlobalPause(stateDir: string): void {
  const st = readOverrideState(stateDir);
  st.pa_global_pause = { active: false, since: null, set_by_session: null };
  atomicWrite(stateDir, STATE_FILE, JSON.stringify(st, null, 2));
}

// --- offsets-<receiver_id8>.json ---
//
// Per-instance file rather than a shared offsets.json, because each instance
// processes ALL JSONLs independently to decide whether to fire to its own
// session. A shared file would cause whichever instance ticks first to
// advance the offset for everyone else, masking events from peers.

function offsetsFileName(receiverId8: string): string {
  return `offsets-${receiverId8}.json`;
}

export function readOffsets(
  stateDir: string,
  receiverId8: string,
): Record<string, number> {
  return safeRead<Record<string, number>>(
    join(stateDir, offsetsFileName(receiverId8)),
    {},
  );
}

/**
 * Replace the entire offsets map for this receiver. Atomic temp+rename.
 *
 * The filewatcher accumulates per-file offset advances during a tick and
 * calls this once at the end with the merged map - one disk write per tick
 * per instance instead of one per processed file. (Old per-file writeOffset
 * caused N+1 writes per tick at scale; see agent_channel.ts processFile.)
 */
export function writeAllOffsets(
  stateDir: string,
  receiverId8: string,
  offsets: Record<string, number>,
): void {
  atomicWrite(
    stateDir,
    offsetsFileName(receiverId8),
    JSON.stringify(offsets, null, 2),
  );
}

/** @deprecated Use writeAllOffsets to batch per-tick. Kept for callers
 *  outside the filewatcher hot loop. */
export function writeOffset(
  stateDir: string,
  receiverId8: string,
  jsonlPath: string,
  offset: number,
): void {
  const offsets = readOffsets(stateDir, receiverId8);
  offsets[jsonlPath] = offset;
  writeAllOffsets(stateDir, receiverId8, offsets);
}
