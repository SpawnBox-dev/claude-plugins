import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  NOTE_TYPES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_PRIORITIES,
  RELATIONSHIP_TYPES,
  BRIEFING_SECTIONS,
  DIMENSIONS,
} from "./types";
import type { WorkItemStatus, Dimension } from "./types";
import { getProjectDb, getGlobalDb } from "./db/connection";
import { handleRemember } from "./tools/remember";
import { handleRecall } from "./tools/recall";
import { handleOrient } from "./tools/orient";
import { handlePrepare } from "./tools/prepare";
import { handleReflect } from "./tools/reflect";
import { composeUserProfile } from "./engine/composer";
import { generateId, now, extractKeywords } from "./utils";
import { createAutoLinks } from "./engine/linker";

const server = new McpServer({
  name: "orchestrator",
  version: "0.9.0",
});

// ── briefing ────────────────────────────────────────────────────────────
server.tool(
  "briefing",
  "Get up to speed on the current project. Returns open threads, recent decisions, work items, user profile, neglected areas, and your last checkpoint. Use at session start, after context compaction, or whenever you feel you're missing context. Pass `sections` to reduce context cost when you only need specific info.",
  {
    event: z.enum(["startup", "resume", "clear", "compact"]).optional().default("startup"),
    sections: z
      .array(z.enum(BRIEFING_SECTIONS))
      .optional()
      .describe("Filter to specific sections. Omit for full briefing. Options: work_items, open_threads, decisions, neglected, drift, user_model, cross_project, checkpoint"),
  },
  async ({ event, sections }) => {
    const result = handleOrient(getProjectDb(), getGlobalDb(), {
      event: event ?? "startup",
      sections: sections ?? undefined,
    });
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
    dimension: z
      .enum(DIMENSIONS)
      .optional()
      .describe("For user_pattern notes: explicitly set the dimension instead of relying on auto-inference"),
  },
  async ({ content, type, context, tags, scope, dimension }) => {
    const result = handleRemember(getProjectDb(), getGlobalDb(), {
      content,
      type,
      context,
      tags,
      scope,
      dimension: dimension as Dimension | undefined,
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
  "Mark an open thread, commitment, or work item as resolved/done. Cascades through the knowledge graph: unblocks blocked items, auto-completes parents when all children are done, auto-resolves superseded notes. Use when a tracked issue has been addressed, a question answered, a commitment fulfilled, or a task completed.",
  {
    id: z.string(),
    resolution: z.string().optional(),
  },
  async ({ id, resolution }) => {
    const projectDb = getProjectDb();
    const globalDb = getGlobalDb();

    let db = projectDb;
    let row = db
      .query(`SELECT id, type, content, status FROM notes WHERE id = ?`)
      .get(id) as { id: string; type: string; content: string; status: string | null } | null;

    if (!row) {
      db = globalDb;
      row = db
        .query(`SELECT id, type, content, status FROM notes WHERE id = ?`)
        .get(id) as { id: string; type: string; content: string; status: string | null } | null;
    }

    if (!row) {
      return {
        content: [{ type: "text" as const, text: `No note found with id "${id}".` }],
      };
    }

    const timestamp = new Date().toISOString();

    if (row.type === "work_item") {
      db.run(
        `UPDATE notes SET resolved = 1, status = 'done', updated_at = ? WHERE id = ?`,
        [timestamp, id]
      );
    } else {
      db.run(
        `UPDATE notes SET resolved = 1, updated_at = ? WHERE id = ?`,
        [timestamp, id]
      );
    }

    const cascadeResults = cascadeResolution(db, id, timestamp);

    if (resolution) {
      handleRemember(projectDb, globalDb, {
        content: resolution,
        type: "decision",
        context: `Resolved ${row.type}: ${row.content}`,
        tags: row.type,
      });
    }

    let message = `Resolved ${row.type} note "${id}".`;
    if (resolution) message += " Decision recorded.";
    if (cascadeResults.length > 0) {
      message += "\n\nCascade effects:\n" + cascadeResults.map(r => `- ${r}`).join("\n");
    }

    return {
      content: [{ type: "text" as const, text: message }],
    };
  }
);

// ── update_note ─────────────────────────────────────────────────────────
server.tool(
  "update_note",
  "Modify an existing note's content, context, or tags. Use when knowledge evolves, a preference changes, or a note needs correction. Preserves the note's ID, creation date, and links. Re-indexes keywords for search.",
  {
    id: z.string(),
    content: z.string().optional().describe("New content (replaces existing)"),
    context: z.string().optional().describe("New context (replaces existing)"),
    tags: z.string().optional().describe("New tags (replaces existing)"),
    confidence: z.enum(["low", "medium", "high"]).optional(),
  },
  async ({ id, content, context, tags, confidence }) => {
    const projectDb = getProjectDb();
    const globalDb = getGlobalDb();

    let db = projectDb;
    let row = db.query(`SELECT id, type, content, context, tags, keywords FROM notes WHERE id = ?`)
      .get(id) as any | null;

    if (!row) {
      db = globalDb;
      row = db.query(`SELECT id, type, content, context, tags, keywords FROM notes WHERE id = ?`)
        .get(id) as any | null;
    }

    if (!row) {
      return { content: [{ type: "text" as const, text: `No note found with id "${id}".` }] };
    }

    const updates: string[] = [];
    const timestamp = now();

    const newContent = content ?? row.content;
    const newContext = context ?? row.context;

    if (content) updates.push("content");
    if (context !== undefined) updates.push("context");
    if (tags !== undefined) updates.push("tags");
    if (confidence) updates.push("confidence");

    if (updates.length === 0) {
      return { content: [{ type: "text" as const, text: "No fields to update." }] };
    }

    // Re-extract keywords if content or context changed
    const newKeywords = (content || context !== undefined)
      ? extractKeywords([newContent, newContext].filter(Boolean).join(" "))
      : null;

    db.run(
      `UPDATE notes SET
        content = ?,
        context = ?,
        tags = ?,
        keywords = ?,
        confidence = ?,
        last_validated = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        newContent,
        newContext ?? null,
        tags ?? row.tags,
        newKeywords ? newKeywords.join(",") : row.keywords,
        confidence ?? row.confidence ?? "medium",
        timestamp,
        timestamp,
        id,
      ]
    );

    return {
      content: [{
        type: "text" as const,
        text: `Updated note "${id}" (${updates.join(", ")} changed).`,
      }],
    };
  }
);

// ── delete_note ─────────────────────────────────────────────────────────
server.tool(
  "delete_note",
  "Permanently delete a note from the knowledge base. Use when a note is wrong, outdated, or no longer relevant. Links to/from this note are also removed (CASCADE). Prefer close_thread for resolving issues - use delete_note only for genuinely incorrect or harmful knowledge.",
  {
    id: z.string(),
    reason: z.string().optional().describe("Why this note is being deleted"),
  },
  async ({ id, reason }) => {
    const projectDb = getProjectDb();
    const globalDb = getGlobalDb();

    let db = projectDb;
    let row = db.query(`SELECT id, type, content FROM notes WHERE id = ?`)
      .get(id) as { id: string; type: string; content: string } | null;

    if (!row) {
      db = globalDb;
      row = db.query(`SELECT id, type, content FROM notes WHERE id = ?`)
        .get(id) as { id: string; type: string; content: string } | null;
    }

    if (!row) {
      return { content: [{ type: "text" as const, text: `No note found with id "${id}".` }] };
    }

    // Delete links first (in case CASCADE doesn't fire)
    db.run(`DELETE FROM links WHERE from_note_id = ? OR to_note_id = ?`, [id, id]);
    db.run(`DELETE FROM notes WHERE id = ?`, [id]);

    const reasonStr = reason ? ` Reason: ${reason}` : "";
    return {
      content: [{
        type: "text" as const,
        text: `Deleted ${row.type} note "${id}".${reasonStr}`,
      }],
    };
  }
);

// ── user_profile ────────────────────────────────────────────────────────
server.tool(
  "user_profile",
  "View or update the structured user profile. Shows all learned observations about the user grouped by dimension (preferences, communication style, decision patterns, strengths, blind spots, intent). Use to understand the user better or to explicitly record a user trait.",
  {
    action: z.enum(["view", "set", "remove"]).optional().default("view"),
    dimension: z.enum(DIMENSIONS).optional().describe("Which dimension to set/remove"),
    observation: z.string().optional().describe("The observation to record (for 'set' action)"),
    id: z.string().optional().describe("ID of user_model entry to remove (for 'remove' action)"),
  },
  async ({ action, dimension, observation, id }) => {
    const globalDb = getGlobalDb();

    if (action === "view") {
      const profile = composeUserProfile(globalDb);
      let text = "# User Profile\n\n";
      if (profile.entries.length === 0) {
        text += "No user profile data yet. Observations are captured automatically from `user_pattern` notes and can be set explicitly with `user_profile({ action: 'set', ... })`.";
      } else {
        text += profile.summary;
        text += `\n\n*${profile.entries.length} total observations across ${new Set(profile.entries.map(e => e.dimension)).size} dimensions*`;
      }
      return { content: [{ type: "text" as const, text }] };
    }

    if (action === "set") {
      if (!dimension || !observation) {
        return { content: [{ type: "text" as const, text: "Both `dimension` and `observation` are required for 'set' action." }] };
      }

      const timestamp = now();

      // Check for existing observation in this dimension with same content
      const existing = globalDb
        .query(`SELECT id FROM user_model WHERE dimension = ? AND observation = ?`)
        .get(dimension, observation) as { id: string } | null;

      if (existing) {
        globalDb.run(
          `UPDATE user_model SET confidence = 'high', updated_at = ? WHERE id = ?`,
          [timestamp, existing.id]
        );
        return { content: [{ type: "text" as const, text: `Promoted existing observation confidence to high.` }] };
      }

      globalDb.run(
        `INSERT INTO user_model (id, dimension, observation, evidence, confidence, trajectory, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [generateId(), dimension, observation, "", "high", "stable", timestamp, timestamp]
      );

      return { content: [{ type: "text" as const, text: `Recorded ${dimension}: "${observation}"` }] };
    }

    if (action === "remove") {
      if (!id) {
        return { content: [{ type: "text" as const, text: "`id` is required for 'remove' action. Use `user_profile({ action: 'view' })` to see entries." }] };
      }

      const row = globalDb.query(`SELECT id, dimension, observation FROM user_model WHERE id = ?`)
        .get(id) as { id: string; dimension: string; observation: string } | null;

      if (!row) {
        return { content: [{ type: "text" as const, text: `No user_model entry found with id "${id}".` }] };
      }

      globalDb.run(`DELETE FROM user_model WHERE id = ?`, [id]);
      return { content: [{ type: "text" as const, text: `Removed ${row.dimension}: "${row.observation}"` }] };
    }

    return { content: [{ type: "text" as const, text: "Unknown action." }] };
  }
);

// ── create_work_item ────────────────────────────────────────────────────
server.tool(
  "create_work_item",
  "Create a trackable work item (task/todo). Work items persist across sessions and appear in the briefing. Use for concrete tasks that need to be done - not strategic questions (use open_thread for those). Supports priority, status, due dates, and parent relationships for breaking down larger work.",
  {
    content: z.string().describe("What needs to be done - be specific and actionable"),
    priority: z.enum(WORK_ITEM_PRIORITIES).optional().default("medium"),
    status: z.enum(WORK_ITEM_STATUSES).optional().default("planned"),
    parent_id: z.string().optional().describe("ID of parent work_item this belongs to (creates part_of link)"),
    due_date: z.string().optional().describe("Due date in YYYY-MM-DD format"),
    tags: z.string().optional(),
    context: z.string().optional(),
  },
  async ({ content, priority, status, parent_id, due_date, tags, context }) => {
    const projectDb = getProjectDb();
    const noteId = generateId();
    const timestamp = now();
    const textForKeywords = [content, context].filter(Boolean).join(" ");
    const keywords = extractKeywords(textForKeywords);

    const tagParts: string[] = ["work_item"];
    if (tags) {
      for (const t of tags.split(",").map((s) => s.trim())) {
        if (t && !tagParts.includes(t)) tagParts.push(t);
      }
    }

    projectDb.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, last_validated, resolved, status, priority, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [noteId, "work_item", content, context ?? null, keywords.join(","), tagParts.join(","),
       "high", timestamp, 0, status ?? "planned", priority ?? "medium", due_date ?? null, timestamp, timestamp]
    );

    const links = createAutoLinks(projectDb, noteId, keywords);

    if (parent_id) {
      const parent = projectDb.query(`SELECT id FROM notes WHERE id = ?`).get(parent_id);
      if (parent) {
        projectDb.run(
          `INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
           VALUES (?, ?, ?, 'part_of', 'strong', ?)`,
          [generateId(), noteId, parent_id, timestamp]
        );
      }
    }

    const dueStr = due_date ? ` due ${due_date}` : "";
    return {
      content: [{
        type: "text" as const,
        text: `Created work_item "${noteId}" [${priority}/${status}]${dueStr}${parent_id ? ` (child of ${parent_id})` : ""}${links.length > 0 ? ` with ${links.length} auto-link(s)` : ""}.`,
      }],
    };
  }
);

// ── update_work_item ────────────────────────────────────────────────────
server.tool(
  "update_work_item",
  "Update a work item's status, priority, due date, or content. Triggers cascade logic: completing an item unblocks dependents and may auto-complete parent items. Use to track progress through tasks.",
  {
    id: z.string(),
    status: z.enum(WORK_ITEM_STATUSES).optional(),
    priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
    due_date: z.string().optional().describe("Due date in YYYY-MM-DD format, or empty string to clear"),
    content: z.string().optional().describe("Updated description"),
    blocked_by: z.string().optional().describe("ID of the note blocking this work item (creates blocks link)"),
  },
  async ({ id, status, priority, due_date, content, blocked_by }) => {
    const projectDb = getProjectDb();

    const row = projectDb
      .query(`SELECT id, type, content, status, priority, due_date FROM notes WHERE id = ?`)
      .get(id) as { id: string; type: string; content: string; status: string | null; priority: string | null; due_date: string | null } | null;

    if (!row) {
      return {
        content: [{ type: "text" as const, text: `No note found with id "${id}".` }],
      };
    }

    const timestamp = now();
    const updates: string[] = [];
    const changes: string[] = [];

    if (status) {
      updates.push(`status = '${status}'`);
      changes.push(`status: ${row.status} -> ${status}`);
    }
    if (priority) {
      updates.push(`priority = '${priority}'`);
      changes.push(`priority: ${row.priority} -> ${priority}`);
    }
    if (due_date !== undefined) {
      const newDue = due_date === "" ? null : due_date;
      updates.push(`due_date = ${newDue ? `'${newDue}'` : "NULL"}`);
      changes.push(`due_date: ${row.due_date ?? "none"} -> ${newDue ?? "cleared"}`);
    }
    if (content) {
      updates.push(`content = '${content.replace(/'/g, "''")}'`);
      const newKeywords = extractKeywords(content);
      updates.push(`keywords = '${newKeywords.join(",")}'`);
      changes.push("content updated");
    }

    if (updates.length > 0) {
      updates.push(`updated_at = '${timestamp}'`);
      if (status === "done") updates.push("resolved = 1");
      projectDb.run(`UPDATE notes SET ${updates.join(", ")} WHERE id = ?`, [id]);
    }

    if (blocked_by) {
      const blocker = projectDb.query(`SELECT id FROM notes WHERE id = ?`).get(blocked_by);
      if (blocker) {
        projectDb.run(
          `INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
           VALUES (?, ?, ?, 'blocks', 'strong', ?)`,
          [generateId(), blocked_by, id, timestamp]
        );
        changes.push(`blocked by: ${blocked_by}`);
      }
    }

    if (status === "done") {
      const cascadeResults = cascadeResolution(projectDb, id, timestamp);
      if (cascadeResults.length > 0) {
        changes.push("Cascade: " + cascadeResults.join(", "));
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: `Updated work_item "${id}": ${changes.join("; ")}.`,
      }],
    };
  }
);

// ── breakdown ───────────────────────────────────────────────────────────
server.tool(
  "breakdown",
  "Break down a work item or plan into child work items. Creates multiple work_items linked to a parent via part_of relationships. Use when you have a complex task that needs to be split into concrete steps.",
  {
    parent_id: z.string().optional().describe("ID of parent work_item. If omitted, creates a new parent from the title."),
    parent_title: z.string().optional().describe("Title for a new parent work_item (used when parent_id is omitted)"),
    items: z.array(z.object({
      content: z.string(),
      priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
      due_date: z.string().optional(),
    })),
    tags: z.string().optional(),
    due_date: z.string().optional().describe("Default due date for all items (individual items can override)"),
  },
  async ({ parent_id, parent_title, items, tags, due_date }) => {
    const projectDb = getProjectDb();
    const timestamp = now();

    let actualParentId = parent_id;
    if (!actualParentId && parent_title) {
      actualParentId = generateId();
      const keywords = extractKeywords(parent_title);
      const tagParts = ["work_item", ...(tags ? tags.split(",").map(s => s.trim()) : [])];

      projectDb.run(
        `INSERT INTO notes (id, type, content, keywords, tags, confidence, last_validated, resolved, status, priority, due_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [actualParentId, "work_item", parent_title, keywords.join(","), tagParts.join(","),
         "high", timestamp, 0, "planned", "high", due_date ?? null, timestamp, timestamp]
      );
      createAutoLinks(projectDb, actualParentId, keywords);
    }

    const created: string[] = [];
    for (const item of items) {
      const childId = generateId();
      const keywords = extractKeywords(item.content);
      const tagParts = ["work_item", ...(tags ? tags.split(",").map(s => s.trim()) : [])];

      projectDb.run(
        `INSERT INTO notes (id, type, content, keywords, tags, confidence, last_validated, resolved, status, priority, due_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [childId, "work_item", item.content, keywords.join(","), tagParts.join(","),
         "high", timestamp, 0, "planned", item.priority ?? "medium", item.due_date ?? due_date ?? null, timestamp, timestamp]
      );

      createAutoLinks(projectDb, childId, keywords);

      if (actualParentId) {
        projectDb.run(
          `INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
           VALUES (?, ?, ?, 'part_of', 'strong', ?)`,
          [generateId(), childId, actualParentId, timestamp]
        );
      }

      created.push(`"${childId}" - ${item.content}`);
    }

    return {
      content: [{
        type: "text" as const,
        text: `Created ${created.length} work items${actualParentId ? ` under parent "${actualParentId}"` : ""}:\n${created.map(c => `- ${c}`).join("\n")}`,
      }],
    };
  }
);

// ── retro ───────────────────────────────────────────────────────────────
server.tool(
  "retro",
  "Run maintenance on the knowledge base and analyze what's working. Decays confidence on stale notes, merges duplicates, identifies orphans, queues notes for revalidation, computes autonomy scores, and analyzes user model trajectories. Use after a debugging session, when an approach failed, or periodically to keep knowledge fresh.",
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
    if (result.trajectory_updates > 0) {
      text += `\n\nUser model: ${result.trajectory_updates} trajectory update(s).`;
    }
    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ── Cascade resolution helper ───────────────────────────────────────────
function cascadeResolution(db: import("bun:sqlite").Database, noteId: string, timestamp: string): string[] {
  const results: string[] = [];

  // 1. Unblock items that this note was blocking
  const blockedItems = db
    .query(
      `SELECT DISTINCT n.id, n.type, n.status FROM links l
       JOIN notes n ON (
         (l.from_note_id = ? AND l.to_note_id = n.id) OR
         (l.to_note_id = ? AND l.from_note_id = n.id)
       )
       WHERE l.relationship = 'blocks' AND n.id != ? AND n.resolved = 0`
    )
    .all(noteId, noteId, noteId) as Array<{ id: string; type: string; status: string | null }>;

  for (const blocked of blockedItems) {
    // Check for other unresolved blockers
    const otherBlockers = db
      .query(
        `SELECT COUNT(*) as cnt FROM links l
         JOIN notes n ON (
           (l.from_note_id = n.id AND l.to_note_id = ?) OR
           (l.to_note_id = n.id AND l.from_note_id = ?)
         )
         WHERE l.relationship = 'blocks' AND n.id != ? AND n.resolved = 0`
      )
      .get(blocked.id, blocked.id, noteId) as { cnt: number };

    if (otherBlockers.cnt === 0 && blocked.type === "work_item" && blocked.status === "blocked") {
      db.run(`UPDATE notes SET status = 'planned', updated_at = ? WHERE id = ?`, [timestamp, blocked.id]);
      results.push(`Unblocked "${blocked.id}"`);
    }
  }

  // 2. Auto-complete parent if all children done
  const parentLinks = db
    .query(`SELECT l.to_note_id FROM links l WHERE l.from_note_id = ? AND l.relationship = 'part_of'`)
    .all(noteId) as Array<{ to_note_id: string }>;

  for (const parentLink of parentLinks) {
    const unresolvedSiblings = db
      .query(
        `SELECT COUNT(*) as cnt FROM links l
         JOIN notes n ON l.from_note_id = n.id
         WHERE l.to_note_id = ? AND l.relationship = 'part_of'
         AND n.id != ? AND (n.resolved = 0 OR (n.type = 'work_item' AND n.status != 'done'))`
      )
      .get(parentLink.to_note_id, noteId) as { cnt: number };

    if (unresolvedSiblings.cnt === 0) {
      const parent = db.query(`SELECT id, type, status FROM notes WHERE id = ?`)
        .get(parentLink.to_note_id) as { id: string; type: string; status: string | null } | null;

      if (parent && parent.status !== "done") {
        if (parent.type === "work_item") {
          db.run(`UPDATE notes SET resolved = 1, status = 'done', updated_at = ? WHERE id = ?`, [timestamp, parent.id]);
        } else {
          db.run(`UPDATE notes SET resolved = 1, updated_at = ? WHERE id = ?`, [timestamp, parent.id]);
        }
        results.push(`Auto-completed parent "${parent.id}" (all children done)`);
      }
    }
  }

  // 3. Auto-resolve superseded notes
  const superseded = db
    .query(
      `SELECT n.id FROM links l
       JOIN notes n ON l.to_note_id = n.id
       WHERE l.from_note_id = ? AND l.relationship = 'supersedes' AND n.resolved = 0`
    )
    .all(noteId) as Array<{ id: string }>;

  for (const sup of superseded) {
    db.run(`UPDATE notes SET resolved = 1, updated_at = ? WHERE id = ?`, [timestamp, sup.id]);
    results.push(`Auto-resolved superseded "${sup.id}"`);
  }

  return results;
}

// ── Start server ────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
