import { describe, test, expect } from "bun:test";
import { INGRESS_ACTIVE_PROBE_NOTE } from "../../mcp/engine/agent_channel";

// ===========================================================================
// 0.36.1: the direct address must survive future editing of this alert.
//
// THE CELL NOTHING PASSIVE REACHES (SA-90bf73bd's structural argument):
// idle-and-healthy and idle-and-unreachable are identical under every passive
// signal - flat transcript, fresh heartbeat, zero channel events - because in
// both cases the subject is correctly doing nothing. No amount of watching
// separates them. Only an ACTIVE probe does, because it creates an event the
// subject must process: a healthy idle session answers with no human involved,
// an unreachable one structurally cannot.
//
// PA sat in exactly that cell at 16:04Z on 2026-07-28 - silent for thirty
// minutes, entirely healthy - and the ambiguity was resolved by Jarid
// prompting a probe. The fleet currently depends on a human noticing.
//
// WHY THIS NEEDS A GUARD RATHER THAN JUST A COMMENT: the address is the step
// most likely to be "optimised" away. Beside two file reads it looks like the
// expensive one - it spends a peer's turn - and the 0.34.0 wording I shipped
// actively encouraged skipping it by saying the triage "cannot see" transport
// death. That reads as "do not bother". It is the opposite of correct, and the
// same misreading will be available to the next editor.
// ===========================================================================

describe("0.36.1: the alert keeps the active probe in the triage", () => {
  const t = INGRESS_ACTIVE_PROBE_NOTE.toLowerCase();

  test("names addressing as what DISTINGUISHES the two idle cases", () => {
    expect(t).toContain("address");
    expect(t).toContain("idle-and-healthy");
    expect(t).toContain("idle-and-unreachable");
  });

  test("frames silence as the POSITIVE result, not a failed check", () => {
    // The load-bearing inversion. A reader who treats silence as "the check
    // didn't work" learns nothing from it; a reader who treats it as the
    // finding escalates correctly.
    expect(INGRESS_ACTIVE_PROBE_NOTE).toContain("SILENCE IS THE POSITIVE RESULT");
  });

  test("explains WHY passive checks cannot resolve it", () => {
    // Without the reason this is just an instruction, and instructions bounce -
    // the asymmetry SA-c5b207e0 identified reading the 0.33.0 draft cold.
    expect(t).toContain("correctly doing nothing");
  });

  test("orders escalation AFTER the address, not instead of it", () => {
    // /mcp asks a human to interrupt a terminal. It is earned by silence to a
    // direct address, never reached for first - that mistake has already sent
    // someone to press keys at a healthy terminal once.
    expect(t).toContain("/mcp");
    const probeIdx = t.indexOf("address");
    const escalateIdx = t.indexOf("/mcp");
    expect(probeIdx).toBeLessThan(escalateIdx);
    expect(t).toContain("only after silence");
  });
});
