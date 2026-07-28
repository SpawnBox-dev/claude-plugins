import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseIngressTail, classifyIngress, INGRESS_STALE_THRESHOLD_MS } from "../../mcp/engine/agent_channel";

// ===========================================================================
// THE FIRST REAL INGRESS-FAILURE TRANSCRIPT THIS FLEET HAS EVER CAPTURED.
//
// parseIngressTail's own comment records that the residual bug lives in the
// PARSE - which entries count as "real", and whether the 128KB tail window
// reaches them - and that fixing it "needs a real parked-session transcript to
// test against, which no firing has yet produced." On 2026-07-28 one was
// produced: PA's MCP transport died 13:54Z-14:52Z while the session itself kept
// running, and instance 8 of ingress_suspect fired at 14:01:46Z inside it. That
// firing is the detector's first true positive in eight.
//
// READ THIS BEFORE USING THE FIXTURE: THIS IS A DEAF SESSION, NOT A PARKED ONE.
// (SA-b14fafa3's caveat, endorsed by PA.) The comment above asks for a PARKED
// session - an event loop that has stopped. This session's loop was healthy and
// its transport was severed. They present similarly from outside and they are
// different classes; encoding one as the other would bake a wrong expectation
// into the fix that has been waiting for this file.
//
// WHY IT IS STRUCTURAL, AND WHY THAT IS NOT MERE TIDINESS. The raw slice could
// never be committed. SA-b14fafa3 scanned it and found card last-four
// fragments, 154 currency amounts, and - on a second pass, after their first
// "0 emails, clean" turned out to be an allowlist probe that asked only about
// domains they expected - two THIRD PARTIES' personal contact details, arriving
// from other lanes' traffic in the same window.
//
// So this file is not the raw slice with the bad parts removed. Redaction is a
// blocklist: it deletes what someone thought to look for, and its misses are
// silent. scripts/structuralize-ingress-fixture.ts is a FIELD ALLOWLIST that
// rebuilds every line from scratch, emitting only the four things the parser
// reads - timestamp, type, operation, and whether an assistant entry carries a
// tool_use block. Nothing can survive by omission.
//
// Verified rather than asserted, both directions:
//   - Equivalence: parseIngressTail returns identical output on the raw slice
//     and on this one. The generator refuses to write when it does not.
//   - Disclosure: every shape probe that FIRES on the raw file (emails 12,
//     currency 154, card fragments 15, prose 997) returns 0 here. A probe that
//     never fired on the original would have proven nothing, so each was
//     checked against the raw file first.
//   - Total characterisation, stronger than any probe: the only scalars in this
//     file are 775 ISO timestamps and a closed set of 11 enum strings.
// ===========================================================================

const FIXTURE = join(import.meta.dir, "..", "fixtures", "ingress-outage-2026-07-28-structural.jsonl");

describe("real ingress outage 2026-07-28 (structural fixture)", () => {
  const tail = readFileSync(FIXTURE, "utf-8");

  test("the fixture carries no free-form content - only timestamps and enums", () => {
    // Guards the fixture itself. If someone regenerates it from a raw
    // transcript without the allowlist, this fails before the data spreads.
    const emails = tail.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
    const currency = tail.match(/\$\s?\d[\d,]*\.\d{2}/g) ?? [];
    const prose = tail.match(/[A-Za-z]{4}(?:\s+[A-Za-z]{3,}){6,}/g) ?? [];
    expect(emails).toEqual([]);
    expect(currency).toEqual([]);
    expect(prose).toEqual([]);

    const keys = new Set(Array.from(tail.matchAll(/"(\w+)":/g), (m) => m[1]));
    expect([...keys].sort()).toEqual(["content", "message", "operation", "timestamp", "type"]);
  });

  test("the parser reaches a verdict on a real transcript at all", () => {
    const parsed = parseIngressTail(tail);
    expect(parsed.lastRealActivityTs).toBeGreaterThan(0);
    expect(Number.isFinite(parsed.oldestOrphanEnqueueTs!)).toBe(true);
  });

  // Helper: what the parser would have seen AT a given moment. Parsing the
  // whole file reproduces the state at 14:58 - AFTER recovery - which is why
  // the first draft of this test asserted the wrong thing and failed.
  function tailAsOf(iso: string): string {
    const cut = Date.parse(iso);
    return tail
      .split("\n")
      .filter((l) => {
        try {
          return Date.parse(JSON.parse(l).timestamp) <= cut;
        } catch {
          return false;
        }
      })
      .join("\n");
  }

  test("THE TRUE POSITIVE: correctly classified at the moment it actually fired", () => {
    // Instance 8 fired 14:01:46Z. Reconstructed from the fixture, the parser
    // saw an enqueue from 13:58:22.5Z still unmatched - 203.5s old against a
    // 180s threshold. The detector was RIGHT.
    //
    // Whatever the parse fix changes, THIS CASE MUST KEEP FIRING. A fix that
    // silences it has not reduced false positives, it has broken the detector.
    const at = "2026-07-28T14:01:46Z";
    const parsed = parseIngressTail(tailAsOf(at));
    expect(parsed.oldestOrphanEnqueueTs).toBe(Date.parse("2026-07-28T13:58:22.500Z"));
    const ageSec = (Date.parse(at) - parsed.oldestOrphanEnqueueTs!) / 1000;
    expect(ageSec).toBeCloseTo(203.5, 1);

    const verdict = classifyIngress({
      heartbeatFresh: true,
      oldestOrphanEnqueueTs: parsed.oldestOrphanEnqueueTs,
      lastRealIsMidTurn: parsed.lastRealIsMidTurn,
      now: Date.parse(at),
      thresholdMs: INGRESS_STALE_THRESHOLD_MS,
    });
    expect(verdict).toBe("ingress_suspect");
  });

  test("stays suspect for the duration, and CLEARS on recovery", () => {
    // Mid-outage the same orphan is still unmatched, 31 minutes old.
    const mid = parseIngressTail(tailAsOf("2026-07-28T14:30:00Z"));
    expect(mid.oldestOrphanEnqueueTs).toBe(Date.parse("2026-07-28T13:58:22.500Z"));

    // At recovery the queue drains and the orphan disappears - so the detector
    // self-clears without anyone intervening. Worth pinning: a watchdog that
    // cannot stand down is as broken as one that cannot fire.
    const after = parseIngressTail(tailAsOf("2026-07-28T14:52:00Z"));
    expect(after.oldestOrphanEnqueueTs).toBeNull();
  });

  test("EVIDENCE: the transcript was FROZEN for 53 of the 58 outage minutes", () => {
    // Settles a disagreement three sessions had while the outage was live. One
    // sampled PA's transcript at ~14:02 and found it frozen; another reported
    // growth; PA concluded transcript state was unreliable and that a dead-MCP
    // session "keeps thinking and keeps writing".
    //
    // The captured record says otherwise for THIS incident: no transcript
    // entries at all between 13:58 and 14:51. The frozen sample was
    // representative, not lucky.
    //
    // There is a mechanism, which is why this is not just trivia: an INGRESS
    // failure means the session receives nothing, so it has nothing to respond
    // to, so it stops writing. Deafness produces silence. That does NOT
    // generalise to egress failure, where a session still receives work and
    // would keep writing - so this is evidence about one failure mode, not a
    // rehabilitation of transcript-mtime as a liveness test in general.
    const during = tail
      .split("\n")
      .filter((l) => {
        try {
          const ts = Date.parse(JSON.parse(l).timestamp);
          return ts > Date.parse("2026-07-28T13:58:30Z") && ts < Date.parse("2026-07-28T14:51:00Z");
        } catch {
          return false;
        }
      });
    expect(during.length).toBe(0);
  });

  test("the 128KB tail window covers this transcript, so the window is NOT the cause here", () => {
    // A live suspect for some of the seven false positives is that a large
    // recovery turn pushes every real entry outside the 128KB window, leaving
    // the parser to see only queue ops. Worth ruling in or out per fixture
    // rather than assuming: this structural slice is well under the window, so
    // any misbehaviour it shows is the parse logic, not truncation.
    expect(tail.length).toBeLessThan(128 * 1024);
  });
});
