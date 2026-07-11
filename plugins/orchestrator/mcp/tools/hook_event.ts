import type { Database } from "bun:sqlite";
import type { SessionTracker } from "../engine/session_tracker";
import { getLiveSessions, getAgentChannelStateDir } from "../engine/live_sessions";
import { appendSystemEvent, type SystemEvent } from "../engine/agent_channel_state";
import { now } from "../utils";

// R6/R7 cross-session messaging (peekInbox/drainInbox) removed in 0.29.0.
// Cross-session communication is now via agent-channel notifications -
// recipients see <channel ...> tags inline, no hook drain required.

// R7.5: defense-in-depth sanitization on session_id values used as
// plugin_state key suffixes. The bash session-start regex-validates the
// session_id before writing the fallback file, but the dispatcher receives
// session_id directly from hook input - unvalidated. Real Claude Code IDs
// are UUID-shaped so this is belt-and-suspenders, but a malformed value
// like `me_%` could over-delete on `LIKE 'orch_active_<sid>_%'` cleanup.
function sanitizeSessionId(sid: string): string {
  return sid.replace(/[^a-zA-Z0-9_-]/g, "");
}

// Hook event names mirror Claude Code's hook event surface. Each branch is
// responsible for the entire response shape (additionalContext,
// permissionDecision, decision:"block", systemMessage) for that event.
// Returning {} is the fast path - empty JSON to stdout = zero token cost.
// SINGLE SOURCE OF TRUTH for hook event names. Both the `HookEvent` type
// (compile-time) AND the `_hook_event` MCP tool's Zod `event` enum
// (runtime validation in server.ts) derive from THIS array - they MUST
// stay in lockstep. They drifted in 0.30.41 and earlier: the Zod enum was
// hand-maintained separately and never got "SessionStart" when 167ffbaf
// added it to the type/dispatcher/hooks.json. Result: Claude Code's
// SessionStart `matcher:"compact"` hook hit `-32602 Invalid arguments for
// tool _hook_event` at the MCP boundary, the dispatcher never ran, and
// post-compact re-orientation silently never surfaced (167ffbaf-xs).
// Deriving the type AND the runtime validator from one const makes that
// class of drift structurally impossible. Order mirrors the dispatcher
// switch for readability; order is not semantically significant.
export const HOOK_EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  // 167ffbaf: post-compaction SessionStart. Routed via hooks.json
  // `matcher:"compact"` ONLY (the universal SessionStart stays the bash
  // hook), so the dispatcher's "SessionStart" case is unambiguously the
  // post-compact one. NOT added to HSO_EVENTS - SessionStart is not an
  // HSO-valid hookEventName (see hook_envelope.test.ts ALLOWED_HSO_EVENT_
  // NAMES); it delivers via top-level systemMessage like PreCompact.
  "SessionStart",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "TaskCompleted",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookEventArgs {
  event: HookEvent;
  session_id: string;
  tool_name?: string;
  agent_id?: string;
  payload?: Record<string, unknown>;
}

export interface HookEventResponse {
  additionalContext?: string;
  permissionDecision?: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  decision?: "block";
  reason?: string;
  systemMessage?: string;
}

// Events whose schema documents a `hookSpecificOutput` envelope shape.
// All other events use top-level fields only - emitting `hookSpecificOutput`
// for them triggers schema validation failure ("Hook JSON output validation
// failed - (root): Invalid input"). Source: Claude Code hook output schema.
export const HSO_EVENTS: ReadonlySet<HookEvent | "PostToolBatch"> = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  // PostToolBatch is in the schema but we don't currently route it.
] as const);

/**
 * Build the JSON envelope Claude Code's hook engine expects, given a
 * dispatcher result. Centralizes the HSO/non-HSO split so the tool wrapper
 * and tests share one implementation. Returns a plain object ready to be
 * JSON.stringify'd.
 */
export function buildHookEnvelope(
  event: HookEvent,
  result: HookEventResponse
): Record<string, unknown> {
  const envelope: Record<string, unknown> = {};

  if (HSO_EVENTS.has(event)) {
    // Only emit hookSpecificOutput when there's actual content to deliver.
    // An HSO with just `hookEventName` and nothing else is wasteful, and
    // for UserPromptSubmit the schema REQUIRES additionalContext - emitting
    // an empty HSO there triggers schema validation failure. Per the schema,
    // permissionDecision in HSO is PreToolUse-only.
    const permitHsoPermission = event === "PreToolUse";
    const hasHsoContent =
      Boolean(result.additionalContext) ||
      (permitHsoPermission && Boolean(result.permissionDecision));
    if (hasHsoContent) {
      const hso: Record<string, unknown> = { hookEventName: event };
      if (result.additionalContext) hso.additionalContext = result.additionalContext;
      if (permitHsoPermission && result.permissionDecision) {
        hso.permissionDecision = result.permissionDecision;
        if (result.permissionDecisionReason)
          hso.permissionDecisionReason = result.permissionDecisionReason;
      }
      envelope.hookSpecificOutput = hso;
    }
  } else if (result.additionalContext && !result.systemMessage) {
    // Non-HSO events (Stop, SubagentStop, PreCompact, StopFailure,
    // PostToolUseFailure, TaskCompleted) can't carry additionalContext.
    // Fold it into top-level systemMessage so the message reaches the model.
    envelope.systemMessage = result.additionalContext;
  }

  if (result.decision === "block") {
    envelope.decision = "block";
    if (result.reason) envelope.reason = result.reason;
  }
  if (result.systemMessage) envelope.systemMessage = result.systemMessage;

  return envelope;
}

// Per-turn nudges, rotated. Framing principle (decision 3b962e67):
// the orchestrator is ADDITIVE to your normal practice, never a substitute.
// Nudges should help you layer historical/cross-session context onto the
// careful code reading, doc-checking, and web research you'd do anyway -
// not encourage shortcuts based on what the KB happens to know. If a
// phrasing implies "lookup = enough context" or "skip the source read,"
// rewrite it before adding.
const VARIANTS = [
  "[orch] REFLECT on last turn: did you note decisions, capture patterns, update work items, or close threads? THEN for this turn: lookup adds historical context to layer onto your own code reading - it doesn't replace it.",
  "[orch] What prior decisions or anti-patterns apply here? lookup surfaces team-level context you'd otherwise miss; pair it with reading the actual code you're about to touch. Capture new knowledge the moment it appears.",
  "[orch] Discipline check: knowledge captured this session so far? When you're about to touch unfamiliar code, check_similar gives you adjacent prior thinking - additive to (not a substitute for) reading the current source.",
  "[orch] Mid-session nudge: user preferences, anti-patterns, and decisions are easiest to lose. If any surfaced last turn, note() them NOW before context shifts.",
  "[orch] Lookups as you go alongside your normal investigation. The KB tells you what was learned/decided in the past; the current code is still ground truth. Capture new findings the moment they appear - 'I will capture it later' is the top cause of knowledge loss.",
  "[orch] Toolkit scan: briefing, lookup, note, check_similar, plan, save_progress, close_thread, update_note, supersede_note, update_session_task. These ADD context-engineering primitives on top of your normal workflow - they don't replace the careful reading/web-checking you'd do anyway. code_refs: [paths] on note/update_note when the knowledge is about specific files.",
  "[orch] Struggle detector: if you are editing code you just edited, or hitting the same error twice, STOP and lookup for prior anti-patterns/gotchas - then re-read the actual source with that context in hand. If a PA is active, address `PA, ...` in your terminal output - PA's tailing will surface the address. Do not hammer.",
  "[orch] Past-self continuity: what you learn this turn only helps future sessions if you note() it. Context windows are temporary, the knowledge base is permanent.",
  "[orch] Work-item hygiene: did a tracked item just change status? update_work_item. New work identified? create_work_item. Do not rely on memory across turns.",
  "[orch] Completeness check: if this turn is a list, inventory, or audit, list_work_items gives a complete filtered view (FTS5 keyword search may miss vocabulary variants).",
  "[orch] Capturing knowledge about specific code? Add code_refs: [paths] so future agents find this note via lookup({code_ref: 'path'}) when they touch the same file.",
  "[orch] Editing a non-trivial file? While reading it, also try lookup({code_ref: 'path/to/file'}) to pull notes breadcrumb-tagged with that exact path - past decisions/gotchas/conventions about this specific code, additive to what you'll learn from reading it now.",
  "[orch] Cross-session check: see sibling sessions in your hook context? Set update_session_task at the start of major work so they see your scope in their agent-channel notifications. To address a sibling, type `@SA-<id8>` in your terminal output.",
  "[orch] Agent-channel: cross-session events arrive as <channel source=\"plugin:orchestrator:core\" ...>content</channel> tags inline at every turn. Empty agent-channel = zero token cost. If you see one, act on it before continuing your own work - someone left it for a reason.",
  "[orch] Loop-closure check: any in-flight work_items in your scope? If you completed one, mark done. If unsure whether the user considers it done, ASK in your reply - closing loops is part of the job, not 'bothering the user'.",
  "[orch] Update as you go, not at the end. When a work_item's scope shifts mid-task, update_work_item({id, content}) keeps siblings looking at current state. Stale work_item descriptions actively mislead other agents.",
  "[orch] Coordination etiquette: starting work that overlaps a sibling's current_task? Address `@SA-<id8>` in your terminal output FIRST to align - 'I'm about to touch X, anything I should know?' beats 'we both edited the same file in different directions and now have to merge'.",
  "[orch] Check siblings when it matters. You don't need to scan their state every turn - but at a task boundary, when starting something that might overlap, take 5s to check the sibling activity in your hook context.",
  "[orch] Orchestrator notes are starting hypotheses, not final answers. After a couple of lookups, you may feel you have the picture - in practice the KB knows what WAS, current code/docs/web are what IS. Use both.",
  "[orch] The orchestrator adds historical + cross-session context to your normal investigation. It never replaces reading the current source, checking docs, or fetching upstream behavior. If a lookup tempted you to skip a step you'd otherwise take, take the step.",
];

interface HookCtx {
  db: Database;
  tracker: SessionTracker;
}

export function handleHookEvent(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  switch (args.event) {
    case "UserPromptSubmit":
      return handleUserPromptSubmit(ctx, args);
    case "PreToolUse":
      return handlePreToolUse(ctx, args);
    case "PostToolUse":
      return handlePostToolUse(ctx, args);
    case "PostToolUseFailure":
      return handlePostToolUseFailure(ctx, args);
    case "PreCompact":
      return handlePreCompact(ctx, args);
    case "SessionStart":
      return handleSessionStartCompact(ctx, args);
    case "Stop":
      return handleStop(ctx, args);
    case "StopFailure":
      return handleStopFailure(ctx, args);
    case "SubagentStop":
      return handleSubagentStop(ctx, args);
    case "TaskCompleted":
      return handleTaskCompleted(ctx, args);
    default:
      return {};
  }
}

// ── Per-event handlers ──────────────────────────────────────────────────

function handleUserPromptSubmit(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  ctx.tracker.registerSession(args.session_id);
  const turn = ctx.tracker.nextTurn(args.session_id);

  // Reset per-turn struggle counter and orch-active flag on new user turn so
  // PostToolUseFailure escalation has a clean window each turn.
  resetTurnState(ctx.db, args.session_id);

  const reminder = VARIANTS[(turn - 1) % VARIANTS.length];
  const userPrompt = (args.payload?.user_prompt as string | undefined) ?? "";
  const siblingLine = renderSiblingActivity(ctx, args.session_id, userPrompt);
  const bridge = composeBridgeFromLog(ctx, args.session_id, turn);

  // R7 loop-closure + user-signal escalation.
  const loopClose = composeLoopCloseNudge(ctx, args.session_id, userPrompt);

  // WI 2ad3240e (Jarid override 2026-07-11): cadence-aware regular-checkpoint
  // nudge. Point-of-compaction capture cannot work (no model turn), so the
  // only real protection against context loss is checkpointing DURING normal
  // operation. This is deliberately NOT an every-turn nudge (that trains
  // agents to ignore it - the 5d1c20fc trigger-design defect); it fires only
  // when turns-since-save AND uncaptured-activity BOTH cross role-aware,
  // per-level-widening thresholds, with escalating wording. Resets on
  // save_progress.
  const checkpointNudge = composeCheckpointCadenceNudge(ctx, args.session_id, turn);

  const parts: string[] = [reminder];
  if (bridge) parts.push(`Last turn bridge: ${bridge}`);
  if (siblingLine) parts.push(siblingLine);
  if (loopClose) parts.push(loopClose);
  if (checkpointNudge) parts.push(checkpointNudge);

  return { additionalContext: parts.join("\n\n") };
}

function handlePreToolUse(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  // R7: when about to edit a file we have prior notes about, surface that
  // signal proactively. Independent of Option-B - fires whenever there's
  // useful pre-edit context, even on turn 1.
  const filePath = (args.payload?.file_path as string | undefined) ?? null;
  let codeRefsHint = "";
  if (filePath) {
    codeRefsHint = composeCodeRefsHint(ctx.db, args.session_id, filePath);
  }

  // Option-B escalation preserved from the legacy bash hook: nag turn 2-3
  // sessions that haven't called any orchestrator tool this turn, escalate
  // to permissionDecision:"ask" on turn 4+. Per-session, per-turn, fires
  // once per turn.
  const turn = ctx.tracker.getCurrentTurn(args.session_id);
  if (turn < 2) {
    if (codeRefsHint) {
      return { permissionDecision: "allow", additionalContext: codeRefsHint };
    }
    return {};
  }

  if (sessionHadOrchActivityThisTurn(ctx.db, args.session_id, turn)) {
    if (codeRefsHint) {
      return { permissionDecision: "allow", additionalContext: codeRefsHint };
    }
    return {};
  }
  if (warnedThisTurn(ctx.db, args.session_id, turn)) {
    if (codeRefsHint) {
      return { permissionDecision: "allow", additionalContext: codeRefsHint };
    }
    return {};
  }
  markWarnedThisTurn(ctx.db, args.session_id, turn);

  if (turn >= 4) {
    const reason = codeRefsHint
      ? `Orchestrator discipline check: turn ${turn}, no orchestrator tool called this turn. ${codeRefsHint} Approve to proceed (explicit choice to skip orch this turn) or deny and run lookup({code_ref:'<path>'}) first.`
      : `Orchestrator discipline check: turn ${turn}, no orchestrator tool called this turn. Approve to proceed (explicit choice to skip orch this turn) or deny and run lookup / briefing first to check for relevant decisions, conventions, or anti-patterns.`;
    return { permissionDecision: "ask", permissionDecisionReason: reason };
  }
  const ctx_msg = codeRefsHint
    ? `[orch] Turn ${turn}: about to modify code with no orchestrator tool called this turn. ${codeRefsHint}`
    : `[orch] Turn ${turn}: about to modify code with no orchestrator tool called this turn. A 2-second lookup can save 20 minutes of rework. From turn 4 this becomes an interactive approval prompt.`;
  return { permissionDecision: "allow", additionalContext: ctx_msg };
}

function handlePostToolUse(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  // Mark orch activity for the turn so PreToolUse Option B doesn't nag.
  if (args.tool_name && args.tool_name.startsWith("mcp__plugin_orchestrator_core__")) {
    markOrchActivityThisTurn(ctx.db, args.session_id, ctx.tracker.getCurrentTurn(args.session_id));
    appendBridgeAction(ctx.db, args.session_id, ctx.tracker.getCurrentTurn(args.session_id), args.tool_name);

    // R7.6: log work_item touches so loop-close can scope to "I actually
    // updated this work_item this session," not just "I happened to see it
    // in a briefing." Cleanly tightens the false-positive amplifier.
    if (args.tool_name === "mcp__plugin_orchestrator_core__update_work_item") {
      const id = args.payload?.tool_input_id as string | undefined;
      if (id) markWorkItemTouched(ctx.db, args.session_id, id);
    }
  }
  // WI 2ad3240e checkpoint-cadence tracking (Jarid override 2026-07-11). A
  // save_progress RESETS the cadence state (the loop just closed); any other
  // substantive action (edits / knowledge captures) BUMPS the uncaptured-work
  // counter that, together with turns-since-save, gates the escalating
  // regular-checkpointing nudge in handleUserPromptSubmit.
  if (args.tool_name === "mcp__plugin_orchestrator_core__save_progress") {
    recordCheckpointSaved(
      ctx.db,
      args.session_id,
      ctx.tracker.getCurrentTurn(args.session_id)
    );
  } else if (isSubstantiveActivity(args.tool_name)) {
    bumpActivitySinceSave(ctx.db, args.session_id);
  }
  // Reset struggle counter on any successful tool call.
  resetStruggleCounter(ctx.db, args.session_id);

  // R7 work-item drift nudge: when the agent just edited a file tied to an
  // in-flight work_item via code_refs, surface the work_item so the agent
  // can update its content/status if scope shifted. Once per session+work_item.
  const driftNudge = composeWorkItemDriftNudge(ctx.db, args.session_id, args);

  const parts: string[] = [];
  if (driftNudge) parts.push(driftNudge);

  if (parts.length === 0) return {};
  return { additionalContext: parts.join("\n\n") };
}

function composeWorkItemDriftNudge(
  db: Database,
  sessionId: string,
  args: HookEventArgs
): string {
  // Only fires on file-edit tools where we know what file was touched.
  const writeTool =
    args.tool_name === "Edit" ||
    args.tool_name === "Write" ||
    args.tool_name === "MultiEdit" ||
    args.tool_name === "NotebookEdit";
  if (!writeTool) return "";
  const filePath = args.payload?.file_path as string | undefined;
  if (!filePath) return "";

  const needle = JSON.stringify(filePath);
  const rows = db
    .query(
      `SELECT id, content FROM notes
       WHERE type = 'work_item'
         AND COALESCE(status, '') NOT IN ('done', 'cancelled', 'completed')
         AND code_refs IS NOT NULL
         AND code_refs LIKE ?
       ORDER BY COALESCE(signal, 0) DESC, updated_at DESC
       LIMIT 3`
    )
    .all(`%${needle}%`) as Array<{ id: string; content: string }>;
  if (rows.length === 0) return "";

  // Skip if we already nudged for any of these work_items this session.
  const fresh = rows.filter((r) => {
    const key = `wi_drift_${sessionId}_${r.id}`;
    const seen = db.query(`SELECT 1 FROM plugin_state WHERE key = ?`).get(key);
    if (seen) return false;
    db.run(
      `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, '1', ?)`,
      [key, now()]
    );
    return true;
  });
  if (fresh.length === 0) return "";

  const list = fresh
    .map((r) => `  - **${r.id.slice(0, 8)}**: ${r.content.slice(0, 80)}`)
    .join("\n");
  return `[orch] You just edited a file tied to in-flight work_item${fresh.length === 1 ? "" : "s"} (via code_refs):\n${list}\n  -> If your edit advances or completes the work_item, update_work_item NOW. If scope has shifted, update its content too. Don't let work_item descriptions drift out of sync with what you're actually doing - other agents look at them.`;
}

function handlePostToolUseFailure(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  const next = bumpStruggleCounter(ctx.db, args.session_id);
  if (next < 2) return {};
  if (next >= 3) {
    return {
      additionalContext: `[orch] STOP. ${next} consecutive tool failures. You are stuck. Run lookup NOW with keywords from the error + context. If a PA is active, address \`PA, ...\` in your terminal output for orchestration help. Do not retry until you have consulted the knowledge base.`,
    };
  }
  return {
    additionalContext: `[orch] Two tool calls failed in a row. Before trying a third approach, lookup against the failure - the knowledge base may have a documented gotcha for this exact situation. If a PA is active, addressing \`PA, ...\` in your terminal output also surfaces the situation to the orchestrator.`,
  };
}

// R7.7: when /compact runs, the engine fires PreCompact AND Stop on the
// same boundary - both with overlapping "capture knowledge / curate notes"
// prompts. The Stop block also derails the compact flow itself. PreCompact
// stamps this marker so handleStop can detect a compaction-driven stop and
// skip its block. 60s window is generous; real Stop-after-PreCompact is sub-second.
const COMPACT_STOP_SUPPRESS_WINDOW_MS = 60_000;

// WI 2ad3240e synthetic-snapshot caps. The banked snapshot lands in the
// checkpoint slot, which composePostCompactReorientation independently caps at
// SESSIONSTART_CHECKPOINT_CAP (4000) - keep the snapshot under that so it is
// surfaced whole rather than double-truncated.
const PRECOMPACT_SNAPSHOT_ROW_CAP = 6;
const PRECOMPACT_SNAPSHOT_SNIPPET_CAP = 100;
const PRECOMPACT_SNAPSHOT_TOTAL_CAP = 3500;

/**
 * PURE composer for the deterministic pre-compact snapshot (WI 2ad3240e).
 * Turns the session's durable pointers (last-broadcast task, recent notes,
 * in-flight work_items) into a bounded checkpoint-shaped text banked at
 * PreCompact. Pure + exported so the payload is unit-tested without the DB
 * reads; the impure gather in handlePreCompact stays thin. Never emits the
 * literal "null"/"undefined" (the post-compact composer's no-checkpoint test
 * guards against those leaking through).
 */
export function composePrecompactSnapshot(opts: {
  currentTask: string | null;
  recentNotes: Array<{ id: string; type: string; snippet: string }>;
  workItems: Array<{ id: string; status: string; content: string }>;
  ts: string;
}): string {
  const { currentTask, recentNotes, workItems, ts } = opts;
  const sections: string[] = [
    `[Auto-captured durable snapshot, banked deterministically at compaction (${ts}). The pre-compact model turn cannot run tools, so the orchestrator wrote this for you; it captures POINTERS, not full narrative. A fresher real save_progress checkpoint supersedes it.]`,
    `Last-broadcast task: ${
      currentTask && currentTask.trim() ? currentTask : "(none set)"
    }`,
  ];
  if (workItems.length > 0) {
    const wl = workItems
      .slice(0, PRECOMPACT_SNAPSHOT_ROW_CAP)
      .map(
        (w) =>
          `  - ${w.id.slice(0, 8)} [${w.status}] ${w.content.slice(0, PRECOMPACT_SNAPSHOT_SNIPPET_CAP)}`
      )
      .join("\n");
    sections.push(`In-flight work_items in your scope:\n${wl}`);
  }
  if (recentNotes.length > 0) {
    const nl = recentNotes
      .slice(0, PRECOMPACT_SNAPSHOT_ROW_CAP)
      .map(
        (n) =>
          `  - ${n.id.slice(0, 8)} [${n.type}] ${n.snippet.slice(0, PRECOMPACT_SNAPSHOT_SNIPPET_CAP)}`
      )
      .join("\n");
    sections.push(`Recent notes you captured this session:\n${nl}`);
  }
  if (workItems.length === 0 && recentNotes.length === 0) {
    sections.push(
      'No notes or work_items captured this session yet - reconstruct from the task above and briefing({event:"compact"}).'
    );
  }
  let text = sections.join("\n\n");
  if (text.length > PRECOMPACT_SNAPSHOT_TOTAL_CAP) {
    text = text.slice(0, PRECOMPACT_SNAPSHOT_TOTAL_CAP) + "\n...[snapshot truncated]";
  }
  return text;
}

/** Read the WI 2ad3240e synthetic pre-compact snapshot for a session, or null
 *  if none was banked / the row is corrupt. Stored as JSON {text, ts} in
 *  plugin_state under `precompact_cp_<sid>`; ts is the ISO time it was banked,
 *  used to compare freshness against a real checkpoint note's created_at. */
function readPrecompactSnapshot(
  db: Database,
  sid: string
): { text: string; ts: string } | null {
  const row = db
    .query(`SELECT value FROM plugin_state WHERE key = ?`)
    .get(`precompact_cp_${sid}`) as { value: string } | null;
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (
      parsed &&
      typeof parsed.text === "string" &&
      typeof parsed.ts === "string"
    ) {
      return { text: parsed.text, ts: parsed.ts };
    }
  } catch {
    /* corrupt row - treat as absent */
  }
  return null;
}

/** Recent non-checkpoint notes this session authored, newest first, for the
 *  synthetic snapshot. Snippet is single-lined + length-bounded in SQL. */
function listRecentSessionNotes(
  db: Database,
  sessionId: string,
  limit: number
): Array<{ id: string; type: string; snippet: string }> {
  return db
    .query(
      `SELECT id, type, substr(replace(replace(content, char(10), ' '), char(13), ' '), 1, 100) as snippet
       FROM notes
       WHERE source_session = ? AND type != 'checkpoint'
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(sessionId, limit) as Array<{
    id: string;
    type: string;
    snippet: string;
  }>;
}

function handlePreCompact(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  const sid = sanitizeSessionId(args.session_id);
  if (sid) {
    // Store numeric epoch ms (not the ISO string from now()) so the
    // suppression-window check in handleStop can compare directly. KEPT
    // EXACTLY AS-IS - the Stop-suppression window depends on it.
    ctx.db.run(
      `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)`,
      [`compacting_${sid}`, String(Date.now()), now()]
    );

    // WI 2ad3240e requirement 4: DETERMINISTIC pre-compact capture. Claude
    // Code's PreCompact hook is a synchronous decision point with NO model
    // turn between it and compaction (verified vs code.claude.com/docs/en/
    // hooks 2026-07-11), so the long-standing "call save_progress NOW"
    // systemMessage was structurally non-actionable - the same trigger-design
    // defect class the post-compact side already fixed by going deterministic
    // (5d1c20fc). Bank a synthetic mini-checkpoint server-side so the digest
    // ALWAYS has fresh durable state even when the agent never checkpointed.
    // Best-effort + fully guarded: a failure here must never block compaction.
    try {
      const ts = now();
      let currentTask: string | null = null;
      try {
        const taskRow = ctx.db
          .query(`SELECT current_task FROM session_registry WHERE session_id = ?`)
          .get(sid) as { current_task: string | null } | null;
        currentTask = taskRow?.current_task ?? null;
      } catch {
        /* registry missing - non-fatal */
      }
      const workItems = listInFlightWorkItemsForSession(ctx.db, sid);
      const recentNotes = listRecentSessionNotes(
        ctx.db,
        sid,
        PRECOMPACT_SNAPSHOT_ROW_CAP
      );
      const text = composePrecompactSnapshot({
        currentTask,
        recentNotes,
        workItems,
        ts,
      });
      ctx.db.run(
        `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)`,
        [`precompact_cp_${sid}`, JSON.stringify({ text, ts }), ts]
      );
    } catch {
      /* best-effort deterministic capture - never block compaction */
    }
  }
  // WI 2ad3240e (Jarid override 2026-07-11): NO systemMessage. The former
  // "capture your knowledge NOW via save_progress" prompt is deleted, not
  // softened. Two reasons, both decisive:
  //  (1) Non-actionable: PreCompact is a synchronous decision point with no
  //      model turn before compaction (code.claude.com/docs/en/hooks,
  //      2026-07-11) - the agent can never act on it pre-compaction. Shipping
  //      code that looks functional but structurally cannot fire is exactly
  //      what future agents must not inherit (5d1c20fc trigger-design defect).
  //  (2) ACTIVELY HARMFUL: because there is no pre-compaction turn, any
  //      systemMessage this hook returns can only reach the model on the NEXT
  //      turn - which is AFTER compaction. An instruction to "save_progress
  //      now" delivered post-compaction induces the agent to checkpoint the
  //      already-degraded, incomplete post-compaction context, poisoning the
  //      durable state with a lossy rollup. Removing it eliminates that trap.
  // Deterministic capture is fully handled by the synthetic snapshot banked
  // above (now the first-class pre-compact capture mechanism) + the
  // cadence-aware regular-checkpointing nudge in handleUserPromptSubmit. The
  // compacting_<sid> Stop-suppression marker (written above) is UNCHANGED.
  return {};
}

// 167ffbaf + e4774e4b: post-compaction re-orientation. Fires ONLY via
// hooks.json SessionStart `matcher:"compact"` (universal SessionStart is the
// bash hook), so this branch is unambiguously the post-compact path.
// Delivers a BOUNDED durable-state digest as a top-level systemMessage
// (SessionStart is not an HSO-valid hookEventName - verified vs
// hook_envelope.test.ts ALLOWED_HSO_EVENT_NAMES; mirrors handlePreCompact's
// shape). When a live PrimeAgent exists, the handler ALSO emits the
// e4774e4b peer-backstop solicitation DETERMINISTICALLY onto the
// system_events bus (the exact mechanism the permission relay uses),
// addressed to PA, so a non-compacted peer/PA can flag what the lossy
// compaction summary dropped. This replaced the original agent-driven
// design (the hook used to merely instruct the just-compacted SA to post
// the line itself) - that soft instruction was shipped, exercised on a
// perfect live case, and did nothing: the just-compacted agent is
// precisely the agent least able to comply with an optional side-
// instruction (note 5d1c20fc, the trigger-design defect). The composer now
// only INFORMS the agent it happened automatically. Bounded-by-
// construction (05f072d3 cap discipline:
// briefing() proved an unbounded hook payload breaks the session entry).
//
// WI 2ad3240e made this ROLE-AWARE + SYMMETRIC using sessions.role from the
// agent-channel registry: when the compacted session is itself the PA, the
// digest becomes a FLEET CHECK-IN and the handler deterministically emits a
// pa_compact_recovery advisory to EVERY active SA (the reversed-direction
// counterpart of the SA->PA peer-backstop). When it's an SA, the existing
// PA-backstop is kept and augmented with a proactive PA check-in + a bounded
// lateral roster. Both directions carry the highest-loss-zone warning (the
// final minutes before compaction are where directives/completions are most
// likely lost or mis-stated).
const SESSIONSTART_CHECKPOINT_CAP = 4000;
const SESSIONSTART_TOTAL_CAP = 7000;

/**
 * A bounded roster entry for a fleet peer surfaced in the post-compact
 * digest (WI 2ad3240e). `id8` is the 8-char session prefix used for
 * @SA-<id8> addressing; `current_task` is the session's last-broadcast task
 * (may be null / stale - it's a pointer, not authority).
 */
export interface CompactPeer {
  id8: string;
  current_task: string | null;
}

// WI 2ad3240e roster caps. The whole systemMessage is still bounded by
// SESSIONSTART_TOTAL_CAP; these keep the roster itself from dominating the
// budget before the total slice runs (an unbounded hook payload once broke
// session entry - 05f072d3).
const COMPACT_ROSTER_MAX_PEERS = 8;
const COMPACT_ROSTER_TASK_CAP = 70;

/**
 * PURE render of a bounded fleet roster block. Returns "" for an empty
 * roster so callers can skip the surrounding label. Null tasks render as an
 * explicit "(no task set)" - never the literal "null"/"undefined" (the
 * post-compact composer's no-checkpoint test guards against those leaking).
 */
function renderCompactRoster(peers: CompactPeer[]): string {
  if (!peers || peers.length === 0) return "";
  const shown = peers.slice(0, COMPACT_ROSTER_MAX_PEERS);
  const lines = shown.map((p) => {
    const task =
      p.current_task && p.current_task.trim()
        ? `: ${p.current_task.slice(0, COMPACT_ROSTER_TASK_CAP)}`
        : ": (no task set)";
    return `  - SA-${p.id8}${task}`;
  });
  const more =
    peers.length > shown.length
      ? `\n  ...and ${peers.length - shown.length} more.`
      : "";
  return lines.join("\n") + more;
}

/**
 * PURE post-compact re-orientation composer (167ffbaf + e4774e4b + WI
 * 2ad3240e role-awareness). Separated from the DB/disk reads so the role /
 * livePA / roster branches are deterministically testable - `getLiveSessions()`
 * is a non-hermetic disk read (it reflects the real running fleet), so the
 * impure shell stays untested for the live branch exactly like the other
 * `getLiveSessions()` call site, and this pure core carries the test coverage.
 * Bounded-by-construction (05f072d3 cap discipline: briefing() proved an
 * unbounded hook payload breaks the entry).
 *
 * ROLE-AWARE + SYMMETRIC (WI 2ad3240e): the guidance is tuned to the
 * compacted session's own role (from sessions.role in the agent-channel
 * registry).
 *   - subordinate (SA): existing digest + PA-backstop inform, PLUS a
 *     proactive "check in with PA" instruction and a bounded roster of the
 *     other active SAs so the SA knows who holds what and keeps lateral comms.
 *   - prime (PA): the SA branches are replaced by a FLEET CHECK-IN directive
 *     (poll every active SA) + the roster of SAs to poll. The advisories to
 *     the SAs are emitted deterministically by the impure handler, not here.
 * `role`/`peers` are optional and default to the pre-2ad3240e subordinate
 * behavior so existing callers/tests are unaffected.
 */
export function composePostCompactReorientation(opts: {
  currentTask: string | null;
  checkpoint: string | null;
  livePA: boolean;
  role?: "prime" | "subordinate";
  peers?: CompactPeer[];
}): string {
  const { currentTask, checkpoint, livePA } = opts;
  const role = opts.role ?? "subordinate";
  const peers = opts.peers ?? [];
  const parts: string[] = [
    "Context was just compacted. Re-orient from this durable state, then verify it against live reality (read the actual code/notes) before acting - the compaction summary is lossy.",
  ];
  // WI 2da3e119: re-establish HOW TO OPERATE, not only WHAT (task/checkpoint).
  // Compaction summaries are task-narrative-heavy and lossily drop the
  // behavioral operating reflexes; the terse re-injected "invoke
  // getting-started/every-turn" directive is an optional-feeling side-
  // instruction the just-compacted agent demonstrably SKIPS (e4774e4b /
  // 5d1c20fc class). So the contract is folded into THIS deterministic
  // emitted systemMessage (the agent cannot skip it). Placed as parts[1]
  // (right after the header, before task/checkpoint/peer-backstop): the
  // final SESSIONSTART_TOTAL_CAP slice truncates the END, so this fixed,
  // load-bearing block always survives while the elastic, lookup-
  // recoverable checkpoint is what yields (05f072d3 bounded-payload
  // discipline preserved; detection-must-be-external + asymmetry rationale
  // in notes e7779cae / 037fac50). Kept tight - load-bearing reflexes only,
  // never a verbose dump.
  parts.push(
    "Operating contract - the compaction summary preserves task narrative but DROPS these behavioral reflexes; they are NOT optional and you have most likely been running degraded. Re-establish now: " +
      "(1) The orchestrator every-turn loop (capture/lookup scan) is mandatory EVERY turn - the keystone reflex compaction most degrades; run it this turn and every turn hereafter, do not assume it survived the summary. " +
      "(2) Capture knowledge the moment it appears via note()/update_note - never defer ('capture later' is the top cause of loss), and never substitute file/.md memory for orchestrator note(). " +
      "(3) Verify before asserting: this summary + the KB = what WAS; current source/code/docs = what IS - no 'maybe/probably', check. " +
      "(4) Cross-agent messages stay trap-safe / explicit-envelope; honor no-false-close (shipped != live-confirmed). " +
      "(5) You operate under a role contract (prime or subordinate) - reload it via orchestrator:getting-started (PA also: /pa-bootstrap + prime-agent.md); do not infer your role/contract from the lossy summary."
  );
  // WI 2ad3240e requirement 3: the last minutes before a compaction are the
  // highest-loss zone in BOTH directions. Warn the compacted agent that its
  // summary may be missing directives it received right before compacting
  // (stale queue) AND may list already-DONE items as still-pending. Placed
  // before the role action block + task/checkpoint so it survives the final
  // budget slice (load-bearing, role-independent).
  parts.push(
    "Highest-loss zone: the final minutes before this compaction are where the most context was lost. Directives you received right before compacting may be ABSENT from your summary (they were still in the queue when it was written), and items your summary lists as still-pending may in fact already be DONE. Before you re-issue, re-request, or re-do anything, reconcile against live reality (and the fleet below, if you have peers) - do not act off the stale queue."
  );
  // WI 2ad3240e role-aware action block. Kept above task/checkpoint so the
  // load-bearing directive survives truncation while the elastic checkpoint
  // yields. The advisory EMISSION to peers is deterministic in the impure
  // handler (handleSessionStartCompact) - here we only tell the compacted
  // agent what will happen and what it should do.
  if (role === "prime") {
    parts.push(
      "You are the PrimeAgent and your context was just compacted. Beyond re-orienting yourself, run a FLEET CHECK-IN now: poll every active subordinate (SA) and have each reply with (a) its current task/state, (b) recent completions with their IDs, and (c) anything it would bet you just lost from the summary - especially work already DONE or directives you already sent it, so you do not re-drive them. Advisories were ALSO emitted to each active SA automatically on your behalf (system bus), so they already know you compacted and will surface dropped context; aggregate their replies as they arrive. RAID principle: your warm, recently-uncompacted SAs are striped redundancy for the context your summary lost - reconstruct coherence by aggregating from them, do not treat your lossy summary as authority over their intact memory. Non-blocking - continue meanwhile."
    );
    const roster = renderCompactRoster(peers);
    if (roster) parts.push(`Active subordinates to poll:\n${roster}`);
  } else {
    // Subordinate. When a distinct live PA exists: 5d1c20fc trigger-design
    // fix - the hook already emitted the peer-backstop solicitation to PA
    // itself (deterministic, system_events bus), so do NOT ask the agent to
    // post the solicitation (that voluntary post was the exact failure mode).
    // INFORM it of the passive backstop AND (WI 2ad3240e req 2a) instruct it to
    // proactively check in with PA, which sees the whole fleet.
    if (livePA) {
      parts.push(
        "A peer-backstop request was just emitted to PA on your behalf automatically - you do NOT need to post anything for it. Beyond that passive backstop, proactively CHECK IN with PA now: tell it you just compacted and ask it to aggregate for you - what you were working on, what PA is currently driving, and any in-flight material from other subordinates that bears on your task. RAID principle: a warm PA (and any uncompacted peer) is striped redundancy for what your summary dropped - the fastest rebuild is aggregating coherence from them rather than trusting your lossy summary. A reply may also flag load-bearing context the summary lost; fold it in as it arrives. Non-blocking: continue meanwhile. This is a targeted gap-check, not a full context re-request."
      );
    }
    // WI 2ad3240e req 2b: the lateral roster is useful whenever there are peer
    // SAs, PA or not - it's what keeps lateral coordination alive across the
    // compaction. Gated on peers, not livePA.
    const roster = renderCompactRoster(peers);
    if (roster)
      parts.push(
        `Other active subordinates (who holds what - coordinate laterally via @SA-<id8>, and flag anything already done/received so no one re-does it):\n${roster}`
      );
  }
  // The currentTask comes verbatim from session_registry.current_task, which
  // persists indefinitely until the session next calls update_session_task -
  // so right after a compaction it can be STALE (an old broadcast from before
  // the work pivoted). Presenting it as a bald "Your task: X" assertion at the
  // single most context-fragile moment actively misleads. Hedge it to match
  // this message's own "verify against live reality - the summary is lossy"
  // spirit (observed 2026-05-18 during the 167ffbaf-xs live-confirm: a months-
  // old probe task surfaced authoritatively post-compact). Mechanism is
  // correct; the input is just not guaranteed fresh - say so.
  if (currentTask)
    parts.push(
      `Your last-broadcast task (from session_registry - may be STALE if work moved on since it was set; reconcile against the checkpoint below + live reality before trusting it): ${currentTask}`
    );
  if (checkpoint) {
    const capped =
      checkpoint.length > SESSIONSTART_CHECKPOINT_CAP
        ? checkpoint.slice(0, SESSIONSTART_CHECKPOINT_CAP) +
          '\n...[checkpoint truncated for the post-compact budget - lookup the latest checkpoint note for the full content]'
        : checkpoint;
    parts.push(`Last checkpoint:\n${capped}`);
  } else {
    parts.push(
      'No durable checkpoint found - reconstruct from your task above and a briefing({event:"compact"}) before proceeding.'
    );
  }

  let systemMessage = parts.join("\n\n");
  if (systemMessage.length > SESSIONSTART_TOTAL_CAP) {
    systemMessage =
      systemMessage.slice(0, SESSIONSTART_TOTAL_CAP) +
      '\n...[post-compact re-orientation truncated to fit the budget - lookup the latest checkpoint and call briefing({event:"compact"}) for the rest]';
  }
  return systemMessage;
}

/** system_events `event_type` for the e4774e4b peer-backstop solicitation.
 *  Single source of truth - shared by the producer (this file) and the
 *  consumer (agent_channel.ts processSystemEvents). */
export const POST_COMPACT_RECOVERY_EVENT = "post_compact_recovery" as const;

/**
 * PURE builder for the e4774e4b peer-backstop system_events row. Returns the
 * SystemEvent to append, or `null` when there is no distinct live PA to
 * address (no oracle/router listening = nothing to solicit; a PA that
 * compacted is out of scope - PA is the backstop SOURCE in e4774e4b's
 * design, not a recipient). Kept pure + exported so the payload contract is
 * unit-tested deterministically; the impure getLiveSessions() /
 * appendSystemEvent() glue in handleSessionStartCompact stays
 * untested-for-live exactly like the other getLiveSessions() call site (same
 * convention as composePostCompactReorientation - note 5d1c20fc).
 */
export function buildPeerBackstopEvent(opts: {
  fromSession: string;
  paSession: string | null;
  currentTask: string | null;
  ts: string;
}): SystemEvent | null {
  const { fromSession, paSession, currentTask, ts } = opts;
  if (!fromSession || !paSession || paSession === fromSession) return null;
  return {
    event_type: POST_COMPACT_RECOVERY_EVENT,
    from_session: fromSession,
    to_session: paSession,
    ts,
    task: currentTask ?? "",
  };
}

/** system_events `event_type` for the WI 2ad3240e PA-compacted advisory - the
 *  symmetric, reversed-direction counterpart of POST_COMPACT_RECOVERY_EVENT.
 *  Single source of truth - shared by the producer (this file) and the
 *  consumer (agent_channel.ts processSystemEvents). */
export const PA_COMPACT_RECOVERY_EVENT = "pa_compact_recovery" as const;

/**
 * PURE builder for the WI 2ad3240e PA-compacted advisory system_events row,
 * one per active SA. Returns the SystemEvent to append, or `null` when there
 * is no distinct SA to address (fromSession === toSession, or either empty).
 * Mirror of buildPeerBackstopEvent but reversed: PA (fromSession) advises each
 * active SA (toSession) that PA just compacted and its summary is lossy. Kept
 * pure + exported so the payload contract is unit-tested deterministically;
 * the impure getLiveSessions() / appendSystemEvent() glue in
 * handleSessionStartCompact stays untested-for-live exactly like the other
 * getLiveSessions() call site.
 */
export function buildPaCompactAdvisoryEvent(opts: {
  fromSession: string;
  toSession: string;
  currentTask: string | null;
  ts: string;
}): SystemEvent | null {
  const { fromSession, toSession, currentTask, ts } = opts;
  if (!fromSession || !toSession || fromSession === toSession) return null;
  return {
    event_type: PA_COMPACT_RECOVERY_EVENT,
    from_session: fromSession,
    to_session: toSession,
    ts,
    task: currentTask ?? "",
  };
}

function handleSessionStartCompact(
  ctx: HookCtx,
  args: HookEventArgs
): HookEventResponse {
  const sid = sanitizeSessionId(args.session_id);

  let currentTask: string | null = null;
  try {
    const taskRow = ctx.db
      .query(`SELECT current_task FROM session_registry WHERE session_id = ?`)
      .get(sid) as { current_task: string | null } | null;
    currentTask = taskRow?.current_task ?? null;
  } catch {
    /* registry missing - non-fatal */
  }

  // WI 2ad3240e requirement 4 (Jarid override 2026-07-11): the synthetic
  // snapshot banked at PreCompact is now the FIRST-CLASS pre-compact capture
  // mechanism, not a fallback. It represents THIS session's own state captured
  // at the compaction boundary (seconds before this handler runs), so when it
  // exists and is fresh, prefer it outright - do NOT weigh it against the
  // global-latest checkpoint note, which may belong to a DIFFERENT session and
  // would otherwise shadow this session's own state (the original cross-session
  // staleness bug). A real checkpoint note is used ONLY when there is no fresh
  // synthetic (PreCompact didn't fire, banking failed, or a lingering snapshot
  // from a prior compaction is too old to trust). Freshness bound guards that
  // lingering-snapshot edge; snapshot ts is ISO-8601 UTC (now()).
  const SYNTHETIC_FRESH_MS = 30 * 60_000;
  const synthetic = readPrecompactSnapshot(ctx.db, sid);
  const syntheticMs = synthetic ? Date.parse(synthetic.ts) : NaN;
  const syntheticFresh =
    !!synthetic &&
    Number.isFinite(syntheticMs) &&
    Date.now() - syntheticMs <= SYNTHETIC_FRESH_MS;

  let checkpoint: string | null;
  if (syntheticFresh) {
    checkpoint = synthetic!.text;
  } else {
    // Fallback (no fresh synthetic). Prefer THIS session's OWN latest checkpoint
    // (notes.source_session == sid), so another session's newer global-latest
    // checkpoint cannot shadow this session's boundary state - the same
    // cross-session shadow the synthetic-first-class design fixes, which must not
    // reappear in the degraded path (WI 2ad3240e P2 review). source_session holds
    // the full session_id and sid is the identity-preserving sanitize of it, so
    // they match. Only when this session has NO checkpoint of its own do we
    // surface the global-latest as a last resort; the composer hedges that value.
    let realCp: { content: string } | null = null;
    try {
      realCp =
        (ctx.db
          .query(
            `SELECT content FROM notes WHERE type = 'checkpoint' AND source_session = ? ORDER BY created_at DESC LIMIT 1`
          )
          .get(sid) as { content: string } | null) ??
        (ctx.db
          .query(
            `SELECT content FROM notes WHERE type = 'checkpoint' ORDER BY created_at DESC LIMIT 1`
          )
          .get() as { content: string } | null);
    } catch {
      /* notes missing - non-fatal */
    }
    checkpoint = realCp?.content ?? null;
  }

  // Role detection + fleet snapshot from the agent-channel registry
  // (sessions.role). Non-channel / single-session projects: getLiveSessions()
  // returns null -> role defaults to subordinate, livePA false, empty peers -
  // exactly the pre-2ad3240e behavior, so nothing regresses there.
  let selfRole: "prime" | "subordinate" = "subordinate";
  let livePA = false;
  let paSession: string | null = null;
  let peers: CompactPeer[] = [];
  let activeSAs: Array<{ session_id: string; id8: string }> = [];
  try {
    const live = getLiveSessions();
    if (live) {
      const self = live.find((e) => e.session_id === sid) ?? null;
      if (self?.role === "prime") selfRole = "prime";
      const pa = live.find((e) => e.role === "prime") ?? null;
      const distinctPA = pa && pa.session_id !== sid ? pa : null;
      livePA = !!distinctPA;
      paSession = distinctPA?.session_id ?? null;
      const otherSubs = live.filter(
        (e) => e.role === "subordinate" && e.session_id !== sid
      );
      peers = otherSubs.map((e) => ({
        id8: e.id8,
        current_task: e.current_task ?? null,
      }));
      activeSAs = otherSubs.map((e) => ({
        session_id: e.session_id,
        id8: e.id8,
      }));
    }
  } catch {
    livePA = false;
    paSession = null;
  }

  // WI 2ad3240e: DETERMINISTIC, role-aware, symmetric emission on the
  // system_events bus (the same mechanism the permission relay + e4774e4b
  // peer-backstop use). The prior design relied on the just-compacted agent
  // voluntarily posting a channel line - shipped, exercised on a perfect live
  // case, did nothing (5d1c20fc). A non-compacted peer's filewatcher surfaces
  // these within ~1.5s with zero dependence on the compacted agent. Strictly
  // non-fatal: the re-orientation systemMessage MUST return whether or not the
  // bus write succeeds (bus may be absent on non-channel projects).
  try {
    const stateDir = getAgentChannelStateDir();
    if (stateDir) {
      const ts = now();
      if (selfRole === "prime") {
        // PA compacted: advise EVERY active SA that PA's summary is lossy so
        // they surface dropped fleet context (and flag already-done/received
        // items) back to PA. One row per SA, same bus.
        for (const sa of activeSAs) {
          const ev = buildPaCompactAdvisoryEvent({
            fromSession: sid,
            toSession: sa.session_id,
            currentTask,
            ts,
          });
          if (ev) appendSystemEvent(stateDir, ev);
        }
      } else {
        // SA compacted: solicit the PA backstop (existing e4774e4b mechanism).
        const ev = buildPeerBackstopEvent({
          fromSession: sid,
          paSession,
          currentTask,
          ts,
        });
        if (ev) appendSystemEvent(stateDir, ev);
      }
    }
  } catch {
    /* agent-channel bus unavailable - non-fatal; systemMessage still re-orients */
  }

  return {
    systemMessage: composePostCompactReorientation({
      role: selfRole,
      currentTask,
      checkpoint,
      livePA,
      peers,
    }),
  };
}

function handleStop(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  // R7.7: suppress the housekeeping block when this Stop is compaction-driven.
  // PreCompact already requested the same capture work; double-prompting at
  // the compact boundary derails the flow and bloats the prompt right when
  // context is most fragile.
  const sid = sanitizeSessionId(args.session_id);
  if (sid) {
    const compactRow = ctx.db
      .query(`SELECT value FROM plugin_state WHERE key = ?`)
      .get(`compacting_${sid}`) as { value: string } | null;
    if (compactRow?.value) {
      const compactedAt = parseInt(compactRow.value, 10);
      if (
        Number.isFinite(compactedAt) &&
        Date.now() - compactedAt < COMPACT_STOP_SUPPRESS_WINDOW_MS
      ) {
        // Clear the marker so the NEXT real Stop (post-compact, after the
        // user has continued and finished) blocks normally.
        ctx.db.run(`DELETE FROM plugin_state WHERE key = ?`, [`compacting_${sid}`]);
        return {};
      }
    }
  }

  // Block once per session id, then pass through. Reuse plugin_state with a
  // marker key.
  const key = `stop_${args.session_id}`;
  const exists = ctx.db
    .query(`SELECT 1 FROM plugin_state WHERE key = ?`)
    .get(key);
  if (exists) return {};
  ctx.db.run(
    `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, '1', ?)`,
    [key, now()]
  );

  // R7.6: tightened to fit the design's 5-10k char soft ceiling. Drops the
  // duplicated fresh-notes section (was redundant with the R3.4 nudge).
  // Caps loop-close + nudge lists at 3 entries each. Single-paragraph intro.
  const fresh = countFreshSurfaced(ctx.db, args.session_id);
  const inFlight = listInFlightWorkItemsForSession(ctx.db, args.session_id);
  const freshNoteList = fresh >= 3 ? listFreshSurfacedNotes(ctx.db, args.session_id, 3) : [];

  const parts: string[] = [];
  parts.push(
    "Before ending: complete orchestrator housekeeping. Maintenance is equal-priority to capture."
  );

  let n = 1;

  if (inFlight.length > 0) {
    const list = inFlight
      .slice(0, 3)
      .map((w) => `  - **${w.id.slice(0, 8)}** [${w.status}] ${w.content.slice(0, 70)}`)
      .join("\n");
    const more = inFlight.length > 3 ? `\n  ...and ${inFlight.length - 3} more.` : "";
    parts.push(
      `**${n}. Loop-closure.** ${inFlight.length} in-flight work_item${inFlight.length === 1 ? "" : "s"}:\n${list}${more}\n  -> For each: did it complete? \`update_work_item({id, status:"done"})\`. If unsure, ASK.`
    );
    n++;
  }

  if (freshNoteList.length > 0) {
    const list = freshNoteList
      .map((r) => `  - **${r.id.slice(0, 8)}** [${r.type}] ${r.snippet}`)
      .join("\n");
    const more = fresh > freshNoteList.length ? `\n  ...and ${fresh - freshNoteList.length} more (\`lookup({session_id:"${args.session_id}"})\`).` : "";
    parts.push(
      `**${n}. Curate (update_note / close_thread / supersede_note).** ${fresh} fresh note${fresh === 1 ? "" : "s"} surfaced. For each you relied on, decide: still correct? thread settled? Top:\n${list}${more}`
    );
    n++;
  } else {
    parts.push(
      `**${n}. Curate (update_note / close_thread / supersede_note).** No fresh notes surfaced; skip unless you corrected a note verbally without writing it back.`
    );
    n++;
  }

  parts.push(
    `**${n}. Capture (note).** Decisions, conventions, anti-patterns, architecture, risks, insights, user preferences from this session. \`code_refs: [paths]\` when about specific code.`
  );
  n++;

  parts.push(
    `**${n}. Save progress.** \`save_progress\` with summary, open questions, next steps.`
  );

  return { decision: "block", reason: parts.join("\n\n") };
}

interface FreshSurfacedNote {
  id: string;
  type: string;
  snippet: string;
}

function listFreshSurfacedNotes(
  db: Database,
  sessionId: string,
  limit: number
): FreshSurfacedNote[] {
  return db
    .query(
      `SELECT n.id, n.type, substr(replace(replace(n.content, char(10), ' '), char(13), ' '), 1, 70) as snippet
       FROM session_log sl
       JOIN notes n ON sl.note_id = n.id
       WHERE sl.session_id = ? AND sl.delivery_type = 'fresh'
       GROUP BY n.id
       ORDER BY n.updated_at ASC
       LIMIT ?`
    )
    .all(sessionId, limit) as FreshSurfacedNote[];
}

// ── WI 2ad3240e: regular-checkpoint cadence nudge ───────────────────────────
//
// Point-of-compaction capture is impossible (PreCompact has no model turn), so
// the durable defense against context loss is checkpointing DURING normal work.
// This nudge must NOT be an every-turn nag (that trains the agent to tune it
// out - the 5d1c20fc trigger-design defect). It fires only when BOTH gates are
// crossed - turns since the last save_progress AND substantive uncaptured
// actions since then - and each time it fires it raises its own bar (level), so
// successive nudges are spaced further apart and worded more urgently.
// save_progress resets everything. Thresholds are role-aware: a PA's context
// loss is the worst case (it holds the whole fleet's coherence), so PA is
// nudged sooner and escalates faster than an SA. Numbers are initial + tunable;
// the invariants (both-gates, per-level widening, reset-on-save, PA-tighter)
// are the load-bearing design, not the exact constants.
interface CadenceThresholds {
  turnBase: number;
  turnStep: number;
  actBase: number;
  actStep: number;
}
const CADENCE_PA: CadenceThresholds = {
  turnBase: 6,
  turnStep: 5,
  actBase: 5,
  actStep: 5,
};
const CADENCE_SA: CadenceThresholds = {
  turnBase: 10,
  turnStep: 6,
  actBase: 12,
  actStep: 8,
};

/** Tools that represent "work that would be lost if not checkpointed": file
 *  mutations + orchestrator knowledge captures. Reads (Read/Grep/Glob, most
 *  Bash) are deliberately excluded - they don't accrue uncaptured state. Note
 *  lookups/briefings are also excluded (they create no unsaved work). */
function isSubstantiveActivity(toolName?: string): boolean {
  if (!toolName) return false;
  if (
    toolName === "Edit" ||
    toolName === "Write" ||
    toolName === "MultiEdit" ||
    toolName === "NotebookEdit"
  ) {
    return true;
  }
  return (
    toolName === "mcp__plugin_orchestrator_core__note" ||
    toolName === "mcp__plugin_orchestrator_core__create_work_item" ||
    toolName === "mcp__plugin_orchestrator_core__update_work_item" ||
    toolName === "mcp__plugin_orchestrator_core__update_note" ||
    toolName === "mcp__plugin_orchestrator_core__supersede_note"
  );
}

function readIntState(db: Database, key: string): number {
  const row = db
    .query(`SELECT value FROM plugin_state WHERE key = ?`)
    .get(key) as { value: string } | null;
  if (!row) return 0;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) ? n : 0;
}

/** save_progress just fired: reset the cadence state (loop closed). */
function recordCheckpointSaved(
  db: Database,
  sessionId: string,
  turn: number
): void {
  const sid = sanitizeSessionId(sessionId);
  db.run(
    `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)`,
    [`last_save_turn_${sid}`, String(turn), now()]
  );
  db.run(`DELETE FROM plugin_state WHERE key = ?`, [
    `activity_since_save_${sid}`,
  ]);
  db.run(`DELETE FROM plugin_state WHERE key = ?`, [`ckpt_nudge_level_${sid}`]);
}

/** A substantive action happened: bump the uncaptured-work counter. */
function bumpActivitySinceSave(db: Database, sessionId: string): void {
  const sid = sanitizeSessionId(sessionId);
  const key = `activity_since_save_${sid}`;
  const next = readIntState(db, key) + 1;
  db.run(
    `INSERT INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, String(next), now()]
  );
}

/** Best-effort self-role from the agent-channel registry. Defaults to
 *  "subordinate" when the registry is absent / self not found (non-channel +
 *  single-session projects still get the SA-cadence nudge). */
function getSelfRole(sid: string): "prime" | "subordinate" {
  try {
    const live = getLiveSessions();
    const self = live?.find((e) => e.session_id === sid) ?? null;
    return self?.role === "prime" ? "prime" : "subordinate";
  } catch {
    return "subordinate";
  }
}

/**
 * Cadence-aware regular-checkpoint nudge. Returns "" (silent) unless BOTH
 * turns-since-save and substantive-activity-since-save cross the current
 * level's role-aware bar - then it fires, raises the bar (escalation +
 * spacing), and returns escalating wording. Reset by save_progress via
 * recordCheckpointSaved.
 */
function composeCheckpointCadenceNudge(
  ctx: HookCtx,
  sessionId: string,
  turn: number
): string {
  const sid = sanitizeSessionId(sessionId);
  const lastSaveTurn = readIntState(ctx.db, `last_save_turn_${sid}`);
  // Absent last_save_turn (0) = never saved this session -> gap is the turn no.
  const turnsSinceSave = lastSaveTurn > 0 ? turn - lastSaveTurn : turn;
  const activity = readIntState(ctx.db, `activity_since_save_${sid}`);
  if (turnsSinceSave <= 0 || activity <= 0) return "";

  // Pre-gate with the SMALLEST possible bar (PA base) before the registry read,
  // so getSelfRole only runs when a nudge is plausibly due. PA is the tighter
  // role, so this never suppresses a legitimate fire.
  if (turnsSinceSave < CADENCE_PA.turnBase || activity < CADENCE_PA.actBase) {
    return "";
  }

  const role = getSelfRole(sid);
  const t = role === "prime" ? CADENCE_PA : CADENCE_SA;
  const level = readIntState(ctx.db, `ckpt_nudge_level_${sid}`);

  // Both gates must clear THIS level's (widening) bar.
  const turnBar = t.turnBase + level * t.turnStep;
  const actBar = t.actBase + level * t.actStep;
  if (turnsSinceSave < turnBar || activity < actBar) return "";

  // Fire. Raise the bar for next time (escalation + spacing).
  ctx.db.run(
    `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)`,
    [`ckpt_nudge_level_${sid}`, String(level + 1), now()]
  );

  const paTag =
    role === "prime"
      ? " As PA your context is the fleet's shared memory - your loss is the worst case; checkpoint more often than feels necessary."
      : "";
  if (level === 0) {
    return `[orch] Checkpoint hygiene: ${turnsSinceSave} turns and ${activity} substantive actions since your last save_progress. Point-of-compaction capture does NOT work (no model turn before a compaction fires), so REGULAR save_progress is the only real protection against losing this stretch of work. A 10-second save now is cheap insurance.${paTag}`;
  }
  if (level === 1) {
    return `[orch] Still uncheckpointed: ${turnsSinceSave} turns / ${activity} substantive actions of work not yet saved. Call save_progress THIS turn - re-deriving lost context after a compaction or crash costs far more than the save.${paTag}`;
  }
  return `[orch] URGENT checkpoint gap: ${turnsSinceSave} turns / ${activity} substantive actions since your last save_progress. You are one compaction away from losing all of it. Call save_progress NOW, before more work.${paTag}`;
}

function handleSubagentStop(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  // Subagents don't own their parent's checkpoint - they should NOT call
  // save_progress. Their job is to capture knowledge they discovered before
  // exiting; the parent agent decides session-level checkpoints.
  const key = `subagent_stop_${args.session_id}`;
  const exists = ctx.db
    .query(`SELECT 1 FROM plugin_state WHERE key = ?`)
    .get(key);
  if (exists) return {};
  ctx.db.run(
    `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, '1', ?)`,
    [key, now()]
  );

  const reason = `Before exiting, complete orchestrator housekeeping. Maintenance is equal-priority to capture:

**1. Curate what you used (update_note / close_thread / supersede_note).** For every lookup result you relied on:
- Was it still correct? If not, \`update_note\` (minor correction) or \`supersede_note\` (canonical replacement, preserves history).
- Is a tracked thread now settled by your work? \`close_thread\`.
- Stale notes actively mislead future sessions - fix them now.

**2. Capture new knowledge (note).** Subagent contexts evaporate on exit. If you discovered:
- A decision you made or recommended (type=decision)
- A pattern, convention, or gotcha (type=convention / anti_pattern)
- An architectural insight (type=architecture), risk, or hard-won insight
- For notes about specific code, pass \`code_refs: [paths]\` (file or module paths only).

NOTE: Do NOT call \`save_progress\` - that's the parent agent's job. Your job is to capture what you learned so the parent and future sessions benefit.

Retro is automatic on a 7-day cadence; no manual call needed.

If nothing applies, exit. But most subagent work produces at least one decision, gotcha, or insight worth preserving.`;

  return { decision: "block", reason };
}

function handleStopFailure(_ctx: HookCtx, _args: HookEventArgs): HookEventResponse {
  // Turn ended due to API error (rate limit, auth failure, etc). Lightweight
  // - emit a systemMessage that survives into the next turn so the agent
  // adjusts strategy if errors persist. Don't block.
  return {
    systemMessage:
      "Turn ended due to API error (rate limit, auth, or transient). If you retry and the same approach fails again, consider whether: (1) context size is the issue (compact or save_progress + continue lean), (2) a different tool path avoids the failing call, (3) lookup might surface a documented workaround. Don't loop on the same approach.",
  };
}

function handleTaskCompleted(_ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  // A subagent task just finished. Nudge the parent to capture what the
  // subagent discovered, not just take its result. Subagent contexts
  // evaporate after their final message - patterns/gotchas they surfaced
  // will be lost unless the parent acts.
  const aid = args.agent_id ? args.agent_id.slice(0, 8) : "subagent";
  return {
    additionalContext: `[orch] Subagent ${aid} just completed. Did it surface anything worth keeping? Capture decisions, patterns, anti-patterns, or gotchas it discovered before its context evaporates. Single item: \`note\`. Multiple: send the concierge a batch-capture request. Do NOT just take the subagent's result and move on.`,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function renderSiblingActivity(
  ctx: HookCtx,
  sessionId: string,
  userPrompt: string,
): string {
  // getActiveSiblings intersects with agent-channel sessions.json
  // heartbeat-fresh set internally (when sessions.json exists), so the
  // returned list is already free of ghost siblings.
  const sibs = ctx.tracker.getActiveSiblings(sessionId);

  if (sibs.length === 0) return "";

  // R7 overlap detection: if the user's prompt and any sibling's current_task
  // share meaningful keywords, flag potential overlap so the agent
  // proactively coordinates via the agent-channel (@SA-<id8>) instead of
  // stomping on parallel work.
  const promptKeywords = extractMeaningfulKeywords(userPrompt);
  const overlapping: typeof sibs = [];
  for (const s of sibs) {
    if (!s.current_task) continue;
    const taskKeywords = extractMeaningfulKeywords(s.current_task);
    const shared = intersectKeywords(promptKeywords, taskKeywords);
    if (shared.length >= 2) overlapping.push(s);
  }

  // 0.30.31 (WI c03c9d6a): look up each sibling's kind from sessions.json
  // so the briefing surfaces functional identity (discord-bot vs generic
  // SA vs PA) alongside the session_id. Falls back to no kind suffix when
  // the sibling was launched without ORCHESTRATOR_SESSION_KIND (e.g.
  // older launcher or a plain `claude` invocation that joined the
  // channel). Single sessions.json read; map by session_id for O(1) lookup.
  const liveEntries = getLiveSessions();
  const kindBySession = new Map<string, string>();
  if (liveEntries) {
    for (const e of liveEntries) {
      if (e.kind) kindBySession.set(e.session_id, e.kind);
    }
  }

  // 0.29.0: show FULL session_id (not 8-char prefix). Prior behavior
  // truncated to slice(0, 8) which made the displayed id useless for any
  // tooling that needed the canonical session_id (e.g. addressing peers via
  // @SA-<id8>, looking up in sessions.json). Show the full UUID; agent can
  // visually pick out the prefix for readability.
  const lines = sibs.map((s) => {
    const isOverlap = overlapping.some((o) => o.session_id === s.session_id);
    const marker = isOverlap ? " *POTENTIAL OVERLAP*" : "";
    const kind = kindBySession.get(s.session_id);
    const kindSuffix = kind ? ` (${kind})` : "";
    const task = s.current_task
      ? `: ${s.current_task.slice(0, 80)}`
      : ": (no task set)";
    return `  - ${s.session_id}${kindSuffix}${marker}${task}`;
  });

  let block = `[orch] ${sibs.length} sibling session${sibs.length > 1 ? "s" : ""} active:\n${lines.join("\n")}`;
  if (overlapping.length > 0) {
    const ids = overlapping.map((o) => o.session_id).join(", ");
    block += `\n  -> Coordinate with ${ids} via @SA-<id8> in your terminal output BEFORE starting work in their area. Shared scope is the most common cause of merge conflicts and contradictory decisions across sessions.`;
  }
  return block;
}

// R7.5: extended with code-vocabulary words that would otherwise trigger
// false-positive POTENTIAL OVERLAP markers between code-heavy prompts.
// "want" was duplicated in the original list - deduped. Two unrelated tasks
// each saying "test the function that updates state" share `function`,
// `update`, `state` - all stopwords now.
const STOPWORDS = new Set([
  // Articles, conjunctions, copulas
  "the","a","an","and","or","but","if","then","else","is","are","was","were","be","been",
  "have","has","had","do","does","did","will","would","could","should","may","might","must",
  // Prepositions, pronouns, demonstratives
  "to","of","in","on","at","for","with","from","by","as","into","onto","that","this","these",
  "those","it","its","i","you","we","they","he","she","them","us","my","your","our","their",
  // Question words, polarity, modifiers
  "what","when","where","why","how","which","who","whom","not","no","yes","so","just","also",
  "very","really","still","only","ever","never","more","less","most","least","some","any",
  "all","none","each","every","one","two","new","old",
  // Common low-information verbs
  "make","made","get","got","let","lets","want","need","like","try","run","use","using",
  "add","fix","update","check","take","show","see","look","know","think","tell","ask","help",
  "work","working","working","done","ok","okay",
  // Adverbs of position/time
  "now","up","down","out","back","over","under","again","much","many","few","next","last",
  // R7.5 code-vocabulary stopwords - high-frequency in coding prompts, low overlap signal
  "function","functions","method","methods","class","classes","interface","interfaces","type","types",
  "value","values","variable","variables","parameter","parameters","argument","arguments",
  "return","returns","import","imports","export","exports","module","modules",
  "test","tests","testing","spec","specs","mock","mocks","stub","stubs",
  "error","errors","exception","exceptions","bug","bugs","issue","issues","problem","problems",
  "code","codes","file","files","folder","folders","dir","directory","path","paths",
  "string","strings","number","numbers","array","arrays","object","objects","null","undefined",
  "state","states","prop","props","data","items","item","list","lists",
  "true","false","none","void",
]);

function extractMeaningfulKeywords(text: string): Set<string> {
  if (!text) return new Set();
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return new Set(words);
}

function intersectKeywords(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const w of a) {
    if (b.has(w)) out.push(w);
  }
  return out;
}

function composeBridgeFromLog(ctx: HookCtx, sessionId: string, turn: number): string {
  const prevTurn = turn - 1;
  if (prevTurn < 1) return "";
  const key = `bridge_${sessionId}_${prevTurn}`;
  const row = ctx.db
    .query(`SELECT value FROM plugin_state WHERE key = ?`)
    .get(key) as { value: string } | null;
  if (!row || !row.value) return "";
  ctx.db.run(`DELETE FROM plugin_state WHERE key = ?`, [key]);
  return row.value;
}

function appendBridgeAction(db: Database, sessionId: string, turn: number, toolName: string): void {
  const action = toolName.replace("mcp__plugin_orchestrator_core__", "");
  const key = `bridge_${sessionId}_${turn}`;
  const existing = db
    .query(`SELECT value FROM plugin_state WHERE key = ?`)
    .get(key) as { value: string } | null;
  const next = existing?.value ? `${existing.value}, ${action}` : action;
  db.run(
    `INSERT INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, next, now()]
  );
}

function resetTurnState(db: Database, sessionId: string): void {
  db.run(`DELETE FROM plugin_state WHERE key = ?`, [`struggle_${sessionId}`]);
  db.run(`DELETE FROM plugin_state WHERE key LIKE ?`, [`orch_active_${sessionId}_%`]);
  db.run(`DELETE FROM plugin_state WHERE key LIKE ?`, [`preuse_warned_${sessionId}_%`]);
}

function sessionHadOrchActivityThisTurn(db: Database, sessionId: string, turn: number): boolean {
  return (
    db
      .query(`SELECT 1 FROM plugin_state WHERE key = ?`)
      .get(`orch_active_${sessionId}_${turn}`) !== null
  );
}

function markOrchActivityThisTurn(db: Database, sessionId: string, turn: number): void {
  db.run(
    `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, '1', ?)`,
    [`orch_active_${sessionId}_${turn}`, now()]
  );
}

function warnedThisTurn(db: Database, sessionId: string, turn: number): boolean {
  return (
    db
      .query(`SELECT 1 FROM plugin_state WHERE key = ?`)
      .get(`preuse_warned_${sessionId}_${turn}`) !== null
  );
}

function markWarnedThisTurn(db: Database, sessionId: string, turn: number): void {
  db.run(
    `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, '1', ?)`,
    [`preuse_warned_${sessionId}_${turn}`, now()]
  );
}

function bumpStruggleCounter(db: Database, sessionId: string): number {
  const key = `struggle_${sessionId}`;
  const row = db
    .query(`SELECT value FROM plugin_state WHERE key = ?`)
    .get(key) as { value: string } | null;
  const next = (row ? parseInt(row.value, 10) : 0) + 1;
  db.run(
    `INSERT INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, String(next), now()]
  );
  return next;
}

function resetStruggleCounter(db: Database, sessionId: string): void {
  db.run(`DELETE FROM plugin_state WHERE key = ?`, [`struggle_${sessionId}`]);
}

function markWorkItemTouched(db: Database, sessionId: string, workItemId: string): void {
  // Sanitize the work_item id to avoid SQL-LIKE special chars sneaking into
  // the plugin_state key (the loop-close query uses string concat against
  // this key, so % or _ in the id could match other keys).
  const cleanId = workItemId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!cleanId) return;
  db.run(
    `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, '1', ?)`,
    [`wi_touched_${sanitizeSessionId(sessionId)}_${cleanId}`, now()]
  );
}

function countFreshSurfaced(db: Database, sessionId: string): number {
  const row = db
    .query(
      `SELECT COUNT(DISTINCT note_id) as cnt FROM session_log
       WHERE session_id = ? AND delivery_type = 'fresh'`
    )
    .get(sessionId) as { cnt: number } | null;
  return row?.cnt ?? 0;
}

// R7.6: removed buildStopSessionNudge - the R3.4 fresh-notes nudge is now
// integrated into the surgical Stop prompt's Curate section directly via
// listFreshSurfacedNotes(). One section per concern instead of two saying
// the same thing.

// ── R7: Loop-closure + user-signal ──────────────────────────────────────

interface InFlightWorkItem {
  id: string;
  status: string;
  content: string;
}

function listInFlightWorkItemsForSession(
  db: Database,
  sessionId: string
): InFlightWorkItem[] {
  // R7.6 tightened heuristic. Pre-R7.6 this OR'd `source_session = me` with
  // `session_log surfaced via lookup` - which over-fired on items merely
  // seen in briefings (the briefing surfaces hot work_items routinely, all
  // of which would then flag as "in scope"). Field signal: heavy sessions
  // saw 5+ unrelated work_items in their loop-close prompt every turn,
  // most belonging to other sessions.
  //
  // Tightened to: I created the work_item (source_session = me), OR I
  // explicitly updated it this session via update_work_item / update_note
  // (tracked by writing to plugin_state on those tool calls). The `wi_touched_`
  // markers are written by handlePostToolUse when the tool was an
  // orchestrator update on a work_item id.
  //
  // The `session_log surfaced` amplifier was the noise source. Dropping it
  // loses signal for "work I picked up but didn't author and didn't edit
  // this session" - acceptable: agents reading about work_items in
  // briefings shouldn't be told to close them.
  return db
    .query(
      `SELECT DISTINCT n.id, n.status, n.content
       FROM notes n
       WHERE n.type = 'work_item'
         AND COALESCE(n.status, '') NOT IN ('done', 'cancelled', 'completed')
         AND (
           n.source_session = ?
           OR EXISTS (
             SELECT 1 FROM plugin_state ps
             WHERE ps.key = 'wi_touched_' || ? || '_' || n.id
           )
         )
       ORDER BY COALESCE(n.signal, 0) DESC, n.updated_at DESC
       LIMIT 5`
    )
    .all(sessionId, sessionId) as InFlightWorkItem[];
}

// R7.5: anchored start, optional trailing punctuation, multi-word phrases or
// unambiguous tokens only. Bare singletons like "done", "thanks", "great",
// "nice", "perfect", "sweet", "yep" are dropped - in field testing those
// matched casual usage ("everything you've done", "thanks for trying",
// "perfect storm", "great pain") and triggered the strong "Close loops NOW"
// escalation in the wrong direction. Honors the orchestrator's "no
// prompt-layer shims" principle: a noisy escalation trains agents to ignore
// the real ones.
const APPROVAL_REGEX =
  /^(?:looks?\s+good|ship\s+it|lgtm|approved?|all\s+good|nailed\s+it|that('?s|\s+is)\s+(it|right|perfect)|works?\s+now|all\s+done|i'?m\s+done|we'?re\s+done|good\s+to\s+go|good\s+to\s+ship|let'?s\s+ship)\b[\s.!]*$/i;

function userPromptSignalsApproval(prompt: string): boolean {
  if (!prompt) return false;
  // Only detect on short prompts (<300 chars). Anchored regex requires the
  // approval phrase to be the entire prompt (modulo trailing punctuation),
  // so long-prompt false positives can't sneak in either.
  if (prompt.length > 300) return false;
  const trimmed = prompt.trim();
  if (APPROVAL_REGEX.test(trimmed)) return true;
  // Multi-clause approval like "looks good, ship it" - check the FIRST
  // clause delimited by , . ; ! ?. If the leading clause is a clean
  // approval phrase, treat the prompt as approval.
  const firstClause = trimmed.split(/[,.;!?]/, 1)[0]?.trim();
  if (firstClause && firstClause !== trimmed && APPROVAL_REGEX.test(firstClause)) {
    return true;
  }
  return false;
}

function composeLoopCloseNudge(
  ctx: HookCtx,
  sessionId: string,
  userPrompt: string
): string {
  const inFlight = listInFlightWorkItemsForSession(ctx.db, sessionId);
  if (inFlight.length === 0) return "";

  const ids = inFlight.map((w) => w.id.slice(0, 8)).join(", ");

  if (userPromptSignalsApproval(userPrompt)) {
    // Strong escalation: user just signaled approval, agent should close
    // loops decisively this turn.
    return `[orch] User just signaled approval. Close loops NOW. In-flight work_items in your scope: ${ids}. For each: did it just complete? \`update_work_item({id, status:"done"})\`. Capture any decisions/patterns from this turn before they evaporate. If anything else should close, ask explicitly in your reply.`;
  }

  return `[orch] Loop-close check: in-flight work_items in your scope: ${ids}. Did any just complete? Mark done. If unsure whether the user considers it done, ASK in your reply rather than carry forward silently.`;
}

function composeCodeRefsHint(
  db: Database,
  sessionId: string,
  filePath: string
): string {
  // Cheap LIKE query against the JSON-encoded code_refs column. We need at
  // least one note tagged with this exact path. Track per-session+file
  // surfacing via plugin_state to avoid repeating the same hint within a
  // single session.
  const stateKey = `code_refs_hint_${sessionId}_${filePath}`;
  const seen = db
    .query(`SELECT 1 FROM plugin_state WHERE key = ?`)
    .get(stateKey);
  if (seen) return "";

  // Sample by exact-path containment in the JSON array. No wildcards.
  const needle = JSON.stringify(filePath);
  const row = db
    .query(
      `SELECT COUNT(*) as cnt FROM notes
       WHERE code_refs IS NOT NULL AND code_refs LIKE ?`
    )
    .get(`%${needle}%`) as { cnt: number } | null;
  const cnt = row?.cnt ?? 0;
  if (cnt === 0) return "";

  // Mark as seen so we don't re-nudge for this file this session.
  db.run(
    `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, '1', ?)`,
    [stateKey, now()]
  );

  return `This file has ${cnt} note${cnt === 1 ? "" : "s"} tagged with its path - run \`lookup({code_ref:"${filePath}"})\` first to pull file-scoped knowledge that keyword search would miss.`;
}
