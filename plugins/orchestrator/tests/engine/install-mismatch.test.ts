import { describe, expect, test } from "bun:test";
import {
  decideInstallMismatch,
  extractInstalledPaths,
  formatMismatchLine,
  formatMismatchNudge,
  shouldNudgeMismatch,
  MISMATCH_NUDGE_INTERVAL_MS,
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

// ===========================================================================
// EVERY-TURN NUDGE (WI 61da44fa, 2026-09-06).
//
// The detector has been correct since 0.69.2 and was read by nobody. It fired
// FIVE times on 2026-09-06, predicting the day's duplicate-MCP failure nine
// minutes before it happened with the work-item id attached, and two agents
// plus a warden still rebuilt the diagnosis by hand from process tables. The
// routing was the defect, not the detection - so these arms are about WHEN the
// message reaches a reader, which is now as load-bearing as whether it is true.
// ===========================================================================

describe("shouldNudgeMismatch", () => {
  test("FIRES ON THE FIRST CALL - the arm most likely to be written wrong", () => {
    // The first turn after a straddle begins is the single most valuable
    // moment to say so. A gate that treated "never nudged" as "nudged just
    // now" would swallow exactly that turn, and would be the same
    // cannot-fire-on-its-own-motivating-case shape that has already cost this
    // work item forty minutes once today.
    expect(shouldNudgeMismatch(null, 1_000_000)).toBe(true);
  });

  test("stays quiet inside the interval", () => {
    const t = 1_000_000;
    expect(shouldNudgeMismatch(t, t + MISMATCH_NUDGE_INTERVAL_MS - 1)).toBe(false);
  });

  test("fires again exactly at the interval, not one tick later", () => {
    // A session that compacts and loses the briefing banner needs to meet this
    // again promptly; an off-by-one here silently doubles the quiet window.
    const t = 1_000_000;
    expect(shouldNudgeMismatch(t, t + MISMATCH_NUDGE_INTERVAL_MS)).toBe(true);
  });

  test("a clock that goes backwards does not spam", () => {
    // Wall-clock adjustments happen. A negative delta must read as "recent",
    // never as "overdue" - the failure mode there is a nudge on every turn,
    // which trains the reader to skip the one banner that matters.
    const t = 1_000_000;
    expect(shouldNudgeMismatch(t, t - 5_000)).toBe(false);
  });
});

describe("formatMismatchNudge", () => {
  const check = {
    verdict: "mismatch" as const,
    runningRoot: "c:/users/j/.claude/plugins/cache/mp/orchestrator/0.69.10",
    installedPaths: ["c:/users/j/.claude/plugins/cache/mp/orchestrator/0.69.11"],
    reason: "sibling of an installed path",
  };

  test("names both directories, so the reader can verify rather than trust", () => {
    const n = formatMismatchNudge(check);
    expect(n).toContain("0.69.10");
    expect(n).toContain("0.69.11");
  });

  test("carries the remedy AND rules out the remedy that does not work", () => {
    // Killing the duplicate was tried twice on 2026-09-06 and it respawned
    // within three minutes both times. A nudge that names only the symptom
    // invites the reader to rediscover that at their own cost.
    const n = formatMismatchNudge(check);
    expect(n).toContain("restart this window");
    expect(n.toLowerCase()).toContain("does not");
  });

  test("attributes the cause upstream, so nobody re-hunts it in the plugin", () => {
    const n = formatMismatchNudge(check);
    expect(n).toContain("61da44fa");
    expect(n).toContain("claude-code#25976");
  });

  test("is distinct from the durable log line, which serves a different reader", () => {
    // The log line is greppable provenance for a human reading after the fact
    // and carries the rollback caveat; the nudge interrupts an agent mid-task
    // and leads with the consequence to the work in front of it.
    expect(formatMismatchNudge(check)).not.toBe(formatMismatchLine(check));
  });
});
