import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../mcp/db/schema";
import { handleRemember } from "../mcp/tools/remember";
import { NOTE_TYPES, GLOBAL_TYPES, MAYBE_GLOBAL_TYPES } from "../mcp/types";

// Backlog item H, open since 2026-07-27 and hit twice in real use: a
// version->date lookup table and a `gotcha`, both rejected because the enum had
// nowhere to put them.
//
// Every other note type is a CLAIM ABOUT THE WORLD. `reference` is the one
// thing that is not - a POINTER to where something lives. Forcing pointers into
// `insight` or `architecture` mislabels them and degrades type-filtered
// retrieval for both.

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("item H: the `reference` note type", () => {
  test("is accepted by the type enum", () => {
    expect(NOTE_TYPES).toContain("reference");
  });

  test("a reference note can actually be written and read back", async () => {
    const db = makeDb("project");
    const g = makeDb("global");
    const res = await handleRemember(db, g, {
      content: "Cloudflare dashboard for the worker lives at dash.cloudflare.com/<account>/workers",
      type: "reference",
    });
    expect(res.note_id).toBeTruthy();
    const row = db.query("SELECT type FROM notes WHERE id = ?").get(res.note_id!) as any;
    expect(row.type).toBe("reference");
  });

  test("it is MAYBE-global, not always-global", () => {
    // A vendor dashboard is cross-project; a pointer to this repo's build
    // output is not. Judged per note rather than forced either way.
    expect(MAYBE_GLOBAL_TYPES).toContain("reference");
    expect(GLOBAL_TYPES).not.toContain("reference");
  });

  test("it is NOT duplicate-gated", async () => {
    // Two pointers to DIFFERENT resources are often near-identical in wording
    // ("dashboard for X lives at ..."), so gating them would block legitimate
    // writes - the exact corrosion backlog item A described, where the cost of
    // a false positive biases agents against writing the note at all.
    const db = makeDb("project");
    const g = makeDb("global");
    const first = await handleRemember(db, g, {
      content: "Billing dashboard for the payment provider lives at the vendor console",
      type: "reference",
    });
    expect(first.note_id).toBeTruthy();

    const second = await handleRemember(db, g, {
      content: "Billing dashboard for the email provider lives at the vendor console",
      type: "reference",
    });
    // Written, not blocked pending a resolution token.
    expect(second.note_id).toBeTruthy();
    expect(second.stored).toBe(true);
  });
});
