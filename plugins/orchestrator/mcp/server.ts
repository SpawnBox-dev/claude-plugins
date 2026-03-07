import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NOTE_TYPES } from "./types";
import { getProjectDb, getGlobalDb } from "./db/connection";
import { handleRemember } from "./tools/remember";
import { handleRecall } from "./tools/recall";
import { handleOrient } from "./tools/orient";
import { handlePrepare } from "./tools/prepare";
import { handleReflect } from "./tools/reflect";

const server = new McpServer({
  name: "orchestrator",
  version: "0.5.0",
});

// ── briefing ────────────────────────────────────────────────────────────
server.tool(
  "briefing",
  "Get up to speed on the current project. Returns open threads, recent decisions, neglected areas, and your last checkpoint so you can pick up where the previous session left off. Use at session start, after context compaction, or whenever you feel you're missing context about the project's state.",
  {
    event: z.enum(["startup", "resume", "clear", "compact"]).optional().default("startup"),
  },
  async ({ event }) => {
    const result = handleOrient(getProjectDb(), getGlobalDb(), { event: event ?? "startup" });
    return {
      content: [{ type: "text" as const, text: result.formatted }],
    };
  }
);

// ── note ────────────────────────────────────────────────────────────────
server.tool(
  "note",
  "Save a piece of knowledge you've just learned, decided, or observed. Use this the moment something noteworthy happens - a decision is made, a pattern is discovered, a gotcha is found, the user corrects you, or a convention is established. Don't batch these up; capture them immediately so future sessions benefit. The system auto-links related notes and detects duplicates.",
  {
    content: z.string(),
    type: z.enum(NOTE_TYPES),
    context: z.string().optional(),
    tags: z.string().optional(),
    scope: z.enum(["global", "project"]).optional(),
  },
  async ({ content, type, context, tags, scope }) => {
    const result = handleRemember(getProjectDb(), getGlobalDb(), {
      content,
      type,
      context,
      tags,
      scope,
    });
    return {
      content: [{ type: "text" as const, text: result.message }],
    };
  }
);

// ── lookup ──────────────────────────────────────────────────────────────
server.tool(
  "lookup",
  "Search what you already know. Use this before implementing anything, when you wonder 'has this been decided before?', when you encounter unfamiliar code, or when you want to check for existing conventions or anti-patterns. Searches both project and cross-project knowledge using full-text search with BM25 ranking.",
  {
    query: z.string().optional(),
    id: z.string().optional(),
    type: z.enum(NOTE_TYPES).optional(),
    limit: z.number().optional(),
    depth: z.number().min(1).max(5).optional(),
  },
  async ({ query, id, type, limit, depth }) => {
    const result = handleRecall(getProjectDb(), getGlobalDb(), {
      query,
      id,
      type,
      limit,
      depth,
    });
    let text = result.message;
    if (result.detail) {
      text += `\n\n**${result.detail.type}** (${result.detail.confidence})\n${result.detail.content}`;
      if (result.detail.links.length > 0) {
        text += "\n\nLinked notes:";
        for (const link of result.detail.links) {
          const indent = "  ".repeat(link.depth - 1);
          text += `\n${indent}- **${link.note.id}** [${link.relationship}] ${link.note.content}`;
        }
      }
    } else if (result.results.length > 0) {
      text += "\n";
      for (const r of result.results) {
        text += `\n- **${r.id}** [${r.type}/${r.confidence}] ${r.content}`;
      }
    }
    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ── plan ─────────────────────────────────────────────────────────────────
server.tool(
  "plan",
  "Gather domain-specific context before starting a complex task. Returns relevant conventions, anti-patterns, quality gates, architecture notes, and recent decisions so you don't contradict past work or re-learn solved problems. Use when facing multi-step work or entering an unfamiliar domain.",
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
  "Save your current progress so the next session can pick up seamlessly. Captures what you accomplished, what's still in flight, open questions, and suggested next steps. Use when finishing a task, completing a milestone, switching work streams, or before the session ends.",
  {
    summary: z.string().describe("What was accomplished and current state"),
    open_questions: z.array(z.string()).optional().describe("Unresolved questions"),
    next_steps: z.array(z.string()).optional().describe("What should happen next"),
    in_flight: z.string().optional().describe("Work currently in progress, if any"),
  },
  async ({ summary, open_questions, next_steps, in_flight }) => {
    const parts = [`## Work State\n${summary}`];
    if (in_flight) parts.push(`\n## In Flight\n${in_flight}`);
    if (open_questions?.length) parts.push(`\n## Open Questions\n${open_questions.map(q => `- ${q}`).join("\n")}`);
    if (next_steps?.length) parts.push(`\n## Next Steps\n${next_steps.map(s => `- ${s}`).join("\n")}`);

    const content = parts.join("\n");
    const result = handleRemember(getProjectDb(), getGlobalDb(), {
      content,
      type: "checkpoint",
      context: `Checkpoint created at ${new Date().toISOString()}`,
      tags: "checkpoint",
    });

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
  "Mark an open thread or commitment as resolved. Use when a tracked issue has been addressed, a question has been answered, or a commitment has been fulfilled. This keeps the knowledge base clean and prevents future sessions from revisiting solved problems.",
  {
    id: z.string(),
    resolution: z.string().optional(),
  },
  async ({ id, resolution }) => {
    const projectDb = getProjectDb();
    const globalDb = getGlobalDb();

    // Try project DB first, then global
    let db = projectDb;
    let row = db
      .query(`SELECT id, type, content FROM notes WHERE id = ?`)
      .get(id) as { id: string; type: string; content: string } | null;

    if (!row) {
      db = globalDb;
      row = db
        .query(`SELECT id, type, content FROM notes WHERE id = ?`)
        .get(id) as { id: string; type: string; content: string } | null;
    }

    if (!row) {
      return {
        content: [
          { type: "text" as const, text: `No note found with id "${id}".` },
        ],
      };
    }

    const timestamp = new Date().toISOString();
    db.run(
      `UPDATE notes SET resolved = 1, updated_at = ? WHERE id = ?`,
      [timestamp, id]
    );

    // If resolution context provided, store it as a decision note
    if (resolution) {
      const { handleRemember } = await import("./tools/remember");
      handleRemember(projectDb, globalDb, {
        content: resolution,
        type: "decision",
        context: `Resolved ${row.type}: ${row.content}`,
        tags: row.type,
      });
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Resolved ${row.type} note "${id}".${resolution ? " Decision recorded." : ""}`,
        },
      ],
    };
  }
);

// ── retro ───────────────────────────────────────────────────────────────
server.tool(
  "retro",
  "Run maintenance on the knowledge base and analyze what's working. Decays confidence on stale notes, merges duplicates, identifies orphans, queues notes for revalidation, and computes autonomy scores across domains. Use after a debugging session, when an approach failed, or periodically to keep knowledge fresh.",
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
    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ── Start server ────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
