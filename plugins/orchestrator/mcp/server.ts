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
  version: "0.3.3",
});

// ── orient ──────────────────────────────────────────────────────────────
server.tool(
  "orient",
  "Get a session briefing with open threads, recent decisions, neglected areas, and drift warnings. Call this at the start of every conversation or when resuming work to understand current project state.",
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

// ── remember ────────────────────────────────────────────────────────────
server.tool(
  "remember",
  "Store a piece of knowledge - decisions, insights, conventions, risks, architecture notes, open threads, or patterns. The system auto-links related notes, detects duplicates, and routes global knowledge (user patterns, tool capabilities) to the cross-project database.",
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

// ── recall ──────────────────────────────────────────────────────────────
server.tool(
  "recall",
  "Search stored knowledge by query or retrieve a specific note by ID. Searches both project and global databases using full-text search with BM25 ranking. Use depth > 1 to traverse the knowledge graph for progressive disclosure.",
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

// ── prepare ─────────────────────────────────────────────────────────────
server.tool(
  "prepare",
  "Gather domain-specific context before starting a task. Returns relevant conventions, anti-patterns, quality gates, architecture notes, and recent decisions for the inferred or specified domain (frontend, backend, cloud, infra, testing, discord).",
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

// ── checkpoint ──────────────────────────────────────────────────────────
server.tool(
  "checkpoint",
  "Create a checkpoint capturing current work state. MUST be called before context compaction and at the end of sessions. Captures summary, open questions, and next steps so the next session can pick up seamlessly.",
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
          ? `Checkpoint saved (${result.note_id}). Next session will recover from here.`
          : `Checkpoint updated (existing checkpoint promoted).`,
      }],
    };
  }
);

// ── resolve ─────────────────────────────────────────────────────────────
server.tool(
  "resolve",
  "Mark an open_thread or commitment as resolved. Use this when a thread has been addressed or a commitment fulfilled.",
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

// ── reflect ─────────────────────────────────────────────────────────────
server.tool(
  "reflect",
  "Run maintenance on the knowledge base: decay confidence on stale notes, identify orphan notes with no links, queue low-confidence notes for revalidation, and compute autonomy scores across domains. Call periodically to keep knowledge fresh.",
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
