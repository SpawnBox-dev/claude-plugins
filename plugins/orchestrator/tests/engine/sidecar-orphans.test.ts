import { describe, expect, test } from "bun:test";
import {
  classifyOrphans,
  identifyLive,
  totalRssMb,
  type SidecarProc,
} from "../../mcp/engine/sidecar_orphans";

/**
 * These are modelled on the ACTUAL 2026-09-07 process list, not invented shapes,
 * because the defect was never in the predicate - it was that the predicate
 * could not be reached when /health stopped answering. The cases that matter
 * are therefore the ones where `healthPid` is absent.
 *
 * ⚠️ WHAT THIS FILE CANNOT CATCH, STATED SO NOBODY READS MORE INTO IT THAN IS
 * THERE. The original defect was a REACHABILITY failure in `system_status` - the
 * classification sat inside `if (h.pid)`. A unit test at this layer would have
 * passed green through the entire incident, because the function under test was
 * always right; nothing called it. These tests pin the new fallback basis and
 * the refuse-to-guess behaviour, which did not exist before. They do NOT prove
 * that `system_status` invokes any of it. The only instrument for that is
 * running `system_status` with the sidecar unreachable and reading the output -
 * which is a live check, not a unit test, and is recorded on ef6255d9 instead.
 */
const SELF = 9999;

// The real census at 16:27Z: three superseded trees plus the live one.
const CENSUS_2026_09_07: SidecarProc[] = [
  { pid: 3688, port: 51677, ageMs: 60 * 60 * 1000, rssMb: 1 },
  { pid: 36360, port: 60559, ageMs: 60 * 60 * 1000, rssMb: 1 },
  { pid: 29864, port: 50517, ageMs: 60 * 60 * 1000, rssMb: 2328 },
  { pid: 16912, port: 50728, ageMs: 60 * 60 * 1000, rssMb: 2364 },
];

describe("identifyLive", () => {
  test("prefers /health's pid, which is the only fact from the process we are talking to", () => {
    expect(identifyLive(16912, 50728)).toEqual({ kind: "pid", pid: 16912 });
  });

  test("FALLS BACK TO THE PORT FILE WHEN /health IS SILENT - the branch that never ran", () => {
    expect(identifyLive(null, 50728)).toEqual({ kind: "port", port: 50728 });
    expect(identifyLive(undefined, 50728)).toEqual({ kind: "port", port: 50728 });
  });

  test("reports unknown rather than guessing when it has neither", () => {
    expect(identifyLive(null, null)).toEqual({ kind: "unknown" });
  });

  test("treats non-positive values as absent rather than as an identity", () => {
    expect(identifyLive(0, 0)).toEqual({ kind: "unknown" });
  });
});

describe("classifyOrphans", () => {
  test("names the three superseded trees and never the live one (pid basis)", () => {
    const orphans = classifyOrphans(CENSUS_2026_09_07, identifyLive(16912, 50728), SELF);
    expect(orphans.map((o) => o.pid).sort((a, b) => a - b)).toEqual([3688, 29864, 36360]);
    expect(orphans.some((o) => o.pid === 16912)).toBe(false);
    expect(totalRssMb(orphans)).toBe(2330);
  });

  test("🔴 REGRESSION: reports orphans WITH NO /health AT ALL - the reported state of the incident", () => {
    // This is the exact situation on 2026-09-07: system_status printed
    // "/health did not answer" and listed nothing, while 2,330 MB sat in
    // processes nothing could route to. The old code reached no classification
    // here at all; this asserts the report survives the outage it describes.
    const orphans = classifyOrphans(CENSUS_2026_09_07, identifyLive(null, 50728), SELF);
    expect(orphans.map((o) => o.pid).sort((a, b) => a - b)).toEqual([3688, 29864, 36360]);
    expect(totalRssMb(orphans)).toBe(2330);
  });

  test("the two bases agree when both are available, so the fallback is not a different answer", () => {
    const byPid = classifyOrphans(CENSUS_2026_09_07, identifyLive(16912, 50728), SELF);
    const byPort = classifyOrphans(CENSUS_2026_09_07, identifyLive(null, 50728), SELF);
    expect(byPort.map((o) => o.pid).sort((a, b) => a - b)).toEqual(byPid.map((o) => o.pid).sort((a, b) => a - b));
  });

  test("classifies NOTHING when the live one cannot be identified - silence beats a wrong kill", () => {
    // Reporting all four as orphans would invite killing the working one, which
    // is the expensive direction of this error.
    expect(classifyOrphans(CENSUS_2026_09_07, identifyLive(null, null), SELF)).toEqual([]);
  });

  test("never reports this process as its own orphan", () => {
    const withSelf = [...CENSUS_2026_09_07, { pid: SELF, port: 1234, ageMs: 1, rssMb: 50 }];
    const orphans = classifyOrphans(withSelf, identifyLive(null, 50728), SELF);
    expect(orphans.some((o) => o.pid === SELF)).toBe(false);
  });

  test("a lone live sidecar yields no orphans on either basis (negative control)", () => {
    const only = [CENSUS_2026_09_07[3]];
    expect(classifyOrphans(only, identifyLive(16912, 50728), SELF)).toEqual([]);
    expect(classifyOrphans(only, identifyLive(null, 50728), SELF)).toEqual([]);
  });

  test("a SUPERSEDED sidecar is still classified an orphan even though it holds a live port", () => {
    // 51424 listened on 55069 and answered nobody, while the port file named
    // 53947. Holding a port is not being reachable.
    const after = [
      { pid: 51424, port: 55069, ageMs: 34 * 60 * 1000, rssMb: 2505 },
      { pid: 2032, port: 53947, ageMs: 60 * 1000, rssMb: 1499 },
    ];
    const orphans = classifyOrphans(after, identifyLive(null, 53947), SELF);
    expect(orphans.map((o) => o.pid)).toEqual([51424]);
    expect(totalRssMb(orphans)).toBe(2505);
  });
});
