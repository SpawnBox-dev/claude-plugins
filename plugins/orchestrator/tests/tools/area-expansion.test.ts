import { describe, test, expect } from "bun:test";
import { deriveArea, isNewArea } from "../../mcp/tools/hook_event";

// ===========================================================================
// 0.30.80: exploration-driven scope expansion.
//
// Jarid, correcting 0.30.75's prompt-string triggers: "the real value would be
// in the agent noticing scope is expanding as it uncovers more and more about
// systems during its exploratory operations, and then it needs to know to
// query the kb as it goes."
//
// The prompt detectors only see what the USER says. They cannot see the case
// that dominates: an agent starts in one subsystem, follows a reference into a
// second, then a third, and by the fifth file is deep in territory it has
// never worked - with no prompt issued anywhere in that walk. The agent's own
// footprint is the signal.
// ===========================================================================

describe("deriveArea", () => {
  test("uses the containing directory, matching how code_refs are stored", () => {
    expect(deriveArea("worker/src/routes/telemetry.ts")).toBe("worker/src/routes");
    expect(deriveArea("src-tauri/src/core/backup/engine.rs")).toBe(
      "src-tauri/src/core/backup"
    );
  });

  test("normalizes Windows separators and leading ./", () => {
    // NB: written with String.raw so the backslashes survive as literal path
    // separators. A plain "worker\src\..." literal would silently become
    // control characters (\r, \t), which is a great way to "prove" a
    // normalization bug that does not exist.
    expect(deriveArea(String.raw`worker\src\routes\telemetry.ts`)).toBe(
      "worker/src/routes"
    );
    expect(deriveArea("./worker/src/routes/telemetry.ts")).toBe("worker/src/routes");
  });

  test("returns null for a repo-root file - too coarse to be an area", () => {
    expect(deriveArea("README.md")).toBeNull();
    expect(deriveArea("")).toBeNull();
  });
});

describe("isNewArea", () => {
  test("true the first time an area is touched", () => {
    expect(isNewArea("worker/src/routes", [])).toBe(true);
    expect(isNewArea("worker/src/routes", ["dashboard/src"])).toBe(true);
  });

  test("false once visited - fires ONCE per area per session", () => {
    expect(isNewArea("worker/src/routes", ["worker/src/routes"])).toBe(false);
  });

  test("sibling directories are distinct areas", () => {
    // Walking from routes into services IS an expansion worth surfacing.
    expect(isNewArea("worker/src/services", ["worker/src/routes"])).toBe(true);
  });

  test("models the multi-hop walk that has no user prompt in it", () => {
    const visited: string[] = [];
    const walk = [
      "worker/src/routes/telemetry.ts",
      "worker/src/routes/funnel.ts",
      "worker/src/services/quota.ts",
      "dashboard/src/views/LifecycleView.tsx",
    ];
    const fired: string[] = [];
    for (const f of walk) {
      const area = deriveArea(f)!;
      if (isNewArea(area, visited)) {
        fired.push(area);
        visited.push(area);
      }
    }
    // Two files in routes -> one fire. Then services, then dashboard.
    expect(fired).toEqual([
      "worker/src/routes",
      "worker/src/services",
      "dashboard/src/views",
    ]);
  });
});
