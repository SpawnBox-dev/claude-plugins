/**
 * Install-mismatch self-check (WI 61da44fa) - "am I running the version that is
 * actually installed?"
 *
 * WHY THIS EXISTS. On 2026-08-29 a fleet window was left running while
 * `/plugin update` replaced 0.68.0 with 0.69.0 underneath it. For the next 95
 * minutes that ONE window produced 15 MCP server starts in strict alternation
 * between the two cache directories, while five windows launched after the
 * install produced exactly one start each. Under the age-based dedup of the
 * time, those churned spawns killed the server that was serving a live client -
 * twice in ten minutes. The condition was silent from every angle: the log said
 * `version=0.68.0`, which reads as information rather than as an alarm, and
 * nothing anywhere said "that is not the version you installed".
 *
 * The trigger was not even new. `5c3ee3d` (2026-05-12), the commit that created
 * `killOlderDuplicateMcps`, names it in its own message: a `/plugin update`
 * sequence hits Claude Code's plugin-manager race (anthropics/claude-code#25976)
 * and leaves two servers alive under one parent. The knowledge was lost, not
 * missing - which is exactly the failure a loud runtime line prevents and a
 * knowledge base does not.
 *
 * WHY IT COMPARES PATHS AND NOT VERSION STRINGS. A version string is read from
 * the package.json of whatever directory the bundle was loaded from, so it
 * describes the DIRECTORY, not the bytes. During the same incident three cache
 * dirs held byte-identical bundles under three different version labels, and a
 * server running patched code truthfully reported `version=0.68.0`. Any check
 * built on comparing version strings would have been satisfied by that lie.
 * The directory a module was loaded from cannot lie about itself.
 *
 * WHAT IT DOES NOT CLAIM. A mismatch says "this process is running from a
 * directory the registry does not name as installed". It does NOT say the code
 * is wrong, that anything has broken, or which of the two is correct - a
 * deliberate rollback looks identical. It is a fact worth surfacing, not a
 * diagnosis, and the wording of the emitted line holds that line deliberately.
 */

export type InstallVerdict =
  /** Running from a directory the registry names as installed. */
  | "match"
  /** Running from a SIBLING of an installed directory - the straddle case. */
  | "mismatch"
  /** Not running from the plugin cache at all (dev checkout, linked source). */
  | "not-a-cache-copy"
  /** Registry unreadable, absent, or naming no install for this plugin. */
  | "unknown";

export interface InstallCheck {
  verdict: InstallVerdict;
  /** Normalized directory this process's bundle was loaded from. */
  runningRoot: string;
  /** Normalized install paths the registry names, in registry order. */
  installedPaths: string[];
  /** One sentence, safe to put in front of a human. */
  reason: string;
}

/**
 * Normalize for comparison: forward slashes, no trailing separator.
 *
 * `caseFold` is a parameter rather than a `process.platform` read so the rule is
 * testable on any host. Fold on Windows and macOS, where two spellings of one
 * path denote one directory; do not fold on Linux, where they do not.
 */
export function normalizePath(p: string, caseFold: boolean): string {
  const slashed = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return caseFold ? slashed.toLowerCase() : slashed;
}

/** Parent directory of a normalized path, or "" if it has none. */
function parentOf(normalized: string): string {
  const i = normalized.lastIndexOf("/");
  return i <= 0 ? "" : normalized.slice(0, i);
}

/**
 * Decide, from already-normalized inputs, whether this process is running the
 * installed copy.
 *
 * The rules, and each is load-bearing:
 *
 * - No installed paths at all -> `unknown`. Absence of a registry entry is not
 *   evidence of a mismatch; a caller must never escalate on it. This is the
 *   same discipline the orphan watchdog needed: "could not determine" is a
 *   third state, not a quiet synonym for the bad one.
 *
 * - Running root is among them -> `match`. Checked first so a multi-scope
 *   registry (user + project entries) cannot produce a mismatch against one
 *   entry while matching another.
 *
 * - Running root SHARES A PARENT with an installed path -> `mismatch`. This is
 *   the discriminator, and it is derived from the data rather than from a
 *   hardcoded `.claude/plugins/cache` fragment that a future layout change
 *   would silently invalidate. Cache versions live as siblings under one
 *   plugin directory, so "sibling of an installed path" IS "a different
 *   installed version of the same plugin".
 *
 * - Anywhere else -> `not-a-cache-copy`. A dev checkout or a linked source tree
 *   is not a mismatch and must never be reported as one; a repo working copy
 *   would otherwise fire this alarm on every developer run forever.
 */
export function decideInstallMismatch(
  runningRoot: string,
  installedPaths: string[],
): InstallCheck {
  const base = { runningRoot, installedPaths };

  if (installedPaths.length === 0) {
    return {
      ...base,
      verdict: "unknown",
      reason:
        "the plugin registry names no install for this plugin, so there is nothing to compare against",
    };
  }

  if (installedPaths.includes(runningRoot)) {
    return {
      ...base,
      verdict: "match",
      reason: "running from the directory the plugin registry names as installed",
    };
  }

  const runningParent = parentOf(runningRoot);
  const sibling = installedPaths.find(
    (p) => runningParent !== "" && parentOf(p) === runningParent,
  );
  if (sibling) {
    return {
      ...base,
      verdict: "mismatch",
      reason:
        `running from ${runningRoot} but the plugin registry names ${sibling} as installed - ` +
        `this window is on a different version of the plugin than the one installed`,
    };
  }

  return {
    ...base,
    verdict: "not-a-cache-copy",
    reason:
      "running from outside the plugin cache (a source checkout or linked tree), so the installed path does not apply",
  };
}

/**
 * Pull this plugin's install paths out of an already-parsed
 * `installed_plugins.json`.
 *
 * Kept pure (takes the parsed object, not a filename) so every shape the file
 * can actually take is testable without a filesystem: the key is
 * `"<plugin>@<marketplace>"` so the marketplace segment must not be assumed,
 * the value is an ARRAY because one plugin can be installed at more than one
 * scope, and entries in the wild have been seen without `installPath`.
 *
 * Anything unreadable yields an empty list, which the decision rule maps to
 * `unknown` rather than to `mismatch` - a malformed registry must never be able
 * to manufacture an alarm.
 */
export function extractInstalledPaths(
  registry: unknown,
  pluginName: string,
  caseFold: boolean,
): string[] {
  const plugins = (registry as { plugins?: unknown } | null)?.plugins;
  if (!plugins || typeof plugins !== "object") return [];

  const out: string[] = [];
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (key !== pluginName && !key.startsWith(`${pluginName}@`)) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      const p = (entry as { installPath?: unknown } | null)?.installPath;
      if (typeof p === "string" && p.length > 0) out.push(normalizePath(p, caseFold));
    }
  }
  return out;
}

/**
 * The operator-facing line for a mismatch. Kept beside the rule so the wording
 * and the verdict cannot drift apart.
 *
 * It states the CONDITION and the REMEDY and stops there. It does not assert
 * that anything is broken - a deliberate rollback produces an identical
 * reading - because an alert that overstates its evidence trains its readers to
 * discount it, which is how the sibling transport detector reached 0-for-11
 * before anyone questioned the wording.
 */
export function formatMismatchLine(check: InstallCheck): string {
  return (
    `install-mismatch: this window is running the plugin from ${check.runningRoot}, ` +
    `but installed_plugins.json names ${check.installedPaths.join(", ")}. ` +
    `Restart THIS window to pick up the installed copy. ` +
    `Until then expect duplicate MCP servers under this window - the harness can ` +
    `start the plugin from either directory (WI 61da44fa). ` +
    `This is a statement of fact, not a fault: a deliberate rollback looks the same.`
  );
}
