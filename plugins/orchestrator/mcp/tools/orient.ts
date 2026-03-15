import type { Database } from "bun:sqlite";
import type { Briefing, BriefingSection, Note, NoteSummary } from "../types";
import { composeBriefing } from "../engine/composer";
import { summarizeForBriefing, relativeTime, truncate } from "../utils";

export interface OrientInput {
  event: "startup" | "resume" | "clear" | "compact";
  sections?: BriefingSection[];
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
                source AS source_conversation
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
      superseded_by: null,
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
        lines.push(`- \u26a0\ufe0f ${pri} **${item.id}** ${truncate(item.content, 120)}${formatDueDate(item.due_date)}`);
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
          lines.push(`- ${status} ${pri} **${item.id}** ${truncate(item.content, 120)}${due}`);
        }
        lines.push("");
      }
      if (briefing.blocked_work.length > 0) {
        lines.push("### Blocked");
        for (const item of briefing.blocked_work) {
          const pri = item.priority ? `[${item.priority.toUpperCase()}]` : "";
          lines.push(`- \ud83d\udeab ${pri} **${item.id}** ${truncate(item.content, 120)}`);
        }
        lines.push("");
      }
    }

    if (briefing.recently_completed.length > 0) {
      lines.push("## Recently Completed");
      for (const item of briefing.recently_completed) {
        lines.push(`- \u2705 **${item.id}** ${truncate(item.content, 120)}`);
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
  input: OrientInput
): OrientResult {
  const briefing = composeBriefing(projectDb, globalDb, input.sections);

  const include = (section: BriefingSection) =>
    !input.sections || input.sections.length === 0 || input.sections.includes(section);

  // Always fetch checkpoint - it provides continuity across sessions
  const checkpoint = include("checkpoint") ? fetchLatestCheckpoint(projectDb) : null;
  const globalPatterns = include("cross_project") ? fetchGlobalPatterns(globalDb) : [];
  const formatted = formatBriefing(briefing, checkpoint, globalPatterns, input.event, input.sections);

  return { briefing, recovery_checkpoint: checkpoint, formatted };
}
