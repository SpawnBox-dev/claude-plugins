import type { Database } from "bun:sqlite";
import type { NoteType } from "../types";
import { GLOBAL_TYPES } from "../types";
import { generateId, now } from "../utils";
import { handleRemember } from "./remember";
import { resolveNoteId } from "./id_resolver";
import type { EmbeddingClient } from "../engine/embeddings";

export interface SupersedeInput {
  old_id: string;
  new_id?: string;
  new_content?: string;
  new_type?: NoteType;
  reason?: string;
  session_id?: string;
  /** R5: code_refs passed through to the inline-created replacement note.
   *  Ignored when new_id is provided (target note keeps its own refs). */
  code_refs?: string[];
}

export interface SupersedeResult {
  superseded: boolean;
  old_id: string;
  new_id: string | null;
  error?: string;
  message: string;
}


/**
 * 0.33.0: A RETRACTION IS NOT DONE UNTIL EVERY SURFACE CARRYING THE CLAIM IS
 * UPDATED.
 *
 * THE CLASS THIS ADDRESSES, and why it is neither of the other two:
 * PA, 2026-07-28. A checkout retraction was applied to work item f8a55926, to
 * the warden ledger, and to a checkpoint - and `polar-mor-account.md`, the
 * durable memory file every future session reads, kept the un-retracted
 * version including a flatly false claim. Retrieval worked. Authorship worked.
 * The correction was written correctly, more than once. It still failed,
 * because NOTHING ENUMERATES THE SURFACES THAT CARRY A CLAIM, so "done" meant
 * "done in the places I happened to think of."
 *
 * That is distinct from writing past a note you were shown (0.32.0's class)
 * and from asserting something never in the KB at all. Those are failures to
 * consult or to verify. This is a failure of COMPLETION, and it is the one
 * that leaves a false statement live in the highest-traffic surface while
 * every artifact you looked at says you fixed it.
 *
 * WHY supersede IS THE TRIGGER: it is the explicit "this was wrong / has been
 * replaced" act. It is deliberate and comparatively rare, so firing on every
 * one cannot train the dismissal reflex that an always-on check does - the
 * base-rate constraint PA and SA-5a433456 both insisted on.
 *
 * HONESTY ABOUT COVERAGE - the load-bearing part. This lists what the KB can
 * PROVE carries the claim (inbound links, work items, the note's own
 * code_refs) and then NAMES the surfaces it cannot see (memory files, docs,
 * specs, and anything already published). A checklist that silently omits the
 * category the original bug lived in would be worse than none, because it
 * would confer exactly the false sense of completion that caused this.
 */
export function formatPropagationSurfaces(
  db: Database,
  oldId: string,
  codeRefs: string[]
): string {
  const inbound = db
    .query(
      `SELECT n.id, n.type, substr(n.content, 1, 90) AS snippet
       FROM links l JOIN notes n ON n.id = l.from_note_id
       WHERE l.to_note_id = ?
         AND l.relationship != 'supersedes'
         AND n.id != ?
         AND n.superseded_by IS NULL
       ORDER BY CASE l.strength WHEN 'strong' THEN 0 ELSE 1 END
       LIMIT 6`
    )
    .all(oldId, oldId) as Array<{ id: string; type: string; snippet: string }>;

  const lines: string[] = [];
  if (inbound.length > 0) {
    lines.push(`  NOTES THAT POINT AT THE RETRACTED ONE (may restate the claim):`);
    for (const r of inbound) {
      lines.push(`    - ${r.id.slice(0, 8)} [${r.type}]: "${r.snippet.replace(/\s+/g, " ")}"`);
    }
  }
  if (codeRefs.length > 0) {
    lines.push(`  FILES THE RETRACTED NOTE POINTED AT: ${codeRefs.join(", ")}`);
  }

  const known = lines.length > 0 ? lines.join("\n") + "\n" : "";
  return (
    "\n\n[PROPAGATE THE RETRACTION - a correction is not done until every " +
    "surface carrying it is updated]\n" +
    known +
    "  SURFACES THIS TOOL CANNOT SEE - check them yourself, this is where the " +
    "class actually bites:\n" +
    "    - memory files (MEMORY.md and the auto-memory topic files) - the " +
    "highest-traffic surface, and the one that has actually been missed\n" +
    "    - docs/ and specs that state the same claim\n" +
    "    - anything already PUBLISHED (Discord, landing copy, release notes) - " +
    "superseding a note cannot reach those\n" +
    "  If a surface is fine as-is, that is a real answer. Leaving it " +
    "unchecked is not."
  );
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

  // id8-prefix resolution for old_id: try project first, fall back to global.
  let oldResolved = resolveNoteId(projectDb, input.old_id);
  let db = projectDb;
  if (!oldResolved.id && !oldResolved.ambiguous) {
    oldResolved = resolveNoteId(globalDb, input.old_id);
    db = globalDb;
  }
  if (oldResolved.ambiguous) {
    return {
      superseded: false,
      old_id: input.old_id,
      new_id: null,
      error: `old_id prefix "${input.old_id}" is ambiguous - matches ${oldResolved.ambiguous.length} notes`,
      message: `ID prefix "${input.old_id}" is ambiguous - matches ${oldResolved.ambiguous.length} notes: ${oldResolved.ambiguous.join(", ")}. Use the full UUID.`,
    };
  }
  if (!oldResolved.id) {
    return {
      superseded: false,
      old_id: input.old_id,
      new_id: null,
      error: `old note "${input.old_id}" not found`,
      message: `No note found with id "${input.old_id}".`,
    };
  }
  const oldId = oldResolved.id;
  // Update input.old_id so error messages downstream cite the resolved UUID.
  input = { ...input, old_id: oldId };

  const oldRow = db.query("SELECT id, type FROM notes WHERE id = ?").get(oldId) as { id: string; type: string } | null;
  if (!oldRow) {
    return {
      superseded: false,
      old_id: oldId,
      new_id: null,
      error: `old note "${oldId}" not found`,
      message: `No note found with id "${oldId}".`,
    };
  }

  // Check current state of old note - reject chain-fork, allow true idempotent no-op.
  // This runs BEFORE any new_id validation or inline creation to prevent orphan notes.
  const currentSupersededBy = (db.query(`SELECT superseded_by FROM notes WHERE id = ?`).get(oldId) as { superseded_by: string | null }).superseded_by;

  if (currentSupersededBy !== null) {
    // Resolve caller's new_id (potentially an id8 prefix) BEFORE comparing
    // against currentSupersededBy (full UUID from DB). Without this, an
    // idempotent retry like `supersede({old_id: "ab12cd34", new_id: "ef56ab78"})`
    // would compare the prefix against the full UUID and silently fall through
    // to the chain-fork rejection.
    let resolvedNewIdForIdempotent: string | null = null;
    if (input.new_id) {
      const r = resolveNoteId(db, input.new_id);
      resolvedNewIdForIdempotent = r.id;
    }

    // Old note is already superseded. Two sub-cases:
    if (input.new_id && (resolvedNewIdForIdempotent ?? input.new_id) === currentSupersededBy) {
      // True idempotent no-op for same (old_id, new_id) pair. Preserve original superseded_at.
      return {
        superseded: true,
        old_id: input.old_id,
        new_id: currentSupersededBy,
        message: `Note "${input.old_id}" was already superseded by "${currentSupersededBy}" - no change.`,
      };
    }
    // Any other case (different new_id, or inline new_content path): reject, don't fork the chain.
    return {
      superseded: false,
      old_id: input.old_id,
      new_id: null,
      error: `"${input.old_id}" is already superseded by "${currentSupersededBy}". To change the successor, supersede "${currentSupersededBy}" with the new replacement, or use a different old_id.`,
      message: `Cannot re-supersede: already points at "${currentSupersededBy}".`,
    };
  }

  let newId: string | null = null;

  // If new_id was provided directly, validate (with id8-prefix resolution) it lives in the same db
  if (input.new_id) {
    const newInSameDb = resolveNoteId(db, input.new_id);
    if (newInSameDb.ambiguous) {
      return {
        superseded: false,
        old_id: input.old_id,
        new_id: null,
        error: `new_id prefix "${input.new_id}" is ambiguous - matches ${newInSameDb.ambiguous.length} notes`,
        message: `new_id prefix "${input.new_id}" is ambiguous - matches ${newInSameDb.ambiguous.length} notes: ${newInSameDb.ambiguous.join(", ")}. Use the full UUID.`,
      };
    }
    if (!newInSameDb.id) {
      const otherDb = db === projectDb ? globalDb : projectDb;
      const newInOtherDb = resolveNoteId(otherDb, input.new_id);
      if (newInOtherDb.id) {
        return {
          superseded: false,
          old_id: input.old_id,
          new_id: null,
          // 0.30.78: give the SANCTIONED PATH, not a bare refusal.
          //
          // PA flagged this as the nastiest of the concurrent-capture defects:
          // the consolidation tool fails at precisely the moment it is needed.
          // Two sessions reacting to one broadcast frequently disagree about
          // scope - one reads a rule as project-specific, the other as global -
          // and that disagreement is ITSELF a symptom of concurrent capture. So
          // the system generates forks its own merge tool structurally cannot
          // close, and an agent left holding two notes with no sanctioned path
          // reaches for a manual delete, losing revision history.
          //
          // Scope here means a DIFFERENT SQLite DATABASE (project.db vs
          // global.db), and links/embeddings/revisions are all DB-local, so an
          // automatic cross-DB move is a real migration, not a flag flip. Until
          // that is built and tested, the honest fix is to stop leaving the
          // caller stranded: name the two safe paths explicitly, and say which
          // one preserves history.
          error:
            `cross-scope supersede not supported: the old note lives in the ${db === projectDb ? "project" : "global"} DB and new_id "${input.new_id}" lives in the other. ` +
            `Scope = a separate database here, and links/embeddings/revisions are DB-local, so this cannot be a silent move. TWO SANCTIONED PATHS: ` +
            `(1) PREFERRED - re-create the SURVIVING content as a new note in the LOSER's scope via note({scope}), then supersede within that one scope. History is preserved and the merge is a normal same-scope supersede. ` +
            `(2) REDIRECT STUB - the remedy proven in the field (SA-90bf73bd, 2026-07-27): update_note the LOSER so it opens with "SUPERSEDED IN PRACTICE BY <id> (other scope)" plus one line on why the duplicate exists, then close_thread it. ` +
            `This keeps the old ID resolvable, keeps every INBOUND LINK, and teaches anyone who lands on the old ID. ` +
            `NEVER delete_note the loser: delete CASCADE-removes its links - the note this was learned on had 87 - and "in revision history" is strictly weaker than "live". A known, linked duplicate is far cheaper than a lost revision history. ` +
            `If this came from two sessions capturing the same broadcast, settle it in-channel and pick by better CONTENT, not by who wrote first.`,
          message: `Cannot supersede across scopes - see error for the two sanctioned paths (re-create in one scope, or link-and-close; never delete).`,
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
    newId = newInSameDb.id;
  }

  if (!newId && input.new_content && input.new_type) {
    const newGoesGlobal = GLOBAL_TYPES.includes(input.new_type);
    const oldIsGlobal = db === globalDb;
    if (newGoesGlobal !== oldIsGlobal) {
      return {
        superseded: false,
        old_id: input.old_id,
        new_id: null,
        // 0.30.78: same actionable-path treatment as the new_id branch above.
        // This one is easier to recover from, because the caller usually just
        // picked a new_type whose GLOBAL_TYPES routing disagrees with the old
        // note's scope - so naming that as the cause is most of the fix.
        error:
          `cross-scope supersede not supported: the old note is ${oldIsGlobal ? "global" : "project"}-scoped, but new_type "${input.new_type}" routes to the ${newGoesGlobal ? "global" : "project"} DB (some types are always global - see GLOBAL_TYPES). ` +
          `FIX: pick a new_type that routes to the ${oldIsGlobal ? "global" : "project"} scope, which is usually just keeping the old note's own type. ` +
          `If the replacement genuinely belongs in the other scope, create it there with note({scope}) and then make the fork explicit on the old note (open it with "SUPERSEDED IN PRACTICE BY <id> (other scope)" and close_thread it). Never delete_note the old one - that discards revision history.`,
        message: `Cannot supersede across scopes - new_type routes to the other DB. See error for the fix.`,
      };
    }

    const created = await handleRemember(projectDb, globalDb, {
      content: input.new_content,
      type: input.new_type,
      context: input.reason ? `Supersedes ${input.old_id}: ${input.reason}` : `Supersedes ${input.old_id}`,
      session_id: input.session_id,
      code_refs: input.code_refs,
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

  // Best-effort: a propagation hint must never fail the supersede itself.
  let propagation = "";
  try {
    const refRow = db
      .query(`SELECT code_refs FROM notes WHERE id = ?`)
      .get(input.old_id) as { code_refs: string | null } | undefined;
    let refs: string[] = [];
    if (refRow?.code_refs) {
      try {
        const parsed = JSON.parse(refRow.code_refs);
        if (Array.isArray(parsed)) refs = parsed.filter((r) => typeof r === "string");
      } catch {
        refs = refRow.code_refs.split(",").map((r) => r.trim()).filter(Boolean);
      }
    }
    propagation = formatPropagationSurfaces(db, input.old_id, refs);
  } catch {
    propagation = "";
  }
  return {
    superseded: true,
    old_id: input.old_id,
    new_id: newId,
    message: `Superseded "${input.old_id}" with "${newId}".${reasonNote}${propagation}`,
  };
}
