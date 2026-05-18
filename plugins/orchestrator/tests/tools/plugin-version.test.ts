import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// WI 6fe9199c / KB 8349cf8d. The hardcoded-version-string-in-server.ts class
// has recurred 3+ times (notes 19a4438a, c1f87b01, and again here): the
// 0.30.31 fix routed the McpServer-registration field + startup banner
// through PLUGIN_VERSION, but the `system_status` tool re-introduced a
// LITERAL `**0.30.28**` on its Version line. Result: system_status reported
// 0.30.28 forever regardless of the actually-running bundle, which caused a
// multi-turn phantom misdiagnosis ("deployment pin"/"resolution cache" - all
// false; the code was 0.30.39 the whole time). 8349cf8d's rule: "Do NOT
// re-introduce hardcoded version strings in server.ts." This guard enforces
// it permanently and source-wide so the next reintroduction fails CI.

const SERVER_TS = readFileSync(
  join(import.meta.dir, "..", "..", "mcp", "server.ts"),
  "utf8"
);

describe("PLUGIN_VERSION integrity (WI 6fe9199c / KB 8349cf8d)", () => {
  test("the system_status Version line uses ${PLUGIN_VERSION}, never a hardcoded semver", () => {
    const versionLines = SERVER_TS.split("\n").filter(
      (l) => l.includes("orchestrator MCP server") && l.includes("Version")
    );
    expect(versionLines.length).toBeGreaterThan(0); // the line must still exist
    for (const l of versionLines) {
      expect(l).toContain("${PLUGIN_VERSION}");
      // No `**X.Y.Z` hardcoded version adjacent to the display.
      expect(l).not.toMatch(/\*\*\d+\.\d+\.\d+/);
    }
  });

  test("McpServer registration + startup banner remain PLUGIN_VERSION-driven (lock the 0.30.31 fix)", () => {
    expect(SERVER_TS).toMatch(/version:\s*PLUGIN_VERSION/); // McpServer registration field
    expect(SERVER_TS).toMatch(/version=\$\{PLUGIN_VERSION\}/); // startup banner
  });

  test("PLUGIN_VERSION is resolved dynamically from package.json (not a literal)", () => {
    expect(SERVER_TS).toMatch(/const PLUGIN_VERSION[^=]*=\s*\(\(\)\s*=>/);
    expect(SERVER_TS).toContain('"..", "package.json"');
    // The catch fallback must be an honest sentinel, never a real version
    // (a real-version fallback would silently misreport on any read failure).
    expect(SERVER_TS).toMatch(/catch\s*\{\s*\n?\s*return\s*"0\.0\.0-unknown"/);
  });
});
