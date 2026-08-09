import { describe, test, expect } from "bun:test";
import { classifyClientTransport, CLIENT_STALE_MS } from "../../mcp/engine/agent_channel";

// WI d4873dfc. PA's MCP "disconnects" were never server deaths - the server
// heartbeated normally through BOTH outages (pid 17968 through the ~12h one,
// pid 33520 through the 74-minute one). The client could not reach a healthy
// server, and PA lost ~12 hours to it because nothing flagged it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FIRST DESIGN OF THIS DETECTOR WAS WRONG, AND THE INCIDENT REFUTED IT.
//
// It keyed on "no tool calls WHILE the transcript keeps growing" - reasoning
// that a session taking turns without landing calls must be disconnected. Then
// the actual transcript was measured (2026-08-09, PA session d3ba56ed):
//
//   entries 02Z: 46      <- last entry 02:31:18Z, a COMPLETED assistant turn
//   entries 03Z-12Z: 0   <- 11.37 hours, ZERO entries, heartbeat fresh throughout
//   entries 13Z: 34      <- resumes 13:53:40Z
//
// The transcript was FROZEN, not growing. The first design would have been
// SILENT on the exact incident it was built for. Worse, the signals it used
// (fresh heartbeat, no tool calls, frozen transcript, clean last turn) are
// pixel-for-pixel what an IDLE session looks like - so no threshold could have
// saved it. The 2026-07-28 ingress fixture had already recorded the mechanism:
// deafness produces silence.
//
// WHAT ACTUALLY SEPARATES DEAF FROM IDLE IS UNDELIVERED MAIL. At 02:34:56Z -
// three minutes into the freeze - SA-d4db6493 addressed PA turn-final. PA's
// transcript recorded nothing for the next 11.4 hours. Mail was sent and never
// arrived. Idleness cannot fake that, because a harness writes an incoming
// message down at ENQUEUE (584 such entries in PA's transcript that day, 0
// during the freeze) whether or not a turn is running to process it.
//
// So the signals INVERT: growth after an emit is the HEALTH signal, and its
// absence is the fault. These tests pin that inversion, because the intuitive
// version is the one that was already tried and already failed.
// ─────────────────────────────────────────────────────────────────────────────

const STALE = CLIENT_STALE_MS + 60_000;

describe("classifyClientTransport: it must FIRE on a real client drop", () => {
  test("emitted, and nothing was written down afterwards", () => {
    expect(
      classifyClientTransport({ msSinceEmit: STALE, deliveryObserved: false }),
    ).toBe("client_transport_suspect");
  });

  test("THE REAL INCIDENT: PA's 11.37-hour freeze is caught", () => {
    // Reconstructed from the measured timeline. The emit is SA-d4db6493's
    // 02:34:56Z message; "now" is one hour later, still deep in the freeze,
    // with PA's transcript byte-identical to where it stood at 02:31:18Z.
    //
    // Whatever else changes, THIS CASE MUST KEEP FIRING - it is the incident
    // the work item exists for, and the previous design returned "healthy".
    const emitAt = Date.parse("2026-08-09T02:34:56Z");
    const now = Date.parse("2026-08-09T03:34:56Z");
    expect(
      classifyClientTransport({
        msSinceEmit: now - emitAt,
        deliveryObserved: false,
      }),
    ).toBe("client_transport_suspect");
  });
});

describe("classifyClientTransport: it must STAY SILENT otherwise", () => {
  test("an IDLE session is not disconnected - nothing was owed to it", () => {
    // The overwhelmingly common case, and the one the first design got wrong.
    // No emit means no expectation, so silence proves nothing whatsoever.
    expect(
      classifyClientTransport({ msSinceEmit: null, deliveryObserved: false }),
    ).toBe("healthy");
  });

  test("delivery observed = reachable, however long the wait", () => {
    // The decisive inversion. Growth after the emit means the harness wrote the
    // message down, which it can only do if the transport carried it - so this
    // stays healthy even at ten times the threshold.
    expect(
      classifyClientTransport({
        msSinceEmit: CLIENT_STALE_MS * 10,
        deliveryObserved: true,
      }),
    ).toBe("healthy");
  });

  test("a session mid-LONG-TURN is not disconnected", () => {
    // A harness mid-turn still enqueues incoming mail, so a long turn shows
    // delivery like any other healthy state. This is why the corrected design
    // does not race against turn latency at all - the old failure mode.
    expect(
      classifyClientTransport({
        msSinceEmit: CLIENT_STALE_MS * 4,
        deliveryObserved: true,
      }),
    ).toBe("healthy");
  });

  test("sent too recently to conclude anything", () => {
    expect(
      classifyClientTransport({
        msSinceEmit: CLIENT_STALE_MS - 60_000,
        deliveryObserved: false,
      }),
    ).toBe("healthy");
  });

  test("the grace window stays generous", () => {
    // Guards the tuning. Delivery is evidenced at enqueue, so this only needs
    // to cover filewatcher round-trip plus mtime slack - but an alert that
    // cries wolf is one the fleet learns to ignore, so it stays at minutes.
    expect(CLIENT_STALE_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });
});
