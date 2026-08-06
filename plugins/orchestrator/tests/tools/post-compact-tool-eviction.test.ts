import { describe, test, expect } from "bun:test";
import {
  composePostCompactReorientation,
  POST_COMPACT_TOOL_EVICTION_NOTE,
} from "../../mcp/tools/hook_event";

// ===========================================================================
// 0.43.0: a compaction is a TOOL-SCHEMA EVICTION event (ed316fcd entry P,
// from root-causing 7bc15075).
//
// THE FAILURE THIS PREVENTS, and it is a real one from 2026-08-06: a deferred
// MCP tool whose schema is absent from the request fails with "<field>:
// required, received undefined" for a field that IS present in the call. The
// harness's own remedy hint is suppressed for exactly this case, because the
// suppressing guard keys on a STICKY "ever discovered" set carried across
// compact boundaries - so the hint is withheld from precisely the long-lived
// sessions most likely to hit it. SA-df343a05 held both the deferred-tools
// list and the explanation in context and still spent five attempts blaming
// their own JSON escaping.
//
// WHY A TEST AND NOT JUST A COMMENT (CLAUDE.md "WHERE to put a guard", tier 1):
// 0.37.0's guard shipped COMPLETELY INERT behind thirteen green tests because
// every one of them exercised a pure function while the wiring was broken. So
// the load-bearing assertions here are NOT about the constant's wording - they
// are that the composer actually EMITS it, for both roles, and that it SURVIVES
// THE CAP. Truncation is the live risk: the payload is sliced at
// SESSIONSTART_TOTAL_CAP and a large checkpoint is what pushes content off the
// end.
// ===========================================================================

const HUGE_CHECKPOINT = "x".repeat(12_000);

describe("0.43.0: the composer actually emits the eviction note (WIRING, not wording)", () => {
  test("subordinate branch emits it", () => {
    const out = composePostCompactReorientation({
      currentTask: "some task",
      checkpoint: "a checkpoint",
      livePA: true,
      role: "subordinate",
    });
    expect(out).toContain(POST_COMPACT_TOOL_EVICTION_NOTE);
  });

  test("prime branch emits it too - PA is MORE exposed, not less", () => {
    // PA calls the maintenance verbs on other sessions' behalf, so an evicted
    // schema costs it more. A role-gated version of this note would be a bug.
    const out = composePostCompactReorientation({
      currentTask: "orchestrating",
      checkpoint: "a checkpoint",
      livePA: false,
      role: "prime",
    });
    expect(out).toContain(POST_COMPACT_TOOL_EVICTION_NOTE);
  });

  test("emitted with no checkpoint and no peers - the minimal call", () => {
    const out = composePostCompactReorientation({
      currentTask: null,
      checkpoint: null,
      livePA: false,
    });
    expect(out).toContain(POST_COMPACT_TOOL_EVICTION_NOTE);
  });
});

describe("0.43.0: it SURVIVES TRUNCATION - the assertion that actually protects it", () => {
  // The whole point of placing it early. If a future edit moves it after the
  // checkpoint, this is the test that catches it, and nothing else would:
  // every wording assertion above would still pass on a note that gets sliced
  // off before the agent ever reads it.
  test("survives a checkpoint far larger than the total cap", () => {
    const out = composePostCompactReorientation({
      currentTask: "a task",
      checkpoint: HUGE_CHECKPOINT,
      livePA: true,
      role: "subordinate",
      peers: Array.from({ length: 12 }, (_, i) => ({
        id8: `peer${i}`,
        current_task: "y".repeat(200),
      })),
    });
    expect(out).toContain(POST_COMPACT_TOOL_EVICTION_NOTE);
  });

  test("survives it in the prime branch too, which carries a longer action block", () => {
    const out = composePostCompactReorientation({
      currentTask: "a task",
      checkpoint: HUGE_CHECKPOINT,
      livePA: false,
      role: "prime",
      peers: Array.from({ length: 12 }, (_, i) => ({
        id8: `peer${i}`,
        current_task: "y".repeat(200),
      })),
    });
    expect(out).toContain(POST_COMPACT_TOOL_EVICTION_NOTE);
  });

  test("PRECEDES the checkpoint in the string - position is the mechanism", () => {
    // Guards the reason it survives, not just the fact. If someone reorders
    // parts, the truncation tests above could still pass by luck on a small
    // payload; this one states the invariant.
    const marker = "UNIQUE_CHECKPOINT_MARKER_42";
    const out = composePostCompactReorientation({
      currentTask: "a task",
      checkpoint: marker,
      livePA: true,
      role: "subordinate",
    });
    const noteIdx = out.indexOf(POST_COMPACT_TOOL_EVICTION_NOTE);
    const cpIdx = out.indexOf(marker);
    expect(noteIdx).toBeGreaterThan(-1);
    expect(cpIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeLessThan(cpIdx);
  });
});

describe("0.43.0: the content carries the three things that actually redirect a reader", () => {
  const t = POST_COMPACT_TOOL_EVICTION_NOTE.toLowerCase();

  test("names the EXACT error string, which is what links the abstract state to what the reader is staring at", () => {
    // df343a05's diagnosis of why the harness's own mild wording failed on
    // them: "cannot be invoked" predicts a REFUSAL, but the actual event is a
    // schema error about a visible field. Those do not look like the same
    // event, so the reader follows the error toward their own payload. Naming
    // the string closes that gap.
    expect(t).toContain("required, received undefined");
    expect(t).toContain("is present");
  });

  test("kills the retry-with-cleaner-JSON path explicitly", () => {
    // Five attempts went there. Saying "the error is wrong" is not enough;
    // the useless remedy has to be named and closed.
    expect(t).toContain("can never work");
  });

  test("gives the remedy AND the diagnostic ordering", () => {
    expect(t).toContain("toolsearch select:");
    expect(t).toContain("before payload, server, env or permissions");
  });

  test("carries the hidden-second-defect corollary", () => {
    // A deferral failure can MASK a real error, because validation never
    // reaches the type check. Verbatim instance: warm_context is an array and
    // was being passed as a string for the whole episode, and no message could
    // ever have reported it.
    expect(t).toContain("hide a second");
  });

  test("does NOT claim the harness will warn you - it claims the opposite", () => {
    // The suppressed-hint fact is the reason this note has to exist at all.
    // If a future edit softens it to "the harness will tell you", the note
    // becomes actively misleading.
    expect(t).toContain("suppressed");
  });
});
