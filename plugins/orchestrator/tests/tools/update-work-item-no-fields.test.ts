import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import {
  WORK_ITEM_MUTABLE_FIELDS,
  noFieldsToUpdate,
  nothingWritten,
} from "../../mcp/tools/update_work_item_guard";

// deac5d30. PA sent `append:"..."` to update_work_item five times on
// 2026-09-28 (19:49Z-19:59Z). The SDK's non-strict object stripped `append`,
// the handler saw only `id`, wrote nothing and replied `Updated work_item
// "<id>": .`. A ruling looked recorded and was not.
//
// Behaviour for the importable guard, wiring (source assertions) for the
// server.ts handler, which is not importable - the same split the other
// update_work_item tests use, because a guard that is correct and never called
// passes every behaviour test.

const SERVER_SRC = readFileSync(join(import.meta.dir, "..", "..", "mcp", "server.ts"), "utf-8");

/** The update_work_item registration, from its server.tool( to the next tool's banner. */
function handlerSrc(): string {
  const start = SERVER_SRC.indexOf(`"update_work_item",`);
  expect(start).toBeGreaterThan(-1);
  const end = SERVER_SRC.indexOf("// ── breakdown", start);
  expect(end).toBeGreaterThan(start);
  return SERVER_SRC.slice(start, end);
}

/** The shape the SDK parses with: a plain (non-strict) z.object, as objectFromShape builds it. */
const sdkParse = (args: Record<string, unknown>) =>
  z
    .object({
      id: z.string(),
      ...Object.fromEntries(WORK_ITEM_MUTABLE_FIELDS.map((f) => [f, z.any().optional()])),
    })
    .parse(args) as Record<string, unknown>;

describe("deac5d30: a call with no recognised field is refused", () => {
  test("THE INCIDENT: `append` is stripped by the SDK, and the guard refuses what is left", () => {
    const parsed = sdkParse({ id: "3a22ccc7", append: "ruling text", session_id: "36abe436" });
    expect(parsed.append).toBeUndefined();
    const msg = noFieldsToUpdate(parsed);
    expect(msg).not.toBeNull();
    expect(msg!).toContain("nothing was written");
    expect(msg!).toContain("append_content");
  });

  test("a call with no fields at all is refused", () => {
    expect(noFieldsToUpdate({ id: "3a22ccc7" })).not.toBeNull();
  });

  test("append_content passes the guard", () => {
    expect(noFieldsToUpdate(sdkParse({ id: "x", append_content: "a" }))).toBeNull();
  });

  test("every mutable field on its own passes the guard", () => {
    for (const f of WORK_ITEM_MUTABLE_FIELDS) {
      expect(noFieldsToUpdate({ id: "x", [f]: f === "code_refs" ? [] : "" })).toBeNull();
    }
  });

  test("the field list is exactly the handler's parameters minus id", () => {
    // A parameter added to the tool but not here would be refused as "no fields".
    const src = handlerSrc();
    const destructure = src.match(/async \(\{([^}]*)\}\) =>/);
    expect(destructure).not.toBeNull();
    const params = destructure![1].split(",").map((s) => s.trim()).filter(Boolean).filter((p) => p !== "id");
    expect([...params].sort()).toEqual([...WORK_ITEM_MUTABLE_FIELDS].sort());
  });

  test("nothingWritten: empty changes refuse, with the skipped reasons", () => {
    const msg = nothingWritten([], ['blocked_by: no note "deadbeef"']);
    expect(msg).toContain("Nothing was written");
    expect(msg).toContain("deadbeef");
    expect(nothingWritten(["append_content"], [])).toBeNull();
  });
});

describe("deac5d30 wiring: the handler uses the guard and never prints an empty change list", () => {
  test("the handler refuses before any write when no field arrived", () => {
    const src = handlerSrc();
    const guard = src.indexOf("noFieldsToUpdate(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(src.indexOf("appendToNoteContent("));
    expect(guard).toBeLessThan(src.indexOf("projectDb.run("));
    // Called is not enough: its answer must end the call, as an error.
    expect(src).toMatch(
      /const noFields = noFieldsToUpdate\(\{[^}]*\}\);\s*if \(noFields\) \{\s*return \{ content: \[\{ type: "text" as const, text: noFields \}\], isError: true \};/
    );
  });

  test("the guard is handed every mutable field the handler receives", () => {
    const src = handlerSrc();
    const call = src.match(/noFieldsToUpdate\(\{([^}]*)\}\)/);
    expect(call).not.toBeNull();
    const passed = call![1].split(",").map((s) => s.trim()).filter(Boolean);
    expect([...passed].sort()).toEqual([...WORK_ITEM_MUTABLE_FIELDS].sort());
  });

  test("the success line is reachable only after nothingWritten has had its say", () => {
    const src = handlerSrc();
    const check = src.indexOf("nothingWritten(");
    const success = src.indexOf("text: `Updated work_item");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(success);
    expect(src).toMatch(
      /const none = nothingWritten\(changes, skipped\);\s*if \(none\) \{\s*return \{ content: \[\{ type: "text" as const, text: none \}\], isError: true \};/
    );
  });

  test("both refusals are marked as errors", () => {
    const src = handlerSrc();
    expect((src.match(/isError: true/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("a blocked_by that names no note is reported, not dropped", () => {
    const src = handlerSrc();
    const branch = src.slice(src.indexOf("if (blocked_by)"), src.indexOf("nothingWritten("));
    expect(branch).toContain("skipped.push(");
  });

  test("blocked_by resolves an id8 prefix, as `id` does", () => {
    const src = handlerSrc();
    const branch = src.slice(src.indexOf("if (blocked_by)"), src.indexOf("nothingWritten("));
    expect(branch).toContain("resolveNoteId(projectDb, blocked_by)");
    expect(branch).not.toContain("WHERE id = ?`).get(blocked_by)");
  });
});
