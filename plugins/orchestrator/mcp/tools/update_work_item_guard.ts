// deac5d30: update_work_item must never report success for a call that wrote nothing.
//
// The SDK builds a NON-strict z.object from the tool's raw shape, so an unknown
// key (`append` for `append_content`) is stripped before the handler runs. The
// handler then saw a call carrying only `id`, wrote nothing, and replied
// `Updated work_item "<id>": .` - an empty change list inside a success-shaped
// message. PA lost five appends that way on 2026-09-28 between 19:49Z and 19:59Z,
// and SA-df343a05 nearly did the same with `add_tags` on 2026-07-29.
//
// The raw arguments never reach the handler, so the unknown key cannot be named
// here. What CAN be said is that no recognised field arrived, and which names do.

/** Every update_work_item parameter that changes the row. `id` selects it; it is not one. */
export const WORK_ITEM_MUTABLE_FIELDS = [
  "status",
  "priority",
  "due_date",
  "content",
  "append_content",
  "tags",
  "add_tags",
  "context",
  "confidence",
  "code_refs",
  "blocked_by",
] as const;

const NAMES = WORK_ITEM_MUTABLE_FIELDS.join(", ");

/**
 * The refusal for a call with no recognised field, or null when at least one
 * arrived. Takes the handler's parsed arguments, i.e. AFTER the SDK stripped any
 * unknown key.
 */
export function noFieldsToUpdate(args: Record<string, unknown>): string | null {
  if (WORK_ITEM_MUTABLE_FIELDS.some((f) => args[f] !== undefined)) return null;
  return `No fields to update - nothing was written. Check the parameter names: ${NAMES}. A misspelled name (for example \`append\` for \`append_content\`) is dropped before this tool sees it, so it cannot be named here.`;
}

/**
 * The refusal for a call whose recognised fields all turned out to write nothing
 * (for example `content: ""`, which is skipped so a description is never blanked,
 * or a `blocked_by` that names no note). Null when something was written.
 */
export function nothingWritten(changes: string[], skipped: string[]): string | null {
  if (changes.length > 0) return null;
  const why = skipped.length > 0 ? ` ${skipped.join("; ")}.` : "";
  return `Nothing was written.${why} Check the parameter names and values: ${NAMES}.`;
}
