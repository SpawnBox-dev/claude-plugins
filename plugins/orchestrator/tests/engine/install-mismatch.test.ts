import { describe, expect, test } from "bun:test";
import {
  decideInstallMismatch,
  extractInstalledPaths,
  formatMismatchLine,
  normalizePath,
} from "../../mcp/engine/install_mismatch";

/** The real cache shape, from the 2026-08-29 incident. */
const CACHE = "c:/users/jarid/.claude/plugins/cache/spawnbox-dev-claude-plugins/orchestrator";
const V68 = `${CACHE}/0.68.0`;
const V690 = `${CACHE}/0.69.0`;
const V691 = `${CACHE}/0.69.1`;
const CHECKOUT = "c:/users/jarid/onedrive/appdev/claude-plugins/plugins/orchestrator";

describe("install-mismatch decision (WI 61da44fa)", () => {
  test("THE FIELD CASE: running a sibling cache version while another is installed = mismatch", () => {
    // This is the 2026-08-29 straddle, exactly: the window boot-latched 0.68.0,
    // the registry named 0.69.0, and 95 minutes of duplicate spawns followed
    // with nothing anywhere saying so.
    const check = decideInstallMismatch(V68, [V690]);
    expect(check.verdict).toBe("mismatch");
    expect(check.reason).toContain(V68);
    expect(check.reason).toContain(V690);
  });

  test("running the installed directory = match", () => {
    expect(decideInstallMismatch(V691, [V691]).verdict).toBe("match");
  });

  // The control that makes the mismatch result mean something. A rule that
  // fires on the field case but ALSO on an ordinary developer run would be
  // indistinguishable from one that always fires - and a repo working copy is
  // the single most common way this code will ever be executed.
  test("CONTROL: a source checkout is NOT a mismatch", () => {
    const check = decideInstallMismatch(CHECKOUT, [V691]);
    expect(check.verdict).toBe("not-a-cache-copy");
  });

  test("CONTROL: an empty registry is 'unknown', never 'mismatch'", () => {
    // Absence of evidence. The orphan watchdog shipped a bug by collapsing
    // exactly this third state into the bad one (WI 590bf9a9); it is not
    // repeated here.
    const check = decideInstallMismatch(V68, []);
    expect(check.verdict).toBe("unknown");
  });

  test("multi-scope registry: matching ANY installed entry wins over a sibling mismatch", () => {
    // A user-scope and a project-scope entry can both be present. Reporting a
    // mismatch against the first while the second matches would be a false
    // alarm produced purely by iteration order.
    expect(decideInstallMismatch(V691, [V690, V691]).verdict).toBe("match");
    expect(decideInstallMismatch(V691, [V691, V690]).verdict).toBe("match");
  });

  test("a different plugin's cache tree is not a sibling, so it is not a mismatch", () => {
    const other = "c:/users/jarid/.claude/plugins/cache/claude-plugins-official/playwright/1.0.0";
    expect(decideInstallMismatch(other, [V691]).verdict).toBe("not-a-cache-copy");
  });

  test("a root with no parent cannot be a sibling of anything", () => {
    expect(decideInstallMismatch("c:", [V691]).verdict).toBe("not-a-cache-copy");
  });
});

describe("path normalization", () => {
  test("backslashes, trailing separators and case fold to one spelling", () => {
    const win = "C:\\Users\\Jarid\\.claude\\plugins\\cache\\m\\orchestrator\\0.69.1\\";
    expect(normalizePath(win, true)).toBe(
      "c:/users/jarid/.claude/plugins/cache/m/orchestrator/0.69.1",
    );
  });

  test("case is preserved when folding is off, so Linux paths stay distinct", () => {
    expect(normalizePath("/home/u/Plugins/X", false)).toBe("/home/u/Plugins/X");
    expect(normalizePath("/home/u/Plugins/X", true)).toBe("/home/u/plugins/x");
  });

  test("normalization is what makes a real Windows pair compare equal", () => {
    // installed_plugins.json stores backslashed paths; import.meta.dir yields
    // forward slashes. Un-normalized, these two spellings of ONE directory
    // compare unequal and the check reports a mismatch that does not exist.
    const fromRegistry = normalizePath(
      "C:\\Users\\Jarid\\.claude\\plugins\\cache\\m\\orchestrator\\0.69.1",
      true,
    );
    const fromRuntime = normalizePath(
      "c:/Users/Jarid/.claude/plugins/cache/m/orchestrator/0.69.1",
      true,
    );
    expect(decideInstallMismatch(fromRuntime, [fromRegistry]).verdict).toBe("match");
  });
});

describe("registry parsing", () => {
  const REG = {
    version: 2,
    plugins: {
      "rust-analyzer-lsp@claude-plugins-official": [
        { scope: "user", installPath: "C:\\x\\rust\\1.0.0", version: "1.0.0" },
      ],
      "orchestrator@spawnbox-dev-claude-plugins": [
        { scope: "user", installPath: "C:\\Users\\Jarid\\.claude\\plugins\\cache\\m\\orchestrator\\0.69.1" },
      ],
    },
  };

  test("finds this plugin's path and normalizes it, ignoring other plugins", () => {
    const paths = extractInstalledPaths(REG, "orchestrator", true);
    expect(paths).toEqual(["c:/users/jarid/.claude/plugins/cache/m/orchestrator/0.69.1"]);
  });

  test("the marketplace segment is not assumed - any @marketplace matches", () => {
    const reg = { plugins: { "orchestrator@some-other-market": [{ installPath: "/a/b" }] } };
    expect(extractInstalledPaths(reg, "orchestrator", false)).toEqual(["/a/b"]);
  });

  test("a plugin whose NAME merely starts with ours is not matched", () => {
    // "orchestrator-extras@m" must not be read as our install.
    const reg = { plugins: { "orchestrator-extras@m": [{ installPath: "/a/b" }] } };
    expect(extractInstalledPaths(reg, "orchestrator", false)).toEqual([]);
  });

  test("multiple scopes both come through, in registry order", () => {
    const reg = {
      plugins: { "orchestrator@m": [{ installPath: "/a" }, { installPath: "/b" }] },
    };
    expect(extractInstalledPaths(reg, "orchestrator", false)).toEqual(["/a", "/b"]);
  });

  // Controls: every malformed shape must yield [] -> "unknown", never a
  // fabricated path that could produce a false mismatch.
  test("CONTROL: malformed registries yield no paths rather than an alarm", () => {
    for (const bad of [null, undefined, 42, "text", {}, { plugins: null }, { plugins: 7 }]) {
      expect(extractInstalledPaths(bad, "orchestrator", false)).toEqual([]);
    }
    expect(extractInstalledPaths({ plugins: { "orchestrator@m": [{}] } }, "orchestrator", false))
      .toEqual([]);
    expect(
      extractInstalledPaths({ plugins: { "orchestrator@m": [{ installPath: 5 }] } }, "orchestrator", false),
    ).toEqual([]);
  });

  test("end to end: a registry naming a sibling version produces a mismatch", () => {
    const paths = extractInstalledPaths(
      { plugins: { "orchestrator@m": [{ installPath: V690.replace(/\//g, "\\") }] } },
      "orchestrator",
      true,
    );
    expect(decideInstallMismatch(V68, paths).verdict).toBe("mismatch");
  });
});

describe("operator-facing line", () => {
  test("names both directories and the remedy, and claims no fault", () => {
    const line = formatMismatchLine(decideInstallMismatch(V68, [V690]));
    expect(line).toContain(V68);
    expect(line).toContain(V690);
    expect(line).toContain("Restart THIS window");
    expect(line).toContain("61da44fa");
    // The wording must not assert breakage: a deliberate rollback reads the
    // same, and an alert that overstates its evidence gets discounted.
    expect(line).toContain("not a fault");
  });
});
