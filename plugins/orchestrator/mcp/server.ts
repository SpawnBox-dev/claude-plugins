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
  version: "0.1.0",
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
  "Search stored knowledge by query or retrieve a specific note by ID. Searches both project and global databases using full-text search with BM25 ranking. Use this before making decisions to check for existing context.",
  {
    query: z.string().optional(),
    id: z.string().optional(),
    type: z.enum(NOTE_TYPES).optional(),
    limit: z.number().optional(),
  },
  async ({ query, id, type, limit }) => {
    const result = handleRecall(getProjectDb(), getGlobalDb(), {
      query,
      id,
      type,
      limit,
    });
    let text = result.message;
    if (result.detail) {
      text += `\n\n**${result.detail.type}** (${result.detail.confidence})\n${result.detail.content}`;
      if (result.detail.links.length > 0) {
        text += "\n\nLinked notes:";
        for (const link of result.detail.links) {
          text += `\n- [${link.relationship}] ${link.note.content}`;
        }
      }
    } else if (result.results.length > 0) {
      text += "\n";
      for (const r of result.results) {
        text += `\n- [${r.type}/${r.confidence}] ${r.content}`;
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
