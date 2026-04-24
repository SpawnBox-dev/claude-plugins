import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { parseCodeRefs, stringifyCodeRefs } from "../../mcp/utils";
import { handleRemember } from "../../mcp/tools/remember";
import { handleRecall } from "../../mcp/tools/recall";
import { handleSupersede } from "../../mcp/tools/supersede";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("R5 code_refs: serialization helpers", () => {
  test("stringifyCodeRefs + parseCodeRefs roundtrip", () => {
    const input = ["mcp/server.ts", "mcp/engine/signal.ts"];
    const s = stringifyCodeRefs(input);
    expect(s).toBe(JSON.stringify(input));
    expect(parseCodeRefs(s)).toEqual(input);
  });

  test("stringifyCodeRefs returns null for empty / null / undefined", () => {
    expect(stringifyCodeRefs([])).toBeNull();
    expect(stringifyCodeRefs(null)).toBeNull();
    expect(stringifyCodeRefs(undefined)).toBeNull();
  });

  test("stringifyCodeRefs dedupes and trims", () => {
    expect(stringifyCodeRefs(["a.ts", "  a.ts  ", "b.ts", ""])).toBe(
      JSON.stringify(["a.ts", "b.ts"])
    );
  });

  test("stringifyCodeRefs drops all-whitespace entries", () => {
    expect(stringifyCodeRefs(["   ", "\t", ""])).toBeNull();
  });

  test("parseCodeRefs handles null / empty string", () => {
    expect(parseCodeRefs(null)).toBeNull();
    expect(parseCodeRefs("")).toBeNull();
  });

  test("parseCodeRefs rejects invalid JSON", () => {
    expect(parseCodeRefs("not json")).toBeNull();
  });

  test("parseCodeRefs rejects non-array JSON", () => {
    expect(parseCodeRefs('"just a string"')).toBeNull();
    expect(parseCodeRefs('{"obj": true}')).toBeNull();
  });

  test("parseCodeRefs rejects arrays of non-strings", () => {
    expect(parseCodeRefs("[1,2,3]")).toBeNull();
    expect(parseCodeRefs('["a", 2, "c"]')).toBeNull();
  });

  test("parseCodeRefs collapses empty array to null", () => {
    expect(parseCodeRefs("[]")).toBeNull();
  });
});

describe("R5 code_refs: write + read path", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("note() with code_refs stores JSON and retrieves as array", async () => {
    const created = await handleRemember(projectDb, globalDb, {
      content: "architecture of the signal module",
      type: "architecture",
      code_refs: ["mcp/engine/signal.ts", "mcp/server.ts"],
    });
    expect(created.stored).toBe(true);
    const row = projectDb
      .query("SELECT code_refs FROM notes WHERE id = ?")
      .get(created.note_id!) as any;
    expect(parseCodeRefs(row.code_refs)).toEqual([
      "mcp/engine/signal.ts",
      "mcp/server.ts",
    ]);

    const result = await handleRecall(projectDb, globalDb, { id: created.note_id! });
    expect(result.detail?.code_refs).toEqual([
      "mcp/engine/signal.ts",
      "mcp/server.ts",
    ]);
  });

  test("note() without code_refs stores NULL", async () => {
    const created = await handleRemember(projectDb, globalDb, {
      content: "some decision",
      type: "decision",
    });
    const row = projectDb
      .query("SELECT code_refs FROM notes WHERE id = ?")
      .get(created.note_id!) as any;
    expect(row.code_refs).toBeNull();

    const result = await handleRecall(projectDb, globalDb, { id: created.note_id! });
    expect(result.detail?.code_refs).toBeNull();
  });

  test("note() with empty code_refs array stores NULL", async () => {
    const created = await handleRemember(projectDb, globalDb, {
      content: "another decision",
      type: "decision",
      code_refs: [],
    });
    const row = projectDb
      .query("SELECT code_refs FROM notes WHERE id = ?")
      .get(created.note_id!) as any;
    expect(row.code_refs).toBeNull();
  });

  test("code_refs survives search-mode lookup via NoteSummary", async () => {
    const created = await handleRemember(projectDb, globalDb, {
      content: "gossamer zymurgy nyctalopia",
      type: "architecture",
      code_refs: ["path/to/thing.ts"],
    });
    expect(created.stored).toBe(true);

    const result = await handleRecall(projectDb, globalDb, {
      query: "gossamer zymurgy",
    });
    const match = result.results.find((r) => r.id === created.note_id);
    expect(match).toBeTruthy();
    expect(match!.code_refs).toEqual(["path/to/thing.ts"]);
  });
});

describe("R5 code_refs: reverse-index lookup", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("lookup({code_ref: 'path'}) filters to notes referencing that path", async () => {
    // Unique word shared across all 4 so FTS5 returns them; remaining words
    // deliberately diverse to stay clear of Jaccard dedup (MIN_SHARED_KEYWORDS=3).
    await handleRemember(projectDb, globalDb, {
      content: "alphaword kestrel hibiscus zeppelin",
      type: "insight",
      code_refs: ["mcp/server.ts"],
    });
    await handleRemember(projectDb, globalDb, {
      content: "alphaword nebula goblin quicksand",
      type: "insight",
      code_refs: ["mcp/engine/signal.ts"],
    });
    await handleRemember(projectDb, globalDb, {
      content: "alphaword driftwood marzipan ossuary",
      type: "insight",
      code_refs: ["mcp/server.ts", "mcp/engine/linker.ts"],
    });
    await handleRemember(projectDb, globalDb, {
      content: "alphaword xylophone parabola tundra",
      type: "insight",
    });

    const result = await handleRecall(projectDb, globalDb, {
      query: "alphaword",
      code_ref: "mcp/server.ts",
    });
    expect(result.results.length).toBe(2);
    const refsLists = result.results.map((r) => r.code_refs ?? []);
    for (const refs of refsLists) {
      expect(refs).toContain("mcp/server.ts");
    }
  });

  test("lookup({code_ref}) requires exact match, not substring", async () => {
    await handleRemember(projectDb, globalDb, {
      content: "betaword first",
      type: "insight",
      code_refs: ["mcp/server.ts"],
    });
    await handleRemember(projectDb, globalDb, {
      content: "betaword second",
      type: "insight",
      code_refs: ["mcp/server.ts.bak"],
    });

    const result = await handleRecall(projectDb, globalDb, {
      query: "betaword",
      code_ref: "mcp/server.ts",
    });
    expect(result.results.length).toBe(1);
    expect(result.results[0].code_refs).toEqual(["mcp/server.ts"]);
  });

  test("lookup without code_ref returns all matching results", async () => {
    await handleRemember(projectDb, globalDb, {
      content: "gamma unique one",
      type: "insight",
      code_refs: ["mcp/server.ts"],
    });
    await handleRemember(projectDb, globalDb, {
      content: "gamma unique two",
      type: "insight",
    });
    const result = await handleRecall(projectDb, globalDb, { query: "gamma unique" });
    expect(result.results.length).toBeGreaterThanOrEqual(2);
  });

  test("lookup({code_ref}) returns empty when no note references the path", async () => {
    await handleRemember(projectDb, globalDb, {
      content: "deltaword x",
      type: "insight",
      code_refs: ["other/place.ts"],
    });
    const result = await handleRecall(projectDb, globalDb, {
      query: "deltaword",
      code_ref: "nothing/here.ts",
    });
    expect(result.results.length).toBe(0);
  });
});

describe("R5 code_refs: supersede inline-creation passes code_refs through", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("supersede_note new_content path stores code_refs on the replacement", async () => {
    const old = await handleRemember(projectDb, globalDb, {
      content: "original decision text",
      type: "decision",
    });
    const result = await handleSupersede(projectDb, globalDb, {
      old_id: old.note_id!,
      new_content: "updated architecture notes for the signal module",
      new_type: "architecture",
      code_refs: ["mcp/engine/signal.ts"],
    });
    expect(result.superseded).toBe(true);
    expect(result.new_id).toBeTruthy();
    const newRow = projectDb
      .query("SELECT code_refs FROM notes WHERE id = ?")
      .get(result.new_id!) as any;
    expect(parseCodeRefs(newRow.code_refs)).toEqual(["mcp/engine/signal.ts"]);
  });

  test("supersede_note new_id path does NOT touch target's code_refs", async () => {
    // Create an existing replacement note that already has its own code_refs.
    const replacement = await handleRemember(projectDb, globalDb, {
      content: "zeroword replacement content",
      type: "decision",
      code_refs: ["kept/original.ts"],
    });
    const oldNote = await handleRemember(projectDb, globalDb, {
      content: "zeroword original stale decision",
      type: "decision",
    });

    const result = await handleSupersede(projectDb, globalDb, {
      old_id: oldNote.note_id!,
      new_id: replacement.note_id!,
      // code_refs deliberately supplied - should be ignored in new_id path.
      code_refs: ["should/be/ignored.ts"],
    });
    expect(result.superseded).toBe(true);
    const row = projectDb
      .query("SELECT code_refs FROM notes WHERE id = ?")
      .get(replacement.note_id!) as any;
    expect(parseCodeRefs(row.code_refs)).toEqual(["kept/original.ts"]);
  });
});
