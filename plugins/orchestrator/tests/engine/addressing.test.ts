import { describe, expect, test } from "bun:test";
import { parseAddressing, type SessionLike } from "../../mcp/engine/addressing";

const PA: SessionLike = {
  session_id: "f5b8708d-1234-5678-9abc-def012345678",
  id8: "f5b8708d",
  role: "prime",
  name: "PA-test",
};
const SA_A: SessionLike = {
  session_id: "abc12345-1234-5678-9abc-def012345678",
  id8: "abc12345",
  role: "subordinate",
  name: "SA-frontend",
};
const SA_B: SessionLike = {
  session_id: "d4e5f6a7-1234-5678-9abc-def012345678",
  id8: "d4e5f6a7",
  role: "subordinate",
  name: "SA-backend",
};
const SESSIONS = [PA, SA_A, SA_B];

describe("addressing parser", () => {
  test("explicit @PA address from SA targets PA", () => {
    const result = parseAddressing("@PA review the migration?", SA_A, SESSIONS);
    expect(result.targets).toEqual([PA.session_id]);
    expect(result.pa_addressed).toBe(true);
  });

  test("explicit @SA-<id8> targets that session", () => {
    const result = parseAddressing("@SA-d4e5f6a7 want to coordinate?", SA_A, SESSIONS);
    expect(result.targets).toEqual([SA_B.session_id]);
  });

  test("multiple addresses in one message all resolved", () => {
    const result = parseAddressing("@SA-d4e5f6a7 and @SA-abc12345 sync up", PA, SESSIONS);
    expect(result.targets).toEqual(expect.arrayContaining([SA_A.session_id, SA_B.session_id]));
    expect(result.targets).toHaveLength(2);
  });

  test("@all expands to every active session except sender", () => {
    const result = parseAddressing("@all stand down for 5", PA, SESSIONS);
    expect(result.targets).toEqual(expect.arrayContaining([SA_A.session_id, SA_B.session_id]));
    expect(result.targets).not.toContain(PA.session_id);
  });

  test("PA-comma conversational form (no @) targets PA, sets pa_addressed", () => {
    const result = parseAddressing("PA, can you check note ecbea9ac?", SA_A, SESSIONS);
    expect(result.targets).toEqual([PA.session_id]);
    expect(result.pa_addressed).toBe(true);
  });

  test("PrimeAgent-comma is also recognized", () => {
    const result = parseAddressing("PrimeAgent, run the tests", SA_A, SESSIONS);
    expect(result.targets).toEqual([PA.session_id]);
  });

  test("unaddressed SA event has no explicit targets and no pa_addressed flag", () => {
    const result = parseAddressing("Just edited foo.ts to fix the null case", SA_A, SESSIONS);
    expect(result.targets).toEqual([]);
    expect(result.pa_addressed).toBe(false);
  });

  test("slash-command override sets override_command flag", () => {
    const result = parseAddressing("/pa-pause", SA_A, SESSIONS);
    expect(result.override_command).toBe("pause");
  });

  test("slash-command resume sets override_command resume", () => {
    const result = parseAddressing("/pa-resume", SA_A, SESSIONS);
    expect(result.override_command).toBe("resume");
  });

  test("natural-language pause variants set override_command", () => {
    expect(parseAddressing("PA, back off", SA_A, SESSIONS).override_command).toBe("pause");
    expect(parseAddressing("PA, stand down", SA_A, SESSIONS).override_command).toBe("pause");
    expect(parseAddressing("PA, take five", SA_A, SESSIONS).override_command).toBe("pause");
  });

  test("natural-language resume variants set override_command", () => {
    expect(parseAddressing("PA, come back in", SA_A, SESSIONS).override_command).toBe("resume");
    expect(parseAddressing("PA, you can resume", SA_A, SESSIONS).override_command).toBe("resume");
  });

  test("unresolvable @SA-<id8> is dropped silently with warning flag", () => {
    const result = parseAddressing("@SA-deadbeef hello", SA_A, SESSIONS);
    expect(result.targets).toEqual([]);
    expect(result.unresolved_addresses).toEqual(["deadbeef"]);
  });

  // 0.30.11 - mention vs address disambiguation (work_item b4c37849)
  test("descriptive mention of @SA in middle of prose does NOT address", () => {
    // Real leak case: PA explained warming and referenced @SA descriptively
    const result = parseAddressing(
      "my warm tick already addresses @SA-d4e5f6a7 every 50min",
      PA,
      SESSIONS,
    );
    expect(result.targets).toEqual([]);
  });

  test("quoted @PA reference does NOT address PA", () => {
    // Real leak case: PA quoted what an SA might say in a reply
    const result = parseAddressing(
      'the SA processes a turn ("@PA warm" reply) and keeps cache fresh',
      SA_A,
      SESSIONS,
    );
    expect(result.pa_addressed).toBe(false);
    expect(result.targets).toEqual([]);
  });

  test("@-address on a new line (after \\n) DOES address", () => {
    const result = parseAddressing(
      "Here is some context.\n@SA-d4e5f6a7 please proceed",
      PA,
      SESSIONS,
    );
    expect(result.targets).toEqual([SA_B.session_id]);
  });

  test("@-address after a comma DOES chain-address", () => {
    const result = parseAddressing("@SA-d4e5f6a7, @SA-abc12345 sync up", PA, SESSIONS);
    expect(result.targets).toEqual(expect.arrayContaining([SA_A.session_id, SA_B.session_id]));
    expect(result.targets).toHaveLength(2);
  });

  test("@-address in a list bullet DOES address", () => {
    const result = parseAddressing(
      "Tasks:\n- @SA-d4e5f6a7: fix the bug\n- @SA-abc12345: run the tests",
      PA,
      SESSIONS,
    );
    expect(result.targets).toEqual(expect.arrayContaining([SA_A.session_id, SA_B.session_id]));
    expect(result.targets).toHaveLength(2);
  });

  test("descriptive mention of @PA in middle of prose does NOT address PA", () => {
    const result = parseAddressing(
      "via @PA in your terminal output - PA's tailing will surface the address",
      SA_A,
      SESSIONS,
    );
    expect(result.pa_addressed).toBe(false);
    expect(result.targets).not.toContain(PA.session_id);
  });
});
