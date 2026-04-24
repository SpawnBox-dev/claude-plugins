import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../../mcp/db/schema";
import { handleReflect } from "../../mcp/tools/reflect";
import { handleRemember } from "../../mcp/tools/remember";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("R5 code_refs: retro verification pass", () => {
  let projectDb: Database;
  let globalDb: Database;
  let originalProjectDir: string | undefined;
  let originalOrchestratorRoot: string | undefined;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    originalOrchestratorRoot = process.env.ORCHESTRATOR_PROJECT_ROOT;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.ORCHESTRATOR_PROJECT_ROOT;
  });

  afterEach(() => {
    if (originalProjectDir !== undefined) {
      process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    } else {
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    if (originalOrchestratorRoot !== undefined) {
      process.env.ORCHESTRATOR_PROJECT_ROOT = originalOrchestratorRoot;
    } else {
      delete process.env.ORCHESTRATOR_PROJECT_ROOT;
    }
  });

  test("graceful degradation when no project root env is set", async () => {
    // Seed a note with a code_ref. With no project root env, the retro
    // pass must NOT crash and must report zero checked refs.
    await handleRemember(projectDb, globalDb, {
      content: "note pointing at some path",
      type: "insight",
      code_refs: ["mcp/server.ts"],
    });
    const result = handleReflect(projectDb, globalDb, {});
    expect(result.code_refs_checked).toBe(0);
    expect(result.code_refs_broken).toBe(0);
    expect(result.message).not.toContain("code_refs verified");
  });

  test("verifies refs against CLAUDE_PROJECT_DIR: all resolve", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "orch-refs-"));
    try {
      writeFileSync(path.join(tmpRoot, "existing.ts"), "// stub\n");
      process.env.CLAUDE_PROJECT_DIR = tmpRoot;

      await handleRemember(projectDb, globalDb, {
        content: "note pointing at an existing file",
        type: "insight",
        code_refs: ["existing.ts"],
      });

      const result = handleReflect(projectDb, globalDb, {});
      expect(result.code_refs_checked).toBe(1);
      expect(result.code_refs_broken).toBe(0);
      expect(result.message).toContain("code_refs verified: 1 refs");
      expect(result.message).toContain("0 broken");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("verifies refs: detects broken paths", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "orch-refs-"));
    try {
      writeFileSync(path.join(tmpRoot, "real.ts"), "// stub\n");
      process.env.CLAUDE_PROJECT_DIR = tmpRoot;

      await handleRemember(projectDb, globalDb, {
        content: "note with mix of real and broken refs",
        type: "insight",
        code_refs: ["real.ts", "does-not-exist.ts", "also/missing/path/"],
      });

      const result = handleReflect(projectDb, globalDb, {});
      expect(result.code_refs_checked).toBe(3);
      expect(result.code_refs_broken).toBe(2);
      expect(result.message).toContain("code_refs verified: 3 refs");
      expect(result.message).toContain("2 broken");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("retro skips resolved and superseded notes", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "orch-refs-"));
    try {
      process.env.CLAUDE_PROJECT_DIR = tmpRoot;

      // Note 1: resolved - should be skipped. Use content keyword-disjoint
      // from the other two to avoid Jaccard dedup (MIN_SHARED_KEYWORDS=3).
      const resolved = await handleRemember(projectDb, globalDb, {
        content: "zeppelin kestrel hibiscus dormant",
        type: "open_thread",
        code_refs: ["gone.ts"],
      });
      projectDb.run(`UPDATE notes SET resolved = 1 WHERE id = ?`, [resolved.note_id!]);

      // Note 2: superseded - should be skipped. Different type so no cross-
      // type Jaccard coincidence can merge it with note 1 either.
      const superseded = await handleRemember(projectDb, globalDb, {
        content: "nebula goblin quicksand marzipan",
        type: "insight",
        code_refs: ["also-gone.ts"],
      });
      projectDb.run(
        `UPDATE notes SET superseded_by = ? WHERE id = ?`,
        ["somewhere-else", superseded.note_id!]
      );

      // Note 3: live - should be the only one checked.
      await handleRemember(projectDb, globalDb, {
        content: "driftwood xylophone ossuary parabola",
        type: "architecture",
        code_refs: ["still-broken.ts"],
      });

      const result = handleReflect(projectDb, globalDb, {});
      expect(result.code_refs_checked).toBe(1);
      expect(result.code_refs_broken).toBe(1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("retro runs cleanly when no notes have code_refs", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "orch-refs-"));
    try {
      process.env.CLAUDE_PROJECT_DIR = tmpRoot;

      await handleRemember(projectDb, globalDb, {
        content: "plain note without refs",
        type: "insight",
      });

      const result = handleReflect(projectDb, globalDb, {});
      expect(result.code_refs_checked).toBe(0);
      expect(result.code_refs_broken).toBe(0);
      expect(result.message).not.toContain("code_refs verified");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("honors ORCHESTRATOR_PROJECT_ROOT as a fallback when CLAUDE_PROJECT_DIR is unset", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "orch-refs-"));
    try {
      writeFileSync(path.join(tmpRoot, "here.ts"), "// stub\n");
      process.env.ORCHESTRATOR_PROJECT_ROOT = tmpRoot;

      await handleRemember(projectDb, globalDb, {
        content: "note with ref",
        type: "insight",
        code_refs: ["here.ts", "missing.ts"],
      });

      const result = handleReflect(projectDb, globalDb, {});
      expect(result.code_refs_checked).toBe(2);
      expect(result.code_refs_broken).toBe(1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
