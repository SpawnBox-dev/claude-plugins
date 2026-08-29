import { describe, expect, test } from "bun:test";
import {
  decideWatchdogAction,
  type ParentLiveness,
} from "../../mcp/engine/orphan_watchdog";

const N = 3;

/** Feed a sequence of observations; return every action in order. */
function run(seq: ParentLiveness[], threshold = N): string[] {
  let streak = 0;
  const actions: string[] = [];
  for (const obs of seq) {
    const d = decideWatchdogAction(obs, streak, threshold);
    streak = d.streak;
    actions.push(d.action);
    if (d.action === "shutdown") break; // the real caller stops here
  }
  return actions;
}

describe("orphan watchdog decision rule (WI 590bf9a9)", () => {
  // POSITIVE - mandatory per PA. The failure mode of this whole change is a
  // watchdog that never fires, which would reintroduce the orphan class
  // (d78867af) this watchdog exists for.
  test("a genuinely dead parent IS still reaped, after N consecutive readings", () => {
    expect(run(["dead", "dead", "dead"])).toEqual(["wait", "wait", "shutdown"]);
  });

  test("shutdown is bounded at exactly N ticks - not more", () => {
    let streak = 0;
    let ticks = 0;
    for (let i = 0; i < 50; i++) {
      ticks++;
      const d = decideWatchdogAction("dead", streak, N);
      streak = d.streak;
      if (d.action === "shutdown") break;
    }
    expect(ticks).toBe(N);
  });

  // NEGATIVE - the defect that motivated the change.
  test("undetermined NEVER shuts down, however long it persists", () => {
    const actions = run(Array(25).fill("undetermined") as ParentLiveness[]);
    expect(actions).toHaveLength(25);
    expect(actions.every((a) => a === "ignore")).toBe(true);
    expect(actions).not.toContain("shutdown");
  });

  test("undetermined does not ADVANCE a streak", () => {
    const d1 = decideWatchdogAction("dead", 0, N); // streak 1
    const d2 = decideWatchdogAction("undetermined", d1.streak, N);
    expect(d2.streak).toBe(1);
    expect(d2.action).toBe("ignore");
  });

  test("undetermined does not RESET a streak either - it is not evidence of life", () => {
    // Otherwise a parent dying while the probe is flaky never accumulates.
    const actions = run(["dead", "undetermined", "dead", "undetermined", "dead"]);
    expect(actions).toEqual(["wait", "ignore", "wait", "ignore", "shutdown"]);
  });

  test("a live reading clears the streak", () => {
    const actions = run(["dead", "dead", "alive", "dead", "dead"]);
    expect(actions).toEqual(["wait", "wait", "clear", "wait", "wait"]);
    expect(actions).not.toContain("shutdown");
  });

  test("two dead readings alone are not enough", () => {
    expect(run(["dead", "dead"])).not.toContain("shutdown");
  });

  // THE CONTROL FOR THE CONTROL. These assertions must be capable of failing,
  // so reproduce the OLD boolean-collapse semantics (undetermined treated as
  // dead) and confirm the same sequence that is safe above becomes a shutdown.
  // If this ever stops shutting down, the negative tests above have gone vacuous.
  test("the old collapse WOULD have shut down on the undetermined-only sequence", () => {
    const collapse = (l: ParentLiveness): ParentLiveness =>
      l === "undetermined" ? "dead" : l;
    let streak = 0;
    let sawShutdown = false;
    for (const obs of Array(25).fill("undetermined") as ParentLiveness[]) {
      const d = decideWatchdogAction(collapse(obs), streak, N);
      streak = d.streak;
      if (d.action === "shutdown") {
        sawShutdown = true;
        break;
      }
    }
    expect(sawShutdown).toBe(true);
  });
});
