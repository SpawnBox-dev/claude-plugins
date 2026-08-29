import { describe, expect, test } from "bun:test";
import {
  decideDuplicateKills,
  type ClientClaim,
  type SiblingCandidate,
} from "../../mcp/engine/client_claim";

const SELF = 1000;

function claim(pid: number, createdAt: string | null = "2026-08-29T18:00:00.000Z"): ClientClaim {
  return { pid, processCreatedAt: createdAt, claimedAt: "2026-08-29T18:00:05.000Z" };
}

/** Build the two injected probes from plain maps. */
function probes(
  claims: Record<number, ClientClaim>,
  live: Record<number, string | null | false>,
) {
  return {
    readClaim: (pid: number) => claims[pid] ?? null,
    isPidLive: (pid: number, expected: string | null) => {
      const v = live[pid];
      if (v === undefined || v === false) return false;
      return v === expected;
    },
  };
}

describe("duplicate-kill decision (WI ca509bb7)", () => {
  test("THE FIELD REGRESSION: a newcomer does NOT kill an older sibling holding a live client", () => {
    // This is PA's incident: parent 48760, incumbent serving, newcomer spawned
    // during reload churn. Under the old age rule the incumbent died.
    const incumbent = 55512;
    const candidates: SiblingCandidate[] = [
      { pid: incumbent, createdAt: "2026-08-29T17:40:00.000Z" },
    ];
    const p = probes(
      { [incumbent]: claim(incumbent) },
      { [incumbent]: "2026-08-29T18:00:00.000Z" },
    );
    const d = decideDuplicateKills(SELF, candidates, p.readClaim, p.isPidLive);
    expect(d.kill).toEqual([]);
    expect(d.spared[0]?.reason).toContain("live client claim");
  });

  test("THE CASE AGE GETS WRONG: oldest holds the client, newest is debris", () => {
    const oldestWithClient = 100;
    const youngerDebris = 900;
    const candidates: SiblingCandidate[] = [
      { pid: oldestWithClient, createdAt: "2026-08-29T10:00:00.000Z" },
      { pid: youngerDebris, createdAt: "2026-08-29T17:59:00.000Z" },
    ];
    const p = probes(
      { [oldestWithClient]: claim(oldestWithClient) },
      { [oldestWithClient]: "2026-08-29T18:00:00.000Z" },
    );
    const d = decideDuplicateKills(SELF, candidates, p.readClaim, p.isPidLive);
    // Age would have killed the OLDEST. The claim rule kills the debris instead.
    expect(d.kill).toEqual([youngerDebris]);
  });

  test("stale debris with NO claim is still reaped - dedup must not become a no-op", () => {
    // The failure mode of this change is a dedup that never kills anything,
    // which reinstates anthropics/claude-code#25976.
    const candidates: SiblingCandidate[] = [
      { pid: 2001, createdAt: null },
      { pid: 2002, createdAt: null },
    ];
    const p = probes({}, {});
    const d = decideDuplicateKills(SELF, candidates, p.readClaim, p.isPidLive);
    expect(d.kill).toEqual([2001, 2002]);
  });

  test("a claim whose process is GONE protects nothing", () => {
    const dead = 3001;
    const p = probes({ [dead]: claim(dead) }, { [dead]: false });
    const d = decideDuplicateKills(
      SELF,
      [{ pid: dead, createdAt: null }],
      p.readClaim,
      p.isPidLive,
    );
    expect(d.kill).toEqual([dead]);
  });

  test("PID REUSE: claim's creation time must match the live process, or it protects nothing", () => {
    const reused = 4001;
    const p = probes(
      { [reused]: claim(reused, "2026-08-29T10:00:00.000Z") },
      { [reused]: "2026-08-29T17:55:00.000Z" }, // different process now holds the pid
    );
    const d = decideDuplicateKills(
      SELF,
      [{ pid: reused, createdAt: null }],
      p.readClaim,
      p.isPidLive,
    );
    expect(d.kill).toEqual([reused]);
  });

  test("never kills itself, even if enumerated", () => {
    const p = probes({}, {});
    const d = decideDuplicateKills(
      SELF,
      [{ pid: SELF, createdAt: null }],
      p.readClaim,
      p.isPidLive,
    );
    expect(d.kill).toEqual([]);
    expect(d.spared[0]?.reason).toBe("self");
  });

  test("mixed fleet: only the unclaimed die", () => {
    const withClient = 5001;
    const debrisA = 5002;
    const debrisB = 5003;
    const p = probes(
      { [withClient]: claim(withClient) },
      { [withClient]: "2026-08-29T18:00:00.000Z" },
    );
    const d = decideDuplicateKills(
      SELF,
      [
        { pid: withClient, createdAt: null },
        { pid: debrisA, createdAt: null },
        { pid: debrisB, createdAt: null },
      ],
      p.readClaim,
      p.isPidLive,
    );
    expect(d.kill.sort()).toEqual([debrisA, debrisB]);
    expect(d.spared.map((s) => s.pid)).toEqual([withClient]);
  });

  // CONTROL FOR THE CONTROL: reproduce the old age rule and confirm it kills the
  // incumbent on the very sequence the new rule spares. If this stops failing,
  // the tests above have gone vacuous.
  test("the OLD age rule would have killed the client-holding incumbent", () => {
    const incumbent = { pid: 55512, createdAt: "2026-08-29T17:40:00.000Z" };
    const newcomerStart = "2026-08-29T17:59:00.000Z";
    const oldRuleKills = [incumbent]
      .filter((c) => (c.createdAt ?? "") < newcomerStart)
      .map((c) => c.pid);
    expect(oldRuleKills).toEqual([55512]);
  });
});
