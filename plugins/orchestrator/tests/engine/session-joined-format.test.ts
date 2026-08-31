import { describe, test, expect } from "bun:test";
import { formatSessionJoined } from "../../mcp/engine/agent_channel";

// ===========================================================================
// 0.69.3 - THE JOIN WINDOW (aee63728, companion to 8ef4176f).
//
// `session_joined` fires the moment a peer appears in the roster. That is
// several tool round-trips BEFORE the peer can have finished its briefing and
// called update_session_task, so its roster line is genuinely empty for that
// whole window. The event used to carry name, id8 and role - which left a peer
// composing a welcome exactly one lane-shaped signal: the session NAME.
//
// THE MEASURED CONSEQUENCE, 2026-08-31. A session joined at 20:06:28Z with no
// task line. Two independent peers wrote to it within ninety seconds and BOTH
// stated a lane for it that nobody had assigned, each having read it off the
// session name. Neither was correct. Across that evening the same error ran
// five times over three authors - every instance disclosed by its own author,
// none caught by any instrument, and twice by authors who had objected to the
// identical thing being done to them earlier the same day.
//
// The convergence is the finding, not the individual errors. Two observers
// reaching the same wrong answer independently reads as corroboration when it
// is one inference drawn twice from one shared blind spot.
//
// SO THE FIX IS TO STATE THE ABSENCE. A reader told "no task declared yet" is
// not guessing. A reader told only a name is, and cannot tell that they are.
// Same move as the transport alert's denominator: report the measurement, not
// only the verdict.
//
// THE NEGATIVE HALF MATTERS AS MUCH. Once a session HAS declared, repeating
// the warning would be noise on every subsequent join, and the plugin's whole
// nudge-design constraint is that volume trains dismissal.
// ===========================================================================

const NO_TASK_MARKER = "NO TASK DECLARED YET";

describe("0.69.3: formatSessionJoined - make the empty roster line visible", () => {
  describe("FIRES the warning when the joiner has no declared task", () => {
    test("null current_task (the real join-window state)", () => {
      const line = formatSessionJoined({
        name: "SA-PLUGIN-2026-08-31",
        id8: "cd5a1686",
        role: "subordinate",
        current_task: null,
      });
      expect(line).toContain(NO_TASK_MARKER);
    });

    test("an omitted current_task behaves the same as null", () => {
      const line = formatSessionJoined({
        name: "SA-CLAIMS-2026-08-31",
        id8: "ba847bb7",
        role: "subordinate",
      });
      expect(line).toContain(NO_TASK_MARKER);
    });

    test("an empty string is an absent task, not a present one", () => {
      const line = formatSessionJoined({
        name: "x",
        id8: "00000000",
        role: "subordinate",
        current_task: "",
      });
      expect(line).toContain(NO_TASK_MARKER);
    });

    test("whitespace-only is absent too - it is not a declaration", () => {
      const line = formatSessionJoined({
        name: "x",
        id8: "00000000",
        role: "subordinate",
        current_task: "   \n  ",
      });
      expect(line).toContain(NO_TASK_MARKER);
    });

    test("it says what NOT to do, not merely that something is missing", () => {
      // "no task set" alone still leaves the name as the only signal, which is
      // the whole failure. The instruction has to be present in the text.
      const line = formatSessionJoined({
        name: "SA-PLUGIN-2026-08-31",
        id8: "cd5a1686",
        role: "subordinate",
        current_task: null,
      });
      expect(line).toContain("not an assignment record");
      expect(line.toLowerCase()).toContain("do not infer its lane");
    });
  });

  describe("STAYS QUIET once the joiner has actually declared", () => {
    test("a declared task suppresses the warning entirely", () => {
      const line = formatSessionJoined({
        name: "SA-EYES-2026-08-30",
        id8: "dfde96db",
        role: "subordinate",
        current_task: "SA-EYES. Prod-D1 bracket owner + pre-deploy tree gate.",
      });
      expect(line).not.toContain(NO_TASK_MARKER);
      expect(line).toContain("task declared");
    });

    test("it does not inline the whole task - from_task already carries it", () => {
      // Task lines run to 2000 chars. Pasting one into every join event would
      // be exactly the wallpaper this plugin's nudge-design rules forbid.
      const long = "L".repeat(1500);
      const line = formatSessionJoined({
        name: "x",
        id8: "00000000",
        role: "subordinate",
        current_task: long,
      });
      expect(line).not.toContain(long);
      expect(line.length).toBeLessThan(200);
    });
  });

  describe("the identifying head survives in both branches", () => {
    for (const task of [null, "some declared task"]) {
      test(`name, id8 and role are present when task is ${task === null ? "absent" : "present"}`, () => {
        const line = formatSessionJoined({
          name: "SA-VERIFY-2026-08-30",
          id8: "348a1d82",
          role: "subordinate",
          current_task: task,
        });
        expect(line).toContain("[session_joined]");
        expect(line).toContain("SA-VERIFY-2026-08-30");
        expect(line).toContain("348a1d82");
        expect(line).toContain("role=subordinate");
      });
    }
  });
});
