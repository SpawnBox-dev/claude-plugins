import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// 0.38.0: DOES THE HOOK ACTUALLY REACH THE CODE? Nothing else tested this.
//
// 0.37.0 shipped a heredoc guard with thirteen passing tests. It could never
// fire. PreToolUse was registered with matcher "Write|Edit|MultiEdit|
// NotebookEdit" - Bash was not matched - and the input carried no `command`
// field, so even a matched call would have delivered nothing to read. Found by
// running one harmless heredoc in production and noticing the absence.
//
// The thirteen tests all exercised detectsRiskyHeredoc, a pure function of a
// string, which was correct. THE DELIVERY WAS NEVER CROSSED. That is precisely
// the anti-pattern written the day before (64f126c0): when a feature's
// correctness depends on state or config outside the function, testing the
// function proves nothing. Committed by its author, one day later.
//
// THE BOUNDARY HAS TWO LAYERS AND BOTH DROP SILENTLY:
//   1. hooks.json `matcher` - decides whether the hook fires at all.
//   2. the _hook_event zod schema - builds `payload` from NAMED fields only,
//      so any key it does not declare is discarded before the handler runs.
// Neither logs anything when it drops. A feature reading the missing field
// just quietly does nothing, forever, while its unit tests stay green.
//
// These tests assert the WIRING, which is the half no pure test can see. They
// are deliberately about config rather than behaviour - if that feels like the
// wrong altitude for a test, that judgement is what let 0.37.0 ship inert.
// ===========================================================================

const ROOT = join(import.meta.dir, "..");
const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8"));
const serverSrc = readFileSync(join(ROOT, "mcp", "server.ts"), "utf-8");

type Block = { matcher?: string; hooks: Array<{ input?: Record<string, string> }> };

function preToolUseBlocks(): Block[] {
  return hooks.hooks.PreToolUse as Block[];
}

describe("0.38.0: hook wiring reaches the handlers that read it", () => {
  test("SOME PreToolUse block matches Bash", () => {
    // The 0.37.0 defect in one assertion.
    const matchers = preToolUseBlocks().map((b) => b.matcher ?? "");
    const matchesBash = matchers.some((m) => new RegExp(`^(${m})$`).test("Bash"));
    expect(matchesBash).toBe(true);
  });

  test("the Bash block actually carries the command", () => {
    // Matching without the payload would be the same bug wearing a fix.
    const bashBlock = preToolUseBlocks().find((b) =>
      new RegExp(`^(${b.matcher ?? ""})$`).test("Bash")
    );
    expect(bashBlock).toBeTruthy();
    const input = bashBlock!.hooks[0]?.input ?? {};
    expect(Object.keys(input)).toContain("command");
    expect(input.command).toBe("${tool_input.command}");
  });

  test("the file-editing block still carries file_path - no regression", () => {
    const editBlock = preToolUseBlocks().find((b) =>
      new RegExp(`^(${b.matcher ?? ""})$`).test("Edit")
    );
    expect(editBlock).toBeTruthy();
    expect(editBlock!.hooks[0]?.input?.file_path).toBe("${tool_input.file_path}");
  });

  test("EVERY field EVERY event sends is declared AND copied - all ten events", () => {
    // Generalised from the PreToolUse-only version after an audit found no
    // other instance of the 0.37.0 defect. A one-off audit answers the question
    // once; this keeps answering it. Cheap, because the invariant is uniform:
    // a field that reaches the handler must be (a) sent by hooks.json, (b)
    // declared in the schema, and (c) copied into payload - and (b) and (c)
    // are separate steps that fail independently and silently.
    //
    // Fields consumed at the TOP LEVEL of args rather than through payload
    // (event, session_id, tool_name, agent_id) need only (a) and (b).
    const declared = new Set(
      Array.from(serverSrc.matchAll(/^\s{4}(\w+):\s*z\.(?:string|enum)\(/gm), (m) => m[1])
    );
    const copied = new Set(
      Array.from(serverSrc.matchAll(/payload\.(\w+) = args\.\w+/g), (m) => m[1])
    );
    const topLevel = new Set(["event", "session_id", "tool_name", "agent_id"]);

    const problems: string[] = [];
    for (const [event, blocks] of Object.entries(hooks.hooks as Record<string, Block[]>)) {
      for (const block of blocks) {
        for (const hook of block.hooks) {
          for (const field of Object.keys(hook.input ?? {})) {
            if (!declared.has(field)) problems.push(`${event}.${field}: NOT DECLARED in schema`);
            else if (!topLevel.has(field) && !copied.has(field)) {
              problems.push(`${event}.${field}: declared but NEVER COPIED into payload`);
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("every payload field the HANDLERS read is sent by some event", () => {
    // The inverse question, and the one that actually catches an inert feature.
    // Asking "is anything broken?" found nothing for two days; asking "for each
    // field the code reads, is it delivered?" found the heredoc guard in one
    // pass. Searching for an absence always finds one - search instead for what
    // would be there if the wiring existed.
    const hookSrc = readFileSync(join(ROOT, "mcp", "tools", "hook_event.ts"), "utf-8");
    const read = new Set(
      Array.from(hookSrc.matchAll(/payload\??\.(\w+)/g), (m) => m[1])
    );
    const sent = new Set<string>();
    for (const blocks of Object.values(hooks.hooks as Record<string, Block[]>)) {
      for (const block of blocks) {
        for (const hook of block.hooks) {
          for (const f of Object.keys(hook.input ?? {})) sent.add(f);
        }
      }
    }
    const undelivered = [...read].filter((f) => !sent.has(f));
    expect(undelivered).toEqual([]);
  });

  test("EVERY input field any PreToolUse block sends is DECLARED in the schema", () => {
    // Layer 2. The zod schema drops undeclared keys silently, so a field can be
    // wired in hooks.json, arrive at the server, and vanish before the handler.
    // This catches that without needing to know which feature reads it.
    const declared = new Set(
      Array.from(serverSrc.matchAll(/^\s{4}(\w+):\s*z\.string\(\)\.optional\(\)/gm), (m) => m[1])
    );
    // Always present on the tool signature itself.
    declared.add("event");
    declared.add("session_id");

    for (const block of preToolUseBlocks()) {
      for (const hook of block.hooks) {
        for (const field of Object.keys(hook.input ?? {})) {
          expect({ field, declared: declared.has(field) }).toEqual({
            field,
            declared: true,
          });
        }
      }
    }
  });

  test("a declared field is also COPIED into payload, not just accepted", () => {
    // Layer 2b: declaring the field only stops zod rejecting it. The handler
    // reads args.payload, so the copy is what actually delivers it.
    expect(serverSrc).toContain("payload.command = args.command");
    expect(serverSrc).toContain("payload.file_path = args.file_path");
  });
});
