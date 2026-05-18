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

  const parts: string[] = [reminder];
  if (bridge) parts.push(`Last turn bridge: ${bridge}`);
  if (siblingLine) parts.push(siblingLine);
  if (loopClose) parts.push(loopClose);

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

function handlePreCompact(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  const sid = sanitizeSessionId(args.session_id);
  if (sid) {
    // Store numeric epoch ms (not the ISO string from now()) so the
    // suppression-window check in handleStop can compare directly.
    ctx.db.run(
      `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)`,
      [`compacting_${sid}`, String(Date.now()), now()]
    );
  }
  return {
    systemMessage:
      "Context compaction imminent. Before your window shrinks, capture any uncaptured knowledge NOW: call save_progress for current state, note() for decisions/gotchas/patterns discovered this session, update_note / supersede_note for corrections to notes this session read and found wanting, close_thread for resolved open threads. After compaction the orchestrator will re-orient via briefing() automatically - but anything not persisted to the knowledge base is lost.",
  };
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
const SESSIONSTART_CHECKPOINT_CAP = 4000;
const SESSIONSTART_TOTAL_CAP = 7000;

/**
 * PURE post-compact re-orientation composer (167ffbaf + e4774e4b). Separated
 * from the DB/disk reads so the `livePA` branch is deterministically
 * testable - `getLiveSessions()` is a non-hermetic disk read (it reflects
 * the real running fleet), so the impure shell stays untested for the live
 * branch exactly like the other `getLiveSessions()` call site, and this pure
 * core carries the test coverage. Bounded-by-construction (05f072d3 cap
 * discipline: briefing() proved an unbounded hook payload breaks the entry).
 */
export function composePostCompactReorientation(opts: {
  currentTask: string | null;
  checkpoint: string | null;
  livePA: boolean;
}): string {
  const { currentTask, checkpoint, livePA } = opts;
  const parts: string[] = [
    "Context was just compacted. Re-orient from this durable state, then verify it against live reality (read the actual code/notes) before acting - the compaction summary is lossy.",
  ];
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
  if (livePA) {
    // 5d1c20fc trigger-design fix: the hook now emits the peer-backstop
    // solicitation to PA itself (deterministic, system_events bus). Do NOT
    // ask the agent to post anything - the just-compacted agent voluntarily
    // posting an optional line was the exact failure mode. Only INFORM it.
    parts.push(
      "A peer-backstop request was just emitted to PA on your behalf automatically - you do NOT need to post anything for it. A non-compacted peer or PA may reply on the channel flagging load-bearing context the lossy summary dropped; fold any such replies in when they arrive. Non-blocking: continue your work. This is a targeted gap-check, not a full context re-request."
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

function handleSessionStartCompact(
  ctx: HookCtx,
  args: HookEventArgs
): HookEventResponse {
  const sid = sanitizeSessionId(args.session_id);

  let currentTask: string | null = null;
  let checkpoint: string | null = null;
  try {
    const taskRow = ctx.db
      .query(`SELECT current_task FROM session_registry WHERE session_id = ?`)
      .get(sid) as { current_task: string | null } | null;
    currentTask = taskRow?.current_task ?? null;
  } catch {
    /* registry missing - non-fatal */
  }
  try {
    const cpRow = ctx.db
      .query(
        `SELECT content FROM notes WHERE type = 'checkpoint' ORDER BY created_at DESC LIMIT 1`
      )
      .get() as { content: string } | null;
    checkpoint = cpRow?.content ?? null;
  } catch {
    /* notes missing - non-fatal */
  }

  let livePA = false;
  let paSession: string | null = null;
  try {
    const live = getLiveSessions();
    const pa = live?.find((e) => e.role === "prime") ?? null;
    livePA = !!pa;
    paSession = pa?.session_id ?? null;
  } catch {
    livePA = false;
    paSession = null;
  }

  // e4774e4b (5d1c20fc trigger-design fix): emit the peer-backstop
  // solicitation DETERMINISTICALLY on the system_events bus (the same
  // mechanism the permission relay uses), addressed to PA. The prior design
  // relied on the just-compacted agent voluntarily posting a channel line -
  // shipped, exercised on a perfect live case, did nothing. PA's filewatcher
  // surfaces this within ~1.5s with zero dependence on the compacted agent.
  // Strictly non-fatal: the re-orientation systemMessage MUST return whether
  // or not the bus write succeeds (bus may be absent on non-channel projects).
  try {
    const ev = buildPeerBackstopEvent({
      fromSession: sid,
      paSession,
      currentTask,
      ts: now(),
    });
    const stateDir = getAgentChannelStateDir();
    if (ev && stateDir) appendSystemEvent(stateDir, ev);
  } catch {
    /* agent-channel bus unavailable - non-fatal; systemMessage still re-orients */
  }

  return {
    systemMessage: composePostCompactReorientation({
      currentTask,
      checkpoint,
      livePA,
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
