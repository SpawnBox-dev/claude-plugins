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
  | "StopFailure"
  | "SubagentStop"
  | "TaskCompleted";

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
  "[orch] Loop-closure check: any in-flight work_items in your scope? If you completed one, mark done. If unsure whether the user considers it done, ASK in your reply - closing loops is part of the job, not 'bothering the user'.",
  "[orch] Update as you go, not at the end. When a work_item's scope shifts mid-task, update_work_item({id, content}) keeps siblings looking at current state. Stale work_item descriptions actively mislead other agents.",
  "[orch] Coordination etiquette: starting work that overlaps a sibling's current_task? send_message FIRST to align - 'I'm about to touch X, anything I should know?' beats 'we both edited the same file in different directions and now have to merge'.",
  "[orch] Check siblings when it matters. You don't need to scan their state every turn - but at a task boundary, when starting something that might overlap, take 5s to check the sibling activity in your hook context.",
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
  const messages = drainIfPending(ctx, args.session_id);
  const userPrompt = (args.payload?.user_prompt as string | undefined) ?? "";
  const siblingLine = renderSiblingActivity(ctx, args.session_id, userPrompt);
  const bridge = composeBridgeFromLog(ctx, args.session_id, turn);

  // R7 loop-closure + user-signal escalation.
  const loopClose = composeLoopCloseNudge(ctx, args.session_id, userPrompt);

  const parts: string[] = [reminder];
  if (bridge) parts.push(`Last turn bridge: ${bridge}`);
  if (siblingLine) parts.push(siblingLine);
  if (loopClose) parts.push(loopClose);
  if (messages) parts.push(messages);

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
      : `Orchestrator discipline check: turn ${turn}, no orchestrator tool called this turn. Approve to proceed (explicit choice to skip orch this turn) or deny and run orchestrator:consult-concierge / lookup / briefing first to check for relevant decisions, conventions, or anti-patterns.`;
    return { permissionDecision: "ask", permissionDecisionReason: reason };
  }
  const ctx_msg = codeRefsHint
    ? `[orch] Turn ${turn}: about to modify code with no orchestrator tool called this turn. ${codeRefsHint}`
    : `[orch] Turn ${turn}: about to modify code with no orchestrator tool called this turn. A 2-second lookup can save 20 minutes of rework. From turn 4 this becomes an interactive approval prompt.`;
  return { permissionDecision: "allow", additionalContext: ctx_msg };
}

function handlePostToolUse(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  // Mark orch activity for the turn so PreToolUse Option B doesn't nag.
  if (args.tool_name && args.tool_name.startsWith("mcp__plugin_orchestrator_memory__")) {
    markOrchActivityThisTurn(ctx.db, args.session_id, ctx.tracker.getCurrentTurn(args.session_id));
    appendBridgeAction(ctx.db, args.session_id, ctx.tracker.getCurrentTurn(args.session_id), args.tool_name);
  }
  // Reset struggle counter on any successful tool call.
  resetStruggleCounter(ctx.db, args.session_id);

  // R7 work-item drift nudge: when the agent just edited a file tied to an
  // in-flight work_item via code_refs, surface the work_item so the agent
  // can update its content/status if scope shifted. Once per session+work_item.
  const driftNudge = composeWorkItemDriftNudge(ctx.db, args.session_id, args);

  // Densest delivery surface. O(1) fast path via in-memory counter.
  const messages = drainIfPending(ctx, args.session_id);

  const parts: string[] = [];
  if (driftNudge) parts.push(driftNudge);
  if (messages) parts.push(messages);

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

  // R7: surgical Stop prompt. Build only the sections that have signal in
  // this session's state.
  const fresh = countFreshSurfaced(ctx.db, args.session_id);
  const inFlight = listInFlightWorkItemsForSession(ctx.db, args.session_id);

  const sections: string[] = [];
  sections.push(
    "Before ending this session, complete orchestrator housekeeping. Maintenance verbs are equal-priority to capture - a session that only captures grows the corpus; a session that also maintains makes the knowledge base more accurate and faster to traverse over time."
  );

  let sectionNum = 1;

  if (fresh > 0) {
    sections.push(
      `**${sectionNum}. Curate existing knowledge (update_note / close_thread / supersede_note).** You surfaced ${fresh} fresh note${fresh === 1 ? "" : "s"} this session. For each one you used:\n- Was it still correct? If not, \`update_note\` (minor correction) or \`supersede_note\` (new canonical version, preserves history).\n- Is a tracked thread now settled? \`close_thread\`.\n- Did you correct a note verbally but never update it? Fix it now.`
    );
  } else {
    sections.push(
      `**${sectionNum}. Curate existing knowledge (update_note / close_thread / supersede_note).** No fresh notes surfaced this session. Skip if there's nothing to curate, but if you corrected a note verbally without writing the change back, fix it now.`
    );
  }
  sectionNum++;

  sections.push(
    `**${sectionNum}. Capture new knowledge (note).** Scan your work for anything that would be lost: decisions, conventions, anti-patterns, architecture, risks, insights, user preferences. For notes about specific code, pass \`code_refs: [paths]\`.`
  );
  sectionNum++;

  if (inFlight.length > 0) {
    const list = inFlight
      .slice(0, 5)
      .map((w) => `  - **${w.id.slice(0, 8)}** [${w.status}] ${w.content.slice(0, 80)}`)
      .join("\n");
    const more = inFlight.length > 5 ? `\n  ...and ${inFlight.length - 5} more.` : "";
    sections.push(
      `**${sectionNum}. Loop-closure (R7).** ${inFlight.length} in-flight work_item${inFlight.length === 1 ? "" : "s"} touched this session:\n${list}${more}\n\nFor each, ask: did this just complete? \`update_work_item({id, status: "done"})\`. If you cannot tell whether the user considers it done, ASK explicitly before ending the session.`
    );
    sectionNum++;
  }

  sections.push(
    `**${sectionNum}. Save progress.** Call \`save_progress\` with summary, open questions, next steps.`
  );

  sections.push("Retro is automatic on a 7-day cadence; no manual call needed.");

  const nudge = buildStopSessionNudge(ctx.db, args.session_id);
  const reason = sections.join("\n\n") + nudge;

  return { decision: "block", reason };
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
      "Turn ended due to API error (rate limit, auth, or transient). If you retry and the same approach fails again, consider whether: (1) context size is the issue (compact or save_progress + continue lean), (2) a different tool path avoids the failing call, (3) consult-concierge can surface a documented workaround. Don't loop on the same approach.",
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

function renderSiblingActivity(
  ctx: HookCtx,
  sessionId: string,
  userPrompt: string
): string {
  const sibs = ctx.tracker.getActiveSiblings(sessionId);
  if (sibs.length === 0) return "";

  // R7 overlap detection: if the user's prompt and any sibling's current_task
  // share meaningful keywords, flag potential overlap so the agent
  // proactively coordinates via send_message instead of stomping on parallel
  // work. "When it matters" - shown only when the signal is actually present.
  const promptKeywords = extractMeaningfulKeywords(userPrompt);
  const overlapping: typeof sibs = [];
  for (const s of sibs) {
    if (!s.current_task) continue;
    const taskKeywords = extractMeaningfulKeywords(s.current_task);
    const shared = intersectKeywords(promptKeywords, taskKeywords);
    if (shared.length >= 2) overlapping.push(s);
  }

  const lines = sibs.map((s) => {
    const id = s.session_id.slice(0, 8);
    const isOverlap = overlapping.some((o) => o.session_id === s.session_id);
    const marker = isOverlap ? " *POTENTIAL OVERLAP*" : "";
    const task = s.current_task ? `: ${s.current_task.slice(0, 80)}` : ": (no task set)";
    return `  - ${id}${marker}${task}`;
  });

  let block = `[orch] ${sibs.length} sibling session${sibs.length > 1 ? "s" : ""} active:\n${lines.join("\n")}`;
  if (overlapping.length > 0) {
    const ids = overlapping.map((o) => o.session_id.slice(0, 8)).join(", ");
    block += `\n  -> Coordinate with ${ids} via send_message BEFORE starting work in their area. Shared scope is the most common cause of merge conflicts and contradictory decisions across sessions.`;
  }
  return block;
}

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","else","is","are","was","were","be","been",
  "have","has","had","do","does","did","will","would","could","should","may","might","must",
  "to","of","in","on","at","for","with","from","by","as","into","onto","that","this","these",
  "those","it","its","i","you","we","they","he","she","them","us","my","your","our","their",
  "what","when","where","why","how","which","who","whom","not","no","yes","so","just","also",
  "very","really","still","only","ever","never","more","less","most","least","some","any",
  "all","none","each","every","one","two","new","old","make","made","get","got","let","lets",
  "want","need","like","want","try","run","use","using","add","fix","update","check","take",
  "show","see","look","know","think","tell","ask","help","work","working","done","ok","okay",
  "now","up","down","out","back","over","under","again","much","many","few","next","last",
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

function countFreshSurfaced(db: Database, sessionId: string): number {
  const row = db
    .query(
      `SELECT COUNT(DISTINCT note_id) as cnt FROM session_log
       WHERE session_id = ? AND delivery_type = 'fresh'`
    )
    .get(sessionId) as { cnt: number } | null;
  return row?.cnt ?? 0;
}

function buildStopSessionNudge(db: Database, sessionId: string): string {
  const fresh = countFreshSurfaced(db, sessionId);
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

  return `\n\n### Notes this session surfaced that you may not have maintained (${fresh} total):${formatted}${moreHint}\n\nFor each: was it still correct? If not, call update_note / supersede_note. Is the thread/question settled? Call close_thread.`;
}

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
  // Surface in-progress work items the session is plausibly responsible for:
  // either I created them (source_session = me) OR I surfaced them via lookup
  // this session (session_log). Capped at 5 for prompt budget.
  return db
    .query(
      `SELECT DISTINCT n.id, n.status, n.content
       FROM notes n
       WHERE n.type = 'work_item'
         AND COALESCE(n.status, '') NOT IN ('done', 'cancelled', 'completed')
         AND (
           n.source_session = ?
           OR EXISTS (SELECT 1 FROM session_log sl WHERE sl.session_id = ? AND sl.note_id = n.id)
         )
       ORDER BY COALESCE(n.signal, 0) DESC, n.updated_at DESC
       LIMIT 5`
    )
    .all(sessionId, sessionId) as InFlightWorkItem[];
}

const APPROVAL_REGEX =
  /\b(looks?\s+good|ship\s+it|perfect|great|all\s+good|nailed\s+it|works?(\s+now)?|yep|done|sweet|approved?|lgtm|nice|thanks?|thank\s+you|that('?s| is)\s+(it|right))\b/i;

function userPromptSignalsApproval(prompt: string): boolean {
  if (!prompt) return false;
  // Only detect on short prompts (<300 chars). Long prompts that happen to
  // contain "looks good" in unrelated context shouldn't trigger.
  if (prompt.length > 300) return false;
  return APPROVAL_REGEX.test(prompt);
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
