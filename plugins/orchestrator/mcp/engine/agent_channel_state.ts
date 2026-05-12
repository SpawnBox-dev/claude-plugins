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

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";

/**
 * Functional classification of an agent session, distinct from `role`.
 *
 * `role` ("prime" / "subordinate") encodes the orchestration position:
 *  who has authority over whom. `kind` encodes WHAT this session is for
 *  so other consumers (skills, classifier policies, briefing renderers)
 *  can gate on identity without resorting to narrative pattern-matching
 *  on session names or inferring from the role alone.
 *
 *  - "prime"        : PA - the project's orchestrator session.
 *  - "subordinate"  : generic SA - the default working session.
 *  - "discord-bot"  : SA specialized for live Discord community ops.
 *                     role is still "subordinate" - kind distinguishes
 *                     it from generic SAs for /discord-bootstrap skill
 *                     identity checks + future per-kind classifier
 *                     allowlists.
 *
 * Set at launch by ORCHESTRATOR_SESSION_KIND (or SPAWNBOX_SESSION_KIND
 * for the legacy prefix). Optional - sessions launched without the env
 * leave it undefined and consumers fall back to role-based heuristics.
 */
export type SessionKind = "prime" | "subordinate" | "discord-bot";

export interface SessionEntry {
  session_id: string;
  id8: string;
  role: "prime" | "subordinate";
  name: string;
  started_at: string;
  last_heartbeat_at: string;
  current_task?: string | null;
  kind?: SessionKind;
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

/**
 * Atomic write with bounded retry on transient Windows file-lock errors.
 *
 * 0.30.32 (ghost-session fix): the prior single-attempt implementation
 * threw on the first EBUSY / EPERM / EACCES / ENOENT (mid-rename race),
 * which propagated up through writeSession into AgentChannel.heartbeat()'s
 * setInterval callback. In Bun + Node, an uncaught exception in a timer
 * callback silently halts the interval - one transient lock from OneDrive
 * sync, antivirus, or two concurrent sessions racing on sessions.json
 * was enough to permanently kill heartbeats for the rest of the session.
 *
 * Retry policy: 3 attempts with 50ms / 150ms / 450ms backoff. Total worst-
 * case latency 650ms before throw, well under heartbeat interval (30s) so
 * even a fully-retried write that ultimately fails is caught by the next
 * heartbeat tick. SYNCHRONOUS sleep loop (not async) because the existing
 * call sites are sync; converting them is a much bigger refactor and the
 * total stall is bounded.
 */
function atomicWrite(dir: string, name: string, content: string): void {
  ensureDir(dir);
  const target = join(dir, name);
  const RETRY_DELAYS_MS = [50, 150, 450];

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    // Fresh tmp filename per attempt so a half-written tmp from a prior
    // attempt's writeFileSync failure doesn't collide.
    const tmp = join(
      dir,
      `${name}.tmp.${process.pid}.${Date.now()}.${attempt}`,
    );
    try {
      writeFileSync(tmp, content);
      renameSync(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable =
        code === "EBUSY" ||
        code === "EPERM" ||
        code === "EACCES" ||
        code === "ENOENT";
      if (!retryable || attempt === RETRY_DELAYS_MS.length) {
        throw err;
      }
      // Best-effort cleanup of the failed tmp (ignore errors - it may
      // not exist if writeFileSync threw before creating it).
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
      // Synchronous sleep before next attempt. Atomics.wait on a fresh
      // SharedArrayBuffer is the canonical Bun/Node sync-sleep pattern.
      const buf = new SharedArrayBuffer(4);
      const view = new Int32Array(buf);
      Atomics.wait(view, 0, 0, RETRY_DELAYS_MS[attempt]);
    }
  }
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
