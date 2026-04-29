import type { Database } from "bun:sqlite";
import { peekInbox, drainInbox } from "../engine/messaging";
import type { SessionTracker } from "../engine/session_tracker";
import { now } from "../utils";

// Hook event names mirror Claude Code's hook event surface. Each branch is
// responsible for the entire response shape (additionalContext,
// permissionDecision, decision:"block", systemMessage) for that event.
// Returning {} is the fast path - empty JSON to stdout = zero token cost.
export type HookEvent =
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PreCompact"
  | "Stop"
  | "SubagentStop";

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

const VARIANTS = [
  "[orch] REFLECT on last turn: did you note decisions, capture patterns, update work items, or close threads? THEN for this turn: lookup needed? Scan the every-turn action table.",
  "[orch] What prior decisions or anti-patterns apply here? Call lookup before editing unfamiliar code. Capture new knowledge the moment it appears.",
  "[orch] Discipline check: knowledge captured this session so far? If you are about to touch new code, check_similar first. Do not rationalize skipping the action table.",
  "[orch] Mid-session nudge: user preferences, anti-patterns, and decisions are easiest to lose. If any surfaced last turn, note() them NOW before context shifts.",
  "[orch] Lookups before writes, notes as you go. 'I will capture it later' is the top cause of knowledge loss. Later is now.",
  "[orch] Toolkit scan: briefing, lookup, note, check_similar, plan, save_progress, close_thread, update_note, supersede_note, send_message, update_session_task. Which one fits this turn before acting? code_refs: [paths] on note/update_note when the knowledge is about specific files.",
  "[orch] Struggle detector: if you are editing code you just edited, or hitting the same error twice, STOP and invoke orchestrator:consult-concierge. Do not hammer.",
  "[orch] Past-self continuity: what you learn this turn only helps future sessions if you note() it. Context windows are temporary, the knowledge base is permanent.",
  "[orch] Work-item hygiene: did a tracked item just change status? update_work_item. New work identified? create_work_item. Do not rely on memory across turns.",
  "[orch] Completeness check: if this turn is a list, inventory, or audit, use list_work_items or orchestrator:consult-concierge. Direct lookup misses items with different vocabulary.",
  "[orch] Capturing knowledge about specific code? Add code_refs: [paths] so future agents find this note via lookup({code_ref: 'path'}) when they touch the same file.",
  "[orch] Editing a non-trivial file? Before diving in, try lookup({code_ref: 'path/to/file'}) to pull notes breadcrumb-tagged with that exact path.",
  "[orch] Cross-session check: see sibling sessions in your hook context? Set update_session_task at the start of major work so they know what you're touching. Discovered something they need? send_message - direct or broadcast.",
  "[orch] R6 inbox: messages from sibling sessions surface inline at every PostToolUse boundary. Empty inbox = zero token cost. If you see one, act on it before continuing your own work - someone left it for a reason.",
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
    case "Stop":
    case "SubagentStop":
      return handleStop(ctx, args);
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
  const messages = drainIfPending(ctx, args.session_id);
  const siblingLine = renderSiblingActivity(ctx, args.session_id);
  const bridge = composeBridgeFromLog(ctx, args.session_id, turn);

  const parts: string[] = [reminder];
  if (bridge) parts.push(`Last turn bridge: ${bridge}`);
  if (siblingLine) parts.push(siblingLine);
  if (messages) parts.push(messages);

  return { additionalContext: parts.join("\n\n") };
}

function handlePreToolUse(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  // Inter-session messages (including code-scoped) are delivered uniformly
  // via PostToolUse, which fires after every tool call and renders scope
  // labels inline. Pre-edit code-scoped warning was considered but dropped
  // for R6: the duplicate-display problem (PreToolUse peek + PostToolUse
  // drain) outweighs the marginal value of a pre-write nudge. R6.1 can
  // revisit if needed.

  // Option-B escalation preserved from the legacy bash hook: nag turn 2-3
  //    sessions that haven't called any orchestrator tool this turn, escalate
  //    to permissionDecision:"ask" on turn 4+. Per-session, per-turn, fires
  //    once per turn.
  const turn = ctx.tracker.getCurrentTurn(args.session_id);
  if (turn < 2) return {};

  if (sessionHadOrchActivityThisTurn(ctx.db, args.session_id, turn)) return {};
  if (warnedThisTurn(ctx.db, args.session_id, turn)) return {};
  markWarnedThisTurn(ctx.db, args.session_id, turn);

  if (turn >= 4) {
    return {
      permissionDecision: "ask",
      permissionDecisionReason: `Orchestrator discipline check: turn ${turn}, no orchestrator tool called this turn. Approve to proceed (explicit choice to skip orch this turn) or deny and run orchestrator:consult-concierge / lookup / briefing first to check for relevant decisions, conventions, or anti-patterns.`,
    };
  }
  return {
    permissionDecision: "allow",
    additionalContext: `[orch] Turn ${turn}: about to modify code with no orchestrator tool called this turn. A 2-second lookup can save 20 minutes of rework. From turn 4 this becomes an interactive approval prompt.`,
  };
}

function handlePostToolUse(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  // Mark orch activity for the turn so PreToolUse Option B doesn't nag.
  if (args.tool_name && args.tool_name.startsWith("mcp__plugin_orchestrator_memory__")) {
    markOrchActivityThisTurn(ctx.db, args.session_id, ctx.tracker.getCurrentTurn(args.session_id));
    appendBridgeAction(ctx.db, args.session_id, ctx.tracker.getCurrentTurn(args.session_id), args.tool_name);
  }
  // Reset struggle counter on any successful tool call.
  resetStruggleCounter(ctx.db, args.session_id);

  // Densest delivery surface. O(1) fast path via in-memory counter.
  const messages = drainIfPending(ctx, args.session_id);
  if (messages) return { additionalContext: messages };
  return {};
}

function handlePostToolUseFailure(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  const next = bumpStruggleCounter(ctx.db, args.session_id);
  if (next < 2) return {};
  if (next >= 3) {
    return {
      additionalContext: `[orch] STOP. ${next} consecutive tool failures. You are stuck. Invoke orchestrator:consult-concierge NOW with: (1) what you are trying to accomplish, (2) what you have tried, (3) what errors you are seeing. Do not retry until you have consulted the knowledge base.`,
    };
  }
  return {
    additionalContext: `[orch] Two tool calls failed in a row. Before trying a third approach, consider invoking orchestrator:consult-concierge. The knowledge base may have a documented gotcha for this exact situation.`,
  };
}

function handlePreCompact(_ctx: HookCtx, _args: HookEventArgs): HookEventResponse {
  return {
    systemMessage:
      "Context compaction imminent. Before your window shrinks, capture any uncaptured knowledge NOW: call save_progress for current state, note() for decisions/gotchas/patterns discovered this session, update_note / supersede_note for corrections to notes this session read and found wanting, close_thread for resolved open threads. After compaction the orchestrator will re-orient via briefing() automatically - but anything not persisted to the knowledge base is lost.",
  };
}

function handleStop(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  // Block once per session id, then pass through. Reuse plugin_state with a
  // marker key so the same logic works for Stop and SubagentStop.
  const key = args.event === "Stop" ? `stop_${args.session_id}` : `subagent_stop_${args.session_id}`;
  const exists = ctx.db
    .query(`SELECT 1 FROM plugin_state WHERE key = ?`)
    .get(key);
  if (exists) return {};
  ctx.db.run(
    `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, '1', ?)`,
    [key, now()]
  );

  const nudge = buildStopSessionNudge(ctx.db, args.session_id);

  const reason = `Before ending this session, complete orchestrator housekeeping. Maintenance verbs are equal-priority to capture - a session that only captures grows the corpus; a session that also maintains makes the knowledge base more accurate and faster to traverse over time.

**1. Curate existing knowledge (update_note / close_thread / supersede_note).** For every lookup result you used this session, ask:
- Was it still correct? If not, call \`update_note\` (minor correction) or \`supersede_note\` (new note replaces old).
- Is a tracked thread / commitment / work_item now settled? Call \`close_thread\`.
- Did you correct a note verbally but never update the note itself? Fix it now - future sessions will read the stale version.

**2. Capture new knowledge (note).** Scan your work for anything that would be lost:
- A decision you made or recommended (type=decision) - what you chose, what you rejected, why
- A pattern or convention (type=convention) or anti-pattern / gotcha (type=anti_pattern)
- An architectural insight (type=architecture), risk (type=risk), or hard-won insight (type=insight)
- User behavior or preferences (type=user_pattern, scope=global)
- Work completed on a tracked item (call \`update_work_item\` status=done)
- **For notes about specific code**, pass \`code_refs: [paths]\` (file or module paths - not line numbers or symbols).

**3. Save progress.** Call \`save_progress\` with a summary of work done, open questions, and next steps.

**4. Retro is automatic.** \`retro\` now auto-fires from \`briefing\` on a 7-day cadence, so you do NOT need to call it at session end. Call it manually only if you want to force an immediate maintenance pass.${nudge}

The orchestrator is a living knowledge base, not an append-only log. Do this quickly, then you can stop.`;
  return { decision: "block", reason };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function drainIfPending(ctx: HookCtx, sessionId: string): string {
  const peek = peekInbox(ctx.db, sessionId);
  if (peek.count === 0) return "";
  const msgs = drainInbox(ctx.db, sessionId);
  if (msgs.length === 0) return "";
  const lines = msgs.map((m) => {
    const tag = m.priority === "high" ? "[HIGH]" : m.priority === "low" ? "[low]" : "•";
    const where = m.to_session ? "direct" : "broadcast";
    const scopeStr = m.scope?.code_ref
      ? ` {scoped to ${m.scope.code_ref}}`
      : m.scope?.task_contains
        ? ` {scoped to task~${m.scope.task_contains}}`
        : "";
    return `${tag} [${where} from ${m.from_session.slice(0, 8)}]${scopeStr}: ${m.body}`;
  });
  return `### Inter-session messages (${msgs.length})\n${lines.join("\n")}`;
}

function renderSiblingActivity(ctx: HookCtx, sessionId: string): string {
  const sibs = ctx.tracker.getActiveSiblings(sessionId);
  if (sibs.length === 0) return "";
  const lines = sibs.map((s) => {
    const id = s.session_id.slice(0, 8);
    const task = s.current_task ? `: ${s.current_task.slice(0, 80)}` : ": (no task set)";
    return `  - ${id}${task}`;
  });
  return `[orch] ${sibs.length} sibling session${sibs.length > 1 ? "s" : ""} active:\n${lines.join("\n")}`;
}

function composeBridgeFromLog(ctx: HookCtx, sessionId: string, turn: number): string {
  // Bridge = orchestrator MCP tools fired since the last UserPromptSubmit.
  // We track via plugin_state key bridge_<sid>_<turn-1> rather than a file.
  // The previous turn's bridge is what we surface now.
  const prevTurn = turn - 1;
  if (prevTurn < 1) return "";
  const key = `bridge_${sessionId}_${prevTurn}`;
  const row = ctx.db
    .query(`SELECT value FROM plugin_state WHERE key = ?`)
    .get(key) as { value: string } | null;
  if (!row || !row.value) return "";
  // Clean up the prev-turn bridge after consuming it.
  ctx.db.run(`DELETE FROM plugin_state WHERE key = ?`, [key]);
  return row.value;
}

function appendBridgeAction(db: Database, sessionId: string, turn: number, toolName: string): void {
  const action = toolName.replace("mcp__plugin_orchestrator_memory__", "");
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
  // Clear any stale orch-active markers from old turns (older than current).
  // We don't know the old turn here so we delete any orch-active key for this session.
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

function buildStopSessionNudge(db: Database, sessionId: string): string {
  // Reproduce the existing bash-stop nudge: when this session surfaced >=3
  // fresh notes via session_log, list them and prompt for maintenance.
  const countRow = db
    .query(
      `SELECT COUNT(DISTINCT note_id) as cnt FROM session_log
       WHERE session_id = ? AND delivery_type = 'fresh'`
    )
    .get(sessionId) as { cnt: number } | null;
  const fresh = countRow?.cnt ?? 0;
  if (fresh < 3) return "";

  const rows = db
    .query(
      `SELECT n.id, n.type, substr(replace(replace(n.content, char(10), ' '), char(13), ' '), 1, 80) as snippet
       FROM session_log sl
       JOIN notes n ON sl.note_id = n.id
       WHERE sl.session_id = ? AND sl.delivery_type = 'fresh'
       GROUP BY n.id
       ORDER BY n.updated_at ASC
       LIMIT 5`
    )
    .all(sessionId) as Array<{ id: string; type: string; snippet: string }>;
  if (rows.length === 0) return "";

  const formatted = rows
    .map((r) => `\n- **${r.id.slice(0, 8)}** [${r.type}] ${r.snippet}`)
    .join("");
  const remaining = fresh - rows.length;
  const moreHint =
    remaining > 0
      ? `\n...and ${remaining} more - find them with lookup({session_id:"${sessionId}"}) or by tag.`
      : "";

  return `\n\n### Notes this session surfaced that you may not have maintained (${fresh} total):${formatted}${moreHint}\n\nFor each: was it still correct? If not, call update_note / supersede_note. Is the thread/question settled? Call close_thread. Future sessions read these - stale notes actively mislead.`;
}
