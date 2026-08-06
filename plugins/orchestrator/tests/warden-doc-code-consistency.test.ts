import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// 0.43.1 (ed316fcd item K): PIN THE WARDEN DOCS TO THE WARDEN CODE.
//
// THE FAILURE THIS EXISTS FOR, and it was live for ~10 days: the code raised
// WARDEN_STALE_THRESHOLD_MS from 420_000 (~7 min) to 900_000 (~15 min)
// PRECISELY BECAUSE the 7-minute rule caused three premature respawns of a
// healthy warden in one session. `agents/context-warden.md` was updated to
// refute the self-timed model outright. The deployed nudge was updated to say
// "IDLE AWAITING YOUR POKE by design, not stalled ... Do NOT respawn on this
// signal alone."
//
// Two hand-maintained skill files were NOT updated, and both kept teaching
// "mtime older than ~7 min means dead - respawn". PA reported that a
// doc-following PA would have killed a healthy warden at least twice in a
// single evening, and each kill risks the documented name-collision hazard
// (the Agent tool auto-suffixes to context-warden-2 rather than rejecting).
//
// WHY A TEST AND NOT JUST THE CONTENT FIX: fixing the text fixes one instance.
// The CLASS is a hand-maintained doc silently diverging from a constant that
// moved, and nothing announces it - the same shape as the briefing-timeout
// workaround that outlived its defect (recorded on ed316fcd). Complaint-driven
// discovery does not find this, because a doc that is confidently wrong reads
// exactly like a doc that is right. So the guard is a CHANGE DETECTOR on the
// constant plus an absence check on the refuted rule.
// ===========================================================================

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const HOOK_SRC = read("mcp/tools/hook_event.ts");
const DOC_PATHS = ["skills/pa-bootstrap/SKILL.md", "skills/every-turn/SKILL.md"];

describe("0.43.1: the warden staleness constant is pinned to its docs", () => {
  test("WARDEN_STALE_THRESHOLD_MS is still 900_000 - if this fails, UPDATE THE DOCS", () => {
    // This assertion is deliberately a change-detector rather than a range
    // check. If someone retunes the threshold, this fails and names the files
    // that describe it, which is the only mechanism that makes doc drift
    // impossible to ship silently.
    const m = HOOK_SRC.match(/WARDEN_STALE_THRESHOLD_MS\s*=\s*([0-9_]+)/);
    expect(m).not.toBeNull();
    const value = Number(m![1].replace(/_/g, ""));
    expect(value).toBe(900_000);
    // Guard the reason too: 420_000 must not come back as the live value.
    expect(value).toBeGreaterThan(420_000);
  });

  test("the refuted ~7-minute death rule appears in NO skill file", () => {
    // The exact shape that was wrong: a short mtime age treated as proof of
    // death, licensing a respawn. Matching on the co-occurrence of a 7-minute
    // figure with dead/respawn keeps this from firing on the legitimate uses
    // (the singleton guard's freshness window, and the historical note in the
    // code comment explaining why 420_000 was abandoned).
    for (const p of DOC_PATHS) {
      const body = read(p);
      const lines = body.split("\n");
      const offenders = lines.filter(
        (l) =>
          /~?\s*7\s*min/i.test(l) &&
          /\bdead\b|\bdead\/stuck\b/i.test(l) &&
          /respawn/i.test(l) &&
          // The corrective text quotes the old rule in order to retract it.
          !/used to (say|state|read)|old text|old rule|WRONG/i.test(l)
      );
      expect({ file: p, offenders }).toEqual({ file: p, offenders: [] });
    }
  });

  test("both skill files teach POKE-BEFORE-RESPAWN, which is the actual remedy", () => {
    // Absence of the wrong rule is not presence of the right one. A doc that
    // merely deleted the bad line would pass the check above and still leave a
    // PA with no guidance at the moment it is staring at a stale-looking
    // ledger.
    for (const p of DOC_PATHS) {
      const body = read(p).toLowerCase();
      expect(body).toContain("poke first");
      expect(body).toContain("never respawn first");
    }
  });

  test("the warden's own brief still refutes the self-timed model", () => {
    // pa-bootstrap now points at agents/context-warden.md as the authority for
    // why self-arming is a no-op. If that refutation is ever removed, the
    // pointer becomes a dangling claim.
    const brief = read("agents/context-warden.md").toLowerCase();
    expect(brief).toContain("poke-driven");
    expect(brief).toContain("no-op");
  });
});
