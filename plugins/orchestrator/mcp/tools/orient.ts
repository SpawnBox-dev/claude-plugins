import type { Database } from "bun:sqlite";
import type { Briefing, BriefingSection, Note, NoteSummary } from "../types";
import { composeBriefing } from "../engine/composer";
import { summarizeForBriefing, relativeTime, truncate } from "../utils";
import type { SessionTracker } from "../engine/session_tracker";
import { handleReflect } from "./reflect";

// R4.4: auto-retro gate. If the last retro maintenance pass is older than this
// interval (or has never run), handleOrient will inline-invoke handleReflect at
// session startup. This makes the KB maintenance pass non-optional: stale
// signal, duplicates, and orphan notes get swept even when the user forgets to
// call retro manually.
const AUTO_RETRO_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function shouldAutoRetro(projectDb: Database): boolean {
  try {
    const row = projectDb
      .query("SELECT value FROM plugin_state WHERE key = 'last_retro_run_at'")
      .get() as { value: string } | null;
    if (!row) return true; // never run; trigger
    const lastRun = new Date(row.value);
    if (Number.isNaN(lastRun.getTime())) return true; // malformed; trigger
    return Date.now() - lastRun.getTime() > AUTO_RETRO_INTERVAL_MS;
  } catch {
    return false; // table missing or query failed; don't block briefing
  }
}

function recordAutoRetroRun(projectDb: Database): void {
  const ts = new Date().toISOString();
  projectDb.run(
    `INSERT INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ['last_retro_run_at', ts, ts]
  );
}

export interface OrientInput {
  event: "startup" | "resume" | "clear" | "compact";
  sections?: BriefingSection[];
  /** Session ID for cross-session discovery injection. When provided, the
   *  briefing includes notes that other active sessions have created or
   *  been heavily surfacing since the caller's last briefing. */
  session_id?: string;
}

export interface OrientResult {
  briefing: Briefing;
  recovery_checkpoint: Note | null;
  formatted: string;
}

function fetchLatestCheckpoint(db: Database): Note | null {
  try {
    const row = db
      .query(
        `SELECT id, type, content, keywords, confidence, created_at, updated_at,
                source AS source_conversation, source_session, superseded_by, superseded_at
         FROM notes
         WHERE type = 'checkpoint'
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get() as any | null;

    if (!row) return null;

    return {
      id: row.id,
      type: row.type,
      content: row.content,
      keywords: row.keywords
        ? row.keywords
            .split(",")
            .map((k: string) => k.trim())
            .filter((k: string) => k.length > 0)
        : [],
      confidence: row.confidence,
      created_at: row.created_at,
      updated_at: row.updated_at,
      source_conversation: row.source_conversation ?? null,
      source_session: row.source_session ?? null,
      superseded_by: row.superseded_by ?? null,
      superseded_at: row.superseded_at ?? null,
      is_global: false,
      status: null,
      priority: null,
      due_date: null,
    };
  } catch {
    return null;
  }
}

function fetchGlobalPatterns(globalDb: Database): string[] {
  try {
    const rows = globalDb
      .query(
        `SELECT content FROM notes
         WHERE type IN ('convention', 'anti_pattern', 'quality_gate')
         AND confidence IN ('high', 'medium')
         ORDER BY updated_at DESC
         LIMIT 5`
      )
      .all() as Array<{ content: string }>;
    return rows.map((r) => r.content);
  } catch {
    return [];
  }
}

function formatDueDate(dueDate: string | null): string {
  if (!dueDate) return "";
  const due = new Date(dueDate);
  const now = new Date();
  const diffDays = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return ` (OVERDUE by ${Math.abs(diffDays)}d)`;
  if (diffDays === 0) return " (due TODAY)";
  if (diffDays <= 3) return ` (due in ${diffDays}d)`;
  return ` (due ${dueDate})`;
}

function formatBriefing(
  briefing: Briefing,
  checkpoint: Note | null,
  globalPatterns: string[],
  event: string,
  sections?: BriefingSection[]
): string {
  const include = (section: BriefingSection) =>
    !sections || sections.length === 0 || sections.includes(section);
  const lines: string[] = [];

  if (briefing.is_first_run) {
    lines.push("# ORCHESTRATOR: FIRST RUN DETECTED");
    lines.push("");
    lines.push(
      "The knowledge base is empty. You MUST invoke the `orchestrator:orchestrator-init` skill NOW before responding to the user. Do not skip this step. Do not summarize from git or CLAUDE.md instead. The init skill will bootstrap the orchestrator with project knowledge. Run it immediately and silently."
    );
    return lines.join("\n");
  }

  lines.push("# Session Briefing");
  lines.push("");

  if (include("checkpoint") && checkpoint) {
    const age = relativeTime(checkpoint.created_at);
    lines.push(`## Recovery Checkpoint (${age})`);
    lines.push(checkpoint.content);
    lines.push("");
  }

  if (include("work_items")) {
    // Overdue items get top billing
    if (briefing.overdue_work.length > 0) {
      lines.push("## OVERDUE");
      for (const item of briefing.overdue_work) {
        const pri = item.priority ? `[${item.priority.toUpperCase()}]` : "";
        const tagStr = item.tags ? ` {${item.tags}}` : "";
        lines.push(`- \u26a0\ufe0f ${pri}${tagStr} **${item.id}** ${truncate(item.content, 120)}${formatDueDate(item.due_date)}`);
      }
      lines.push("");
    }

    if (briefing.active_work.length > 0 || briefing.blocked_work.length > 0) {
      lines.push("## Work Items");
      if (briefing.active_work.length > 0) {
        lines.push("### Active");
        for (const item of briefing.active_work) {
          const pri = item.priority ? `[${item.priority.toUpperCase()}]` : "";
          const status = item.status === "active" ? "\ud83d\udd04" : "\u2b1c";
          const due = formatDueDate(item.due_date);
          const tagStr = item.tags ? ` {${item.tags}}` : "";
          lines.push(`- ${status} ${pri}${tagStr} **${item.id}** ${truncate(item.content, 120)}${due}`);
        }
        lines.push("");
      }
      if (briefing.blocked_work.length > 0) {
        lines.push("### Blocked");
        for (const item of briefing.blocked_work) {
          const pri = item.priority ? `[${item.priority.toUpperCase()}]` : "";
          const tagStr = item.tags ? ` {${item.tags}}` : "";
          lines.push(`- \ud83d\udeab ${pri}${tagStr} **${item.id}** ${truncate(item.content, 120)}`);
        }
        lines.push("");
      }
    }

    if (briefing.recently_completed.length > 0) {
      lines.push("## Recently Completed");
      for (const item of briefing.recently_completed) {
        const tagStr = item.tags ? ` {${item.tags}}` : "";
        lines.push(`- \u2705${tagStr} **${item.id}** ${truncate(item.content, 120)}`);
      }
      lines.push("");
    }
  }

  if (include("open_threads") && briefing.open_threads.length > 0) {
    lines.push("## Open Threads");
    lines.push(summarizeForBriefing(briefing.open_threads));
    lines.push("");
  }

  if (include("decisions") && briefing.recent_decisions.length > 0) {
    lines.push("## Recent Decisions");
    lines.push(summarizeForBriefing(briefing.recent_decisions));
    lines.push("");
  }

  if (include("neglected") && briefing.neglected_areas.length > 0) {
    lines.push("## Neglected Areas");
    lines.push(briefing.neglected_areas.map((a) => `- ${a}`).join("\n"));
    lines.push("");
  }

  if (include("drift") && briefing.drift_warning) {
    lines.push(`## Drift Warning`);
    lines.push(briefing.drift_warning);
    lines.push("");
  }

  if (include("user_model")) {
    if (briefing.user_profile.length > 0) {
      lines.push("## User Profile");
      // Group by dimension
      const byDim = new Map<string, typeof briefing.user_profile>();
      for (const entry of briefing.user_profile) {
        const existing = byDim.get(entry.dimension) ?? [];
        existing.push(entry);
        byDim.set(entry.dimension, existing);
      }
      for (const [dim, entries] of byDim) {
        const label = dim.replace(/_/g, " ");
        for (const entry of entries.slice(0, 4)) {
          const traj = entry.trajectory !== "stable" ? ` (${entry.trajectory})` : "";
          const conf = entry.confidence === "high" ? "" : ` [${entry.confidence}]`;
          lines.push(`- **${label}**${conf}: ${entry.observation}${traj}`);
        }
      }
      lines.push("");
    } else if (briefing.user_model_summary.length > 0) {
      lines.push("## User Patterns");
      lines.push(briefing.user_model_summary.map((s) => `- ${s}`).join("\n"));
      lines.push("");
    }
  }

  if (include("cross_project") && globalPatterns.length > 0) {
    lines.push("## Cross-Project Patterns");
    lines.push(globalPatterns.map((p) => `- ${p}`).join("\n"));
    lines.push("");
  }

  // R3.3: maintenance-worthy notes. Shown with the actual tool calls the agent
  // should use to resolve - this keeps the briefing actionable, not just a
  // passive log of "stuff that looks old".
  if (include("curation_candidates") && briefing.curation_candidates.length > 0) {
    lines.push("## Curation Candidates (notes worth reviewing)");
    for (const c of briefing.curation_candidates) {
      const reasonTag = c.reason === "stale_but_surfaced"
        ? `stale ${c.stale_age_days}d`
        : "low confidence";
      const contentPreview = c.note.content.length > 120
        ? c.note.content.slice(0, 120) + "..."
        : c.note.content;
      lines.push(`- **${c.note.id}** [${c.note.type}, ${reasonTag}, signal:${c.signal.toFixed(1)}] ${contentPreview}`);
      lines.push(`  [maintain: update_note({id:"${c.note.id}"}) | supersede_note({old_id:"${c.note.id}"}) | delete_note({id:"${c.note.id}"})]`);
    }
    lines.push("");
  }

  if (include("cross_session") && briefing.cross_session) {
    const xs = briefing.cross_session;
    const hasAnything = xs.new_notes.length > 0 || xs.hot_notes.length > 0;
    if (hasAnything) {
      lines.push(`## Cross-Session Activity (${xs.active_session_count} other active session${xs.active_session_count === 1 ? "" : "s"})`);
      if (xs.new_notes.length > 0) {
        lines.push("### New since your last briefing");
        for (const n of xs.new_notes) {
          const tagStr = n.tags ? ` {${n.tags}}` : "";
          const age = relativeTime(n.created_at);
          lines.push(`- [${n.type}]${tagStr} **${n.id}** (${age}) ${truncate(n.content, 140)}`);
        }
        lines.push("");
      }
      if (xs.hot_notes.length > 0) {
        lines.push("### Hot across sessions (surfaced by 2+ others in last 2h)");
        for (const n of xs.hot_notes) {
          const tagStr = n.tags ? ` {${n.tags}}` : "";
          lines.push(`- [${n.type}]${tagStr} **${n.id}** (${n.distinct_sessions} sessions, ${n.surfacings}x) ${truncate(n.content, 140)}`);
        }
        lines.push("");
      }
    }
  }

  if (briefing.suggested_focus) {
    lines.push(`**Suggested focus:** ${briefing.suggested_focus}`);
    lines.push(`**Intensity:** ${briefing.suggested_intensity}`);
    lines.push("");
  }

  // Behavioral reminders based on event type
  if (event === "compact") {
    lines.push("---");
    lines.push("*Context was just compacted. Review the checkpoint above carefully. If anything is unclear, use `recall` to search for more context before proceeding.*");
    lines.push("");
  }

  return lines.join("\n");
}

export function handleOrient(
  projectDb: Database,
  globalDb: Database,
  input: OrientInput,
  sessionTracker?: SessionTracker | null
): OrientResult {
  // R4.4: auto-retro gate. Only fires on session startup (not resume/clear/
  // compact). If retro is stale or has never run, invoke it inline and update
  // the cursor. Any failure is swallowed - briefing must still return.
  let autoRetroSummary: string | null = null;
  if (input.event === "startup" && shouldAutoRetro(projectDb)) {
    try {
      const retroResult = handleReflect(projectDb, globalDb, {});
      autoRetroSummary = retroResult.message || "Retro maintenance ran.";
      recordAutoRetroRun(projectDb);
    } catch (err) {
      console.error("[orient] auto-retro failed", err);
      // Non-fatal; briefing continues
    }
  }

  const briefing = composeBriefing(projectDb, globalDb, input.sections);

  const include = (section: BriefingSection) =>
    !input.sections || input.sections.length === 0 || input.sections.includes(section);

  // Always fetch checkpoint - it provides continuity across sessions
  const checkpoint = include("checkpoint") ? fetchLatestCheckpoint(projectDb) : null;
  const globalPatterns = include("cross_project") ? fetchGlobalPatterns(globalDb) : [];

  // Cross-session updates: read BEFORE we update the last_briefing_at cursor
  // so "since your last briefing" is computed against the stable old value.
  // Capture readAt BEFORE the query and pass the SAME timestamp to both the
  // query's upper bound and to updateLastBriefing, closing the read/write
  // cursor race: any note with created_at in (old_cursor, readAt] is
  // visible, and any note with created_at > readAt is NOT missed because
  // the cursor hasn't moved past it.
  const readAt = new Date().toISOString();
  if (include("cross_session") && sessionTracker && input.session_id) {
    try {
      briefing.cross_session = sessionTracker.getCrossSessionUpdates(
        input.session_id,
        readAt
      );
    } catch (err) {
      console.error(`[orient] cross-session update fetch failed:`, err);
      crossSessionHealthy = false;
      crossSessionLastError = String(err);
    }
  }

  let formatted = formatBriefing(briefing, checkpoint, globalPatterns, input.event, input.sections);

  // R4.4: surface auto-retro result at the top of the briefing when it fired.
  // The briefing already begins with the "# Session Briefing" header; prepending
  // an "## Auto-Retro" section before any other content makes it prominent but
  // non-blocking (other sections still render unchanged).
  if (autoRetroSummary && !briefing.is_first_run) {
    formatted = `## Auto-Retro\n${autoRetroSummary}\n\n${formatted}`;
  }

  // Advance the cursor to EXACTLY the same readAt we just queried against.
  if (sessionTracker && input.session_id) {
    try {
      sessionTracker.updateLastBriefing(input.session_id, readAt);
    } catch {
      // non-fatal
    }
  }

  return { briefing, recovery_checkpoint: checkpoint, formatted };
}

// Module-level cross-session health flags (H3). Exposed via system_status
// so a silent migration or query failure is actually visible.
let crossSessionHealthy = true;
let crossSessionLastError: string | null = null;

export function getCrossSessionHealth(): { healthy: boolean; last_error: string | null } {
  return { healthy: crossSessionHealthy, last_error: crossSessionLastError };
}
