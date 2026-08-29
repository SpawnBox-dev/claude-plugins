import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { appendLifecycleLine, emitLifecycleLine } from "./engine/lifecycle_log";
import { sweepStateDir } from "./engine/state_gc";
import { execSync, spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  NOTE_TYPES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_PRIORITIES,
  RELATIONSHIP_TYPES,
  BRIEFING_SECTIONS,
  DIMENSIONS,
} from "./types";
import type { WorkItemStatus, Dimension, NoteType } from "./types";
import { getProjectDb, getGlobalDb } from "./db/connection";
import { handleRemember } from "./tools/remember";
import { handleSupersede } from "./tools/supersede";
import { handleRecall } from "./tools/recall";
import { handleOrient, getCrossSessionHealth } from "./tools/orient";
import { handlePrepare } from "./tools/prepare";
import { handleReflect } from "./tools/reflect";
import { handleCheckSimilar } from "./tools/check_similar";
import { appendToNoteContent, snapshotRevision, refreshNoteEmbedding } from "./tools/update_note_helpers";
import { resolveNoteId } from "./tools/id_resolver";
import { supersededSuffix } from "./tools/recall";
import { findRestatedBlockers, formatStalledClaimAdvisory } from "./engine/stalled_claim";
import { cascadeResolution } from "./tools/cascade";
import { composeUserProfile } from "./engine/composer";
import { generateId, now, extractKeywords, formatAge, stringifyCodeRefs, parseTagList, normalizeTagString, mergeTags, noteBadge, codeRefsInput } from "./utils";
import { createAutoLinks } from "./engine/linker";
import { EmbeddingClient, ACTIVE_EMBED_MODEL_REPO, ACTIVE_EMBED_MODEL, ACTIVE_EMBED_DIM } from "./engine/embeddings";

// 0.30.31: read plugin version from package.json at module load so the
// McpServer registration field + startup banner self-sync with the
// authoritative source. Previously this string was hand-edited in two
// spots and forgotten on every other version bump (notes 19a4438a,
// c1f87b01). One canonical source eliminates that drift forever.
const PLUGIN_VERSION: string = (() => {
  try {
    const pkgPath = join(import.meta.dir, "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version as string;
  } catch {
    return "0.0.0-unknown";
  }
})();
import { decideWatchdogAction } from "./engine/orphan_watchdog";
import { SessionTracker } from "./engine/session_tracker";
import { depositSignal, depositSignalBatch, WEAK_DEPOSIT } from "./engine/signal";
import { handleUpdateSessionTask } from "./tools/session_task";
import { handleHookEvent, buildHookEnvelope, HOOK_EVENTS, type HookEvent } from "./tools/hook_event";
import { AgentChannel } from "./engine/agent_channel";
import type { SessionEntry } from "./engine/agent_channel_state";
import { PermissionRelay } from "./engine/permission_relay";
import { appendSystemEvent, alertEmissionStats } from "./engine/agent_channel_state";
import { getLiveSessions } from "./engine/live_sessions";
import { handleRespondToPermission, RespondToPermissionInputSchema } from "./tools/permission";
import { homedir } from "node:os";

// ── Session ID fallback ─────────────────────────────────────────────────
//
// Tool handlers accept `session_id` as an optional param, but the model
// frequently forgets to pass it. The session-start hook writes the current
// session_id to a fallback file; we read it here as a last resort so
// cross-session discovery keeps working even without explicit handoff.
//
// Resolution order:
//   1. Explicit param (best)
//   2. CLAUDE_SESSION_ID env var (if Claude Code ever sets it on MCP spawn)
//   3. Per-claude-PID active-session-<pid> file (0.30.19+, race-free)
//   4. $CLAUDE_PROJECT_DIR/.orchestrator-state/active-session (legacy
//      single-file, last-writer-wins across concurrent siblings)
//
// Cache the first successful read for this MCP server's lifetime because the
// server is per-session by stdio design - its session_id cannot change.
//
// 0.30.19+ race fix (work_item ea1bec63): added the per-PID file resolution
// path. Walk the process tree to find the claude.exe PID in our ancestry,
// then read active-session-<claude_pid>. The hook writes both files; new
// MCPs prefer per-PID, old MCPs use legacy. This eliminates the impostor-
// MCP race where N concurrent claude sessions stomped each other's session_id
// in the shared active-session file.
let cachedFallbackSessionId: string | null = null;

// 0.69.0 (WI fda1a7f2): bounded-wait window for the per-PID file. The
// SessionStart hook was measured writing it ~12s after MCP boot on
// 2026-08-29, so we refuse the racy legacy file for this long rather than
// adopt a sibling's session_id. Non-blocking - startAgentChannel()'s
// existing 3s retry loop re-resolves until this expires.
const PROCESS_START_MS = Date.now();
const PER_PID_GRACE_MS = 15_000;

/**
 * Find the PID of the claude.exe (or `claude` on unix) process in this
 * MCP child's ancestry. Returns null if walking fails or claude isn't
 * found in the chain within a small bound.
 *
 * Windows: PowerShell + Get-CimInstance Win32_Process (wmic is deprecated
 * and being removed - the session-start hook already migrated to this).
 * Single PowerShell invocation walks the whole chain internally, so the
 * cold-start cost is one ~1-2s shell startup rather than N.
 *
 * Unix: read /proc/<pid>/stat for parent PID + comm.
 *
 * 0.30.36 (WI d78867af): migrated off wmic. PowerShell command passed via
 * -EncodedCommand (UTF-16LE base64) instead of inline quoting so we don't
 * have to fight cmd.exe -> PowerShell escape layering.
 */
/**
 * 0.69.0 (WI fda1a7f2): the walk's outcome, with WHY it failed.
 *
 * Previously every failure mode returned a bare null: PowerShell throwing, the
 * CIM query coming back empty, and the chain ending without a claude.exe were
 * indistinguishable. Two separate investigations on 2026-08-29 hit that wall -
 * one measured a null with claude.exe apparently 4 hops up, which no theory
 * explains, and the ambiguous return is why it stayed unexplained.
 */
type AncestorWalk = { pid: number | null; reason: string };

/** One-shot latch so a failing walk explains itself once, not per call. */
let walkNullLogged = false;

/**
 * VERIFIED ancestry: walks the real process tree. Never consults CLAUDE_PID.
 *
 * This is the ONLY acceptable source for the DESTRUCTIVE dedup path. An
 * inherited env var says "a claude with this PID exists"; it does NOT say
 * "that claude is my ancestor" - and any process spawned under a claude window
 * inherits it. On 2026-08-29 that distinction cost a live MCP: a rig whose
 * CLAUDE_PID named a real, live claude.exe killed that window's server. A name
 * check would have passed there; only the walk discriminates.
 */
function walkClaudeAncestorPid(): AncestorWalk {
  const start = process.pid;
  if (process.platform === "win32") {
    const script = `
$walk = ${start}
for ($i = 0; $i -lt 8; $i++) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $walk" -ErrorAction Stop
    if (-not $p) { [Console]::Error.WriteLine('cim-empty:' + $walk); break }
    if ($p.Name -eq 'claude.exe' -or $p.Name -eq 'claude') { Write-Output $walk; exit 0 }
    if (-not $p.ParentProcessId -or $p.ParentProcessId -eq 0 -or $p.ParentProcessId -eq $walk) { [Console]::Error.WriteLine('chain-end:' + $walk + ':' + $p.Name); break }
    $walk = $p.ParentProcessId
  } catch { [Console]::Error.WriteLine('cim-throw:' + $walk); break }
}
[Console]::Error.WriteLine('walk-exhausted:depth=' + $i)
`;
    // MARKERS USE CONCATENATION, NOT INTERPOLATION - this is load-bearing and
    // it cost a live server. "chain-end:$walk:" makes PowerShell read `$walk:`
    // as a DRIVE-QUALIFIED variable reference; the script then fails to PARSE,
    // produces no stdout, and the walk returns null unconditionally - a
    // diagnostic added to explain a null became a second cause of that null.
    // The obvious repair, `${walk}`, is ALSO wrong here: this string is a JS
    // template literal, so JavaScript would consume `${walk}` before PowerShell
    // ever saw it. Concatenation removes both traps at once. If you edit these
    // markers, run the script standalone and confirm it prints a PID.
    // spawnSync, NOT execSync. execSync only surfaces stderr by THROWING, so on
    // the ordinary exit-0 path - which is every "walked the chain and found no
    // claude" case - the cause markers the script just wrote were discarded and
    // the reason collapsed to a generic "no-claude-in-chain". The warden
    // demonstrated it: a bogus pid emits `cim-empty` + `walk-exhausted` and the
    // code never read either. spawnSync returns .stderr regardless of exit code,
    // so the null now carries the token that explains it.
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-EncodedCommand", encoded],
      { encoding: "utf8" },
    );
    // Extract OUR markers rather than dumping raw stderr. PowerShell wraps
    // stderr in CLIXML (`#< CLIXML <Objs Version=...>` plus progress records),
    // which is hundreds of characters of noise that would bury the tokens and
    // push them past any truncation. Measured, not assumed - the raw capture
    // came back as `#< CLIXML cim-empty:999999 walk-exhausted:depth=0 <Objs
    // Version="1.1.0.1" xmlns=...`. Match the four known markers instead.
    const tokens = ((res.stderr ?? "").toString().match(
      /(?:cim-empty|cim-throw|chain-end|walk-exhausted):[^\s<]*/g,
    ) ?? [])
      .join(" ")
      .slice(0, 200);
    if (res.error) {
      return {
        pid: null,
        reason: `exec-failed: ${res.error.message}${tokens ? ` | ${tokens}` : ""}`,
      };
    }
    const pid = parseInt((res.stdout ?? "").toString().trim(), 10);
    if (Number.isFinite(pid) && pid > 0) return { pid, reason: "found" };
    // Prefer the script's own token over a label we invented.
    return { pid: null, reason: tokens || "no-claude-in-chain-no-tokens" };
  }
  // Unix path
  let pid: number | null = start;
  for (let depth = 0; depth < 8 && pid; depth++) {
    let name = "";
    let ppid = 0;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rparen = stat.lastIndexOf(")");
      if (rparen < 0) return { pid: null, reason: `stat-malformed:${pid}` };
      name = stat.slice(stat.indexOf("(") + 1, rparen).toLowerCase();
      const fields = stat.slice(rparen + 2).split(/\s+/);
      ppid = parseInt(fields[1] ?? "0", 10);
    } catch {
      return { pid: null, reason: `proc-unreadable:${pid}` };
    }
    if (name === "claude.exe" || name === "claude") return { pid, reason: "found" };
    if (!ppid || ppid === pid) return { pid: null, reason: `chain-end:${pid}:${name}` };
    pid = ppid;
  }
  return { pid: null, reason: "walk-exhausted" };
}

function findClaudeAncestorPid(): number | null {
  // 0.69.0 (WI fda1a7f2): Claude Code sets CLAUDE_PID in the MCP server's
  // environment - the PID of the owning claude process. Verified present
  // alongside CLAUDE_CODE_SESSION_ID in three live sessions 2026-08-29.
  // Preferring it removes a ~1-2s PowerShell cold start from the boot path,
  // which is time spent inside the very window this race lives in.
  //
  // IDENTITY AND THE ORPHAN SELF-CHECK. The destructive dedup path must call
  // walkClaudeAncestorPid() directly - see its doc comment for why an inherited
  // env var is not ancestry.
  //
  // THE ASYMMETRY THAT DECIDES THIS ORDER (PA ruling 2026-08-29 16:37Z): the two
  // consumers have opposite failure costs. A false null here makes the startup
  // orphan check SHUT DOWN A HEALTHY SERVER - which is exactly what happened at
  // 16:32:35Z, killing a live session's MCP one second after it started. A false
  // null in the dedup path merely skips a cleanup. So this path prefers the env
  // var, which cannot fail for parsing or CIM reasons, and only walks when the
  // env is absent. A walk that can fail for any reason must never be able to
  // kill a healthy server.
  const envPid = Number.parseInt(process.env.CLAUDE_PID ?? "", 10);
  if (Number.isFinite(envPid) && envPid > 0) {
    // Verified fall-through on undefined / "" / "  " / "abc" / "0" - all parse
    // to NaN or 0 and reach the walk below. Checked directly, not assumed.
    //
    // Existence check so a STALE CLAUDE_PID (dead window, PID not yet reused)
    // isn't trusted forever. If we cannot confirm it, fall through to the walk
    // rather than adopting a pid that may be gone.
    if (getProcessCreationTime(envPid) !== null) return envPid;
    emitLifecycle(
      `claude-ancestor: CLAUDE_PID=${envPid} set but that process is not ` +
        `resolvable; falling through to process-tree walk (WI fda1a7f2)\n`,
    );
  }

  const walk = walkClaudeAncestorPid();
  if (walk.pid === null && !walkNullLogged) {
    walkNullLogged = true;
    // BOTH SINKS - see the probe line's comment. MCP stderr IS captured per
    // spawn; mcp-lifecycle.log is durable across them. Three investigations
    // stalled on an unexplained null because no reason was recorded anywhere;
    // this is the line that should finally name it.
    const nullLine =
      `claude-ancestor: WALK RETURNED NULL (reason=${walk.reason}) with ` +
      `CLAUDE_PID=${process.env.CLAUDE_PID ?? "<unset>"} - per-PID session ` +
      `resolution and dedup are degraded, and the orphan watchdog will not arm ` +
      `for this process (WI fda1a7f2)`;
    process.stderr.write(`[orchestrator] ${nullLine}\n`);
    // Trailing newline is REQUIRED: emitLifecycleLine writes the string
    // verbatim to both sinks and adds nothing, so a line without it runs into
    // the next record and breaks any anchored grep over the lifecycle log.
    emitLifecycle(nullLine + "\n");
  }
  return walk.pid;
}

function getFallbackSessionId(): string | undefined {
  if (cachedFallbackSessionId) return cachedFallbackSessionId;

  // 0.69.0 (WI fda1a7f2) - THE ROOT CAUSE OF THE BINDING RACE.
  // Claude Code sets CLAUDE_CODE_SESSION_ID. This step read CLAUDE_SESSION_ID,
  // a name the harness never sets, so resolution step 2 was DEAD CODE for the
  // plugin's entire life and every session fell through to the PID walk and
  // the racy shared file. Verified 2026-08-29 across three live sessions:
  // CLAUDE_CODE_SESSION_ID populated, CLAUDE_SESSION_ID empty.
  // CLAUDE_SESSION_ID is kept as an alias in case a future harness sets it.
  const envId =
    process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  if (envId && /^[a-zA-Z0-9_-]+$/.test(envId)) {
    cachedFallbackSessionId = envId;
    process.stderr.write(
      `[orchestrator] resolved session_id from ENV ` +
        `(${process.env.CLAUDE_CODE_SESSION_ID ? "CLAUDE_CODE_SESSION_ID" : "CLAUDE_SESSION_ID"}): ` +
        `${envId.slice(0, 8)}... (race-free - no file read)\n`,
    );
    return envId;
  }

  // Same 3-step fallback as getProjectDbPath in mcp/db/connection.ts.
  // Claude Code doesn't reliably set CLAUDE_PROJECT_DIR in MCP server env;
  // process.cwd() typically resolves to the user's project root.
  const projectDir =
    process.env.ORCHESTRATOR_PROJECT_ROOT ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const stateDir = join(projectDir, ".orchestrator-state");

  // 0.30.19+ race-free path: read per-claude-PID file. Each claude
  // session writes a file keyed on its own PID, so concurrent siblings
  // never collide.
  //
  // 0.30.24 fix: 0.30.23 removed the legacy fallback when a claude
  // ancestor existed but the per-PID file didn't. Turned out the hook
  // on Git Bash for Windows writes `active-session-1` (bash $PPID
  // resolves to 1, not the real claude.exe PID), so the per-PID file
  // for the bun's actual claude ancestor never exists. Without the
  // legacy fallback, session_id resolves to undefined and agent-channel
  // never starts. 0.30.24 restored the legacy fallback as defense-in-depth;
  // 0.30.28 then fixed the hook to write the correct claude.exe PID so
  // the per-PID path is the primary source going forward.
  const claudePid = findClaudeAncestorPid();
  if (claudePid) {
    const perPidFile = join(stateDir, `active-session-${claudePid}`);
    try {
      if (existsSync(perPidFile)) {
        const raw = readFileSync(perPidFile, "utf8").trim();
        if (raw && /^[a-zA-Z0-9_-]+$/.test(raw)) {
          cachedFallbackSessionId = raw;
          process.stderr.write(
            `[orchestrator] resolved session_id from per-PID file ` +
              `(claude_pid=${claudePid}): ${raw.slice(0, 8)}...\n`,
          );
          return raw;
        }
      }
    } catch {
      // Non-fatal - fall through to legacy
    }

    // 0.69.0 (WI fda1a7f2): BOUNDED WAIT before trusting the racy legacy file.
    // If we know our claude ancestor but its per-PID file hasn't appeared yet,
    // the SessionStart hook simply hasn't run - measured at 12s behind MCP boot
    // on 2026-08-29. Reading the shared file in that window is exactly how a
    // server adopts a SIBLING's session_id.
    //
    // This does NOT block: startAgentChannel() already retries every 3s for 60s
    // (see the retry loop at the bottom of this file), so returning undefined
    // simply defers to the next attempt. Tool calls are unaffected - agents pass
    // session_id explicitly, and resolveSessionId() returns that untouched.
    if (Date.now() - PROCESS_START_MS < PER_PID_GRACE_MS) {
      process.stderr.write(
        `[orchestrator] per-PID file not yet written ` +
          `(claude_pid=${claudePid}); deferring rather than racing the legacy ` +
          `file - retry loop will re-resolve\n`,
      );
      return undefined;
    }
  }

  // Legacy single-file fallback. Racy under concurrent siblings - the
  // file holds the LAST session that ran SessionStart, which may not be us.
  //
  // 0.69.0 (WI fda1a7f2): a claim that the orphan-bun watchdog makes impostor
  // races "self-resolve" used to sit here. IT IS FALSE and it sat directly
  // above the buggy branch, which is likely why this survived ea1bec63 and
  // 0.30.19-0.30.28. The watchdog reaps buns whose parent claude.exe is GONE;
  // an impostor's parent is alive BY DEFINITION. Measured 2026-08-29: a bun
  // held a wrong registration for 21 minutes with a healthy parent. The real
  // safety nets are the env var above and the heartbeat reconcile in
  // agent_channel.ts - not this fallback, which stays racy on purpose.
  const file = join(stateDir, "active-session");
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8").trim();
      if (raw && /^[a-zA-Z0-9_-]+$/.test(raw)) {
        cachedFallbackSessionId = raw;

        // 0.30.28+ per-PID write-back: when the legacy fallback succeeds AND
        // we have a real claude.exe ancestor PID, write our own per-PID file
        // with the resolved session_id. This is the "self-healing" path for
        // sessions that started BEFORE the 0.30.25 hook fix landed - the
        // hook wrote an incorrect file name (active-session-1 on Git Bash
        // for Windows), so the per-PID lookup above missed, and we fell
        // through to legacy. On a future MCP restart (plugin reload, etc.)
        // we'd race the legacy file again unless we leave a correct breadcrumb.
        // Writing the per-PID file here means the next restart finds it
        // immediately and skips the racy legacy fallback.
        if (claudePid) {
          const perPidFile = join(stateDir, `active-session-${claudePid}`);
          if (!existsSync(perPidFile)) {
            try {
              writeFileSync(perPidFile, raw, "utf8");
              process.stderr.write(
                `[orchestrator] wrote self-healing per-PID file ${perPidFile} = ${raw.slice(0, 8)}... ` +
                  `(future restarts will use this instead of racing legacy)\n`,
              );
            } catch {
              // Non-fatal - write-back is best-effort
            }
          }
        }

        process.stderr.write(
          `[orchestrator] resolved session_id from LEGACY active-session file ` +
            `(claude_pid=${claudePid ?? "<none>"} but per-PID file missing): ` +
            `${raw.slice(0, 8)}... (impostor-race possible if siblings are racing; ` +
            `watchdog will reap orphans within ~60s)\n`,
        );
        return raw;
      }
    }
  } catch {
    // Non-fatal - fallback is best-effort
  }

  return undefined;
}

/**
 * 0.69.0 (WI fda1a7f2): NON-CACHING authoritative identity read, for the
 * agent-channel heartbeat reconcile.
 *
 * Deliberately NOT `getFallbackSessionId()`: that caches, so a server that
 * latched a sibling's id at boot would keep returning the wrong answer forever
 * and the reconcile could never fire. Deliberately does NOT consult the legacy
 * shared `active-session` file either - that file is the race, and adopting it
 * on a 30s timer would let a server drift onto whichever sibling booted last.
 *
 * Env first (race-free, no file read), then the per-PID file, which the hook
 * has long since written by the first heartbeat tick. Cheap to call repeatedly:
 * findClaudeAncestorPid() now returns CLAUDE_PID from the environment without
 * spawning PowerShell.
 *
 * Returns undefined when neither source is readable - the caller MUST treat
 * that as "cannot verify", not as "identity is fine", and say so out loud.
 */
function readAuthoritativeSessionId(): string | undefined {
  const envId =
    process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  if (envId && /^[a-zA-Z0-9_-]+$/.test(envId)) return envId;

  const claudePid = findClaudeAncestorPid();
  if (!claudePid) return undefined;

  const projectDir =
    process.env.ORCHESTRATOR_PROJECT_ROOT ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const perPidFile = join(
    projectDir,
    ".orchestrator-state",
    `active-session-${claudePid}`,
  );
  try {
    if (existsSync(perPidFile)) {
      const raw = readFileSync(perPidFile, "utf8").trim();
      if (raw && /^[a-zA-Z0-9_-]+$/.test(raw)) return raw;
    }
  } catch {
    // Non-fatal - caller treats undefined as "cannot verify"
  }
  return undefined;
}

function resolveSessionId(explicit?: string): string | undefined {
  // 0.69.0 (WI fda1a7f2): IDENTITY IS NOT ATTRIBUTION. This used to cache the
  // caller-supplied id as the server's own identity. That is the split-brain:
  // agents pass session_id by hand and PA legitimately writes on peers' behalf
  // with THEIR id (see 6a5fae2a), so one typo or one on-behalf write silently
  // re-pointed this process's self-identity at another session.
  //
  // The explicit param now attributes THAT CALL ONLY. Self-identity comes from
  // getFallbackSessionId() (env -> per-PID file -> legacy) and can never be set
  // by a tool argument. The old caching existed to feed startAgentChannel's
  // retry loop when the env var was "unset" - it was only ever unset because
  // we were reading the wrong variable name, which is now fixed above.
  return explicit ?? getFallbackSessionId();
}

// ── Sidecar lifecycle ────────────────────────────────────────────────────
let embeddingClient: EmbeddingClient | null = null;
let sidecarProcess: ReturnType<typeof Bun.spawn> | null = null;
let sessionTracker: SessionTracker | null = null;

// Cache of sessions that have already been registered in this process.
// Skips redundant INSERT OR IGNORE + UPDATE round-trips on every tool call,
// which compounds C1 (SQLITE_BUSY) risk under concurrent siblings. Cleared
// only on process exit.
const registeredSessions = new Set<string>();

function registerSessionOnce(sessionId: string): void {
  if (!sessionTracker || registeredSessions.has(sessionId)) return;
  sessionTracker.registerSession(sessionId);
  registeredSessions.add(sessionId);
}
let sidecarStatus: "ready" | "starting" | "unavailable" | "error" = "starting";
let sidecarError: string | null = null;

async function trySpawn(
  cmd: string[],
  portFile: string,
  label: string,
  timeoutMs: number,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; port: number } | null> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: "ignore",
      stderr: "ignore",
    });

    // Wait for port file to appear, polling every 2s up to timeoutMs
    const maxAttempts = Math.ceil(timeoutMs / 2000);
    let port: number | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const content = await Bun.file(portFile).text();
        port = parseInt(content.trim(), 10);
        if (!isNaN(port) && port > 0) break;
        port = null;
      } catch {
        // Port file not ready yet
      }
    }

    if (!port) {
      try { proc.kill(); } catch { /* already dead */ }
      return null;
    }

    // Verify health (retry 3x with 2s delay)
    const client = new EmbeddingClient(`http://127.0.0.1:${port}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await client.isAvailable()) {
        console.error(`[embed] Sidecar ready on port ${port} via ${label}`);
        return { proc, port };
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
    }

    // Health check failed - kill the process
    try { proc.kill(); } catch { /* already dead */ }
    return null;
  } catch {
    // Command not found or spawn failed
    return null;
  }
}

async function startSidecar(): Promise<EmbeddingClient | null> {
  // Use CLAUDE_PLUGIN_ROOT (set by Claude Code for plugins) or fall back to import.meta.dir
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || resolve(import.meta.dir, "..");
  const sidecarPath = resolve(pluginRoot, "sidecar/embed_server.py");
  const requirementsPath = resolve(pluginRoot, "sidecar/requirements.txt");

  // 0.45.1 - THE PORT FILE MUST NOT LIVE UNDER pluginRoot.
  //
  // pluginRoot is the VERSION-SPECIFIC plugin cache directory
  // (.../plugins/cache/<market>/orchestrator/<version>/). Keeping the port
  // file there scoped the whole "reuse an existing sidecar" mechanism per
  // VERSION, so every release started a new generation: each session's MCP
  // looked in the new version's folder, found nothing, and spawned another
  // ~1.5GB Python sidecar - while adopters deliberately never kill a sidecar
  // they did not start ("let it outlive us"), so the old ones stayed resident.
  //
  // Observed on this machine after three releases in one afternoon: ELEVEN
  // .sidecar-port files, one per installed version, each on a different port,
  // and a system brought to a halt by concurrent python processes. The reuse
  // logic was correct; its SCOPE was wrong.
  //
  // A stable per-user path means one sidecar for the whole fleet across all
  // versions and upgrades. ~/.claude/orchestrator/ already exists as this
  // plugin's durable per-user state dir (mcp-lifecycle.log lives there).
  const sidecarStateDir = join(homedir(), ".claude", "orchestrator");
  try {
    if (!existsSync(sidecarStateDir)) mkdirSync(sidecarStateDir, { recursive: true });
  } catch {
    // Fall through - resolve() below still yields a usable path attempt.
  }
  const portFile = resolve(sidecarStateDir, "sidecar.port");

  // Reuse an existing healthy sidecar if one is already running. Each Claude
  // session spawns its own MCP server process, so without reuse we end up with
  // N Python sidecars each loading ~1.5GB of ONNX model weights. The port file
  // is written by whichever sidecar booted first; if we can reach it over HTTP,
  // adopt it instead of spawning a duplicate.
  try {
    const content = await Bun.file(portFile).text();
    const existingPort = parseInt(content.trim(), 10);
    if (!isNaN(existingPort) && existingPort > 0) {
      const client = new EmbeddingClient(`http://127.0.0.1:${existingPort}`);
      if (await client.isAvailable()) {
        // 0.47.1: HEALTHY IS NOT ENOUGH - it must serve the RIGHT MODEL.
        //
        // Across a model change the old sidecar is still alive and still
        // healthy, so the reuse path adopted it happily and every vector
        // written was produced by the PREVIOUS model while being tagged with
        // the new one. That is the exact corruption ACTIVE_EMBED_MODEL exists
        // to prevent, arriving through the one door that never checked.
        //
        // Dimension is the honest signal: it is a property of the loaded
        // weights, whereas /health's model NAME was a hardcoded literal until
        // this same release fixed it. Checking both means an old sidecar (with
        // a lying name) is still rejected on dimension.
        const dim = (await client.embed(["model check"]))?.[0]?.length ?? 0;
        if (dim === ACTIVE_EMBED_DIM) {
          console.error(`[embed] Reusing existing sidecar on port ${existingPort} (shared across sessions)`);
          // Do NOT set sidecarProcess - we didn't start it, so we must not kill
          // it on our exit. Let it outlive us so sibling sessions keep working.
          return client;
        }
        console.error(
          `[embed] Sidecar on port ${existingPort} serves dim=${dim}, expected ${ACTIVE_EMBED_DIM} ` +
          `(${ACTIVE_EMBED_MODEL}). Not adopting it - spawning the correct model instead.`,
        );
      }
    }
  } catch {
    // No port file or unreadable - proceed with spawn
  }

  // 0.45.2 - SPAWN LOCK. Without it the reuse check is a race: N MCP servers
  // starting in the same instant (exactly what /reload-plugins does across a
  // fleet) all read "no port file", all decide to spawn, and each loads its
  // own ~1.5GB model. The last writer wins the port file and the rest become
  // orphans nobody will ever kill, because adopters deliberately never kill a
  // sidecar they did not start. That is the failure that halted this machine.
  //
  // Only the lock HOLDER may spawn. Everyone else waits for the winner to
  // publish a port and adopts it. A lock older than LOCK_STALE_MS is treated
  // as abandoned (the holder crashed mid-spawn) and taken over, so a dead
  // process can never wedge the fleet into permanently having no sidecar.
  const lockFile = portFile + ".lock";
  const LOCK_STALE_MS = 90_000;
  let holdsLock = false;
  const releaseSpawnLock = () => {
    if (!holdsLock) return;
    holdsLock = false;
    try { require("node:fs").unlinkSync(lockFile); } catch { /* already gone */ }
  };
  try {
    const { openSync, closeSync } = await import("node:fs");
    try {
      // "wx" fails if the file exists - the atomic test-and-set we need.
      closeSync(openSync(lockFile, "wx"));
      holdsLock = true;
    } catch {
      const age = Date.now() - (statSync(lockFile).mtimeMs || 0);
      if (age > LOCK_STALE_MS) {
        try { const { unlinkSync } = await import("node:fs"); unlinkSync(lockFile); } catch {}
        try { closeSync(openSync(lockFile, "wx")); holdsLock = true; } catch {}
      }
    }
  } catch {
    // Lock machinery unavailable - fall through and spawn, preserving old
    // behaviour rather than leaving the session with no embeddings at all.
    holdsLock = true;
  }

  if (!holdsLock) {
    // Someone else is spawning. Wait for their port, then adopt it.
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const p = parseInt((await Bun.file(portFile).text()).trim(), 10);
        if (!isNaN(p) && p > 0) {
          const c = new EmbeddingClient(`http://127.0.0.1:${p}`);
          if (await c.isAvailable()) {
            console.error(`[embed] Adopted sidecar on port ${p} spawned by a peer (waited ${i + 1}s)`);
            return c;
          }
        }
      } catch {
        // Not published yet - keep waiting.
      }
    }
    console.error(`[embed] Waited 60s for a peer's sidecar and saw none; spawning our own.`);
  }

  // No reusable sidecar found - clean the stale port file (if any) and spawn fresh.
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(portFile);
  } catch {
    // File may not exist, that's fine
  }

  // 0.47.0: pass the model explicitly so mcp/engine/embeddings.ts is the single
  // source of truth. Relying on the sidecar's own default would let the two
  // drift, and a drift writes rows tagged with one model that were produced by
  // another - mixed, incomparable vectors that all claim to be comparable.
  const baseArgs = ["--port", "0", "--port-file", portFile, "--model", ACTIVE_EMBED_MODEL_REPO];

  // Try uvx first (handles Python + deps automatically, longer timeout for first-run downloads)
  let result = await trySpawn(
    ["uvx", "--with-requirements", requirementsPath, "python", sidecarPath, ...baseArgs],
    portFile,
    "uvx",
    60000,
  );

  // Fall back to direct python
  if (!result) {
    // Clean port file between attempts
    try { const { unlinkSync } = await import("node:fs"); unlinkSync(portFile); } catch {}
    result = await trySpawn(
      ["python", sidecarPath, ...baseArgs],
      portFile,
      "python",
      30000,
    );
  }

  // Fall back to python3
  if (!result) {
    try { const { unlinkSync } = await import("node:fs"); unlinkSync(portFile); } catch {}
    result = await trySpawn(
      ["python3", sidecarPath, ...baseArgs],
      portFile,
      "python3",
      30000,
    );
  }

  if (!result) {
    // Determine why we failed - check what's available
    let hasUv = false;
    let hasPython = false;
    try {
      const p = Bun.spawn(["uv", "--version"], { stdout: "pipe", stderr: "pipe" });
      await p.exited;
      if (p.exitCode === 0) hasUv = true;
    } catch {}
    try {
      const p = Bun.spawn(["python", "--version"], { stdout: "pipe", stderr: "pipe" });
      await p.exited;
      if (p.exitCode === 0) hasPython = true;
    } catch {}
    if (!hasPython) {
      try {
        const p = Bun.spawn(["python3", "--version"], { stdout: "pipe", stderr: "pipe" });
        await p.exited;
        if (p.exitCode === 0) hasPython = true;
      } catch {}
    }

    if (!hasPython) {
      sidecarError = "Python not installed";
    } else if (!hasUv) {
      sidecarError = "uv/uvx not installed";
    } else {
      sidecarError = "sidecar process failed to start";
    }

    console.error(
      `[embed] Sidecar unavailable (${sidecarError}): install uv (https://docs.astral.sh/uv/) for automatic embedding support, ` +
      "or install Python with: pip install -r sidecar/requirements.txt"
    );
    releaseSpawnLock();
    return null;
  }

  sidecarProcess = result.proc;
  // Release only AFTER the port file is published, so a waiter that sees the
  // lock gone is guaranteed to find a port rather than racing us to spawn.
  releaseSpawnLock();
  return new EmbeddingClient(`http://127.0.0.1:${result.port}`);
}

// 0.30.17+: opt-in PA-gated tool permission routing. When this env var is
// set, the orchestrator MCP declares the `claude/channel/permission`
// capability and routes inbound permission_request notifications through
// the agent-channel to PA for authorization (work_item 32250d62).
// Default-off: existing single-agent and multi-agent users without PA
// are unaffected.
const PERMISSION_RELAY_ENABLED =
  process.env.ORCHESTRATOR_PA_PERMISSION_RELAY === "1";

const experimentalCapabilities: Record<string, object> = {
  // Real-time channel notifications. Used by the agent-channel
  // subsystem (mcp/engine/agent_channel.ts) to deliver inline
  // <channel ...>content</channel> events for cross-session chat.
  // Same primitive the official Discord plugin uses.
  "claude/channel": {},
};
if (PERMISSION_RELAY_ENABLED) {
  experimentalCapabilities["claude/channel/permission"] = {};
}

const server = new McpServer(
  {
    name: "orchestrator",
    version: PLUGIN_VERSION,
  },
  {
    capabilities: {
      tools: {},
      experimental: experimentalCapabilities,
    },
    instructions: [
      "Cross-session events arrive as <channel source=\"plugin:orchestrator:core\" from_id8=\"...\" from_role=\"...\" event_type=\"...\" ...>content</channel> tags injected inline, like prompts you would have typed. (The source attribute is set automatically by Claude Code from the MCP server's plugin-qualified key.)",
      "",
      "Address other sessions in your terminal output using @PA / @PrimeAgent (the prime), @SA-<id8> (a specific subordinate), comma-separated lists @SA-<id8>,@SA-<id8>, or @all (every active session except yourself). The conversational form \"PA, ...\" or \"PrimeAgent, ...\" also addresses PA.",
      "",
      "TURN-FINAL RULE (load-bearing, verified on CC 2.1.172, WI f0d66029): the harness persists ONLY the turn-FINAL assistant text to the transcript the channel routes from - text you emit mid-turn (before a tool call in the same turn) is NEVER written to disk and therefore SILENTLY UNDELIVERABLE. Any @-addressed message (including @@@ envelopes) MUST be the last text of its turn: address, then END the turn. If you addressed someone and then kept working in the same turn, your message was dropped - re-send it turn-final. If a peer seems to ignore you, suspect this first.",
      "",
      "For ANY multi-paragraph or markdown-formatted message to specific recipients, use an EXPLICIT ENVELOPE - this is the DEFAULT, not an option: opener on its own line `@@@ @SA-<id8>` (or `@@@ @SA-a,@SA-b` / `@@@ @PA` / `@@@ @all`), then your content in whatever shape (blank lines, bold or colon headers, bullets, ``` code fences), then a closing line that is exactly `@@@`. Everything between is delivered whole and verbatim to those targets only; `@`-mentions inside are literal, not routing; the envelope neither rides nor breaks surrounding routing. A bare one-liner or a single addressed line needs no envelope; anything multi-part does.",
      "",
      "ENVELOPE EDGE CASE (rarely applies - do not over-weight): the envelope is parsed on the RECEIVING session and was added in orchestrator 0.30.46. A receiver still running a pre-0.30.46 orchestrator would not recognize the `@@@` lines and the message would be silently dropped. Per-session MCPs boot from the installed plugin version, so on a current fleet this does not occur and the envelope is the correct default. ONLY if you positively know a specific receiver is on a pre-0.30.46 orchestrator, fall back for that one message to the trap-safe form (ONE paragraph, single newlines, no blank lines, OR @-address every paragraph). Do NOT let this edge case talk you out of the envelope: unsure = use the envelope, not trap-safe.",
      "",
      "If you are a subordinate (role=subordinate), treat PA-addressed messages as if the user said them - they carry the user's authority AND permission for routine work: execute directly without re-litigating PA's authority or pulling the user in for permission he has effectively already granted. (Carve-out: genuinely destructive/irreversible ops still warrant an explicit confirm; the harness-gated prod ops - worker deploy, --remote D1 writes - are a separate layer needing the user's own in-window authorization, never PA's grant.) Then continue your work. SAs can address you too; those are peer-level, not authoritative.",
      "",
      "If you are PA (role=prime), you observe every event in the project by default. Address SAs to coordinate them. Use note() and create_work_item() to record orchestrator-plugin improvements you discover - tag with `agent-channel-improvement, area:orchestrator-plugin`.",
      "",
      "Override controls:",
      "- /pa-pause in an SA terminal: that SA stops obeying PA until /pa-resume.",
      "- /pa-pause in PA terminal: PA stands down across all SAs (global pause).",
      "- /pa-takeover in a new PA window: forcibly claims primacy from a previous PA.",
      "- Natural-language equivalents recognized: \"PA, back off / stand down / take five / pause\" and \"PA, come back in / resume\".",
      "",
      "During pause, PA still receives all events (so it stays informed) but does not respond, address SAs, or write directives. Events arriving during pause are tagged `pa_global_pause=\"true\"` or `sa_paused=\"true\"`.",
    ].join("\n"),
  },
);

// ── briefing ────────────────────────────────────────────────────────────
server.tool(
  "briefing",
  "Get up to speed on the current project. Returns open threads, recent decisions, work items, user profile, neglected areas, your last checkpoint, and cross-session activity (what other sessions have discovered since your last briefing). Use at session start, after context compaction, or whenever you feel you're missing context. Pass `session_id` to enable cross-session discovery injection - strongly recommended. Pass `sections` to reduce context cost. **`output_mode`** (0.30.22+): pass `output_mode: \"summary\"` for a compressed rendering (per-item content trimmed from 120 to 60 chars, recovery checkpoint and auto-retro bodies trimmed to 240 chars). Default `\"full\"` (current rendering).",
  {
    event: z.enum(["startup", "resume", "clear", "compact"]).optional().default("startup"),
    sections: z
      .array(z.enum(BRIEFING_SECTIONS))
      .optional()
      .describe("Filter to specific sections. Omit for full briefing. Options: work_items, open_threads, decisions, neglected, drift, user_model, cross_project, cross_session, checkpoint, curation_candidates"),
    output_mode: z.enum(["full", "summary"]).optional().describe("'full' (default): current rendering. 'summary': per-item content truncated to 60 chars (was 120), recovery checkpoint and auto-retro bodies truncated to 240 chars. Use when you just need the shape of in-flight work without full content."),
    session_id: z
      .string()
      .optional()
      .describe("Session ID. Required for cross_session updates (what other active sessions have discovered since your last briefing). Strongly recommended - pass your session identifier."),
  },
  async ({ event, sections, output_mode, session_id }) => {
    // Register the session before running the briefing so cross-session
    // tracking has a row to compare against next time.
    session_id = resolveSessionId(session_id);
    if (session_id) registerSessionOnce(session_id);
    const result = handleOrient(
      getProjectDb(),
      getGlobalDb(),
      {
        event: event ?? "startup",
        sections: sections ?? undefined,
        session_id,
      },
      sessionTracker
    );

    // Deposit weak signal on notes surfaced in the briefing
    const briefingNoteIds = [
      ...result.briefing.active_work,
      ...result.briefing.blocked_work,
      ...result.briefing.overdue_work,
      ...result.briefing.recently_completed,
      ...result.briefing.open_threads,
      ...result.briefing.recent_decisions,
    ].map(n => n.id);
    if (briefingNoteIds.length > 0) {
      depositSignalBatch(getProjectDb(), briefingNoteIds, WEAK_DEPOSIT);
    }

    let text = result.formatted;

    // 0.30.22 summary mode: post-process the formatted briefing to compress
    // verbose sections. The composer already truncates per-item content to
    // 120 chars; summary mode tightens that further to 60 and trims long
    // checkpoint / auto-retro bodies to 240. Done as a post-process here
    // rather than threaded through composer.ts to keep the change surgical.
    if (output_mode === "summary") {
      text = compactBriefingText(text);
    }

    // Append system status when embeddings need attention
    if (sidecarStatus !== "ready" && event === "startup") {
      text += "\n## Setup Available\n";
      text += "Semantic search (embeddings) is not active. Call `install_embeddings` to check dependencies and enable it.\n";
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

/**
 * Post-process a briefing's formatted text for summary mode (0.30.22).
 *
 * Strategy: walk lines, detect work-item / open-thread / decision list lines
 * (start with `- ` and contain `**<id>**` markup), trim the content portion
 * after the id+metadata to ~60 chars. Section headers and short metadata
 * lines are preserved verbatim.
 *
 * Also trims the bodies of long auto-retro and recovery-checkpoint sections,
 * which can dominate briefing length when present.
 */
function compactBriefingText(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCheckpoint = false;
  let inAutoRetro = false;
  let bodyBudget = 240;
  const truncateSnippet = (s: string, n: number) =>
    s.length > n ? s.slice(0, n).trimEnd() + "..." : s;

  for (const raw of lines) {
    // Section boundaries reset the budget for verbose bodies.
    if (raw.startsWith("## ")) {
      inCheckpoint = raw.includes("Recovery Checkpoint");
      inAutoRetro = raw.includes("Auto-Retro");
      bodyBudget = 240;
      out.push(raw);
      continue;
    }
    if (raw.startsWith("# ")) {
      inCheckpoint = false;
      inAutoRetro = false;
      out.push(raw);
      continue;
    }

    // List items: `- ... **<id>** rest...` → trim rest to ~60 chars.
    const listMatch = raw.match(/^(\s*-\s+(?:[^*]*?\*\*[\w-]+\*\*\s+))(.*)$/);
    if (listMatch) {
      const prefix = listMatch[1];
      const body = listMatch[2];
      out.push(prefix + truncateSnippet(body, 60));
      continue;
    }

    // Verbose body sections (Recovery Checkpoint, Auto-Retro): apply a
    // section-wide character budget. Once exhausted, append a marker and
    // skip remaining body lines until the next section header.
    if (inCheckpoint || inAutoRetro) {
      if (bodyBudget > 0) {
        const trimmed = raw.length > bodyBudget ? raw.slice(0, bodyBudget) + "..." : raw;
        out.push(trimmed);
        bodyBudget -= trimmed.length;
      } else if (out[out.length - 1] !== "[...trimmed for summary mode]") {
        out.push("[...trimmed for summary mode]");
      }
      continue;
    }

    out.push(raw);
  }

  return out.join("\n");
}

// ── system_status ────────────────────────────────────────────────────────
server.tool(
  "system_status",
  "Check the health of the orchestrator system: embedding sidecar, note counts, embedding coverage, session tracking.",
  {},
  async () => {
    const projectDb = getProjectDb();
    const globalDb = getGlobalDb();

    // Note counts
    const projectNotes = (projectDb.query("SELECT COUNT(*) as cnt FROM notes").get() as any).cnt;
    const globalNotes = (globalDb.query("SELECT COUNT(*) as cnt FROM notes").get() as any).cnt;

    // Embedding coverage. 0.47.2: count only rows the CURRENT model can use.
    // Counting every row regardless of model reported 100% coverage
    // immediately after a model switch, when in fact NONE of those vectors
    // were usable - search was silently keyword-only while status claimed full
    // health. A coverage number that cannot go down when coverage is lost is
    // not a status, it is decoration.
    let embeddedCount = 0;
    let staleModelCount = 0;
    try {
      embeddedCount = (projectDb
        .query("SELECT COUNT(*) as cnt FROM embeddings WHERE model = ?")
        .get(ACTIVE_EMBED_MODEL) as any).cnt;
      staleModelCount = (projectDb
        .query("SELECT COUNT(*) as cnt FROM embeddings WHERE model <> ?")
        .get(ACTIVE_EMBED_MODEL) as any).cnt;
    } catch {}

    const coveragePct = projectNotes > 0 ? Math.round((embeddedCount / projectNotes) * 100) : 0;

    // Session count
    let activeSessions = 0;
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      activeSessions = (projectDb.query("SELECT COUNT(*) as cnt FROM session_registry WHERE last_active_at >= ?").get(oneDayAgo) as any).cnt;
    } catch {}

    const lines: string[] = [];
    lines.push("## System Status");
    lines.push("");
    // 0.30.94: report WHEN this bundle was written, not just its number.
    //
    // SA-5a433456's suggestion, from a real confusion tonight: six terminals
    // were reloaded over ~20 minutes while releases were still being published,
    // so four different versions were fetched and every session could truthfully
    // say "I reloaded". Deciding whether a given session was CURRENT required
    // knowing what happened to be newest at the instant it fetched - knowledge
    // only the publisher had, which turned a self-check into a six-way poll.
    //
    // The bundle's mtime makes the answer self-describing: a session can state
    // when its own code was written and anyone can compare, without a central
    // authority. Labelled as the bundle timestamp rather than "published",
    // because that is what it honestly is - when THIS copy was written to disk.
    let bundleStamp = "";
    try {
      const self = process.argv[1];
      if (self) {
        bundleStamp = ` - bundle ${statSync(self).mtime.toISOString()}`;
      }
    } catch {
      /* best-effort: a missing stamp is better than a wrong one */
    }
    lines.push(
      `- **Version**: orchestrator MCP server **${PLUGIN_VERSION}** (pid ${process.pid})${bundleStamp}`
    );
    if (agentChannel) {
      lines.push(`- **Agent-channel**: ACTIVE - filewatcher running`);
    } else {
      const envSid = process.env.CLAUDE_SESSION_ID ? "set" : "unset";
      const orchProjectRoot = process.env.ORCHESTRATOR_PROJECT_ROOT;
      const claudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
      const cwd = process.cwd();
      const resolvedProjectDir = orchProjectRoot || claudeProjectDir || cwd;
      const fallbackFile = join(resolvedProjectDir, ".orchestrator-state", "active-session");
      const fallbackExists = existsSync(fallbackFile);
      lines.push(`- **Agent-channel**: INACTIVE`);
      lines.push(`    - CLAUDE_SESSION_ID env: ${envSid}`);
      lines.push(`    - ORCHESTRATOR_PROJECT_ROOT env: ${orchProjectRoot ?? "unset"}`);
      lines.push(`    - CLAUDE_PROJECT_DIR env: ${claudeProjectDir ?? "unset"}`);
      lines.push(`    - process.cwd(): ${cwd}`);
      lines.push(`    - **Resolved project dir**: ${resolvedProjectDir}`);
      lines.push(`    - active-session fallback file: ${fallbackExists ? "exists" : "missing at " + fallbackFile}`);
      lines.push(`    - cachedFallbackSessionId: ${resolveSessionId() ?? "undefined"}`);
    }
    lines.push(`- **Knowledge base**: ${projectNotes} notes (project), ${globalNotes} notes (global)`);

    if (sidecarStatus === "ready") {
      lines.push(
        `- **Embeddings**: active (${embeddedCount}/${projectNotes} notes embedded, ${coveragePct}% coverage)` +
          (staleModelCount > 0
            ? ` - WARNING: ${staleModelCount} note(s) still carry vectors from a previous model and are INVISIBLE to semantic search until re-embedded (backfillChunks)`
            : ``),
      );
    } else if (sidecarStatus === "starting") {
      lines.push("- **Embeddings**: starting up...");
    } else {
      lines.push("- **Embeddings**: unavailable - semantic search disabled, using keyword-only (FTS5)");
      if (sidecarError) {
        lines.push(`  - Reason: ${sidecarError}`);
      }
      lines.push("  - To enable: call `install_embeddings` tool, or manually install uv (https://docs.astral.sh/uv/)");
    }

    lines.push(`- **Active sessions** (24h): ${activeSessions}`);

    // Cross-session health - surfaces silent migration/query failures
    const xsHealth = getCrossSessionHealth();
    if (!xsHealth.healthy) {
      lines.push(`- **Cross-session discovery**: DEGRADED`);
      if (xsHealth.last_error) {
        lines.push(`  - Last error: ${xsHealth.last_error}`);
      }
      lines.push(`  - Expected migration 13 to be applied. Check with: bun test, then re-run a briefing.`);
    }

    // 0.32.3: liveness-detector firing rate. Reported because the answer to
    // "is this alert still crying wolf?" was previously assembled from agents'
    // recollection across days - see alertEmissionStats. Rate only; nothing
    // here knows whether a firing was CORRECT, and it must not imply it does.
    try {
      // Same path the AgentChannel constructor uses (see its instantiation).
      // Resolved the same way the AgentChannel constructor resolves it - the
      // cache dir must NOT be used, it is wiped on /plugin update.
      const channelStateDir = join(
        process.env.ORCHESTRATOR_PROJECT_ROOT ||
          process.env.CLAUDE_PROJECT_DIR ||
          process.cwd(),
        ".orchestrator-state",
        "agent-channel"
      );
      const alertStats = alertEmissionStats(channelStateDir);
      if (alertStats.length > 0) {
        lines.push(`- **Liveness alerts fired** (rate only - correctness is not tracked):`);
        for (const a of alertStats.slice(0, 6)) {
          const when = new Date(a.last_emit_ms).toISOString().replace("T", " ").slice(0, 16);
          const span =
            a.first_emit_ms && a.emit_count > 1
              ? ` over ${Math.max(1, Math.round((a.last_emit_ms - a.first_emit_ms) / 3_600_000))}h`
              : "";
          lines.push(
            `  - ${a.alert_kind} -> ${a.subject_session.slice(0, 8)}: ${a.emit_count}x${span}, last ${when}Z`
          );
        }
      }
    } catch {
      // Channel DB unavailable (no fleet yet). Not a status failure.
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ── install_embeddings ──────────────────────────────────────────────────
server.tool(
  "install_embeddings",
  "Check and install dependencies needed for semantic search embeddings. Detects Python and uv availability, installs uv via pip if Python is available, and verifies the embedding sidecar can start.",
  {
    action: z.enum(["check", "install"]).optional().default("check"),
  },
  async ({ action }) => {
    const lines: string[] = [];

    // Check what's available
    const checks = {
      python: false,
      pythonPath: "",
      uv: false,
      uvPath: "",
    };

    // Check python
    try {
      const proc = Bun.spawn(["python", "--version"], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      if (proc.exitCode === 0) {
        const stdout = await new Response(proc.stdout).text();
        checks.python = true;
        checks.pythonPath = stdout.trim();
      }
    } catch {}

    if (!checks.python) {
      try {
        const proc = Bun.spawn(["python3", "--version"], { stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        if (proc.exitCode === 0) {
          const stdout = await new Response(proc.stdout).text();
          checks.python = true;
          checks.pythonPath = stdout.trim();
        }
      } catch {}
    }

    // Check uv
    try {
      const proc = Bun.spawn(["uv", "--version"], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      if (proc.exitCode === 0) {
        const stdout = await new Response(proc.stdout).text();
        checks.uv = true;
        checks.uvPath = stdout.trim();
      }
    } catch {}

    if (action === "check") {
      lines.push("## Embedding Dependencies Check");
      lines.push("");
      lines.push(`- Python: ${checks.python ? `installed (${checks.pythonPath})` : "NOT FOUND"}`);
      lines.push(`- uv: ${checks.uv ? `installed (${checks.uvPath})` : "NOT FOUND"}`);
      lines.push(`- Sidecar: ${sidecarStatus}`);
      lines.push("");

      if (checks.python && checks.uv) {
        lines.push("All dependencies are installed. If the sidecar isn't running, it may need a restart.");
        if (sidecarStatus !== "ready") {
          lines.push("Try restarting the session to trigger sidecar startup.");
        }
      } else if (checks.python && !checks.uv) {
        lines.push("Python is installed but uv is missing. uv manages the sidecar's virtual environment and dependencies automatically.");
        lines.push("");
        lines.push("To install uv, call this tool again with action='install', which will run: `pip install uv`");
      } else {
        lines.push("Python is not installed. The embedding sidecar requires Python 3.10+.");
        lines.push("");
        lines.push("Install Python from https://www.python.org/downloads/ then restart the session.");
        lines.push("After Python is installed, call this tool again to install uv.");
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    // action === "install"
    if (!checks.python) {
      return {
        content: [{
          type: "text" as const,
          text: "Cannot install uv: Python is not available. Please install Python 3.10+ from https://www.python.org/downloads/ first, then call this tool again."
        }]
      };
    }

    if (checks.uv) {
      lines.push("uv is already installed. Attempting to start the embedding sidecar...");
      // Try starting the sidecar
      const client = await startSidecar();
      if (client) {
        embeddingClient = client;
        sidecarStatus = "ready";
        sidecarError = null;
        // Trigger backfill
        client.backfill(getProjectDb()).catch(console.error);
        lines.push("Sidecar started successfully! Semantic search is now active.");
        lines.push("Backfilling embeddings for existing notes in the background.");
      } else {
        lines.push("Sidecar failed to start. Check the logs for details.");
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    // Install uv via pip
    lines.push("Installing uv via pip...");
    try {
      const cmd = checks.pythonPath.includes("python3") ? "python3" : "python";
      const proc = Bun.spawn([cmd, "-m", "pip", "install", "uv"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;

      if (proc.exitCode === 0) {
        lines.push("uv installed successfully!");
        lines.push("");
        lines.push("Now attempting to start the embedding sidecar...");

        const client = await startSidecar();
        if (client) {
          embeddingClient = client;
          sidecarStatus = "ready";
          sidecarError = null;
          client.backfill(getProjectDb()).catch(console.error);
          lines.push("Sidecar started! Semantic search is now active.");
          lines.push("First run will download the bge-m3 model (~1.5GB). This happens once and is cached.");
        } else {
          lines.push("uv installed but sidecar didn't start. Try restarting the session.");
        }
      } else {
        const stderr = await new Response(proc.stderr).text();
        lines.push(`pip install failed: ${stderr.slice(0, 200)}`);
        lines.push("Try running manually: python -m pip install uv");
      }
    } catch (err) {
      lines.push(`Installation error: ${err}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ── note ────────────────────────────────────────────────────────────────
server.tool(
  "note",
  "Capture knowledge not already known. Use when something new is learned, decided, or observed - AND no existing note covers it. If a lookup just showed you a related note that's now stale/wrong/incomplete, prefer update_note, supersede_note, or close_thread on that note instead of creating a new one. Maintenance verbs are equal-priority to this one - the orchestrator is a living knowledge base, not an append-only log. Don't batch captures; write immediately so future sessions benefit. Pass session_id so sibling sessions can see what you've created. When the knowledge is about specific code (an architecture insight, a gotcha, a pattern), add `code_refs: ['mcp/server.ts']` so the note is discoverable later via `lookup({code_ref: 'mcp/server.ts'})`. Breadcrumbs only - file or module paths, not line numbers or symbol names (code indexers handle those). Near-duplicate gate: for types decision/convention/anti_pattern, note() will BLOCK the write if embedding similarity is at/above the type's bar (0.75 decision/convention, 0.85 anti_pattern) against an existing note, and will return candidates. **Your body is stashed server-side** - re-call with `pending_id` (returned in the block message) plus a `resolution` of accept_new / update_existing / supersede_existing / close_existing. Do NOT re-send `content`. Each candidate also lists `overlapping terms (indicative, not the match basis)` - shared vocabulary shown as EVIDENCE. The block itself is decided by embedding similarity, not by those terms, so treat them as a hint and judge the CLAIMS: heavy shared jargon plus genuinely different claims is the signature of a false positive, and accept_new is correct there.",
  {
    content: z.string().optional().describe("The knowledge to capture. Required UNLESS you pass `pending_id` to commit a gate-blocked note."),
    type: z.enum(NOTE_TYPES).optional().describe("Note type. Required UNLESS you pass `pending_id` to commit a gate-blocked note."),
    pending_id: z
      .string()
      .optional()
      .describe("Token returned when the near-duplicate gate blocks a write. Pass it WITH a `resolution` to commit the stashed body - do NOT re-send `content`. One-shot; expires after 60 minutes. Any field you also pass explicitly overrides the stashed value, so you can amend while committing."),
    context: z.string().optional(),
    tags: z.string().optional(),
    scope: z.enum(["global", "project"]).optional(),
    dimension: z
      .enum(DIMENSIONS)
      .optional()
      .describe("For user_pattern notes: explicitly set the dimension instead of relying on auto-inference"),
    session_id: z
      .string()
      .optional()
      .describe("Session ID that authored this note. Enables cross-session discovery - other active sessions will see this note in their next briefing under 'Cross-Session Activity'. Strongly recommended."),
    resolution: z
      .object({
        action: z.enum(["accept_new", "update_existing", "supersede_existing", "close_existing"]),
        target_id: z
          .string()
          .optional()
          .describe("Required for update_existing / supersede_existing / close_existing actions. The id of the near-duplicate candidate being acted on."),
        reason: z
          .string()
          .optional()
          .describe("Why this resolution was chosen. Becomes context on supersede, or resolution text on close_thread."),
      })
      .optional()
      .describe("Required when note() detects near-duplicate candidates (embedding similarity >= 0.75 for types: decision, convention, anti_pattern). Omit when there are no candidates, and the write proceeds normally. When candidates exist, agent must choose: accept_new (candidates are adjacent but genuinely different - both stand); update_existing (APPENDS your content to the target as a timestamped segment - no new note is created; pass ONLY the delta and do NOT pre-merge the target's existing body into your content, or the shared text lands twice); supersede_existing (create new and mark target as superseded, preserves history); close_existing (create new and mark target as resolved)."),
    code_refs: codeRefsInput("Array of file or module paths this note points at (e.g. ['mcp/server.ts', 'src/core/backup/']). Breadcrumbs for code navigation - not line numbers or symbols (code indexers handle those). Used for reverse-index lookup ({code_ref: 'path'}) so agents can find notes about a file they're editing. Paths are normalized: leading './' stripped, backslashes converted to forward slashes, trimmed. Trailing slash preserved (distinguishes file vs directory ref). Each path: 1-500 chars; array max 50 entries."),
  },
  async ({ content, type, context, tags, scope, dimension, session_id, resolution, code_refs, pending_id }) => {
    session_id = resolveSessionId(session_id);
    if (session_id) registerSessionOnce(session_id);
    const result = await handleRemember(getProjectDb(), getGlobalDb(), {
      content: content as string,
      type: type as NoteType,
      context,
      tags,
      scope,
      dimension: dimension as Dimension | undefined,
      session_id,
      resolution,
      code_refs,
      pending_id,
    }, embeddingClient);
    return {
      content: [{ type: "text" as const, text: result.message }],
    };
  }
);

// ── lookup ──────────────────────────────────────────────────────────────
server.tool(
  "lookup",
  "Search what the team already knows about this code/decision/area. Use this **alongside** your normal investigation (reading source, checking docs, web research) when you wonder 'has this been decided before?', when you encounter unfamiliar code, or when you want to check for existing conventions or anti-patterns. The orchestrator is additive (decision 3b962e67): it surfaces team-level history and cross-session context you'd otherwise miss, NOT a substitute for reading the actual code or current docs. Searches both project and cross-project knowledge using full-text search with BM25 ranking. Use `code_ref: 'path/to/file.ts'` to filter to notes that reference this exact file or module path in their code_refs - answers 'what was learned/decided about X?' queries to layer onto your own reading of X. **Type-only enumeration** (0.30.20+): pass `{type: \"user_pattern\"}` (or any note type) without `query`/`id` to list the most-recent N notes of that type - useful for PA bootstrap loading user-patterns / decisions / anti-patterns into context. Combine `type` with `tag` or `code_ref` to narrow further. **Tag-only enumeration**: pass `{tag: \"some-tag\"}` without `query`/`id`/`type` to list notes whose tags contain that substring (signal-ranked). Combine with `type` and/or `code_ref` to narrow. **id8 prefix** (0.30.21+): `id` accepts both the full 36-char UUID and the 8-char hex prefix surfaced in hook hints, agent-channel events, and stop nudges. Ambiguous prefixes return an error listing the candidates. **`output_mode`** (0.30.22+): pass `output_mode: \"summary\"` to get a compact one-line-per-result rendering (id8 + type + truncated content) - useful when you're enumerating to find a candidate ID without needing full content. Default is `\"full\"` (current rich rendering with content, code_refs, maintain hints, etc.). **Pagination** (0.30.28+): pass `offset: N` with the same `limit` to fetch the next page. Response message indicates the next offset when more results exist - use this to traverse large enumerations or wide searches without overflowing.",
  {
    query: z.string().optional(),
    id: z.string().optional(),
    type: z.enum(NOTE_TYPES).optional(),
    tag: z.string().optional().describe("Filter results by tag (substring match on comma-separated tags field)"),
    limit: z.coerce.number().optional(),
    offset: z.coerce.number().min(0).optional().describe("Pagination offset (0.30.28+). Pass `offset: N` with the same `limit` to fetch the next page of search-mode or list-mode results. Default 0. Response message indicates the next offset when more results are available."),
    depth: z.coerce.number().min(1).max(5).optional(),
    include_superseded: z.coerce.boolean().optional().describe("If true, include notes that have been superseded by newer ones. Default false - superseded notes are hidden from search results but still retrievable by explicit id lookup."),
    include_history: z.coerce.boolean().optional().describe("If true, detail-mode lookup (when id is provided) includes the ordered revision chain from note_revisions. Default false. Superseded-chain sections are ALWAYS included in detail view regardless of this flag - they come from the links graph, not the revision table."),
    link_limit: z.coerce.number().min(0).max(500).optional().describe("Cap on number of linked notes returned in detail-mode lookup. Default 20. Set to 0 to skip linked notes entirely (useful for heavily-connected umbrella notes). Set higher (up to 500) to get the full neighborhood. Superseded-chain links are always shown separately and don't count against this limit."),
    code_ref: z.string().optional().describe("Filter results to notes that reference this exact file or module path in their code_refs array. Exact string match; no wildcards. Useful for 'what do we know about mcp/server.ts?' queries."),
    output_mode: z.enum(["full", "summary"]).optional().describe("'full' (default): rich rendering with content, code_refs, maintain hints, annotations. 'summary': one-liner per result (id8 + type + truncated content), no code_refs / hints / annotations. Detail-mode (`id`-by-id) summary: type + truncated content, no linked notes, no supersede chain, no maintain hints. Use summary mode when enumerating candidates without needing full bodies."),
    session_id: z.string().optional().describe("Session ID for tracking which notes have been surfaced. Enables dedup annotations."),
  },
  async ({ query, id, type, tag, limit, offset, depth, include_superseded, include_history, link_limit, code_ref, output_mode, session_id }) => {
    const projectDb = getProjectDb();
    const result = await handleRecall(
      projectDb,
      getGlobalDb(),
      {
        query,
        id,
        type,
        tag,
        limit,
        offset,
        depth,
        include_superseded,
        include_history,
        link_limit,
        code_ref,
      },
      embeddingClient
    );

    // Session tracking: register session, advance turn, annotate results
    session_id = resolveSessionId(session_id);
    let turn: number | null = null;
    const tracker = sessionTracker;
    if (session_id && tracker) {
      registerSessionOnce(session_id);
      turn = tracker.nextTurn(session_id);
    }

    // Collect all note IDs from results for annotation
    const noteIds: string[] = [];
    if (result.detail) {
      noteIds.push(result.detail.id);
    }
    for (const r of result.results) {
      noteIds.push(r.id);
    }

    // Build annotation map if session tracking is active
    const annotations = new Map<string, import("./engine/session_tracker").SessionAnnotation>();
    if (session_id && tracker && turn !== null) {
      for (const noteId of noteIds) {
        // Annotate BEFORE logging (so "already_sent" reflects prior lookups, not this one)
        const annotation = tracker.annotateResult(session_id, noteId, turn);
        annotations.set(noteId, annotation);

        // Log that we surfaced this note
        const deliveryType = annotation.already_sent ? "refresh" : "fresh";
        tracker.logSurfaced(session_id, noteId, turn, deliveryType);
      }
    }

    // Deposit pheromone signal on all surfaced notes (regardless of session tracking)
    if (noteIds.length > 0) {
      depositSignalBatch(projectDb, noteIds);
    }

    // Format annotation marker for a note
    function annotationMarker(noteId: string): string {
      const ann = annotations.get(noteId);
      if (!ann) return "";
      const parts: string[] = [];
      if (ann.already_sent && ann.sent_turns_ago !== null) {
        parts.push(`already sent ${ann.sent_turns_ago} turn(s) ago`);
      }
      if (ann.hot_across_sessions > 0) {
        parts.push(`HOT: ${ann.hot_across_sessions} other session${ann.hot_across_sessions === 1 ? "" : "s"} touched this in last 2h`);
      } else if (ann.sent_to_other_sessions.length > 0) {
        parts.push(`sent to ${ann.sent_to_other_sessions.length} other session(s)`);
      }
      return parts.length > 0 ? ` [${parts.join("; ")}]` : "";
    }

    const summaryMode = output_mode === "summary";
    const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + "..." : s);

    let text = result.message;
    if (result.detail) {
      const age = formatAge(result.detail.updated_at);
      const src = result.detail.source_session ? ` by:${result.detail.source_session.slice(0, 8)}` : "";
      // 0.36.0: a SELF-supersede is corruption, not a supersede, and it must
      // not render as one.
      //
      // Detail-mode lookup deliberately returns superseded notes - that is
      // correct, you often want to read a retired note by id. It labels them
      // `[SUPERSEDED by <id>]`. But when the id is the note's OWN, that label
      // reads as an ordinary retirement unless the reader compares two UUIDs by
      // eye, and the note is simultaneously invisible to every search-mode
      // query (which filters superseded_by IS NOT NULL). So the one surface
      // that can still see the damage describes it as normal.
      //
      // Found via SA-df343a05, checking for exactly this defect and reaching
      // for `lookup({id})` - the path that returns the note regardless. Their
      // result was genuinely clean, but the method could not have told them
      // otherwise. SA-5a433456's rule is the general fix and is worth stating
      // here: to check for a SILENT-DISAPPEARANCE defect, search for what
      // should be there rather than confirming what is.
      //
      // The write path can no longer create this (0.33.2 refuses it), but rows
      // written by earlier builds persist - and the fleet is still on 0.31.3,
      // where the defect is live. Detection has to survive the fix.
      const supSuffix = supersededSuffix(result.detail.id, result.detail.superseded_by);
      text += `\n\n**${result.detail.type}** (${noteBadge(result.detail)}) updated:${age}${src}${supSuffix}`;
      if (!summaryMode && result.detail.code_refs && result.detail.code_refs.length > 0) {
        text += `\ncode_refs: [${result.detail.code_refs.join(", ")}]`;
      }
      const detailBody = summaryMode ? truncate(result.detail.content, 120) : result.detail.content;
      text += `\n${detailBody}${summaryMode ? "" : annotationMarker(result.detail.id)}`;

      // R2: supersede chain (always render when non-empty, even in summary)
      if (result.detail.supersede_chain) {
        const sc = result.detail.supersede_chain;
        if (sc.supersedes.length > 0) {
          text += "\n\nSupersedes:";
          for (const n of sc.supersedes) {
            text += `\n  - **${n.id}** [${n.type}] ${summaryMode ? truncate(n.content, 80) : n.content}`;
          }
        }
        if (sc.superseded_by.length > 0) {
          text += "\n\nSuperseded by:";
          for (const n of sc.superseded_by) {
            text += `\n  - **${n.id}** [${n.type}] ${summaryMode ? truncate(n.content, 80) : n.content}`;
          }
        }
      }

      // R2: revision history (only when include_history: true; suppressed in summary)
      if (!summaryMode && result.detail.revisions && result.detail.revisions.length > 0) {
        text += `\n\nRevision history (${result.detail.revisions.length} revisions, oldest first):`;
        for (const rev of result.detail.revisions) {
          const revAge = formatAge(rev.revised_at);
          const revSrc = rev.revised_by_session ? ` by:${rev.revised_by_session.slice(0, 8)}` : "";
          const preview = rev.content.length > 200 ? rev.content.slice(0, 200) + "..." : rev.content;
          text += `\n  - revised:${revAge}${revSrc}\n    ${preview}`;
        }
      }

      if (!summaryMode) {
        if (result.detail.superseded_by) {
          text += `\n\n[go to current: lookup({id:"${result.detail.superseded_by}"})]`;
        } else {
          text += `\n\n[maintain: update_note({id:"${result.detail.id}"}) | close_thread({id:"${result.detail.id}"}) | supersede_note({old_id:"${result.detail.id}"})]`;
        }
      }

      // Linked notes: suppressed entirely in summary mode (caller can re-request with output_mode: "full")
      if (!summaryMode && result.detail.links.length > 0) {
        text += "\n\nLinked notes:";
        for (const link of result.detail.links) {
          const indent = "  ".repeat(link.depth - 1);
          const linkedSup = link.note.superseded_by
            ? ` [SUPERSEDED by ${link.note.superseded_by}]`
            : "";
          text += `\n${indent}- **${link.note.id}** [${link.relationship}]${linkedSup} ${link.note.content}`;
        }
        // R3.1: tail message when truncated
        if (result.detail.total_link_count !== undefined && result.detail.total_link_count > result.detail.links.length) {
          const hidden = result.detail.total_link_count - result.detail.links.length;
          text += `\n\n${hidden} more linked note(s) not shown. Call lookup({id:"${result.detail.id}", link_limit:500}) to see all, or link_limit:0 to skip links entirely.`;
        }
      }
    } else if (result.results.length > 0) {
      text += "\n";
      for (const r of result.results) {
        if (summaryMode) {
          // Compact one-liner: id8 + type + truncated content. No tags, no age,
          // no code_refs, no maintain hints, no annotations.
          const id8 = r.id.slice(0, 8);
          const supSuffix = r.superseded_by ? ` [SUPERSEDED]` : "";
          text += `\n- **${id8}** [${r.type}]${supSuffix} ${truncate(r.content, 80)}`;
        } else {
          const tagStr = r.tags ? ` {${r.tags}}` : "";
          const age = formatAge(r.updated_at);
          const src = r.source_session ? ` by:${r.source_session.slice(0, 8)}` : "";
          const supSuffix = r.superseded_by ? ` [SUPERSEDED by ${r.superseded_by}]` : "";
          text += `\n- **${r.id}** [${r.type}/${noteBadge(r)}] updated:${age}${src}${tagStr}${supSuffix} ${r.content}${annotationMarker(r.id)}`;
          if (r.code_refs && r.code_refs.length > 0) {
            text += `\n    code_refs: [${r.code_refs.join(", ")}]`;
          }
          if (r.superseded_by) {
            text += `\n  [go to current: lookup({id:"${r.superseded_by}"})]`;
          } else {
            text += `\n  [maintain: update_note({id:"${r.id}"}) | close_thread({id:"${r.id}"}) | supersede_note({old_id:"${r.id}"})]`;
          }
        }
      }
      if (summaryMode) {
        text += `\n\n(Summary mode. Re-call with \`output_mode: "full"\` or specific \`id\` for full content of any result.)`;
      }
    }
    if (text.length > 15000) {
      text += "\n\n---\nLarge result set (" + Math.round(text.length / 1000) + "K chars). Consider narrowing your query (more specific keywords, `code_ref` filter, type filter) instead of reading all of this directly. If a PrimeAgent is active in this project, addressing `PA, can you triage this lookup?` in your terminal output also lets PA do the curation.";
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ── plan ─────────────────────────────────────────────────────────────────
server.tool(
  "plan",
  "Gather domain-specific context to layer onto your own planning. Returns relevant conventions, anti-patterns, quality gates, architecture notes, and recent decisions so you don't contradict past work or re-learn solved problems. Use alongside (not instead of) your normal investigation when facing multi-step work or entering an unfamiliar domain - the orchestrator surfaces team-level history; the current source remains ground truth (decision 3b962e67).",
  {
    task: z.string(),
    domain: z.string().optional(),
  },
  async ({ task, domain }) => {
    const result = handlePrepare(getProjectDb(), getGlobalDb(), {
      task,
      domain,
    });
    return {
      content: [{ type: "text" as const, text: result.formatted }],
    };
  }
);

// ── save_progress ───────────────────────────────────────────────────────
server.tool(
  "save_progress",
  "Save your current progress so the next session can pick up seamlessly. Captures what you accomplished, what's still in flight, open questions, and suggested next steps. Use when finishing a task, completing a milestone, switching work streams, or before the session ends. Pass session_id so the checkpoint is attributed to you for cross-session awareness.",
  {
    summary: z.string().describe("What was accomplished and current state"),
    open_questions: z.union([z.array(z.string()), z.string()]).optional().describe("Unresolved questions (array of strings, or single string)"),
    next_steps: z.union([z.array(z.string()), z.string()]).optional().describe("What should happen next (array of strings, or single string)"),
    in_flight: z.string().optional().describe("Work currently in progress, if any"),
    session_id: z.string().optional().describe("Session ID for cross-session attribution on the checkpoint."),
  },
  async ({ summary, open_questions, next_steps, in_flight, session_id }) => {
    session_id = resolveSessionId(session_id);
    if (session_id) registerSessionOnce(session_id);
    // Normalize string inputs to arrays
    const oq = typeof open_questions === "string" ? [open_questions] : open_questions;
    const ns = typeof next_steps === "string" ? [next_steps] : next_steps;
    const parts = [`## Work State\n${summary}`];
    if (in_flight) parts.push(`\n## In Flight\n${in_flight}`);
    if (oq?.length) parts.push(`\n## Open Questions\n${oq.map(q => `- ${q}`).join("\n")}`);
    if (ns?.length) parts.push(`\n## Next Steps\n${ns.map(s => `- ${s}`).join("\n")}`);

    const content = parts.join("\n");

    // 0.42.0: read the PREVIOUS checkpoint before writing the new one, so a
    // blocker restated unchanged can be caught. This is the only surface with
    // both the text and the prior state - hooks cannot see assistant output
    // (Stop receives only event + session_id), so restatement is mechanically
    // detectable here and nowhere else. Best-effort: a failed read must never
    // cost someone their checkpoint.
    let priorCheckpoint: string | null = null;
    try {
      const row = (session_id
        ? getProjectDb().query(
            `SELECT content FROM notes WHERE type = 'checkpoint' AND source_session = ?
             ORDER BY created_at DESC LIMIT 1`
          ).get(session_id)
        : null) as { content: string } | null;
      priorCheckpoint = row?.content ?? null;
    } catch {
      priorCheckpoint = null;
    }

    const result = await handleRemember(getProjectDb(), getGlobalDb(), {
      content,
      type: "checkpoint",
      context: `Checkpoint created at ${new Date().toISOString()}`,
      tags: "checkpoint",
      session_id,
    }, embeddingClient);

    // Advisory only, appended to a SUCCESSFUL save. Never blocks: losing a
    // checkpoint costs more than any nudge saves, and PA's discriminator is
    // that the guidance must demand the enumeration rather than forbid the
    // hand-back - agents grind forever on real walls otherwise.
    let stalled = "";
    try {
      stalled = formatStalledClaimAdvisory(
        findRestatedBlockers(priorCheckpoint, content)
      );
    } catch {
      stalled = "";
    }

    return {
      content: [{
        type: "text" as const,
        text: (result.stored
          ? `Progress saved (${result.note_id}). Next session will recover from here.`
          : `Progress updated (existing checkpoint promoted).`) + stalled,
      }],
    };
  }
);

// ── close_thread ────────────────────────────────────────────────────────
server.tool(
  "close_thread",
  "Declare a tracked open_thread, commitment, or work_item settled. Cascades through the graph: unblocks blocked items, auto-completes parent work when all children are done, auto-resolves superseded notes. Closing threads while context is fresh is as important as opening them - prevents future sessions from re-litigating. Equal-priority to note(). Pass session_id so the resolution decision (when a resolution string is provided) carries attribution.",
  {
    id: z.string(),
    resolution: z.string().optional(),
    session_id: z.string().optional().describe("Session ID - attributed to the resolution decision note if one is created."),
  },
  async ({ id, resolution, session_id }) => {
    const projectDb = getProjectDb();
    session_id = resolveSessionId(session_id);
    if (session_id) registerSessionOnce(session_id);
    const globalDb = getGlobalDb();

    // id8-prefix resolution: try project first, fall back to global.
    let resolved = resolveNoteId(projectDb, id);
    let db = projectDb;
    if (!resolved.id && !resolved.ambiguous) {
      resolved = resolveNoteId(globalDb, id);
      db = globalDb;
    }
    if (resolved.ambiguous) {
      return {
        content: [{ type: "text" as const, text: `ID prefix "${id}" is ambiguous - matches ${resolved.ambiguous.length} notes: ${resolved.ambiguous.join(", ")}. Use the full UUID.` }],
      };
    }
    if (!resolved.id) {
      return {
        content: [{ type: "text" as const, text: `No note found with id "${id}".` }],
      };
    }
    id = resolved.id;

    const row = db
      .query(`SELECT id, type, content, status FROM notes WHERE id = ?`)
      .get(id) as { id: string; type: string; content: string; status: string | null } | null;

    if (!row) {
      return {
        content: [{ type: "text" as const, text: `No note found with id "${id}".` }],
      };
    }

    const timestamp = new Date().toISOString();

    if (row.type === "work_item") {
      db.run(
        `UPDATE notes SET resolved = 1, status = 'done', updated_at = ? WHERE id = ?`,
        [timestamp, id]
      );
    } else {
      db.run(
        `UPDATE notes SET resolved = 1, updated_at = ? WHERE id = ?`,
        [timestamp, id]
      );
    }

    const cascadeResults = cascadeResolution(db, id, timestamp);

    if (resolution) {
      await handleRemember(projectDb, globalDb, {
        content: resolution,
        type: "decision",
        context: `Resolved ${row.type}: ${row.content}`,
        tags: row.type,
        session_id,
      }, embeddingClient);
    }

    let message = `Resolved ${row.type} note "${id}".`;
    if (resolution) message += " Decision recorded.";
    if (cascadeResults.length > 0) {
      message += "\n\nCascade effects:\n" + cascadeResults.map(r => `- ${r}`).join("\n");
    }

    return {
      content: [{ type: "text" as const, text: message }],
    };
  }
);

// ── update_note ─────────────────────────────────────────────────────────
server.tool(
  "update_note",
  "Keep a note current. Use liberally whenever your read of reality has refined what this note should say - new information, a correction, a clarification. Treat as equal-priority to note(). For quick additions that preserve existing content, prefer append_content. For full rewrites, use content - the prior state is automatically snapshotted to revision history (see lookup include_history). Pass `code_refs: [paths]` to replace the note's breadcrumb array when the note points at specific files; pass `[]` to clear. Breadcrumbs are file or module paths only - not line numbers or symbols.",
  {
    id: z.string(),
    content: z.string().optional().describe("New content (REPLACES existing)."),
    append_content: z.string().min(1).max(20000).optional().describe("Timestamped segment to append to existing content. Preferred over `content` for additive updates - no read-before-write required. Keywords are re-extracted; embeddings are NOT refreshed (use `content` for full rewrites when semantic search currency matters). Max 20000 characters per append - for larger additions, chunk into multiple calls or use `content` for a full rewrite."),
    context: z.string().optional().describe("New context (replaces existing)"),
    tags: z.string().optional().describe("New tags - REPLACES the existing set wholesale. Use `add_tags` to annotate without dropping provenance tags another session set."),
    add_tags: z.string().optional().describe("ADDITIVE: comma-separated tags to MERGE into the existing set (union, deduped case-insensitively, order preserved). Prefer this over `tags` whenever you are annotating rather than redefining - `tags` replaces wholesale and will silently drop provenance tags another session set, such as a reporter handle or a discord_thread:<id> linkage. Mutually exclusive with `tags`."),
    confidence: z.enum(["low", "medium", "high"]).optional(),
    code_refs: codeRefsInput("Replace the note's code_refs breadcrumb array. Pass [] to clear; omit to leave unchanged. See note() code_refs for format."),
    session_id: z.string().optional().describe("Session ID - attributed to the revision snapshot."),
  },
  async ({ id, content, append_content, context, tags, add_tags, confidence, code_refs, session_id }) => {
    session_id = resolveSessionId(session_id);
    if (session_id) registerSessionOnce(session_id);
    const projectDb = getProjectDb();
    const globalDb = getGlobalDb();

    // id8-prefix resolution: try project first, fall back to global.
    let resolved = resolveNoteId(projectDb, id);
    let db = projectDb;
    if (!resolved.id && !resolved.ambiguous) {
      resolved = resolveNoteId(globalDb, id);
      db = globalDb;
    }
    if (resolved.ambiguous) {
      return { content: [{ type: "text" as const, text: `ID prefix "${id}" is ambiguous - matches ${resolved.ambiguous.length} notes: ${resolved.ambiguous.join(", ")}. Use the full UUID.` }] };
    }
    if (!resolved.id) {
      return { content: [{ type: "text" as const, text: `No note found with id "${id}".` }] };
    }
    id = resolved.id;

    let row = db.query(`SELECT id, type, content, context, tags, keywords FROM notes WHERE id = ?`)
      .get(id) as any | null;
    if (!row) {
      return { content: [{ type: "text" as const, text: `No note found with id "${id}".` }] };
    }

    if (append_content !== undefined && content !== undefined) {
      return { content: [{ type: "text" as const, text: `Cannot provide both content and append_content - they are mutually exclusive. Use content for full rewrites, append_content for additive updates.` }] };
    }
    // 0.40.0: same guard for the tag axis. Accepting both would apply one
    // silently and discard the other - the exact silent-swallow shape this
    // parameter was added to remove.
    if (add_tags !== undefined && tags !== undefined) {
      return { content: [{ type: "text" as const, text: `Cannot provide both tags and add_tags - they are mutually exclusive. Use tags to REPLACE the whole set, add_tags to MERGE into it.` }] };
    }

    // 0.30.28+ hard size limit (matches handleRemember). For content
    // rewrites: check the new content directly. For append_content:
    // check what the final content WILL be (current + appended) so
    // appends can't sneak past by being individually small.
    const NOTE_CONTENT_HARD_CHARS = 50_000;
    if (content !== undefined && content.length > NOTE_CONTENT_HARD_CHARS) {
      return { content: [{ type: "text" as const, text: `Note content rewrite is ${content.length} chars - exceeds hard limit of ${NOTE_CONTENT_HARD_CHARS}. Primitives should stay primitive (decision 3b962e67). Split into multiple linked notes.` }] };
    }
    if (append_content !== undefined) {
      const currentLen = row.content?.length ?? 0;
      const projectedLen = currentLen + 4 + 32 + append_content.length; // approx new timestamped block
      // A CORRECTION TO AN ALREADY-OVER-LIMIT NOTE IS NEVER REFUSED.
      //
      // The cap exists to stop a note GROWING into a bad shape (decision
      // 3b962e67), and it should keep doing that. But applied to a note that is
      // already over, it refuses the SAFE operation (an additive, timestamped
      // correction) while still permitting the UNSAFE one (a full `content`
      // rewrite, which only checks the new length). For a record that is over
      // the limit precisely BECAUSE it is important and heavily appended, that
      // is backwards: it freezes the wrong content in place and rejects the fix.
      //
      // Found 2026-08-11 by SA-d4db6493 during a fleet review and confirmed by
      // execution: note 6f098939 - which carries an INERT / must-not-wire
      // SAFETY HOLD that three sessions depend on - is 71,948 chars and refused
      // a correction, having already accepted a peer's contradicting tag. The
      // record most needing correction had become the one that could not take
      // one, and the suggested remedy ("split into linked notes") is itself
      // blocked, since splitting requires a write to the same record.
      //
      // So: still refuse an append that pushes a note from UNDER to OVER - that
      // is the cap doing its job at the boundary. Grandfather notes already
      // over it, and say so, so the size problem stays visible rather than
      // silently forgiven.
      if (projectedLen > NOTE_CONTENT_HARD_CHARS && currentLen <= NOTE_CONTENT_HARD_CHARS) {
        return { content: [{ type: "text" as const, text: `Append would grow note from ${currentLen} to ~${projectedLen} chars - exceeds hard limit of ${NOTE_CONTENT_HARD_CHARS}. Note is too big; split into linked notes (decision 3b962e67) instead of growing this one further.` }] };
      }
    }

    const updates: string[] = [];

    if (append_content !== undefined) {
      // 0.44.0: pass the client so the append re-embeds. Pre-fix the only
      // refresh in this handler sat behind `content !== undefined` below,
      // which this branch could never satisfy - defect 1 of insight 44d445bb.
      appendToNoteContent(db, id, append_content, embeddingClient);
      updates.push("append_content");
      // Re-read row so any fall-through UPDATE sees the appended content
      row = db.query(`SELECT id, type, content, context, tags, keywords FROM notes WHERE id = ?`)
        .get(id) as any;
    }

    if (content !== undefined) updates.push("content");
    if (context !== undefined) updates.push("context");
    if (tags !== undefined) updates.push("tags");
    if (add_tags !== undefined) updates.push("add_tags");
    if (confidence) updates.push("confidence");
    if (code_refs !== undefined) updates.push("code_refs");

    if (updates.length === 0) {
      return { content: [{ type: "text" as const, text: "No fields to update." }] };
    }

    // R5.2 Important-1/2: single timestamp shared across both UPDATE paths so
    // the code_refs-only write doesn't trample the content/context write with
    // a drifted microsecond. Also: snapshot the revision when code_refs is
    // changing - previously code_refs-only updates bypassed the snapshot.
    const timestamp = now();
    const willWriteMainFields =
      content !== undefined || context !== undefined || tags !== undefined ||
      add_tags !== undefined || !!confidence;
    const willWriteCodeRefs = code_refs !== undefined;
    if (willWriteMainFields || willWriteCodeRefs) {
      // R2: snapshot the current row before mutating it
      snapshotRevision(db, id, session_id ?? null);
    }

    if (willWriteMainFields) {
      const newContent = content ?? row.content;
      const newContext = context ?? row.context;
      const newKeywords = (content !== undefined || context !== undefined)
        ? extractKeywords([newContent, newContext].filter(Boolean).join(" "))
        : null;

      db.run(
        `UPDATE notes SET
          content = ?,
          context = ?,
          tags = ?,
          keywords = ?,
          confidence = ?,
          updated_at = ?
         WHERE id = ?`,
        [
          newContent,
          newContext ?? null,
          // c658ce38: normalize when a new tags value is supplied; absent -> keep existing.
          // 0.40.0: add_tags MERGES instead of replacing (see mergeTags).
          add_tags != null
            ? mergeTags(row.tags, add_tags)
            : tags != null
              ? normalizeTagString(tags)
              : row.tags,
          newKeywords ? newKeywords.join(",") : row.keywords,
          confidence ?? row.confidence ?? "medium",
          timestamp,
          id,
        ]
      );

      if (content !== undefined) {
        refreshNoteEmbedding(db, id, newContent, embeddingClient);
      }
    }

    // R5: code_refs replacement is independent of the content/context/etc
    // update path. undefined = unchanged; [] (empty) = clear to NULL; otherwise
    // replace with the serialized JSON array. stringifyCodeRefs maps [] -> null.
    // R5.2 Important-2: reuse `timestamp` from above so updated_at is
    // consistent across both UPDATEs when both run.
    if (willWriteCodeRefs) {
      const codeRefsJson = stringifyCodeRefs(code_refs);
      db.run(
        `UPDATE notes SET code_refs = ?, updated_at = ? WHERE id = ?`,
        [codeRefsJson, timestamp, id]
      );
    }

    return {
      content: [{
        type: "text" as const,
        text: `Updated note "${id}" (${updates.join(", ")} changed).`,
      }],
    };
  }
);

// ── delete_note ─────────────────────────────────────────────────────────
server.tool(
  "delete_note",
  "Remove a note permanently. Use only when a note is genuinely wrong or harmful - prefer supersede_note (preserves history) or close_thread (marks resolved) for knowledge that was right-at-the-time or is now complete. **Links to/from this note are CASCADE-removed, permanently.** If the note has ANY links this tool REFUSES by default and tells you the count plus the safer path; pass `confirm_cascade: true` only after reading that. For a duplicate or superseded note that has inbound links, the right move is a REDIRECT STUB - update_note it to point at the survivor, then close_thread - which keeps the ID resolvable and every edge intact. Equal-priority to note() - curation is as important as capture.",
  {
    id: z.string(),
    reason: z.string().optional().describe("Why this note is being deleted"),
    confirm_cascade: z
      .boolean()
      .optional()
      .describe("Required to delete a note that has links. Deleting CASCADE-removes every edge to and from it, which is unrecoverable - the tool will tell you the count and the safer alternative first. Pass true only after reading that."),
  },
  async ({ id, reason, confirm_cascade }) => {
    const projectDb = getProjectDb();
    const globalDb = getGlobalDb();

    // id8-prefix resolution: try project first, fall back to global.
    let resolved = resolveNoteId(projectDb, id);
    let db = projectDb;
    if (!resolved.id && !resolved.ambiguous) {
      resolved = resolveNoteId(globalDb, id);
      db = globalDb;
    }
    if (resolved.ambiguous) {
      return { content: [{ type: "text" as const, text: `ID prefix "${id}" is ambiguous - matches ${resolved.ambiguous.length} notes: ${resolved.ambiguous.join(", ")}. Use the full UUID.` }] };
    }
    if (!resolved.id) {
      return { content: [{ type: "text" as const, text: `No note found with id "${id}".` }] };
    }
    id = resolved.id;

    const row = db.query(`SELECT id, type, content FROM notes WHERE id = ?`)
      .get(id) as { id: string; type: string; content: string } | null;

    if (!row) {
      return { content: [{ type: "text" as const, text: `No note found with id "${id}".` }] };
    }

    // 0.30.78: STOP THE SILENT CASCADE.
    //
    // delete_note is destructive-by-default while LOOKING like a tidy-up, and
    // the cascade was documented only in the tool description nobody re-reads
    // at the moment of use. Live cost 2026-07-27: a duplicate cleanup deleted a
    // note carrying 87 inbound links; the knowledge survived in revision
    // history but the edges did not, and no warning was shown at any point.
    //
    // The proven remedy is a REDIRECT STUB (SA-90bf73bd): update_note the loser
    // to point at the survivor and close_thread it. That keeps the ID
    // resolvable, keeps every inbound link, and teaches whoever lands on the
    // old ID. So the tool now names that path BEFORE it will cascade, and makes
    // the destructive branch an explicit opt-in rather than the default.
    const linkCount = (
      db
        .query(
          `SELECT COUNT(*) AS c FROM links WHERE from_note_id = ? OR to_note_id = ?`
        )
        .get(id, id) as { c: number }
    ).c;

    if (linkCount > 0 && !confirm_cascade) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `REFUSED - deleting "${id}" would CASCADE-REMOVE ${linkCount} link(s), permanently and unrecoverably.\n\n` +
              `Deleting is almost never the right cleanup for a duplicate or a superseded note. Prefer, in order:\n` +
              `  1. REDIRECT STUB (best when the note has inbound links): update_note this note so it opens with "SUPERSEDED BY <id>" plus one line on why it existed, then close_thread it. The ID stays resolvable, all ${linkCount} edges survive, and anyone landing here learns why.\n` +
              `  2. supersede_note({old_id, new_id}) - replaces it while preserving history and the graph.\n` +
              `  3. close_thread({id, resolution}) - if the question it tracked is simply settled.\n\n` +
              `If you have read the above and still want the note and its ${linkCount} link(s) gone, re-call with confirm_cascade: true.`,
          },
        ],
      };
    }

    // Delete links first (in case CASCADE doesn't fire)
    db.run(`DELETE FROM links WHERE from_note_id = ? OR to_note_id = ?`, [id, id]);
    db.run(`DELETE FROM notes WHERE id = ?`, [id]);

    const reasonStr = reason ? ` Reason: ${reason}` : "";
    return {
      content: [{
        type: "text" as const,
        text: `Deleted ${row.type} note "${id}".${reasonStr}`,
      }],
    };
  }
);

// ── supersede_note ────────────────────────────────────────────────────
server.tool(
  "supersede_note",
  "Replace an old note with a new one, preserving history. The old note is archived (still retrievable by ID, but hidden from default lookup); the new note surfaces on lookup. Use when a decision was right at the time but is now wrong, or when knowledge has evolved. Treat as equally important to note() - maintaining coherence matters as much as capturing new facts. When creating the replacement inline (new_content + new_type), pass `code_refs: [paths]` so the replacement carries breadcrumbs forward. Ignored when `new_id` points at an existing note (it keeps its own refs).",
  {
    old_id: z.string().describe("ID of the note being superseded."),
    new_id: z.string().optional().describe("ID of an existing replacement note. Provide this OR new_content+new_type."),
    new_content: z.string().optional().describe("Content for a new replacement note created inline. Requires new_type."),
    new_type: z.enum(NOTE_TYPES).optional().describe("Type for the inline replacement note. Required when new_content is provided."),
    reason: z.string().optional().describe("Why the old note is being superseded (recorded in the new note's context)."),
    code_refs: codeRefsInput("code_refs for the inline-created replacement note. Ignored when new_id is provided (the target note keeps its own refs). See note() code_refs for format."),
    session_id: z.string().optional().describe("Session ID - enables cross-session attribution on the supersede action."),
  },
  async ({ old_id, new_id, new_content, new_type, reason, code_refs, session_id }) => {
    session_id = resolveSessionId(session_id);
    if (session_id) registerSessionOnce(session_id);
    const result = await handleSupersede(
      getProjectDb(),
      getGlobalDb(),
      { old_id, new_id, new_content, new_type, reason, session_id, code_refs },
      embeddingClient
    );
    return {
      content: [{ type: "text" as const, text: result.message }],
    };
  }
);

// ── user_profile ────────────────────────────────────────────────────────
server.tool(
  "user_profile",
  "View or update the structured user profile. Shows all learned observations about the user grouped by dimension (preferences, communication style, decision patterns, strengths, blind spots, intent). Use to understand the user better or to explicitly record a user trait.",
  {
    action: z.enum(["view", "set", "remove"]).optional().default("view"),
    dimension: z.enum(DIMENSIONS).optional().describe("Which dimension to set/remove. MUST be one of: communication_style, decision_pattern, strength, blind_spot, preference, intent_pattern. Do NOT invent new values."),
    observation: z.string().optional().describe("The observation to record (for 'set' action)"),
    id: z.string().optional().describe("ID of user_model entry to remove (for 'remove' action)"),
  },
  async ({ action, dimension, observation, id }) => {
    const globalDb = getGlobalDb();

    if (action === "view") {
      const profile = composeUserProfile(globalDb);
      let text = "# User Profile\n\n";
      if (profile.entries.length === 0) {
        text += "No user profile data yet. Observations are captured automatically from `user_pattern` notes and can be set explicitly with `user_profile({ action: 'set', ... })`.";
      } else {
        text += profile.summary;
        text += `\n\n*${profile.entries.length} total observations across ${new Set(profile.entries.map(e => e.dimension)).size} dimensions*`;
      }
      return { content: [{ type: "text" as const, text }] };
    }

    if (action === "set") {
      if (!dimension || !observation) {
        return { content: [{ type: "text" as const, text: "Both `dimension` and `observation` are required for 'set' action." }] };
      }

      const timestamp = now();

      // Check for existing observation in this dimension with same content
      const existing = globalDb
        .query(`SELECT id FROM user_model WHERE dimension = ? AND observation = ?`)
        .get(dimension, observation) as { id: string } | null;

      if (existing) {
        globalDb.run(
          `UPDATE user_model SET confidence = 'high', updated_at = ? WHERE id = ?`,
          [timestamp, existing.id]
        );
        return { content: [{ type: "text" as const, text: `Promoted existing observation confidence to high.` }] };
      }

      globalDb.run(
        `INSERT INTO user_model (id, dimension, observation, evidence, confidence, trajectory, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [generateId(), dimension, observation, "", "high", "stable", timestamp, timestamp]
      );

      return { content: [{ type: "text" as const, text: `Recorded ${dimension}: "${observation}"` }] };
    }

    if (action === "remove") {
      if (!id) {
        return { content: [{ type: "text" as const, text: "`id` is required for 'remove' action. Use `user_profile({ action: 'view' })` to see entries." }] };
      }

      const row = globalDb.query(`SELECT id, dimension, observation FROM user_model WHERE id = ?`)
        .get(id) as { id: string; dimension: string; observation: string } | null;

      if (!row) {
        return { content: [{ type: "text" as const, text: `No user_model entry found with id "${id}".` }] };
      }

      globalDb.run(`DELETE FROM user_model WHERE id = ?`, [id]);
      return { content: [{ type: "text" as const, text: `Removed ${row.dimension}: "${row.observation}"` }] };
    }

    return { content: [{ type: "text" as const, text: "Unknown action." }] };
  }
);

// ── create_work_item ────────────────────────────────────────────────────
server.tool(
  "create_work_item",
  "Create a trackable work item (task/todo). Work items persist across sessions and appear in the briefing. Use for concrete tasks that need to be done - not strategic questions (use open_thread for those). Supports priority, status, due dates, and parent relationships for breaking down larger work. Pass session_id so sibling sessions can see this item on their next briefing. When the work is scoped to specific files, add `code_refs: [paths]` so the item is discoverable via `lookup({code_ref: 'path'})` when an agent next touches that code.",
  {
    content: z.string().optional().describe("What needs to be done - be specific and actionable. This is the primary field."),
    title: z.string().optional().describe("Alias for content (if content not provided, title is used)"),
    description: z.string().optional().describe("Additional detail (appended to content if both provided)"),
    priority: z.enum(WORK_ITEM_PRIORITIES).optional().default("medium"),
    status: z.enum(WORK_ITEM_STATUSES).optional().default("planned"),
    parent_id: z.string().optional().describe("ID of parent work_item this belongs to (creates part_of link)"),
    due_date: z.string().optional().describe("Due date in YYYY-MM-DD format"),
    tags: z.string().optional(),
    context: z.string().optional(),
    code_refs: codeRefsInput("Array of file or module paths this work item points at. Same format as note() code_refs."),
    session_id: z.string().optional().describe("Session ID that created this work item. Enables cross-session discovery."),
  },
  async ({ content: rawContent, title, description, priority, status, parent_id, due_date, tags, context, code_refs, session_id }) => {
    // Accept content, title, or description - fold into one content string
    const content = rawContent || title || description || "";
    if (!content) {
      return { content: [{ type: "text" as const, text: "Error: provide content (or title) describing what needs to be done." }] };
    }
    // If both content/title and description provided, combine them
    const fullContent = (rawContent || title || "") + (description && (rawContent || title) ? "\n\n" + description : description || "");
    const projectDb = getProjectDb();
    session_id = resolveSessionId(session_id);
    if (session_id) registerSessionOnce(session_id);
    const noteId = generateId();
    const timestamp = now();
    const textForKeywords = [fullContent, context].filter(Boolean).join(" ");
    const keywords = extractKeywords(textForKeywords);

    const tagParts: string[] = ["work_item"];
    if (tags) {
      // c658ce38: normalize at capture (JSON-array-string -> clean tags).
      for (const t of parseTagList(tags)) {
        if (!tagParts.includes(t)) tagParts.push(t);
      }
    }

    const codeRefsJson = stringifyCodeRefs(code_refs);
    projectDb.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, priority, due_date, created_at, updated_at, source_session, code_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [noteId, "work_item", fullContent, context ?? null, keywords.join(","), tagParts.join(","),
       "high", 0, status ?? "planned", priority ?? "medium", due_date ?? null, timestamp, timestamp, session_id ?? null, codeRefsJson]
    );

    const links = createAutoLinks(projectDb, noteId, keywords);

    if (parent_id) {
      const parent = projectDb.query(`SELECT id FROM notes WHERE id = ?`).get(parent_id);
      if (parent) {
        projectDb.run(
          `INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
           VALUES (?, ?, ?, 'part_of', 'strong', ?)`,
          [generateId(), noteId, parent_id, timestamp]
        );
      }
    }

    const dueStr = due_date ? ` due ${due_date}` : "";
    return {
      content: [{
        type: "text" as const,
        text: `Created work_item "${noteId}" [${priority}/${status}]${dueStr}${parent_id ? ` (child of ${parent_id})` : ""}${links.length > 0 ? ` with ${links.length} auto-link(s)` : ""}.`,
      }],
    };
  }
);

// ── update_work_item ────────────────────────────────────────────────────
server.tool(
  "update_work_item",
  "Update a work item's status, priority, due date, content, tags, context, or confidence. Triggers cascade logic: completing an item unblocks dependents and may auto-complete parent items. Use to track progress through tasks. Pass `code_refs: [paths]` to replace the breadcrumb array (file or module paths, not symbols); pass `[]` to clear.",
  {
    id: z.string(),
    status: z.enum(WORK_ITEM_STATUSES).optional(),
    priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
    due_date: z.string().optional().describe("Due date in YYYY-MM-DD format, or empty string to clear"),
    content: z.string().optional().describe("REPLACES the description WHOLESALE - the prior text is gone. To add to a work item without destroying prior enrichment, use `append_content` instead."),
    append_content: z.string().min(1).max(20000).optional().describe("Timestamped segment to append to the existing description. Preferred over `content` for additive updates - no read-before-write, no risk of clobbering enrichment written by another session. Mutually exclusive with `content`. Max 20000 chars per append."),
    tags: z.string().optional().describe("Replace the full tag string (comma-separated). Existing tags are overwritten - read-modify-write if you only want to add/remove one."),
    add_tags: z.string().optional().describe("ADDITIVE: comma-separated tags to MERGE into the existing set (union, deduped case-insensitively, order preserved). Prefer this over `tags` whenever you are annotating rather than redefining - `tags` replaces wholesale and will silently drop provenance tags another session set, such as a reporter handle or a discord_thread:<id> linkage. Mutually exclusive with `tags`."),
    context: z.string().optional().describe("Updated context (replaces existing; empty string clears)"),
    confidence: z.enum(["low", "medium", "high"]).optional(),
    code_refs: codeRefsInput("Replace code_refs breadcrumbs. [] clears; omit to leave unchanged."),
    blocked_by: z.string().optional().describe("ID of the note blocking this work item (creates blocks link)"),
  },
  async ({ id, status, priority, due_date, content, append_content, tags, add_tags, context, confidence, code_refs, blocked_by }) => {
    const projectDb = getProjectDb();

    // Resolve id8 prefix -> full UUID. The orchestrator surfaces note IDs as
    // 8-char hex prefixes in hook hints, agent-channel events, and stop
    // nudges; agents acting on those need the resolver to find the row.
    const resolved = resolveNoteId(projectDb, id);
    if (resolved.ambiguous) {
      return {
        content: [{ type: "text" as const, text: `ID prefix "${id}" is ambiguous - matches ${resolved.ambiguous.length} notes: ${resolved.ambiguous.join(", ")}. Use the full UUID.` }],
      };
    }
    if (!resolved.id) {
      return {
        content: [{ type: "text" as const, text: `No note found with id "${id}".` }],
      };
    }
    id = resolved.id;

    const row = projectDb
      .query(`SELECT id, type, content, context, tags, status, priority, due_date FROM notes WHERE id = ?`)
      .get(id) as { id: string; type: string; content: string; context: string | null; tags: string | null; status: string | null; priority: string | null; due_date: string | null } | null;

    if (!row) {
      return {
        content: [{ type: "text" as const, text: `No note found with id "${id}".` }],
      };
    }

    // 0.30.72+: same mutual-exclusion guard update_note carries. Accepting
    // both would apply the append and then overwrite it with `content` in the
    // same statement - a silent data loss dressed as a successful call.
    if (append_content !== undefined && content !== undefined) {
      return { content: [{ type: "text" as const, text: `Cannot provide both content and append_content - they are mutually exclusive. Use content for full rewrites, append_content for additive updates.` }] };
    }
    // 0.40.0: same guard for the tag axis. Accepting both would apply one
    // silently and discard the other - the exact silent-swallow shape this
    // parameter was added to remove.
    if (add_tags !== undefined && tags !== undefined) {
      return { content: [{ type: "text" as const, text: `Cannot provide both tags and add_tags - they are mutually exclusive. Use tags to REPLACE the whole set, add_tags to MERGE into it.` }] };
    }

    const timestamp = now();
    // Parameterized UPDATE composition: each field appends to BOTH the SET
    // fragment list (with `?` placeholders) AND the bind-values list. No
    // string interpolation of user input into SQL.
    const setFragments: string[] = [];
    const bindValues: (string | number | null)[] = [];
    const changes: string[] = [];

    if (status) {
      setFragments.push("status = ?");
      bindValues.push(status);
      changes.push(`status: ${row.status} -> ${status}`);
    }
    if (priority) {
      setFragments.push("priority = ?");
      bindValues.push(priority);
      changes.push(`priority: ${row.priority} -> ${priority}`);
    }
    if (due_date !== undefined) {
      const newDue = due_date === "" ? null : due_date;
      setFragments.push("due_date = ?");
      bindValues.push(newDue);
      changes.push(`due_date: ${row.due_date ?? "none"} -> ${newDue ?? "cleared"}`);
    }
    if (content) {
      setFragments.push("content = ?");
      bindValues.push(content);
      const newKeywords = extractKeywords(content);
      setFragments.push("keywords = ?");
      bindValues.push(newKeywords.join(","));
      changes.push("content updated");
    }
    // 0.30.72+: additive update parity with update_note. update_work_item
    // previously offered ONLY wholesale `content` replacement, so annotating a
    // work item meant read-modify-write and any miss silently destroyed prior
    // enrichment - including another session's. SA-df343a05 reported avoiding
    // exactly that clobber on 2026-07-27 only because a memory warned them,
    // and it matches a standing cross-project anti-pattern about these tools
    // looking like they merge when they replace. Same appendToNoteContent
    // helper update_note uses, so timestamp format and keyword re-extraction
    // stay identical across both tools.
    if (append_content !== undefined) {
      appendToNoteContent(projectDb, id, append_content, embeddingClient);
      changes.push("append_content");
    }
    if (tags !== undefined) {
      // c658ce38: normalize at capture so a JSON-array-stringified tags
      // value (or already-baked garbage) never gets stored.
      const normTags = normalizeTagString(tags);
      setFragments.push("tags = ?");
      bindValues.push(normTags);
      changes.push(`tags: ${row.tags ?? "none"} -> ${normTags || "cleared"}`);
    }
    // 0.40.0: ADDITIVE tag update - the counterpart `tags` never had, while
    // `content` has had `append_content` since 0.30.72. See mergeTags().
    if (add_tags !== undefined) {
      const merged = mergeTags(row.tags, add_tags);
      setFragments.push("tags = ?");
      bindValues.push(merged);
      changes.push(`add_tags: ${row.tags ?? "none"} -> ${merged}`);
    }
    if (context !== undefined) {
      const newCtx = context === "" ? null : context;
      setFragments.push("context = ?");
      bindValues.push(newCtx);
      changes.push("context updated");
    }
    if (confidence) {
      setFragments.push("confidence = ?");
      bindValues.push(confidence);
      changes.push(`confidence: ${confidence}`);
    }

    if (setFragments.length > 0) {
      setFragments.push("updated_at = ?");
      bindValues.push(timestamp);
      if (status === "done") setFragments.push("resolved = 1");
      bindValues.push(id);
      projectDb.run(`UPDATE notes SET ${setFragments.join(", ")} WHERE id = ?`, bindValues);
    }

    // 0.44.0: refresh the embedding after a full `content` rewrite. This
    // handler previously contained NO embedding call on any path, which
    // falsified the workaround the fleet was actually using - sessions did
    // full rewrites of work items believing it bought semantic currency (see
    // 7c30b7e1's `full-rewrite-for-embedding-refresh` tag) and it never did.
    // The append branch above is covered inside appendToNoteContent.
    // THIS GUARD MUST STAY IDENTICAL TO THE `if (content)` WRITE GUARD ABOVE.
    // It looks like it should be `content !== undefined` for consistency with
    // the update_note path, and that would be a BUG here: the write itself is
    // falsy-guarded, so content === "" skips the UPDATE and leaves the stored
    // description intact. Re-embedding on "" would then point the vector at an
    // empty body while the note still says something - manufacturing exactly
    // the staleness this release fixes. Change both guards together or neither.
    if (content) {
      refreshNoteEmbedding(projectDb, id, content, embeddingClient);
    }

    // R5: code_refs replacement. Separate parameterized UPDATE so we don't
    // string-concat a JSON payload into the interpolated SQL above. undefined
    // = unchanged; [] clears to NULL.
    if (code_refs !== undefined) {
      const codeRefsJson = stringifyCodeRefs(code_refs);
      projectDb.run(
        `UPDATE notes SET code_refs = ?, updated_at = ? WHERE id = ?`,
        [codeRefsJson, timestamp, id]
      );
      changes.push(codeRefsJson ? `code_refs: updated` : `code_refs: cleared`);
    }

    if (blocked_by) {
      const blocker = projectDb.query(`SELECT id FROM notes WHERE id = ?`).get(blocked_by);
      if (blocker) {
        projectDb.run(
          `INSERT OR IGNORE INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
           VALUES (?, ?, ?, 'blocks', 'strong', ?)`,
          [generateId(), blocked_by, id, timestamp]
        );
        changes.push(`blocked by: ${blocked_by}`);
      }
    }

    if (status === "done") {
      const cascadeResults = cascadeResolution(projectDb, id, timestamp);
      if (cascadeResults.length > 0) {
        changes.push("Cascade: " + cascadeResults.join(", "));
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: `Updated work_item "${id}": ${changes.join("; ")}.`,
      }],
    };
  }
);

// ── breakdown ───────────────────────────────────────────────────────────
server.tool(
  "breakdown",
  "Break down a work item or plan into child work items. Creates multiple work_items linked to a parent via part_of relationships. Use when you have a complex task that needs to be split into concrete steps. Pass session_id so parent and children carry cross-session attribution.",
  {
    parent_id: z.string().optional().describe("ID of parent work_item. If omitted, creates a new parent from the title."),
    parent_title: z.string().optional().describe("Title for a new parent work_item (used when parent_id is omitted)"),
    items: z.array(z.object({
      content: z.string(),
      priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
      due_date: z.string().optional(),
    })),
    tags: z.string().optional(),
    due_date: z.string().optional().describe("Default due date for all items (individual items can override)"),
    session_id: z.string().optional().describe("Session ID for cross-session attribution on parent and children."),
  },
  async ({ parent_id, parent_title, items, tags, due_date, session_id }) => {
    const projectDb = getProjectDb();
    session_id = resolveSessionId(session_id);
    if (session_id) registerSessionOnce(session_id);
    const timestamp = now();

    let actualParentId = parent_id;
    if (!actualParentId && parent_title) {
      actualParentId = generateId();
      const keywords = extractKeywords(parent_title);
      const tagParts = ["work_item", ...parseTagList(tags)];

      projectDb.run(
        `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, status, priority, due_date, created_at, updated_at, source_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [actualParentId, "work_item", parent_title, keywords.join(","), tagParts.join(","),
         "high", 0, "planned", "high", due_date ?? null, timestamp, timestamp, session_id ?? null]
      );
      createAutoLinks(projectDb, actualParentId, keywords);
    }

    const created: string[] = [];
    for (const item of items) {
      const childId = generateId();
      const keywords = extractKeywords(item.content);
      const tagParts = ["work_item", ...parseTagList(tags)];

      projectDb.run(
        `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, status, priority, due_date, created_at, updated_at, source_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [childId, "work_item", item.content, keywords.join(","), tagParts.join(","),
         "high", 0, "planned", item.priority ?? "medium", item.due_date ?? due_date ?? null, timestamp, timestamp, session_id ?? null]
      );

      createAutoLinks(projectDb, childId, keywords);

      if (actualParentId) {
        projectDb.run(
          `INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
           VALUES (?, ?, ?, 'part_of', 'strong', ?)`,
          [generateId(), childId, actualParentId, timestamp]
        );
      }

      created.push(`"${childId}" - ${item.content}`);
    }

    return {
      content: [{
        type: "text" as const,
        text: `Created ${created.length} work items${actualParentId ? ` under parent "${actualParentId}"` : ""}:\n${created.map(c => `- ${c}`).join("\n")}`,
      }],
    };
  }
);

// ── check_similar ────────────────────────────────────────────────────────
server.tool(
  "check_similar",
  "Check if a proposed action is similar to existing decisions, conventions, or anti-patterns. Use alongside (not instead of) your normal investigation when planning a non-trivial change - catches team-level prior art that your own code reading might not surface.",
  {
    proposed_action: z.string(),
    types: z.array(z.enum(NOTE_TYPES)).optional(),
    threshold: z.coerce.number().min(0).max(1).optional(),
  },
  async ({ proposed_action, types, threshold }) => {
    let queryVector: Float32Array | null = null;
    if (embeddingClient) {
      const vecs = await embeddingClient.embed([proposed_action]);
      if (vecs && vecs.length > 0) queryVector = vecs[0];
    }
    const result = handleCheckSimilar(getProjectDb(), queryVector, {
      proposed_action,
      types,
      threshold,
    });

    // Deposit weak signal on matched notes
    const similarNoteIds = result.results.map(r => r.id);
    if (similarNoteIds.length > 0) {
      depositSignalBatch(getProjectDb(), similarNoteIds, WEAK_DEPOSIT);
    }

    let text = result.message;
    if (result.results.length > 0) {
      text += "\n";
      for (const r of result.results) {
        text += `\n- **${r.id}** [${r.type}] (${(r.similarity * 100).toFixed(1)}%) ${r.content}`;
      }
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ── retro ───────────────────────────────────────────────────────────────
server.tool(
  "retro",
  "Run maintenance on the knowledge base and analyze what's working. Decays confidence on stale notes, merges duplicates, identifies orphans, queues notes for revalidation, computes autonomy scores, and analyzes user model trajectories. Use after a debugging session, when an approach failed, or periodically to keep knowledge fresh.",
  {
    focus: z.string().optional(),
  },
  async ({ focus }) => {
    const result = handleReflect(getProjectDb(), getGlobalDb(), { focus });
    let text = result.message;
    text += `\n\nAutonomy scores:`;
    for (const [domain, score] of Object.entries(result.autonomy_scores)) {
      text += `\n- ${domain}: ${score}`;
    }
    if (result.revalidation_queue.length > 0) {
      text += `\n\nRevalidation queue:`;
      for (const item of result.revalidation_queue) {
        text += `\n- [${item.type}] ${item.content}`;
      }
    }
    if (result.trajectory_updates > 0) {
      text += `\n\nUser model: ${result.trajectory_updates} trajectory update(s).`;
    }
    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ── list_work_items ──────────────────────────────────────────────────────
server.tool(
  "list_work_items",
  "List ALL work items, optionally filtered by status and/or priority. Unlike lookup, this does not use keyword search - it returns everything matching the filters. Use when you need a complete inventory of tracked work.",
  {
    status: z.enum(["proposed", "planned", "active", "blocked", "done", "all"]).optional().default("all"),
    priority: z.enum(["critical", "high", "medium", "low", "backlog", "all"]).optional().default("all"),
    tag: z.string().optional().describe("Filter by tag (substring match on tags field)"),
    limit: z.coerce.number().optional().default(50),
  },
  async ({ status, priority, tag, limit }) => {
    const db = getProjectDb();
    let query = `SELECT id, type, content, confidence, created_at, keywords, status, priority, due_date, tags
                 FROM notes WHERE type = 'work_item'`;
    const params: any[] = [];

    if (status && status !== "all") {
      query += ` AND status = ?`;
      params.push(status);
    }
    if (priority && priority !== "all") {
      query += ` AND priority = ?`;
      params.push(priority);
    }
    if (tag) {
      query += ` AND tags LIKE ?`;
      params.push(`%${tag}%`);
    }

    // R3.2: priority tier remains the primary sort; signal is the tiebreaker
    // within a tier so hot work items float up within their priority group.
    query += ` ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 WHEN 'backlog' THEN 4 ELSE 5 END, COALESCE(signal, 0) DESC, updated_at DESC`;
    query += ` LIMIT ?`;
    params.push(limit ?? 50);

    const rows = db.query(query).all(...params) as any[];

    // Get total count (without limit)
    let countQuery = `SELECT COUNT(*) as cnt FROM notes WHERE type = 'work_item'`;
    const countParams: any[] = [];
    if (status && status !== "all") { countQuery += ` AND status = ?`; countParams.push(status); }
    if (priority && priority !== "all") { countQuery += ` AND priority = ?`; countParams.push(priority); }
    if (tag) { countQuery += ` AND tags LIKE ?`; countParams.push(`%${tag}%`); }
    const total = (db.query(countQuery).get(...countParams) as any).cnt;

    // Deposit weak signal on listed work items
    const workItemIds = rows.map((r: any) => r.id);
    if (workItemIds.length > 0) {
      depositSignalBatch(db, workItemIds, WEAK_DEPOSIT);
    }

    const lines: string[] = [];
    lines.push(`## Work Items (${rows.length} of ${total} total)`);
    lines.push("");

    for (const row of rows) {
      const pri = row.priority ? `[${row.priority.toUpperCase()}]` : "";
      const st = row.status ? `(${row.status})` : "";
      const due = row.due_date ? ` due:${row.due_date}` : "";
      const tags = row.tags ? ` [${row.tags}]` : "";
      const content = row.content.length > 120 ? row.content.slice(0, 120) + "..." : row.content;
      lines.push(`- ${pri} **${row.id}** ${st}${due}${tags} ${content}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ── list_open_threads ────────────────────────────────────────────────────
server.tool(
  "list_open_threads",
  "List ALL open threads (unresolved questions, investigations, tracked issues). Unlike lookup, returns everything without keyword search.",
  {
    resolved: z.coerce.boolean().optional().default(false).describe("Include resolved threads"),
    tag: z.string().optional().describe("Filter by tag (substring match)"),
    limit: z.coerce.number().optional().default(50),
  },
  async ({ resolved, tag, limit }) => {
    const db = getProjectDb();
    let query = `SELECT id, type, content, confidence, created_at, keywords, tags, resolved
                 FROM notes WHERE type IN ('open_thread', 'commitment')`;
    const params: any[] = [];

    if (!resolved) {
      query += ` AND resolved = 0`;
    }
    if (tag) {
      query += ` AND tags LIKE ?`;
      params.push(`%${tag}%`);
    }

    // R3.2: signal as secondary sort so hot threads surface above cold
    // threads at the same update time.
    query += ` ORDER BY COALESCE(signal, 0) DESC, updated_at DESC LIMIT ?`;
    params.push(limit ?? 50);

    const rows = db.query(query).all(...params) as any[];

    // Total count
    let countQuery = `SELECT COUNT(*) as cnt FROM notes WHERE type IN ('open_thread', 'commitment')`;
    const countParams: any[] = [];
    if (!resolved) { countQuery += ` AND resolved = 0`; }
    if (tag) { countQuery += ` AND tags LIKE ?`; countParams.push(`%${tag}%`); }
    const total = (db.query(countQuery).get(...countParams) as any).cnt;

    // Deposit weak signal on listed threads
    const threadIds = rows.map((r: any) => r.id);
    if (threadIds.length > 0) {
      depositSignalBatch(db, threadIds, WEAK_DEPOSIT);
    }

    const lines: string[] = [];
    lines.push(`## Open Threads (${rows.length} of ${total} total)`);
    lines.push("");

    for (const row of rows) {
      const resolved_tag = row.resolved ? " [RESOLVED]" : "";
      const tags = row.tags ? ` [${row.tags}]` : "";
      const content = row.content.length > 120 ? row.content.slice(0, 120) + "..." : row.content;
      lines.push(`- **${row.id}**${resolved_tag}${tags} ${content}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ── R6: Cross-session messaging tools ───────────────────────────────────

server.tool(
  "update_session_task",
  "Broadcast what you're currently working on. Sibling sessions see this in their next briefing's Cross-Session Activity AND in agent-channel notifications (the from_task metadata field). Call when you start a major task so other sessions know what you're touching. LENGTH: task is capped at 2000 characters and is REJECTED (not truncated) above it - write it as a broadcast line, not a checkpoint. Prioritise what a peer needs to avoid colliding with you, and CITE work items and notes by id rather than restating them: a cited id stays true after the record changes, while a copied summary rots and costs you the space that collision detail needed. Long-form history belongs in save_progress or a note. PA-coherence (optional): also self-declare warm_context (subsystems/files you're deep in - sharpens the auto-derived floor), hot_path_status ('driving' | 'holding-for-<X>' | 'idle-available' | 'parked' - only 'idle-available' is repurposable), and keep_clean (true = 'do not steer me, keeping context clean for delicate work'). These feed PA's repurposing-candidate query.",
  {
    // 0.30.72+: raised 500 -> 2000. The 500 cap was cutting the part of a lane
    // declaration that peers most need: the standing "do NOT do X" holds.
    // SA-df343a05 had to trim its holds twice to fit and SA-4e3d2623's first
    // call was rejected outright on 2026-07-27. This string is read by every
    // sibling's briefing and rides on every channel notification, so truncating
    // it degrades exactly the cross-session awareness the field exists for.
    // 2000 is still a hard bound - it is a broadcast line, not a checkpoint.
    // 0.58.0 (WI 40d09574): the limit is now STATED - in the tool description
    // above and in this rejection message. It was neither, and the first signal
    // a caller got was a bare `too_big` after composing a full declaration.
    // Measured on 2026-08-10: two sessions hit it independently within minutes
    // (one three times) and BOTH resolved it by deleting collision-avoidance
    // detail - the single most expensive content to lose, since its absence
    // shows up later as duplicated work or a merge conflict rather than as an
    // error. Naming the bound and the way out turns a blind trim into a
    // principled one.
    task: z
      .string()
      .min(1)
      .max(
        2000,
        "Task declaration is over the 2000-character limit. This is a broadcast line, " +
          "not a checkpoint - it rides on every channel notification and every sibling's " +
          "briefing. To fit: keep what a PEER needs in order to avoid colliding with you " +
          "(what you hold, what is blocked on whom, standing 'do NOT do X' holds), and cite " +
          "work items and notes by id instead of restating them - a reader can look those up, " +
          "and a cited id stays true after the record changes while a copied summary rots. " +
          "Put the long-form history in save_progress or a note, not here."
      ),
    session_id: z.string().optional(),
    warm_context: z.array(z.string()).max(50).optional(),
    // WI dcc756ec. CITE, don't restate. The roster resolves these to each
    // record's CURRENT title and status when it renders, so a work item that
    // closes after you declare shows as closed without you touching anything -
    // which a pasted summary can never do, and which is why this exists rather
    // than a bigger `task` cap.
    refs: z
      .array(z.string())
      .max(20)
      .optional()
      .describe(
        "Work-item / note ids your declaration refers to (8-char prefix or full id). " +
          "Cite them here INSTEAD of restating what they say in `task`: the roster renders " +
          "each one's live title and status, so the pointer stays true as the record changes " +
          "while a copied summary silently goes stale. Also frees the `task` budget for what " +
          "only you can say - what you hold, what is blocked on whom, and your standing holds."
      ),
    hot_path_status: z.string().max(80).optional(),
    keep_clean: z.boolean().optional(),
  },
  async (args) => {
    const sid = resolveSessionId(args.session_id);
    if (!sid || !sessionTracker) {
      return {
        content: [
          { type: "text" as const, text: "update_session_task requires a session_id and active tracker." },
        ],
      };
    }
    const text = handleUpdateSessionTask(sessionTracker, {
      session_id: sid,
      task: args.task,
      refs: args.refs,
    });
    // WI fe4d4acf: durable copy of the coherence fields, so a reload or a
    // reaper sweep cannot silently erase what the session declared.
    sessionTracker.persistCoherence(sid, {
      warm_context: args.warm_context,
      hot_path_status: args.hot_path_status,
    });
    // PA-coherence self-declare (Phase 3): persist the optional coherence fields
    // to this session's agent-channel roster row (via declareSelf -> the
    // per-column setters) so the repurposing query can read them. Only present
    // fields are written; the auto-derived warm_context floor (Phase 5) is left
    // intact when warm_context is omitted.
    //
    // 0.57.0: the TASK itself is mirrored unconditionally, not only when an
    // optional coherence field is present. handleUpdateSessionTask above writes
    // session_registry (project.db); getLiveSessions() reads the agent-channel
    // table, and THAT is what builds the post-compact peer roster and the
    // from_task on every channel notification. Nothing wrote that copy, so both
    // surfaces showed "(no task set)" for every peer while session_registry
    // held a current task for each - which is why PA kept rebuilding a blank
    // fleet picture after compaction.
    if (agentChannel) {
      agentChannel.declareSelf({
        current_task: args.task,
        warm_context: args.warm_context,
        refs: args.refs,
        hot_path_status: args.hot_path_status,
        keep_clean: args.keep_clean,
      });
    }
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "_hook_event",
  "Internal: dispatcher invoked from Claude Code hooks via type:'mcp_tool'. Routes per event_name. Returns hookSpecificOutput-shaped JSON. Agents should not call this directly.",
  {
    // Derived from the single source of truth in hook_event.ts so this
    // runtime validator can never again drift from the HookEvent type /
    // dispatcher / hooks.json (the 167ffbaf-xs SessionStart:compact bug:
    // the old hand-maintained enum here was missing "SessionStart", so CC's
    // post-compact hook was rejected -32602 at this boundary).
    event: z.enum(HOOK_EVENTS),
    session_id: z.string(),
    tool_name: z.string().optional(),
    agent_id: z.string().optional(),
    file_path: z.string().optional(),
    user_prompt: z.string().optional(),
    tool_input_id: z.string().optional(),
    // 0.38.0: the Bash command line, for the heredoc guard. Declared here
    // BECAUSE THIS BOUNDARY SILENTLY DROPS WHAT IT DOES NOT DECLARE - the
    // schema builds `payload` from named fields only, so an undeclared key
    // never reaches the handler and the feature reading it can never fire.
    command: z.string().optional(),
  },
  async (args) => {
    if (!sessionTracker) {
      return { content: [{ type: "text" as const, text: "{}" }] };
    }
    const db = getProjectDb();
    const payload: Record<string, unknown> = {};
    if (args.file_path) payload.file_path = args.file_path;
    if (args.user_prompt) payload.user_prompt = args.user_prompt;
    if (args.tool_input_id) payload.tool_input_id = args.tool_input_id;
    if (args.command) payload.command = args.command;
    const result = handleHookEvent(
      { db, tracker: sessionTracker },
      {
        event: args.event as HookEvent,
        session_id: args.session_id,
        tool_name: args.tool_name,
        agent_id: args.agent_id,
        payload: Object.keys(payload).length > 0 ? payload : undefined,
      }
    );

    const envelope = buildHookEnvelope(args.event as HookEvent, result);
    return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }] };
  }
);

// Cascade resolution helper now lives in `tools/cascade.ts` (shared with the
// `resolution: close_existing` path in remember.ts). Imported above.

// ── Agent-channel filewatcher ────────────────────────────────────────────
let agentChannel: AgentChannel | null = null;

/**
 * SA's PermissionRelay instance. Created when:
 *   (a) the PA-permission-relay env var is enabled, AND
 *   (b) this MCP serves a subordinate session (PAs don't receive
 *       permission_requests from CC about themselves).
 *
 * The agent-channel filewatcher routes inbound permission_verdict events
 * (from PA, on the system_events bus) to this relay via resolveVerdict.
 * The MCP notification handler (registered conditionally below) calls
 * registerPending to block until the verdict arrives.
 */
let permissionRelay: PermissionRelay | null = null;

/**
 * Convert a rich ChannelNotification.meta into the on-wire `Record<string, string>`
 * the channels contract requires. Drops null/undefined entries; coerces booleans
 * to "true"/"false", numbers to their string form, and arrays to comma-joined
 * strings. Objects (other than arrays) are dropped — those shouldn't appear in
 * channel meta anyway.
 *
 * See https://code.claude.com/docs/en/channels-reference: "Each entry becomes
 * an attribute on the <channel> tag. Keys must be identifiers: letters, digits,
 * and underscores only. Keys containing hyphens or other characters are
 * silently dropped." Values must be strings.
 */
function sanitizeChannelMeta(
  raw: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = v ? "true" : "false";
    } else if (typeof v === "number") {
      out[k] = String(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map(String).join(",");
    }
    // objects and everything else: dropped
  }
  return out;
}

function startAgentChannel(): void {
  const sessionId = resolveSessionId();
  if (!sessionId) {
    process.stderr.write(
      "agent-channel: no session_id resolvable; channel disabled\n",
    );
    return;
  }

  // Use the same project-root resolution as getProjectDbPath in
  // mcp/db/connection.ts. Claude Code doesn't set CLAUDE_PROJECT_DIR in MCP
  // server env reliably; the working directory or ORCHESTRATOR_PROJECT_ROOT
  // is the load-bearing signal. Refuse to start if we end up in a plugin
  // cache directory (would create state in a place that gets wiped on
  // /plugin update).
  const projectDir =
    process.env.ORCHESTRATOR_PROJECT_ROOT ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();

  if (
    projectDir.includes(".claude/plugins/cache") ||
    projectDir.includes(".claude\\plugins\\cache")
  ) {
    process.stderr.write(
      `agent-channel: refusing to start - resolved project dir is in plugin cache (${projectDir}). Set ORCHESTRATOR_PROJECT_ROOT or run from a real project directory.\n`,
    );
    return;
  }

  // Project hash dir under ~/.claude/projects/. Hash mirrors how Claude Code
  // names the per-project directory: replace path separators + drive colons
  // with hyphens, leading hyphens trimmed.
  const projectHash = projectDir.replace(/[\\/:]/g, "-").replace(/^-+/, "");
  const projectsHashDir = join(homedir(), ".claude", "projects", projectHash);

  // Role/name env vars: ORCHESTRATOR_AGENT_* is the canonical form (set by
  // the project-agnostic launchers in skills/install-launchers/scripts/).
  // SPAWNBOX_AGENT_* is the legacy form kept as a fallback during the
  // transition - older launchers in user projects that haven't been
  // refreshed via /orchestrator:install-launchers still set those.
  const roleEnv =
    process.env.ORCHESTRATOR_AGENT_ROLE ?? process.env.SPAWNBOX_AGENT_ROLE;
  const role: "prime" | "subordinate" =
    roleEnv === "prime" ? "prime" : "subordinate";
  const name =
    process.env.ORCHESTRATOR_AGENT_NAME ??
    process.env.SPAWNBOX_AGENT_NAME ??
    `auto-${sessionId.slice(0, 8)}`;

  // 0.30.31 (WI c03c9d6a): functional session kind, distinct from role.
  // role encodes orchestration position (who has authority); kind encodes
  // WHAT this session is for so consumers (skills, classifier policy, the
  // briefing renderer) can gate on identity without narrative pattern-
  // matching on names. Optional - older launchers that don't set the env
  // leave kind undefined and consumers fall back to role-based heuristics.
  const kindEnv =
    process.env.ORCHESTRATOR_SESSION_KIND ??
    process.env.SPAWNBOX_SESSION_KIND;
  const kind: import("./engine/agent_channel_state").SessionKind | undefined =
    kindEnv === "prime" || kindEnv === "subordinate" || kindEnv === "discord-bot"
      ? kindEnv
      : undefined;

  const self: SessionEntry = {
    session_id: sessionId,
    id8: sessionId.slice(0, 8),
    role,
    name,
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    current_task: null,
    ...(kind ? { kind } : {}),
  };

  const stateDir = join(projectDir, ".orchestrator-state", "agent-channel");

  // SA-side permission relay: created only when env opt-in AND this is a
  // subordinate. PAs don't need a relay (no inbound permission_requests
  // about themselves) - PA's MCP just routes verdicts back via the bus.
  if (PERMISSION_RELAY_ENABLED && role === "subordinate") {
    permissionRelay = new PermissionRelay(getProjectDb(), {
      selfSessionId: sessionId,
      defaultTimeoutMs: 30_000,
    });
    process.stderr.write(
      `permission-relay: enabled for subordinate session ${sessionId}\n`,
    );
  }

  try {
    agentChannel = new AgentChannel(
      stateDir,
      projectsHashDir,
      self,
      (notif) => {
        // The MCP SDK's high-level McpServer wraps a low-level Server at
        // server.server. notification() goes via the underlying transport.
        //
        // CRITICAL: per https://code.claude.com/docs/en/channels-reference, the
        // channel notification `meta` field type is `Record<string, string>`.
        // Claude Code's receive-side validator silently drops notifications
        // whose meta contains non-string values (null, undefined, boolean,
        // array). The SDK does NOT catch this on the send side. Without
        // sanitization, the entire channel architecture is invisible to
        // receivers despite the MCP server appearing healthy. Pre-0.30.8 the
        // orchestrator emitted booleans (pa_addressed), nulls (from_task), and
        // undefineds (tool_name, addressed_to, ...) and silently lost every
        // notification.
        // Defense-in-depth: server.server.notification() returns a Promise
        // that rejects if the transport isn't connected (e.g. during a brief
        // window at MCP startup, or if Claude Code has closed stdin). The
        // `void` discard turns those rejections into unhandled-promise events,
        // which Bun crashes the entire MCP process on by default. .catch()
        // here turns the rejection into a logged warning, keeping the MCP
        // server alive even if a single notification fails to deliver.
        // Channel events are best-effort - a missed one is better than a
        // crashed MCP.
        server.server
          .notification({
            method: "notifications/claude/channel",
            params: {
              content: notif.content,
              meta: sanitizeChannelMeta(notif.meta),
            },
          })
          .catch((err) => {
            process.stderr.write(
              `agent-channel: notification failed (event suppressed): ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            );
          });
      },
      // Inject the permission relay so the filewatcher can route inbound
      // verdict events to resolveVerdict (when this is a subordinate
      // session with the env opt-in). Undefined for PA / opt-out.
      permissionRelay ?? undefined,
      // 0.69.0 (WI fda1a7f2): authoritative, NON-CACHING identity read for the
      // 30s heartbeat reconcile. This is what lets a server that registered
      // under a sibling's session_id repair itself without a /mcp reconnect.
      readAuthoritativeSessionId,
    );
    agentChannel.start();
    process.stderr.write(
      `agent-channel: started as ${role} session_id=${sessionId} ` +
        `id8=${self.id8} name=${name} state_dir=${stateDir} ` +
        `projects_hash_dir=${projectsHashDir}\n`,
    );

    // ── PA-gated permission routing (Phase 2b, work_item 32250d62) ──────
    //
    // When PERMISSION_RELAY_ENABLED:
    // - Subordinate sessions register a notification handler for inbound
    //   permission_request from CC. The handler appends a
    //   permission_request_pending event to the system_events bus
    //   (addressed to PA's session) and awaits the relay Promise, then
    //   emits the verdict back to CC via notifications/claude/channel/permission.
    // - Prime sessions register the respond_to_permission tool. The tool's
    //   emitChannelEvent callback appends a permission_verdict event to
    //   the system_events bus (addressed to the originating SA). NOTE:
    //   This MUST write to the bus (not to a local MCP notification) so
    //   the verdict can traverse to the SA's MCP process.
    if (PERMISSION_RELAY_ENABLED) {
      if (role === "subordinate" && permissionRelay) {
        const relay = permissionRelay;
        const permissionRequestParamsSchema = z.object({
          request_id: z.string(),
          tool_name: z.string(),
          description: z.string(),
          input_preview: z.string(),
        });
        server.server.setNotificationHandler(
          z.object({
            method: z.literal("notifications/claude/channel/permission_request"),
            params: permissionRequestParamsSchema,
          }) as any,
          async (raw: any): Promise<void> => {
            // Defense-in-depth: the SDK's setNotificationHandler with `as any`
            // cast does NOT runtime-validate params (the schema is used only
            // for method dispatch). Parse explicitly so malformed inbound
            // shapes fail loud here, not silently downstream with `undefined`
            // fields propagated into the relay/bus.
            const parsed = permissionRequestParamsSchema.safeParse(raw?.params);
            if (!parsed.success) {
              process.stderr.write(
                `permission-relay: rejected malformed permission_request: ` +
                  `${parsed.error.message}\n`,
              );
              return;
            }
            const params = parsed.data;
            // 1. Resolve the live PA's session_id from the agent-channel
            //    registry (agent_channel.db) so we can target the bus event
            //    correctly. Read it fresh each request - PA may have started
            //    after this SA, and only a heartbeat-fresh PA should receive
            //    the relay.
            //
            //    MUST use getLiveSessions() (SQLite), NOT the legacy
            //    `sessions.json`: the 0.30.35 migration retired and DELETES
            //    that file (migrateSessionsLegacy -> unlinkSync), so the old
            //    readFileSync(sessions.json) path always resolved to null on
            //    any 0.30.35+ build. Result: every inbound permission_request
            //    silently bailed at "no PA active" and dead-ended at the SA
            //    terminal instead of routing to PA. (Fix: WI 0936e25d /
            //    686db7dc; mirrors the post-compact PA-recovery lookup.)
            let paSessionId: string | null = null;
            try {
              const live = getLiveSessions();
              paSessionId =
                live?.find((e) => e.role === "prime")?.session_id ?? null;
            } catch {
              // Fall through to terminal prompt
            }

            // 2. If no PA available, fail-safe by deferring to human (CC
            //    will fall back to terminal prompt). Don't block on a
            //    non-existent PA.
            if (!paSessionId) {
              process.stderr.write(
                `permission-relay: no PA active; deferring request ${params.request_id} to human\n`,
              );
              return;
            }

            // 3. Register pending + append to bus + await verdict.
            const pending = relay.registerPending({
              request_id: params.request_id,
              source_session: sessionId,
              tool_name: params.tool_name,
              description: params.description,
              input_preview: params.input_preview,
            });
            try {
              appendSystemEvent(stateDir, {
                event_type: "permission_request_pending",
                from_session: sessionId,
                to_session: paSessionId,
                ts: new Date().toISOString(),
                request_id: params.request_id,
                tool_name: params.tool_name,
                description: params.description,
                input_preview: params.input_preview,
              });
            } catch (err) {
              process.stderr.write(
                `permission-relay: bus append failed for ${params.request_id}: ${
                  err instanceof Error ? err.message : String(err)
                }\n`,
              );
              // Fall through - the relay still has a Promise + timeout.
            }

            const verdict = await pending;

            // 4. Emit the verdict back to CC, but ONLY for definitive
            //    verdicts (allow / deny). For `defer_to_human` - which
            //    fires on timeout, shutdown, or PA's explicit deferral -
            //    we deliberately do NOT respond. CC's protocol uses
            //    response absence as the signal to fall back to the
            //    terminal permission prompt. Emitting `behavior: "deny"`
            //    would actively foreclose that fallback and trap the SA
            //    at a permission gate. (Caught by code-review 2026-05-11.)
            if (verdict.verdict === "defer_to_human") {
              process.stderr.write(
                `permission-relay: deferring request ${params.request_id} ` +
                  `to terminal (pa_session=${verdict.pa_session})\n`,
              );
              return;
            }
            await server.server
              .notification({
                method: "notifications/claude/channel/permission",
                params: {
                  request_id: params.request_id,
                  behavior: verdict.verdict, // "allow" or "deny"
                  ...(verdict.pa_reason ? { message: verdict.pa_reason } : {}),
                },
              })
              .catch((err) => {
                process.stderr.write(
                  `permission-relay: verdict emit failed for ${params.request_id}: ${
                    err instanceof Error ? err.message : String(err)
                  }\n`,
                );
              });
          },
        );
        process.stderr.write(
          `permission-relay: SA notification handler registered for session ${sessionId}\n`,
        );
      }

      if (role === "prime") {
        // PA-side tool: respond_to_permission. The tool's emitChannelEvent
        // callback writes a permission_verdict event to the system_events
        // bus addressed to the originating SA (looked up from the audit
        // table or the request_id's bus entry).
        server.tool(
          "respond_to_permission",
          "PA-only: respond to a routed permission_request_pending channel event. " +
            "Pass the request_id from the event, verdict (allow/deny/defer_to_human), " +
            "and a reason (required for non-allow verdicts; audited).",
          RespondToPermissionInputSchema.shape,
          async (input) => {
            // Look up originating SA from the permission_audit table (the
            // bus event from the SA already wrote a row when registerPending
            // fired, then this MCP's filewatcher saw the event but doesn't
            // own a relay - so we read the audit directly).
            const row = getProjectDb()
              .query("SELECT source_session FROM permission_audit WHERE request_id = ?")
              .get(input.request_id) as { source_session: string } | undefined;
            const toSession = row?.source_session;
            if (!toSession) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `respond_to_permission: no audit row for request_id=${input.request_id}. ` +
                      `Cannot route verdict - the originating SA's MCP must have written the audit ` +
                      `row first. Possible causes: request_id wrong, SA's MCP died, or the request ` +
                      `was already resolved.`,
                  },
                ],
                isError: true,
              };
            }

            const result = await handleRespondToPermission(input, {
              paSessionId: sessionId,
              emitChannelEvent: (event) => {
                // CRITICAL (per code-review of Phase 2a): this callback
                // MUST write to the system_events bus, not emit a local
                // MCP notification. The verdict needs to traverse to the
                // SA's MCP process via the file-based bus; an in-process
                // notification stays local to PA.
                appendSystemEvent(stateDir, {
                  event_type: event.event_type,
                  from_session: sessionId,
                  to_session: toSession,
                  ts: new Date().toISOString(),
                  request_id: event.request_id,
                  verdict: event.verdict,
                  pa_session: event.pa_session,
                  ...(event.pa_reason ? { pa_reason: event.pa_reason } : {}),
                });
              },
            });

            return {
              content: [{ type: "text" as const, text: result.message }],
              ...(result.emitted ? {} : { isError: true }),
            };
          },
        );
        process.stderr.write(
          `permission-relay: PA tool 'respond_to_permission' registered for session ${sessionId}\n`,
        );
      }
    }
  } catch (err) {
    process.stderr.write(
      `agent-channel: FAILED TO START - ${err instanceof Error ? err.message : String(err)}\n` +
        `  state_dir=${stateDir}\n` +
        `  projects_hash_dir=${projectsHashDir}\n` +
        `  session_id=${sessionId}\n`,
    );
  }
}

// Stop agent-channel cleanly on stdin close (Claude Code closes the MCP
// connection by closing stdin). Without this, sessions.json would retain a
// dangling entry until stale-cleanup reaped it after 90s.
//
// 0.30.10 observability: log to stderr WHY the MCP is shutting down so we
// can correlate against Claude Code's behavior. Issue observed 2026-05-11:
// an idle SA's MCP child silently died (session_departed event fired)
// while claude.exe stayed alive - manual /plugin reconnect was required.
// CC does not persist MCP-server stderr anywhere readable (the ~/.claude debug /
// mcp-servers dirs are empty), so lifecycle/crash events written only to stderr
// vanish after the fact - exactly why a disconnect used to leave no trail.
// FIX (Jarid-directed 2026-07-14): mirror every lifecycle event (startup,
// shutdown, uncaughtException+stack, unhandledRejection+stack, 5-min liveness
// heartbeat) to a DURABLE, cross-session file so the NEXT disconnect is
// diagnosable - a crash stack = a plugin bug to harden; a heartbeat that just
// STOPS with no shutdown line = the process was killed (OOM / harness) = env.
// Each line carries session_id + pid so one global file answers "which MCPs
// died when". Bounded (2MB, truncate-rotate) + never throws (a crash logger
// that crashes the MCP would be worse than none).
const mcpStartMs = Date.now();
const MCP_LIFECYCLE_LOG = join(
  process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  "orchestrator",
  "mcp-lifecycle.log",
);
const MCP_LOG_CAP_BYTES = 2 * 1024 * 1024;
function logMcpLifecycle(line: string): void {
  appendLifecycleLine(MCP_LIFECYCLE_LOG, line, MCP_LOG_CAP_BYTES, new Date().toISOString());
}
/**
 * Write a lifecycle line to BOTH the durable file (primary) and stderr (live,
 * best-effort). File FIRST so a dead-pipe EPIPE on stderr - the transport-death
 * case this log exists for - can't skip the durable write. See emitLifecycleLine.
 */
function emitLifecycle(line: string): void {
  emitLifecycleLine((s) => process.stderr.write(s), logMcpLifecycle, line);
}
function logShutdownTrigger(trigger: string): void {
  const uptimeSec = Math.round((Date.now() - mcpStartMs) / 1000);
  emitLifecycle(
    `[orchestrator] shutdown triggered=${trigger} at=${new Date().toISOString()} ` +
      `pid=${process.pid} uptime_sec=${uptimeSec} ` +
      `session_id=${resolveSessionId() ?? "<none>"}\n`,
  );
}
let shutdownLogged = false;
function shutdownOnce(trigger: string): void {
  if (shutdownLogged) return;
  shutdownLogged = true;
  logShutdownTrigger(trigger);
  if (agentChannel) agentChannel.stop();
}
process.stdin.on("end", () => shutdownOnce("stdin-end"));
process.stdin.on("close", () => shutdownOnce("stdin-close"));
process.on("SIGTERM", () => shutdownOnce("SIGTERM"));
process.on("SIGINT", () => shutdownOnce("SIGINT"));
process.on("SIGHUP", () => shutdownOnce("SIGHUP"));
// 0.44.1: a dead stdio pipe must not kill this process.
//
// Found by SA-622e7298 (DISCORD lane): 808 EPIPE uncaughtExceptions across
// multiple PIDs in the lifecycle log. The subtlety is that emitLifecycleLine
// ALREADY wraps its stderr write in try/catch - so this is not a missing
// guard, it is a guard aimed at the wrong half of the failure.
// `process.stderr.write` on a broken pipe raises EPIPE ASYNCHRONOUSLY, as an
// 'error' event on the stream. With no listener attached, Node/Bun promotes
// that to uncaughtException - and the handler below calls shutdownOnce. So a
// benign "our reader went away" TERMINATES the server, which is itself the
// alive-but-unreachable state the egress_suspect detector then reports. The
// failure manufactures the very condition it looks like.
//
// Exact mirror of the 0.44.0 append-embedding bug: that had `.catch()` for the
// async path and threw synchronously; this has try/catch for the sync path and
// fails asynchronously. A best-effort side effect needs BOTH guards or it can
// kill its host. See anti_pattern 798f741b.
//
// Swallowing is correct here: if stdio is gone there is nowhere to report it,
// and the durable lifecycle FILE (written first, by design) still records it.
process.stderr.on("error", () => {});
process.stdout.on("error", () => {});

process.on("uncaughtException", (err) => {
  emitLifecycle(
    `[orchestrator] uncaughtException at=${new Date().toISOString()} pid=${process.pid} ` +
      `msg=${err instanceof Error ? err.message : String(err)}\n` +
      `stack=${err instanceof Error ? (err.stack ?? "<no stack>") : "<not an Error>"}\n`,
  );
  shutdownOnce("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  emitLifecycle(
    `[orchestrator] unhandledRejection at=${new Date().toISOString()} pid=${process.pid} ` +
      `reason=${reason instanceof Error ? reason.message : String(reason)}\n` +
      `stack=${reason instanceof Error ? (reason.stack ?? "<no stack>") : "<not an Error>"}\n`,
  );
  // Do NOT shutdown - unhandled rejections shouldn't kill the MCP. Just log
  // them so we can correlate with any later disconnect. If the rejection is
  // load-bearing, the next operation will surface it.
});

// Liveness heartbeat every 5 minutes, now durably persisted. Lets us bracket
// exactly when the MCP went silent if it ever disconnects unexpectedly - the
// last "alive" line in the file before the gap is the upper bound for the
// failure window, and the ABSENCE of a following shutdown line means it was
// killed (OOM / harness) rather than exiting cleanly. Cheap; no orchestrator-
// internal effect.
setInterval(() => {
  emitLifecycle(
    `[orchestrator] alive at=${new Date().toISOString()} pid=${process.pid} ` +
      `uptime_sec=${Math.round((Date.now() - mcpStartMs) / 1000)} ` +
      `session_id=${resolveSessionId() ?? "<none>"}\n`,
  );
}, 5 * 60 * 1000).unref();

// 0.30.23+ orphan-bun watchdog: periodically verify our parent claude.exe
// is still alive. If it's gone, this bun has been orphaned - shut down
// cleanly to stop heartbeating sessions, processing peer JSONLs, and
// clobbering the live PA/SA's state.
//
// Without this watchdog, bun processes whose parent claude.exe died (window
// closed, plugin reload race, claude crash, etc.) keep running forever. They
// accumulate (10+ orphans observed 2026-05-11), each heartbeating their
// session entry with whatever role/name they happened to cache at startup,
// and reading every other session's JSONL forever - net effect is identity
// clobber on sessions.json + resource leak.
//
// 0.30.36 (orphan watchdog reliability fix - WI d78867af):
//
// The prior implementation re-walked the process tree on each tick and
// compared the FIRST claude.exe found in the chain against the initial.
// This walk had two failure modes that let two orphans survive for hours
// on 2026-05-12 (DATI-01 bun 36184, DISCORD-LIVE bun 4356):
//
//   1. The walk relied on WMIC to look up process info by PID. After
//      Windows kills the parent claude.exe, the bun's PPID becomes a
//      dangling reference; whether the lookup on a freed PID returned
//      empty (walk -> null -> shutdown) vs stale/partial data depended on
//      Windows version + service state. Also: wmic is being removed from
//      Windows entirely - the session-start hook already migrated to
//      Get-CimInstance, this watchdog hadn't.
//   2. The setInterval callback had no try/catch wrap. An uncaught throw
//      inside execSync or regex parse silently kills the timer for the
//      rest of the process's life (same class as the 0.30.32 heartbeat
//      ghost-session bug).
//
// The fix: replace the walk-and-compare with a direct liveness check on
// the specific initial parent PID via `tasklist /FI "PID eq <N>"` (fast,
// not deprecated, ~50ms). We capture initialParentClaudePid once at
// startup; every tick we ask "is process initialParentClaudePid still
// running AND still named claude.exe?" If no, we're orphaned, shutdown.
// This bypasses the ancestor-walk entirely and depends only on a single
// existence query - easier to reason about, far less surface for stale
// process-table edge cases.
//
// Plus: tick body wrapped in try/catch (timer survives transient failures),
// tick interval tightened to 30s (was 60s) so orphan window is at most
// ~30s, sample tick logs outcome (visibility for future incidents).
//
// findClaudeAncestorPid (called once at startup to capture
// initialParentClaudePid) also migrated off wmic to Get-CimInstance via
// PowerShell -EncodedCommand. The one-time ~1-2s startup cost there is
// acceptable; the hot path uses the faster tasklist.

/**
 * Get a process's CreationDate via Win32_Process (Windows) or /proc start
 * time (Unix). Used together with PID to defend against PID reuse - the
 * same numeric PID can be reassigned to a new, unrelated process after the
 * original exits.
 *
 * Returns null on any failure (process gone, query error, parse error) -
 * callers treat null as "can't determine."
 */
function getProcessCreationTime(pid: number): Date | null {
  if (process.platform === "win32") {
    try {
      const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue).CreationDate.ToString('o')`;
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const out = execSync(
        `powershell.exe -NoProfile -EncodedCommand ${encoded}`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const s = out.trim();
      if (!s) return null;
      const d = new Date(s);
      return Number.isFinite(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  // Unix: /proc/<pid>/stat field 22 is starttime in clock ticks since boot.
  // Converting to a wall-clock Date requires boot time + CLK_TCK. Skip for
  // now (Unix path falls back to PID-only check without reuse defense).
  return null;
}

/**
 * Is this PID alive AND named claude.exe (or claude on Unix)? If
 * `expectedCreationTime` is provided, also verify the process at this PID
 * has the SAME creation time - defends against PID reuse where a freed
 * claude.exe PID gets reassigned to a different process (including, observed
 * 2026-05-12, a brand-new claude.exe instance after the user restarted
 * Claude Code).
 *
 * Without the creation-time check, the watchdog can never fire when the
 * user restarts Claude Code: old claude.exe at PID X dies; new claude.exe
 * (different process, same PID X if Windows recycles) starts; tasklist sees
 * "PID X is claude.exe alive"; watchdog thinks parent is fine. Then the
 * orphan MCP runs forever. Confirmed root cause for two orphan buns observed
 * 2026-05-12 (34088 + 15640, both with PID-reuse-fooled watchdogs).
 */
/**
 * 0.69.0 (WI 590bf9a9): THREE STATES, NOT A BOOLEAN.
 *
 * "I could not determine whether the parent is alive" is not the same claim as
 * "the parent is dead", and collapsing them let a single transient failure
 * shut down a healthy server.
 */
type ParentLiveness = "alive" | "dead" | "undetermined";

/**
 * 0.69.0 (WI 590bf9a9) - was isPidAliveAsClaudeExe(): boolean.
 *
 * THE OLD COMMENT HERE JUSTIFIED "assume dead" WITH A COST MODEL THAT IS FALSE,
 * and the model is what licensed the behaviour, so it is corrected rather than
 * deleted. It read: *"the cost of a false positive (orphan thinks parent is
 * dead and shuts down) is one terminal re-launch."*
 *
 * Measured 2026-08-29: the cost is NOT one re-launch. The shutdown is PARTIAL -
 * the agent-channel half deletes the session row and stops while the stdio half
 * keeps serving tools. The session then looks healthy from outside, still
 * answers tool calls, and is SILENTLY UNADDRESSABLE, with no way to tell from
 * inside. One instance cost ~25 minutes across three agents, two human `/mcp`
 * interventions, and produced a rowless session that could not report its own
 * state. A false positive here is expensive and quiet; the old model assumed it
 * was cheap and loud.
 *
 * Determined-dead vs undetermined, per branch:
 * - tasklist's own "INFO: No tasks..." IS an answer -> dead.
 * - empty stdout is a FAILED INVOCATION, not an answer -> undetermined.
 * - pid exists but is not claude -> the parent died and its pid was reused ->
 *   dead. (Determined: we positively observed a different process.)
 * - getProcessCreationTime returns null -> its OWN doc says callers must treat
 *   null as "can't determine". Honoured here; it used to be read as death.
 * - creation-time drift beyond tolerance -> a DIFFERENT claude holds the pid ->
 *   dead.
 * - any exception -> undetermined.
 */
function checkParentClaudeExe(
  pid: number,
  expectedCreationTime?: Date,
): ParentLiveness {
  try {
    if (process.platform === "win32") {
      // Fast path: tasklist for existence + name. ~50ms vs Get-CimInstance's
      // ~1-2s. Most ticks the parent IS alive with matching name; only when
      // it is AND expectedCreationTime is provided do we pay for the second
      // call to verify creation time.
      const out = execSync(
        `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const trimmed = out.trim();
      if (trimmed.startsWith("INFO:")) return "dead";
      if (!trimmed) return "undetermined";
      const firstCol = trimmed.match(/^"([^"]+)"/)?.[1] ?? "";
      const name = firstCol.toLowerCase();
      if (name !== "claude.exe" && name !== "claude") return "dead";
      // PID-reuse defense via creation-time match
      if (expectedCreationTime) {
        const actualCreation = getProcessCreationTime(pid);
        if (!actualCreation) return "undetermined";
        const drift = Math.abs(
          actualCreation.getTime() - expectedCreationTime.getTime(),
        );
        // 1s tolerance - Windows CreationDate has ~ms precision but small
        // skew can come from timezone parsing / .NET ticks-vs-Date round-trip.
        // Genuine PID reuse with another claude.exe is seconds-to-minutes
        // apart, never within 1s.
        if (drift > 1000) return "dead";
      }
      return "alive";
    } else {
      // Unix: process.kill(pid, 0) throws if dead. Then check /proc/<pid>/stat
      // comm field matches claude. Creation-time reuse defense not yet
      // implemented on Unix (TODO if/when an orphan-on-Unix case surfaces).
      try {
        process.kill(pid, 0);
      } catch (err: any) {
        // ESRCH = no such process (determined). EPERM = it EXISTS but is not
        // ours to signal, which is evidence of life, not death. Anything else
        // is unclassified and must not advance a kill.
        if (err?.code === "ESRCH") return "dead";
        if (err?.code !== "EPERM") return "undetermined";
      }
      let stat: string;
      try {
        stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        return "undetermined";
      }
      const rparen = stat.lastIndexOf(")");
      if (rparen < 0) return "undetermined";
      const name = stat.slice(stat.indexOf("(") + 1, rparen).toLowerCase();
      return name === "claude" || name === "claude.exe" ? "alive" : "dead";
    }
  } catch {
    return "undetermined";
  }
}

/**
 * Find sibling orchestrator MCP bun processes that share our parent claude.exe
 * and were spawned BEFORE us, then force-kill them.
 *
 * Mitigates anthropics/claude-code#25976: rapid `/plugin update` then
 * `/reload-plugins` can spawn a new MCP without killing the prior one - the
 * plugin manager's child-process cleanup races the new spawn. We observed
 * this 2026-05-12 (two orchestrator buns with the same claude.exe ancestor,
 * 25s apart).
 *
 * Why this is needed in addition to the orphan watchdog: both duplicate MCPs
 * have a valid live claude.exe ancestor, so the orphan watchdog (whose job is
 * "detect dead parent, self-shutdown") cannot tell the duplicate apart from
 * the legitimate one. This dedup runs at startup before the watchdog arms.
 *
 * "Newer wins" by Win32_Process.CreationDate: the plugin manager's intent on
 * each reload is "this NEW process is the MCP" - so the youngest sibling is
 * authoritative. Tie on creation time (vanishingly rare given microsecond
 * resolution) tiebreaks on PID (higher wins).
 *
 * Validates against the documented Windows PPID-reuse failure mode (per
 * Win32_Process docs - "ParentProcessId may refer to a process that reused
 * a process identifier"): for the parent claude.exe to be a genuine ancestor
 * of a child bun, parent.CreationDate must be <= child.CreationDate. If a
 * sibling's "ancestor" claude.exe is younger than the sibling itself, the
 * walk was fooled by a freed-then-reassigned PID and we don't kill.
 *
 * Best-effort (try/catch around the whole thing): if PowerShell fails or the
 * scan errors, the orphan watchdog remains the safety net. We never propagate
 * the error.
 */
function killOlderDuplicateMcps(myInitialParentClaudePid: number): void {
  if (process.platform !== "win32") return;
  const myPid = process.pid;
  const script = `
$myPid = ${myPid}
$myParentClaude = ${myInitialParentClaudePid}

$myProc = Get-CimInstance Win32_Process -Filter "ProcessId = $myPid" -ErrorAction SilentlyContinue
if (-not $myProc) { exit 0 }
$myStart = $myProc.CreationDate

$myParentClaudeProc = Get-CimInstance Win32_Process -Filter "ProcessId = $myParentClaude" -ErrorAction SilentlyContinue
if (-not $myParentClaudeProc) { exit 0 }
$myParentClaudeStart = $myParentClaudeProc.CreationDate

$siblings = Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" | Where-Object {
  $_.CommandLine -like '*orchestrator*dist*server.js*' -and $_.ProcessId -ne $myPid
}
foreach ($s in $siblings) {
  # Walk s's ancestor chain to find its claude.exe
  $walk = $s.ProcessId
  $ancestorClaude = 0
  for ($i = 0; $i -lt 8; $i++) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $walk" -ErrorAction SilentlyContinue
    if (-not $p) { break }
    if ($p.Name -eq 'claude.exe') { $ancestorClaude = $walk; break }
    if (-not $p.ParentProcessId -or $p.ParentProcessId -eq 0 -or $p.ParentProcessId -eq $walk) { break }
    $walk = $p.ParentProcessId
  }
  if ($ancestorClaude -ne $myParentClaude) { continue }

  # PPID-reuse defense: if the "ancestor" claude.exe was created AFTER the
  # sibling bun, it's not a real ancestor - it's a freed PID reassigned to a
  # newer process. Skip the kill.
  if ($s.CreationDate -lt $myParentClaudeStart) { continue }

  # Kill if sibling older than me, or same start time and lower PID (tiebreak).
  if ($s.CreationDate -lt $myStart -or ($s.CreationDate -eq $myStart -and $s.ProcessId -lt $myPid)) {
    Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "killed:$($s.ProcessId):created=$($s.CreationDate.ToString('o'))"
  }
}
`;
  try {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const out = execSync(
      `powershell.exe -NoProfile -EncodedCommand ${encoded}`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 },
    );
    const killed = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("killed:"));
    if (killed.length > 0) {
      process.stderr.write(
        `[orchestrator] dedup: killed ${killed.length} older sibling MCP(s) sharing parent claude.exe pid=${myInitialParentClaudePid}: ${killed.join("; ")}\n`,
      );
    }
  } catch (err) {
    // Non-fatal - the orphan watchdog is the second line of defense.
    process.stderr.write(
      `[orchestrator] dedup: sibling scan failed (non-fatal, watchdog will catch): ${err}\n`,
    );
  }
}

const initialParentClaudePid = findClaudeAncestorPid();
// 0.30.38: also capture parent claude.exe's creation time so the watchdog
// can defend against PID reuse. Without this, when the user closes one
// Claude Code window and opens another, Windows may reassign the freed
// claude.exe PID to the new claude.exe - and a tasklist check on the old
// PID would return "claude.exe alive" (because it IS, just a different
// instance). Orphan watchdog stays armed forever, MCP runs forever.
// Confirmed root cause for two orphan buns observed 2026-05-12.
const initialParentClaudeCreationTime =
  initialParentClaudePid !== null
    ? getProcessCreationTime(initialParentClaudePid)
    : null;
if (initialParentClaudePid) {
  // 0.30.37 (WI for anthropics/claude-code#25976): kill older sibling MCPs
  // BEFORE arming the watchdog. The plugin manager's known race leaves stale
  // duplicates that the watchdog can't distinguish from legitimate runs.
  //
  // 0.69.0 (WI fda1a7f2) - THE KILL RUNS ONLY ON WALK-VERIFIED ANCESTRY.
  // `initialParentClaudePid` may now come from CLAUDE_PID, which is INHERITED:
  // every process spawned under a claude window carries it, including ones that
  // are not that window's MCP. Killing on an asserted ancestor rather than a
  // verified one is how a test rig destroyed a live MCP on 2026-08-29 - its
  // CLAUDE_PID named a real, live claude.exe, so a name check would have passed
  // and only the walk disagreed. Identity keeps the env fast path; this
  // destructive path pays the ~1-2s walk once at boot, exactly as it did before
  // today. Disagree or unresolvable -> skip the kill and say so.
  const dedupWalk = walkClaudeAncestorPid();
  if (dedupWalk.pid === null) {
    process.stderr.write(
      `[orchestrator] dedup SKIPPED - could not verify claude ancestry by walk ` +
        `(${dedupWalk.reason}); refusing to kill on an inherited CLAUDE_PID ` +
        `(WI fda1a7f2)\n`,
    );
  } else if (dedupWalk.pid !== initialParentClaudePid) {
    process.stderr.write(
      `[orchestrator] dedup SKIPPED - walk-verified ancestor ${dedupWalk.pid} ` +
        `disagrees with CLAUDE_PID ${initialParentClaudePid}. This process is ` +
        `not the MCP child of the window it inherited that value from ` +
        `(WI fda1a7f2)\n`,
    );
  } else {
    killOlderDuplicateMcps(dedupWalk.pid);
  }

  // 0.69.0 (WI 590bf9a9): N consecutive DETERMINED-dead observations before we
  // shut down. 3 x 30s bounds the extra orphan lifetime at ~90s, which is cheap
  // against the measured cost of a false positive (a partial, silent shutdown
  // that leaves a session serving tools while unaddressable).
  const DEAD_TICKS_BEFORE_SHUTDOWN = 3;
  let consecutiveDeadTicks = 0;

  const creationTimeNote = initialParentClaudeCreationTime
    ? ` created=${initialParentClaudeCreationTime.toISOString()}`
    : " (creation-time unavailable - PID-reuse defense disabled)";
  process.stderr.write(
    `[orchestrator] orphan watchdog armed - parent claude.exe pid=${initialParentClaudePid}${creationTimeNote} (tick every 30s)\n`,
  );
  setInterval(() => {
    try {
      const liveness = checkParentClaudeExe(
        initialParentClaudePid,
        initialParentClaudeCreationTime ?? undefined,
      );
      // 0.69.0 (WI 590bf9a9): the DECISION lives in mcp/engine/orphan_watchdog
      // so it can be unit-tested without a live process tree. This file makes
      // the observation; that module decides. Keep it that way - the streak rule
      // shipped untested for as long as it lived inline here.
      const decision = decideWatchdogAction(
        liveness,
        consecutiveDeadTicks,
        DEAD_TICKS_BEFORE_SHUTDOWN,
      );
      const priorStreak = consecutiveDeadTicks;
      consecutiveDeadTicks = decision.streak;

      if (decision.action === "ignore") {
        // An UNDETERMINED tick logs and neither advances nor resets the streak -
        // it carries no information in either direction. Silence here is what let
        // a transient tasklist failure read as a dead parent.
        process.stderr.write(
          `[orchestrator] orphan watchdog tick UNDETERMINED for parent ` +
            `pid=${initialParentClaudePid} - could not establish liveness. ` +
            `Not counting toward shutdown (streak stays ${consecutiveDeadTicks}/` +
            `${DEAD_TICKS_BEFORE_SHUTDOWN}). (WI 590bf9a9)\n`,
        );
      } else if (decision.action === "shutdown") {
        process.stderr.write(
          `[orchestrator] parent claude.exe pid=${initialParentClaudePid} no longer running ` +
            `(${consecutiveDeadTicks} consecutive determined-dead ticks). ` +
            `Shutting down to avoid becoming an orphan that clobbers live sessions.\n`,
        );
        shutdownOnce("parent-claude-gone");
      } else if (decision.action === "wait") {
        // Requiring consecutive CONFIRMED observations is the whole fix. A
        // genuinely dead parent still gets us reaped - just not on one sample.
        process.stderr.write(
          `[orchestrator] orphan watchdog: parent pid=${initialParentClaudePid} reads DEAD ` +
            `(${consecutiveDeadTicks}/${DEAD_TICKS_BEFORE_SHUTDOWN} consecutive) - ` +
            `waiting for confirmation before shutdown (WI 590bf9a9)\n`,
        );
      } else {
        if (priorStreak > 0) {
          process.stderr.write(
            `[orchestrator] orphan watchdog: parent pid=${initialParentClaudePid} is ALIVE again - ` +
              `clearing dead streak of ${priorStreak}\n`,
          );
        }
        // Visibility tick. Once every 30 ticks (15 min) - cheap and lets
        // post-mortems pinpoint exactly when the watchdog last confirmed
        // the parent alive vs. when it should have triggered.
        if (Math.random() < 1 / 30) {
          process.stderr.write(
            `[orchestrator] orphan watchdog tick - parent claude.exe pid=${initialParentClaudePid} still alive\n`,
          );
        }
      }
    } catch (err) {
      // Defense against the 0.30.32 ghost-session bug class: an uncaught
      // throw in setInterval permanently kills the timer. We log and
      // continue ticking on the next interval rather than silently dying.
      process.stderr.write(
        `[orchestrator] orphan watchdog tick failed (will retry next interval): ${err}\n`,
      );
    }
  }, 30 * 1000).unref();
} else {
  // 0.69.0 (WI fda1a7f2) - "CANNOT VERIFY" IS NOT "ORPHAN". THIS NO LONGER EXITS.
  //
  // It used to call shutdownOnce("no-claude-ancestor-at-startup"). On
  // 2026-08-29 that killed a healthy session's MCP one second after `/mcp`,
  // because a PowerShell parse error made the walk return null for every
  // process. The inference "walk found nothing => I am an orphan" treats an
  // UNRESOLVED question as a POSITIVE finding, and the cost of being wrong is
  // asymmetric and severe: a genuine orphan lingering is cheap and self-limiting
  // (it holds no row and the reaper prunes it), while a false positive destroys
  // a working session's tooling. Worse, the shutdown was PARTIAL - the
  // agent-channel half deleted the row and stopped while the stdio half kept
  // serving tools - so the session looked healthy and was silently unaddressable.
  //
  // Measured the same day: CLAUDE_PID is ABSENT in a real MCP child's
  // environment (present only in bash children), so the walk is the ONLY
  // ancestry source in production and is correctness-critical. Any walk failure
  // - CIM hiccup, PowerShell startup failure, an unexplained null like the one
  // still open from 16:07Z - would otherwise take down a healthy server.
  //
  // We therefore keep running WITHOUT the orphan watchdog and say so loudly.
  // Degraded, not dead: no parent to watch means we cannot detect the parent
  // dying, which is a real gap - but it is the safe half of the trade.
  const msg =
    `no claude.exe ancestor resolved at startup. NOT exiting - "cannot verify" ` +
    `is not "orphan" (WI fda1a7f2). Orphan watchdog is DISABLED for this ` +
    `process; if the parent dies this server will linger until the reaper ` +
    `prunes it. See the claude-ancestor line above for the walk's failure reason.`;
  process.stderr.write(`[orchestrator] ${msg}\n`);
  emitLifecycle(msg + "\n");
}

// ── Start server ────────────────────────────────────────────────────────
async function main() {
  // Startup version banner. Persisted durably (stderr + lifecycle file) so it
  // pairs with the eventual shutdown/crash line: "started at T1, last alive at
  // T2, no shutdown line" = killed between T2 and T2+5min. Also makes "is the
  // new version actually running?" trivially answerable.
  emitLifecycle(
    `[orchestrator] MCP server starting - version=${PLUGIN_VERSION} ` +
      `pid=${process.pid} ` +
      `session_id=${resolveSessionId() ?? "<none>"} ` +
      `project_dir=${process.env.CLAUDE_PROJECT_DIR ?? "<none>"} ` +
      `role=${process.env.ORCHESTRATOR_AGENT_ROLE ?? process.env.SPAWNBOX_AGENT_ROLE ?? "<default:subordinate>"}\n`,
  );

  // 0.48.0 (backlog item M + N): GC the state directory once per process.
  //
  // Nothing had ever deleted a marker. Measured three times on one machine:
  // 448 files -> 535 -> 730 (76 MB), debris back to 2026-04-21, dominated by
  // 445 `active-session-<pid>` anchors that are read once at boot and inert
  // forever after. The directory sits inside a OneDrive-synced project folder,
  // so all of it is replicated to the cloud indefinitely.
  //
  // Startup is the right moment (bounded, once, off the hot loop) and the
  // sweep is allowlist-based, age-floored and best-effort - see state_gc.ts.
  // Deliberately NOT awaited into a blocking gate: a slow filesystem must not
  // delay MCP availability.
  try {
    const projectRoot =
      process.env.ORCHESTRATOR_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const swept = sweepStateDir(join(projectRoot, ".orchestrator-state"));
    if (swept.removed > 0 || swept.rotated > 0) {
      emitLifecycle(
        `[orchestrator] state-dir GC: removed ${swept.removed} stale marker(s), ` +
          `rotated ${swept.rotated} ledger backup(s), of ${swept.scanned} file(s)\n`,
      );
    }
  } catch {
    // Never block startup on housekeeping.
  }

  // Initialize session tracker and clean up stale sessions
  sessionTracker = new SessionTracker(getProjectDb());
  sessionTracker.cleanup();

  // Connect MCP transport FIRST so that any channel notifications fired by
  // the agent-channel filewatcher's initial tick have a connected transport
  // to ride on. Otherwise the filewatcher's first tick (which fires
  // synchronously inside AgentChannel.start()) tries to emit notifications
  // via server.server.notification() while transport is still undefined; the
  // SDK throws "Not connected" and the rejection cascades to an unhandled
  // promise rejection that crashes the MCP process (Bun's default behavior).
  // This bug was invisible for sessions whose offsets-<id8>.json file was
  // caught up (no events to emit on first tick), but crashed any fresh
  // session that needed to process backlog from peer JSONLs at startup.
  // Empirically observed and root-caused 2026-05-11 on the dual-channel
  // Discord-ops session.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start agent-channel filewatcher (no-ops if env not set).
  // R6/R7 messaging system was removed in 0.29.0 - cross-session
  // communication is now entirely via channel notifications.
  //
  // Important: at MCP boot, the SessionStart hook hasn't fired yet, so the
  // active-session file ($CLAUDE_PROJECT_DIR/.orchestrator-state/active-session)
  // doesn't exist and resolveSessionId() returns undefined. The first call
  // here will return early. We retry every 3s for up to 60s until the
  // session is resolvable. Once started, the retry timer cancels itself.
  // 0.69.0 (WI fda1a7f2) - BUN-ENV PROBE. This is a GATE, not a nicety.
  // The whole env-first fix rests on the BUN inheriting CLAUDE_CODE_SESSION_ID,
  // and evidence from a bash child does NOT transfer: the two environments
  // provably diverge in both directions (the bun sees CLAUDE_PROJECT_DIR, bash
  // does not). Printed from inside the bun so the answer is measured, not
  // assumed. If CLAUDE_CODE_SESSION_ID reads ABSENT here, fix (1) is inert and
  // the heartbeat reconcile is carrying the entire repair.
  //
  // SENTINEL `fda1a7f2-binding-probe-v1` is the marker VERIFY greps for to
  // prove which bundle is actually running (content beats timestamps, 1ff5f968).
  // BOTH SINKS, deliberately. An earlier revision moved this to emitLifecycle
  // ONLY, on the belief that Claude Code discards an MCP server's stderr for
  // real spawns. That belief is FALSE and the evidence is this very probe: its
  // stderr output was recovered verbatim from
  // %LOCALAPPDATA%\claude-cli-nodejs\Cache\<slug>\mcp-logs-plugin-orchestrator-core\*.jsonl
  // for two real spawns (bun 13324 and bun 55588) on 2026-08-29, and that
  // capture is what proved CLAUDE_PID is absent in a real bun. Dropping stderr
  // would have thrown away the channel that answered the question.
  // mcp-lifecycle.log is the durable sink; the MCP stderr log is the one that
  // pairs a line with a specific spawn's pid. Keep both.
  const probeLine =
    `fda1a7f2-binding-probe-v1 bun-env: ` +
    `CLAUDE_CODE_SESSION_ID=${
      process.env.CLAUDE_CODE_SESSION_ID
        ? `PRESENT(${process.env.CLAUDE_CODE_SESSION_ID.slice(0, 8)})`
        : "ABSENT"
    } ` +
    `CLAUDE_SESSION_ID=${process.env.CLAUDE_SESSION_ID ? "present" : "absent"} ` +
    `CLAUDE_PID=${process.env.CLAUDE_PID ?? "absent"} ` +
    `bun_pid=${process.pid}`;
  process.stderr.write(`[orchestrator] ${probeLine}\n`);
  emitLifecycle(probeLine + "\n");

  startAgentChannel();
  if (!agentChannel) {
    let attempts = 0;
    const retryTimer = setInterval(() => {
      if (agentChannel) {
        clearInterval(retryTimer);
        return;
      }
      if (++attempts > 20) {
        process.stderr.write(
          "agent-channel: gave up after 20 retries (60s); session_id never became resolvable. Channel disabled for this MCP server lifetime.\n",
        );
        clearInterval(retryTimer);
        return;
      }
      startAgentChannel();
    }, 3000);
  }

  // Start embedding sidecar in background (never blocks MCP availability)
  startSidecar().then((client) => {
    embeddingClient = client;
    if (client) {
      sidecarStatus = "ready";
      sidecarError = null;
      client.backfill(getProjectDb()).catch((err) => {
        console.error("[embed] Backfill failed:", err);
      });
    } else {
      sidecarStatus = "unavailable";
      // sidecarError already set by startSidecar()
    }
  }).catch((err) => {
    console.error("[embed] Sidecar startup failed:", err);
    sidecarStatus = "error";
    sidecarError = String(err);
  });
}

// Do NOT kill the sidecar on exit. Multiple Claude sessions share one
// sidecar via the .sidecar-port file, so killing it here would yank the
// rug out from under sibling sessions. The sidecar will linger as an
// orphan Python process using ~500MB until the user reboots or manually
// kills it - which is a deliberate tradeoff versus respawning a fresh
// 1.5GB ONNX model every session. If the sidecar dies, the next session
// to start will spawn a new one via the reuse-or-spawn logic above.

main().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
