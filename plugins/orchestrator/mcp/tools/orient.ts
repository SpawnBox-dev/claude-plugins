import type { Database } from "bun:sqlite";
import type { Briefing, Note } from "../types";
import { composeBriefing } from "../engine/composer";
import { summarizeForBriefing } from "../utils";

export interface OrientInput {
  event: "startup" | "resume" | "clear" | "compact";
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

function formatBriefing(
  briefing: Briefing,
  checkpoint: Note | null,
  globalPatterns: string[],
  event: string
): string {
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

  if (checkpoint) {
    lines.push("## Recovery Checkpoint");
    lines.push(checkpoint.content);
    lines.push("");
  }

  if (briefing.open_threads.length > 0) {
    lines.push("## Open Threads");
    lines.push(summarizeForBriefing(briefing.open_threads));
    lines.push("");
  }

  if (briefing.recent_decisions.length > 0) {
    lines.push("## Recent Decisions");
    lines.push(summarizeForBriefing(briefing.recent_decisions));
    lines.push("");
  }

  if (briefing.neglected_areas.length > 0) {
    lines.push("## Neglected Areas");
    lines.push(briefing.neglected_areas.map((a) => `- ${a}`).join("\n"));
    lines.push("");
  }

  if (briefing.drift_warning) {
    lines.push(`## Drift Warning`);
    lines.push(briefing.drift_warning);
    lines.push("");
  }

  if (briefing.user_model_summary.length > 0) {
    lines.push("## User Patterns");
    lines.push(briefing.user_model_summary.map((s) => `- ${s}`).join("\n"));
    lines.push("");
  }

  if (globalPatterns.length > 0) {
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
  const briefing = composeBriefing(projectDb, globalDb);

  // Always fetch checkpoint - it provides continuity across sessions
  const checkpoint = fetchLatestCheckpoint(projectDb);
  const globalPatterns = fetchGlobalPatterns(globalDb);
  const formatted = formatBriefing(briefing, checkpoint, globalPatterns, input.event);

  return { briefing, recovery_checkpoint: checkpoint, formatted };
}
