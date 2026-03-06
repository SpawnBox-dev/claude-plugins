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

function formatBriefing(briefing: Briefing, checkpoint: Note | null): string {
  const lines: string[] = [];

  if (briefing.is_first_run) {
    lines.push("# Welcome to Orchestrator");
    lines.push("");
    lines.push(
      "This is a fresh project with no stored knowledge yet. Run `/orchestrator-init` to bootstrap the knowledge base."
    );
    return lines.join("\n");
  }

  lines.push("# Session Briefing");
  lines.push("");

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

  if (briefing.suggested_focus) {
    lines.push(`**Suggested focus:** ${briefing.suggested_focus}`);
    lines.push(`**Intensity:** ${briefing.suggested_intensity}`);
    lines.push("");
  }

  if (checkpoint) {
    lines.push("## Recovery Checkpoint");
    lines.push(checkpoint.content);
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

  let checkpoint: Note | null = null;
  if (input.event === "compact" || input.event === "clear") {
    checkpoint = fetchLatestCheckpoint(projectDb);
  }

  const formatted = formatBriefing(briefing, checkpoint);

  return { briefing, recovery_checkpoint: checkpoint, formatted };
}
