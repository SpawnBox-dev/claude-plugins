import { describe, test, expect } from "bun:test";
import { composeWardenNudgeText } from "../../mcp/tools/hook_event";

// ===========================================================================
// 0.30.83: the warden-staleness nudge reads the warden's declared LOOP MODE.
//
// PA, 2026-07-27: the nudge fired twice reporting "ledger's last write was
// 17:50Z, 1096s ago" - but the warden runs PA-POKE-DRIVEN by design (a
// self-timer does not revive a dormant subagent; two warden instances proved
// that durably). A poke-driven warden's mtime therefore grows monotonically
// BETWEEN POKES, so elapsed-since-write is not a fault.
//
// The alarm's output was IDENTICAL for "dead warden" and "correctly idle
// warden awaiting its poke" - the same measure-a-proxy-and-report-it-as-the-
// property shape as the ingress watchdog (anti_pattern 04359482). The remedy
// was already right; the FRAMING taught the wrong model, and a PA that
// believes it respawns a live warden into a name collision.
//
// Per that anti-pattern, these run the changed code against the case that
// motivated it and confirm the framing FLIPS, then confirm the old framing
// survives where it is still correct.
// ===========================================================================

const base = {
  role: "prime" as const,
  fleetSize: 6,
  turnsSinceLastNudge: null,
};

describe("poke-driven warden: action prompt, not a fault", () => {
  const ledger = {
    status: "stale" as const,
    ageMs: 1_096_000,
    instance: "context-warden",
    ts: "2026-07-27T17:50Z",
    loop: "poke-driven" as const,
  };

  test("reframes as TIME TO POKE and denies it is a fault", () => {
    const r = composeWardenNudgeText({ ...base, ledger });
    expect(r.fired).toBe(true);
    expect(r.text).toContain("TIME TO POKE");
    expect(r.text).toContain("not a fault");
    expect(r.text).toContain("IDLE AWAITING YOUR POKE");
  });

  test("explicitly warns AGAINST respawning on this signal", () => {
    // The concrete harm PA named: respawning a live warden hits the
    // context-warden-2 auto-suffix collision.
    const r = composeWardenNudgeText({ ...base, ledger });
    expect(r.text).toContain("Do NOT respawn");
    expect(r.text).toContain("context-warden-2");
  });

  test("does not call a normally-growing mtime stale", () => {
    const r = composeWardenNudgeText({ ...base, ledger });
    expect(r.text).not.toContain("ledger's last write was");
  });
});

describe("self-timed or undeclared warden: staleness framing survives", () => {
  test("a self-timed warden still gets the staleness wording", () => {
    // For a genuinely self-timed warden a frozen mtime IS anomalous, so the
    // original framing is correct and must not be lost.
    const r = composeWardenNudgeText({
      ...base,
      ledger: { status: "stale", ageMs: 1_096_000, instance: "w", loop: "self-timed" },
    });
    expect(r.fired).toBe(true);
    expect(r.text).toContain("ledger's last write was");
    expect(r.text).not.toContain("TIME TO POKE");
  });

  test("an undeclared loop mode falls back to staleness framing", () => {
    // Absent evidence, do not assume the safer-sounding story.
    const r = composeWardenNudgeText({
      ...base,
      ledger: { status: "stale", ageMs: 1_096_000, instance: "w" },
    });
    expect(r.text).toContain("ledger's last write was");
  });

  test("an ABSENT ledger is unaffected - that is a real gap", () => {
    const r = composeWardenNudgeText({
      ...base,
      ledger: { status: "absent" },
    });
    expect(r.fired).toBe(true);
    expect(r.text).toContain("NO context redundancy");
  });

  test("a FRESH ledger stays silent regardless of loop mode", () => {
    const r = composeWardenNudgeText({
      ...base,
      ledger: { status: "fresh", ageMs: 1000, loop: "poke-driven" },
    });
    expect(r.fired).toBe(false);
    expect(r.clearDedup).toBe(true);
  });
});
