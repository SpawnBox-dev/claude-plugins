import type { Database } from "bun:sqlite";
import type { NoteType } from "../types";
import { GLOBAL_TYPES } from "../types";
import { generateId, now } from "../utils";
import { handleRemember } from "./remember";
import type { EmbeddingClient } from "../engine/embeddings";

export interface SupersedeInput {
  old_id: string;
  new_id?: string;
  new_content?: string;
  new_type?: NoteType;
  reason?: string;
  session_id?: string;
}

export interface SupersedeResult {
  superseded: boolean;
  old_id: string;
  new_id: string | null;
  error?: string;
  message: string;
}

export async function handleSupersede(
  projectDb: Database,
  globalDb: Database,
  input: SupersedeInput,
  embeddingClient?: EmbeddingClient | null
): Promise<SupersedeResult> {
  if (!input.new_id && !(input.new_content && input.new_type)) {
    return {
      superseded: false,
      old_id: input.old_id,
      new_id: null,
      error: "Must provide either new_id (existing note) or new_content+new_type (inline creation).",
      message: "supersede requires new_id OR (new_content AND new_type).",
    };
  }

  let db = projectDb;
  let oldRow = db.query("SELECT id, type FROM notes WHERE id = ?").get(input.old_id) as { id: string; type: string } | null;
  if (!oldRow) {
    db = globalDb;
    oldRow = db.query("SELECT id, type FROM notes WHERE id = ?").get(input.old_id) as { id: string; type: string } | null;
  }
  if (!oldRow) {
    return {
      superseded: false,
      old_id: input.old_id,
      new_id: null,
      error: `old note "${input.old_id}" not found`,
      message: `No note found with id "${input.old_id}".`,
    };
  }

  let newId = input.new_id ?? null;

  // If new_id was provided directly, validate it lives in the same db
  if (input.new_id) {
    const sameDbRow = db.query(`SELECT id FROM notes WHERE id = ?`).get(input.new_id) as { id: string } | null;
    if (!sameDbRow) {
      const otherDb = db === projectDb ? globalDb : projectDb;
      const crossRow = otherDb.query(`SELECT id FROM notes WHERE id = ?`).get(input.new_id) as { id: string } | null;
      if (crossRow) {
        return {
          superseded: false,
          old_id: input.old_id,
          new_id: null,
          error: `cross-scope supersede not supported: old note lives in ${db === projectDb ? "project" : "global"} DB, new_id "${input.new_id}" lives in the other DB. Create a replacement in the same scope and try again.`,
          message: `Cannot supersede across scopes.`,
        };
      }
      return {
        superseded: false,
        old_id: input.old_id,
        new_id: null,
        error: `new_id "${input.new_id}" not found`,
        message: `No note found with new_id "${input.new_id}".`,
      };
    }
    newId = input.new_id;
  }

  if (!newId && input.new_content && input.new_type) {
    const newGoesGlobal = GLOBAL_TYPES.includes(input.new_type);
    const oldIsGlobal = db === globalDb;
    if (newGoesGlobal !== oldIsGlobal) {
      return {
        superseded: false,
        old_id: input.old_id,
        new_id: null,
        error: `cross-scope supersede not supported: old note is ${oldIsGlobal ? "global" : "project"}-scoped, new_type "${input.new_type}" would route to ${newGoesGlobal ? "global" : "project"}. Choose a compatible new_type or create the replacement manually in the same scope.`,
        message: `Cannot supersede across scopes.`,
      };
    }

    const created = await handleRemember(projectDb, globalDb, {
      content: input.new_content,
      type: input.new_type,
      context: input.reason ? `Supersedes ${input.old_id}: ${input.reason}` : `Supersedes ${input.old_id}`,
      session_id: input.session_id,
    }, embeddingClient);
    if (!created.note_id) {
      return {
        superseded: false,
        old_id: input.old_id,
        new_id: null,
        error: "failed to create replacement note",
        message: "supersede failed during replacement creation.",
      };
    }
    newId = created.note_id;
  }

  if (!newId) {
    return {
      superseded: false,
      old_id: input.old_id,
      new_id: null,
      error: "no new_id resolved",
      message: "internal: supersede could not resolve new_id.",
    };
  }

  const timestamp = now();

  db.transaction(() => {
    db.run(
      `UPDATE notes SET superseded_by = ?, superseded_at = ?, updated_at = ? WHERE id = ?`,
      [newId, timestamp, timestamp, input.old_id]
    );

    db.run(
      `INSERT OR IGNORE INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
       VALUES (?, ?, ?, 'supersedes', 'strong', ?)`,
      [generateId(), newId, input.old_id, timestamp]
    );
  })();

  const reasonNote = input.reason ? ` Reason: ${input.reason}.` : "";
  return {
    superseded: true,
    old_id: input.old_id,
    new_id: newId,
    message: `Superseded "${input.old_id}" with "${newId}".${reasonNote}`,
  };
}
