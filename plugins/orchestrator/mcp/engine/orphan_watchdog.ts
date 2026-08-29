/**
 * Orphan-watchdog decision rule (WI 590bf9a9).
 *
 * Extracted from server.ts so the rule can be unit-tested. server.ts performs
 * the OBSERVATION (tasklist / /proc) and this module makes the DECISION; the
 * observation needs a live process tree, the decision does not, and mixing them
 * is why this logic previously shipped untested.
 */

/**
 * Three states, not a boolean. "I could not determine whether the parent is
 * alive" is a different claim from "the parent is dead", and collapsing them is
 * exactly the defect this module exists to prevent: on 2026-08-29 a single
 * transient failure read as a dead parent and shut down a healthy server.
 */
export type ParentLiveness = "alive" | "dead" | "undetermined";

export type WatchdogAction =
  /** Parent confirmed gone enough times - shut down. */
  | "shutdown"
  /** Determined-dead, but not yet enough consecutive readings. */
  | "wait"
  /** Parent alive; any dead streak is cleared. */
  | "clear"
  /** Could not determine; carries no information in either direction. */
  | "ignore";

export interface WatchdogDecision {
  action: WatchdogAction;
  /** The streak AFTER this observation - callers store this back. */
  streak: number;
}

/**
 * Given an observation and the current consecutive-determined-dead streak,
 * decide what the watchdog should do.
 *
 * The rules, and each one is load-bearing:
 * - `alive`        -> clear the streak. A live reading invalidates prior deads.
 * - `dead`         -> increment; shut down only once the streak reaches
 *                     `threshold`. One sample is not enough.
 * - `undetermined` -> do NOTHING to the streak. It must not advance a kill
 *                     (that is the bug), and it must not reset one either -
 *                     an inconclusive reading is not evidence of life. A parent
 *                     that dies while the probe is flaky would otherwise never
 *                     accumulate a streak.
 */
export function decideWatchdogAction(
  liveness: ParentLiveness,
  currentStreak: number,
  threshold: number,
): WatchdogDecision {
  if (liveness === "alive") return { action: "clear", streak: 0 };
  if (liveness === "undetermined") {
    return { action: "ignore", streak: currentStreak };
  }
  const streak = currentStreak + 1;
  return { action: streak >= threshold ? "shutdown" : "wait", streak };
}
