import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
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
import type { WorkItemStatus, Dimension } from "./types";
import { getProjectDb, getGlobalDb } from "./db/connection";
import { handleRemember } from "./tools/remember";
import { handleSupersede } from "./tools/supersede";
import { handleRecall } from "./tools/recall";
import { handleOrient, getCrossSessionHealth } from "./tools/orient";
import { handlePrepare } from "./tools/prepare";
import { handleReflect } from "./tools/reflect";
import { handleCheckSimilar } from "./tools/check_similar";
import { appendToNoteContent, snapshotRevision } from "./tools/update_note_helpers";
import { resolveNoteId } from "./tools/id_resolver";
import { cascadeResolution } from "./tools/cascade";
import { composeUserProfile } from "./engine/composer";
import { generateId, now, extractKeywords, formatAge, stringifyCodeRefs, parseTagList, normalizeTagString } from "./utils";
import { createAutoLinks } from "./engine/linker";
import { EmbeddingClient } from "./engine/embeddings";

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
import { SessionTracker } from "./engine/session_tracker";
import { depositSignal, depositSignalBatch, WEAK_DEPOSIT } from "./engine/signal";
import { handleUpdateSessionTask } from "./tools/session_task";
import { handleHookEvent, buildHookEnvelope, type HookEvent } from "./tools/hook_event";
import { AgentChannel } from "./engine/agent_channel";
import type { SessionEntry } from "./engine/agent_channel_state";
import { PermissionRelay } from "./engine/permission_relay";
import { appendSystemEvent } from "./engine/agent_channel_state";
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
function findClaudeAncestorPid(): number | null {
  const start = process.pid;
  if (process.platform === "win32") {
    const script = `
$walk = ${start}
for ($i = 0; $i -lt 8; $i++) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $walk" -ErrorAction Stop
    if (-not $p) { break }
    if ($p.Name -eq 'claude.exe' -or $p.Name -eq 'claude') { Write-Output $walk; exit 0 }
    if (-not $p.ParentProcessId -or $p.ParentProcessId -eq 0 -or $p.ParentProcessId -eq $walk) { break }
    $walk = $p.ParentProcessId
  } catch { break }
}
`;
    try {
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const out = execSync(
        `powershell.exe -NoProfile -EncodedCommand ${encoded}`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const pid = parseInt(out.trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }
  // Unix path
  let pid: number | null = start;
  for (let depth = 0; depth < 8 && pid; depth++) {
    let name = "";
    let ppid = 0;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rparen = stat.lastIndexOf(")");
      if (rparen < 0) break;
      name = stat.slice(stat.indexOf("(") + 1, rparen).toLowerCase();
      const fields = stat.slice(rparen + 2).split(/\s+/);
      ppid = parseInt(fields[1] ?? "0", 10);
    } catch {
      break;
    }
    if (name === "claude.exe" || name === "claude") return pid;
    if (!ppid || ppid === pid) break;
    pid = ppid;
  }
  return null;
}

function getFallbackSessionId(): string | undefined {
  if (cachedFallbackSessionId) return cachedFallbackSessionId;

  const envId = process.env.CLAUDE_SESSION_ID;
  if (envId && /^[a-zA-Z0-9_-]+$/.test(envId)) {
    cachedFallbackSessionId = envId;
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
  }

  // Legacy single-file fallback. Racy under concurrent siblings - the
  // file holds the LAST session that ran SessionStart, which may not
  // be us. Mitigated by the orphan-bun watchdog (0.30.23+) that kills
  // buns whose parent claude.exe is gone within ~60s, so impostor races
  // self-resolve.
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

function resolveSessionId(explicit?: string): string | undefined {
  // Cache explicit session_ids passed by tool calls so startAgentChannel's
  // retry loop can pick them up even when CLAUDE_SESSION_ID env is unset.
  // Claude Code routes session_id through tool args, not env vars, so this
  // is the only reliable signal during MCP server lifetime.
  if (explicit && /^[a-zA-Z0-9_-]+$/.test(explicit)) {
    cachedFallbackSessionId = explicit;
  }
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
  const portFile = resolve(pluginRoot, ".sidecar-port");

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
        console.error(`[embed] Reusing existing sidecar on port ${existingPort} (shared across sessions)`);
        // Do NOT set sidecarProcess - we didn't start it, so we must not kill
        // it on our exit. Let it outlive us so sibling sessions keep working.
        return client;
      }
    }
  } catch {
    // No port file or unreadable - proceed with spawn
  }

  // No reusable sidecar found - clean the stale port file (if any) and spawn fresh.
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(portFile);
  } catch {
    // File may not exist, that's fine
  }

  const baseArgs = ["--port", "0", "--port-file", portFile];

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
    return null;
  }

  sidecarProcess = result.proc;
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
      "If you are a subordinate (role=subordinate), treat PA-addressed messages as if the user said them - execute, then continue your work. SAs can address you too; those are peer-level, not authoritative.",
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

    // Embedding coverage
    let embeddedCount = 0;
    try {
      embeddedCount = (projectDb.query("SELECT COUNT(*) as cnt FROM embeddings").get() as any).cnt;
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
    lines.push(`- **Version**: orchestrator MCP server **0.30.28** (pid ${process.pid})`);
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
      lines.push(`- **Embeddings**: active (${embeddedCount}/${projectNotes} notes embedded, ${coveragePct}% coverage)`);
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
  "Capture knowledge not already known. Use when something new is learned, decided, or observed - AND no existing note covers it. If a lookup just showed you a related note that's now stale/wrong/incomplete, prefer update_note, supersede_note, or close_thread on that note instead of creating a new one. Maintenance verbs are equal-priority to this one - the orchestrator is a living knowledge base, not an append-only log. Don't batch captures; write immediately so future sessions benefit. Pass session_id so sibling sessions can see what you've created. When the knowledge is about specific code (an architecture insight, a gotcha, a pattern), add `code_refs: ['mcp/server.ts']` so the note is discoverable later via `lookup({code_ref: 'mcp/server.ts'})`. Breadcrumbs only - file or module paths, not line numbers or symbol names (code indexers handle those). Near-duplicate gate: for types decision/convention/anti_pattern, note() will BLOCK the write if embedding similarity >= 0.75 against an existing note, and will return candidates. You must then re-call with a `resolution` choosing one of accept_new / update_existing / supersede_existing / close_existing.",
  {
    content: z.string(),
    type: z.enum(NOTE_TYPES),
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
      .describe("Required when note() detects near-duplicate candidates (embedding similarity >= 0.75 for types: decision, convention, anti_pattern). Omit when there are no candidates, and the write proceeds normally. When candidates exist, agent must choose: accept_new (candidates are adjacent but genuinely different - both stand); update_existing (update the target instead of creating new); supersede_existing (create new and mark target as superseded, preserves history); close_existing (create new and mark target as resolved)."),
    code_refs: z
      .array(z.string().min(1).max(500))
      .max(50)
      .optional()
      .describe("Array of file or module paths this note points at (e.g. ['mcp/server.ts', 'src/core/backup/']). Breadcrumbs for code navigation - not line numbers or symbols (code indexers handle those). Used for reverse-index lookup ({code_ref: 'path'}) so agents can find notes about a file they're editing. Paths are normalized: leading './' stripped, backslashes converted to forward slashes, trimmed. Trailing slash preserved (distinguishes file vs directory ref). Each path: 1-500 chars; array max 50 entries."),
  },
  async ({ content, type, context, tags, scope, dimension, session_id, resolution, code_refs }) => {
    session_id = resolveSessionId(session_id);
    if (session_id) registerSessionOnce(session_id);
    const result = await handleRemember(getProjectDb(), getGlobalDb(), {
      content,
      type,
      context,
      tags,
      scope,
      dimension: dimension as Dimension | undefined,
      session_id,
      resolution,
      code_refs,
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
      const supSuffix = result.detail.superseded_by
        ? ` [SUPERSEDED by ${result.detail.superseded_by}]`
        : "";
      text += `\n\n**${result.detail.type}** (${result.detail.confidence}) updated:${age}${src}${supSuffix}`;
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
          text += `\n- **${r.id}** [${r.type}/${r.confidence}] updated:${age}${src}${tagStr}${supSuffix} ${r.content}${annotationMarker(r.id)}`;
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
    const result = await handleRemember(getProjectDb(), getGlobalDb(), {
      content,
      type: "checkpoint",
      context: `Checkpoint created at ${new Date().toISOString()}`,
      tags: "checkpoint",
      session_id,
    }, embeddingClient);

    return {
      content: [{
        type: "text" as const,
        text: result.stored
          ? `Progress saved (${result.note_id}). Next session will recover from here.`
          : `Progress updated (existing checkpoint promoted).`,
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
    tags: z.string().optional().describe("New tags (replaces existing)"),
    confidence: z.enum(["low", "medium", "high"]).optional(),
    code_refs: z.array(z.string().min(1).max(500)).max(50).optional().describe("Replace the note's code_refs breadcrumb array. Pass [] to clear; omit to leave unchanged. See note() code_refs for format."),
    session_id: z.string().optional().describe("Session ID - attributed to the revision snapshot."),
  },
  async ({ id, content, append_content, context, tags, confidence, code_refs, session_id }) => {
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

    // 0.30.28+ hard size limit (matches handleRemember). For content
    // rewrites: check the new content directly. For append_content:
    // check what the final content WILL be (current + appended) so
    // appends can't sneak past by being individually small.
    const NOTE_CONTENT_HARD_CHARS = 50_000;
    if (content !== undefined && content.length > NOTE_CONTENT_HARD_CHARS) {
      return { content: [{ type: "text" as const, text: `Note content rewrite is ${content.length} chars - exceeds hard limit of ${NOTE_CONTENT_HARD_CHARS}. Primitives should stay primitive (decision 3b962e67). Split into multiple linked notes.` }] };
    }
    if (append_content !== undefined) {
      const projectedLen = (row.content?.length ?? 0) + 4 + 32 + append_content.length; // approx new timestamped block
      if (projectedLen > NOTE_CONTENT_HARD_CHARS) {
        return { content: [{ type: "text" as const, text: `Append would grow note to ~${projectedLen} chars (current ${row.content?.length ?? 0} + append ${append_content.length}) - exceeds hard limit of ${NOTE_CONTENT_HARD_CHARS}. Note is too big; split into linked notes (decision 3b962e67) instead of growing this one further.` }] };
      }
    }

    const updates: string[] = [];

    if (append_content !== undefined) {
      appendToNoteContent(db, id, append_content);
      updates.push("append_content");
      // Re-read row so any fall-through UPDATE sees the appended content
      row = db.query(`SELECT id, type, content, context, tags, keywords FROM notes WHERE id = ?`)
        .get(id) as any;
    }

    if (content !== undefined) updates.push("content");
    if (context !== undefined) updates.push("context");
    if (tags !== undefined) updates.push("tags");
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
      content !== undefined || context !== undefined || tags !== undefined || !!confidence;
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
          tags != null ? normalizeTagString(tags) : row.tags,
          newKeywords ? newKeywords.join(",") : row.keywords,
          confidence ?? row.confidence ?? "medium",
          timestamp,
          id,
        ]
      );

      if (content !== undefined && embeddingClient) {
        embeddingClient.embedIfAvailable(db, id, newContent).catch(() => {
          embeddingClient!.removeEmbedding(db, id);
        });
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
  "Remove a note permanently. Use only when a note is genuinely wrong or harmful - prefer supersede_note (preserves history) or close_thread (marks resolved) for knowledge that was right-at-the-time or is now complete. Links to/from this note are CASCADE-removed. Equal-priority to note() - curation is as important as capture.",
  {
    id: z.string(),
    reason: z.string().optional().describe("Why this note is being deleted"),
  },
  async ({ id, reason }) => {
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
    code_refs: z.array(z.string().min(1).max(500)).max(50).optional().describe("code_refs for the inline-created replacement note. Ignored when new_id is provided (the target note keeps its own refs). See note() code_refs for format."),
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
    code_refs: z.array(z.string().min(1).max(500)).max(50).optional().describe("Array of file or module paths this work item points at. Same format as note() code_refs."),
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
    content: z.string().optional().describe("Updated description"),
    tags: z.string().optional().describe("Replace the full tag string (comma-separated). Existing tags are overwritten - read-modify-write if you only want to add/remove one."),
    context: z.string().optional().describe("Updated context (replaces existing; empty string clears)"),
    confidence: z.enum(["low", "medium", "high"]).optional(),
    code_refs: z.array(z.string().min(1).max(500)).max(50).optional().describe("Replace code_refs breadcrumbs. [] clears; omit to leave unchanged."),
    blocked_by: z.string().optional().describe("ID of the note blocking this work item (creates blocks link)"),
  },
  async ({ id, status, priority, due_date, content, tags, context, confidence, code_refs, blocked_by }) => {
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
    if (tags !== undefined) {
      // c658ce38: normalize at capture so a JSON-array-stringified tags
      // value (or already-baked garbage) never gets stored.
      const normTags = normalizeTagString(tags);
      setFragments.push("tags = ?");
      bindValues.push(normTags);
      changes.push(`tags: ${row.tags ?? "none"} -> ${normTags || "cleared"}`);
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
  "Broadcast what you're currently working on. Sibling sessions see this in their next briefing's Cross-Session Activity AND in agent-channel notifications (the from_task metadata field). Call when you start a major task so other sessions know what you're touching.",
  { task: z.string().min(1).max(500), session_id: z.string().optional() },
  async (args) => {
    const sid = resolveSessionId(args.session_id);
    if (!sid || !sessionTracker) {
      return {
        content: [
          { type: "text" as const, text: "update_session_task requires a session_id and active tracker." },
        ],
      };
    }
    const text = handleUpdateSessionTask(sessionTracker, { session_id: sid, task: args.task });
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "_hook_event",
  "Internal: dispatcher invoked from Claude Code hooks via type:'mcp_tool'. Routes per event_name. Returns hookSpecificOutput-shaped JSON. Agents should not call this directly.",
  {
    event: z.enum([
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PreCompact",
      "Stop",
      "StopFailure",
      "SubagentStop",
      "TaskCompleted",
    ]),
    session_id: z.string(),
    tool_name: z.string().optional(),
    agent_id: z.string().optional(),
    file_path: z.string().optional(),
    user_prompt: z.string().optional(),
    tool_input_id: z.string().optional(),
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
            // 1. Resolve PA's session_id from sessions.json so we can target
            //    the bus event correctly. Read it fresh each request - PA
            //    may have started after this SA.
            let paSessionId: string | null = null;
            try {
              const sessionsFile = join(stateDir, "sessions.json");
              if (existsSync(sessionsFile)) {
                const data = JSON.parse(readFileSync(sessionsFile, "utf8"));
                const entries: Array<{ session_id?: string; role?: string }> =
                  Array.isArray(data) ? data : data?.sessions ?? [];
                paSessionId = entries.find((e) => e.role === "prime")?.session_id ?? null;
              }
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
// We have no Claude Code MCP supervision logs accessible, so the only
// observability handle is the MCP server's own stderr. Capture the trigger
// (stdin end vs close, vs signal) + timestamp + pid + uptime so the next
// occurrence has an evidence trail.
const mcpStartMs = Date.now();
function logShutdownTrigger(trigger: string): void {
  const uptimeSec = Math.round((Date.now() - mcpStartMs) / 1000);
  process.stderr.write(
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
process.on("uncaughtException", (err) => {
  process.stderr.write(
    `[orchestrator] uncaughtException at=${new Date().toISOString()} pid=${process.pid} ` +
      `msg=${err instanceof Error ? err.message : String(err)}\n` +
      `stack=${err instanceof Error ? (err.stack ?? "<no stack>") : "<not an Error>"}\n`,
  );
  shutdownOnce("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `[orchestrator] unhandledRejection at=${new Date().toISOString()} pid=${process.pid} ` +
      `reason=${reason instanceof Error ? reason.message : String(reason)}\n` +
      `stack=${reason instanceof Error ? (reason.stack ?? "<no stack>") : "<not an Error>"}\n`,
  );
  // Do NOT shutdown - unhandled rejections shouldn't kill the MCP. Just log
  // them so we can correlate with any later disconnect. If the rejection is
  // load-bearing, the next operation will surface it.
});

// Liveness heartbeat to stderr every 5 minutes. Lets us bracket exactly when
// the MCP went silent if it ever disconnects unexpectedly - the last "alive"
// timestamp before the gap is the upper bound for the failure window. Cheap
// (one stderr write every 5min); no orchestrator-internal effect.
setInterval(() => {
  process.stderr.write(
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
function isPidAliveAsClaudeExe(
  pid: number,
  expectedCreationTime?: Date,
): boolean {
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
      if (!trimmed || trimmed.startsWith("INFO:")) return false;
      const firstCol = trimmed.match(/^"([^"]+)"/)?.[1] ?? "";
      const name = firstCol.toLowerCase();
      if (name !== "claude.exe" && name !== "claude") return false;
      // PID-reuse defense via creation-time match
      if (expectedCreationTime) {
        const actualCreation = getProcessCreationTime(pid);
        if (!actualCreation) return false;
        const drift = Math.abs(
          actualCreation.getTime() - expectedCreationTime.getTime(),
        );
        // 1s tolerance - Windows CreationDate has ~ms precision but small
        // skew can come from timezone parsing / .NET ticks-vs-Date round-trip.
        // Genuine PID reuse with another claude.exe is seconds-to-minutes
        // apart, never within 1s.
        if (drift > 1000) return false;
      }
      return true;
    } else {
      // Unix: process.kill(pid, 0) throws if dead. Then check /proc/<pid>/stat
      // comm field matches claude. Creation-time reuse defense not yet
      // implemented on Unix (TODO if/when an orphan-on-Unix case surfaces).
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rparen = stat.lastIndexOf(")");
      if (rparen < 0) return false;
      const name = stat.slice(stat.indexOf("(") + 1, rparen).toLowerCase();
      return name === "claude" || name === "claude.exe";
    }
  } catch {
    // Treat any unexpected error as "can't determine, assume dead" -
    // conservative because the cost of a false positive (orphan thinks
    // parent is dead and shuts down) is one terminal re-launch, while
    // the cost of a false negative (orphan thinks parent is alive forever)
    // is the very bug we're fixing.
    return false;
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
  killOlderDuplicateMcps(initialParentClaudePid);

  const creationTimeNote = initialParentClaudeCreationTime
    ? ` created=${initialParentClaudeCreationTime.toISOString()}`
    : " (creation-time unavailable - PID-reuse defense disabled)";
  process.stderr.write(
    `[orchestrator] orphan watchdog armed - parent claude.exe pid=${initialParentClaudePid}${creationTimeNote} (tick every 30s)\n`,
  );
  setInterval(() => {
    try {
      const alive = isPidAliveAsClaudeExe(
        initialParentClaudePid,
        initialParentClaudeCreationTime ?? undefined,
      );
      if (!alive) {
        process.stderr.write(
          `[orchestrator] parent claude.exe pid=${initialParentClaudePid} no longer running. ` +
            `Shutting down to avoid becoming an orphan that clobbers live sessions.\n`,
        );
        shutdownOnce("parent-claude-gone");
      } else {
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
  // No claude.exe ancestor at startup - we're already an orphan (probably
  // started from a test harness or stale process tree). Exit immediately
  // rather than running indefinitely.
  process.stderr.write(
    `[orchestrator] no claude.exe ancestor at startup; refusing to run as orphan. Exiting.\n`,
  );
  // Use setImmediate so the server has a chance to init enough to log,
  // then exit. shutdownOnce isn't defined yet at this point in module
  // evaluation if you read top-to-bottom, but we're inside an IIFE-like
  // block that runs after the function declarations, so it's safe.
  setImmediate(() => shutdownOnce("no-claude-ancestor-at-startup"));
}

// ── Start server ────────────────────────────────────────────────────────
async function main() {
  // Startup version banner. Goes to stderr (which Claude Code captures into
  // the plugin log). Makes "is the new version actually running?" trivially
  // answerable without inferring from rendering changes.
  process.stderr.write(
    `[orchestrator] MCP server starting - version=${PLUGIN_VERSION} ` +
      `pid=${process.pid} ` +
      `session_id=${resolveSessionId() ?? "<none>"} ` +
      `project_dir=${process.env.CLAUDE_PROJECT_DIR ?? "<none>"} ` +
      `role=${process.env.ORCHESTRATOR_AGENT_ROLE ?? process.env.SPAWNBOX_AGENT_ROLE ?? "<default:subordinate>"}\n`,
  );

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
