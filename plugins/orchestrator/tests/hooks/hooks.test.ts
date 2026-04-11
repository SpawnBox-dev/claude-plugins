import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Absolute path to the hooks directory under the source tree.
const HOOKS_DIR = join(import.meta.dir, "..", "..", "hooks");

// Fires a hook script with the given JSON stdin and returns stdout as a
// parsed JSON object (if possible) along with exit code. Uses a dedicated
// temp state dir per call so tests never see each other's markers.
function runHook(
  hookName: string,
  stdinJson: string,
  stateDir: string
): { stdout: string; exitCode: number; json: any | null } {
  const result = spawnSync("bash", [join(HOOKS_DIR, hookName)], {
    input: stdinJson,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: stateDir,
      CLAUDE_HOOK_EVENT_NAME: "startup",
    },
    encoding: "utf8",
  });
  const stdout = result.stdout ?? "";
  let json: any | null = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // Not JSON - that's fine, some hooks emit empty stdout
  }
  return { stdout, exitCode: result.status ?? 1, json };
}

describe("hooks", () => {
  let stateRoot: string;
  let stateDir: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), "orch-hooks-test-"));
    stateDir = stateRoot; // used as CLAUDE_PROJECT_DIR
    // Pre-create the .orchestrator-state subdir so tests that seed fixture
    // files (bridge, struggle markers) don't have to worry about whether the
    // hook has been invoked yet. Hooks will also lazily create it if missing.
    mkdirSync(join(stateDir, ".orchestrator-state"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(stateRoot, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  describe("session-start", () => {
    test("emits valid JSON with startup directive", () => {
      const { exitCode, json } = runHook(
        "session-start",
        '{"session_id":"test-session-1"}',
        stateDir
      );
      expect(exitCode).toBe(0);
      expect(json).not.toBeNull();
      expect(json.additional_context).toContain("MANDATORY FIRST ACTIONS");
      expect(json.hookSpecificOutput.hookEventName).toBe("SessionStart");
    });

    test("writes active-session file with the session_id", () => {
      runHook("session-start", '{"session_id":"test-session-2"}', stateDir);
      const activeFile = join(stateDir, ".orchestrator-state", "active-session");
      expect(existsSync(activeFile)).toBe(true);
      expect(readFileSync(activeFile, "utf8").trim()).toBe("test-session-2");
    });

    test("injects session_id reminder when session_id is present", () => {
      const { json } = runHook(
        "session-start",
        '{"session_id":"abc-123"}',
        stateDir
      );
      expect(json.additional_context).toContain("abc-123");
      expect(json.additional_context).toContain("session_id");
    });

    test("sanitizes malicious session_id with path traversal", () => {
      // Crafted payload attempts to write outside state dir via filename suffix
      runHook(
        "session-start",
        '{"session_id":"../../../evil"}',
        stateDir
      );
      // The sanitization should have collapsed the ID to "unknown" or dropped it
      // The active-session file should NOT contain "../../../evil"
      const activeFile = join(stateDir, ".orchestrator-state", "active-session");
      if (existsSync(activeFile)) {
        const content = readFileSync(activeFile, "utf8").trim();
        expect(content).not.toContain("..");
        expect(content).not.toContain("/");
      }
    });
  });

  describe("user-prompt-submit", () => {
    test("emits rotating reminder variant", () => {
      const { exitCode, json } = runHook(
        "user-prompt-submit",
        '{"session_id":"ups-1"}',
        stateDir
      );
      expect(exitCode).toBe(0);
      expect(json).not.toBeNull();
      expect(json.additional_context).toContain("[orch]");
    });

    test("increments turn counter across invocations", () => {
      runHook("user-prompt-submit", '{"session_id":"ups-turn"}', stateDir);
      runHook("user-prompt-submit", '{"session_id":"ups-turn"}', stateDir);
      runHook("user-prompt-submit", '{"session_id":"ups-turn"}', stateDir);
      const turnFile = join(stateDir, ".orchestrator-state", "turn-ups-turn");
      expect(existsSync(turnFile)).toBe(true);
      expect(readFileSync(turnFile, "utf8").trim()).toBe("3");
    });

    test("clears orch-active marker on each invocation (new turn resets)", () => {
      // Simulate: session has orch activity from a prior turn
      const orchActive = join(
        stateDir,
        ".orchestrator-state",
        "orch-active-ups-reset"
      );
      runHook("user-prompt-submit", '{"session_id":"ups-reset"}', stateDir);
      // File should NOT exist after UserPromptSubmit (it was cleared)
      expect(existsSync(orchActive)).toBe(false);
    });

    test("rotates through different variants as turn counter advances", () => {
      const outputs: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { json } = runHook(
          "user-prompt-submit",
          '{"session_id":"ups-rotate"}',
          stateDir
        );
        outputs.push(json.additional_context);
      }
      // At least two consecutive turns should produce different variant text
      expect(outputs[0]).not.toBe(outputs[1]);
    });

    test("injects bridge content from prior turn if present", () => {
      // Manually write a bridge file to simulate a prior turn's orchestrator activity
      const stateSubDir = join(stateDir, ".orchestrator-state");
      writeFileSync(join(stateSubDir, "bridge-ups-bridge"), "note, update_work_item");
      const { json } = runHook(
        "user-prompt-submit",
        '{"session_id":"ups-bridge"}',
        stateDir
      );
      expect(json.additional_context).toContain("Last turn bridge");
      expect(json.additional_context).toContain("note, update_work_item");
    });
  });

  describe("pre-tool-use", () => {
    test("turn 1: silent free pass (no output)", () => {
      // First UserPromptSubmit sets turn to 1
      runHook("user-prompt-submit", '{"session_id":"pre-t1"}', stateDir);
      const { stdout, exitCode } = runHook(
        "pre-tool-use",
        '{"session_id":"pre-t1","tool_name":"Write"}',
        stateDir
      );
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe(""); // no output on free pass
    });

    test("turn 2 with no orch activity: soft additionalContext", () => {
      runHook("user-prompt-submit", '{"session_id":"pre-t2"}', stateDir);
      runHook("user-prompt-submit", '{"session_id":"pre-t2"}', stateDir);
      const { json } = runHook(
        "pre-tool-use",
        '{"session_id":"pre-t2","tool_name":"Write"}',
        stateDir
      );
      expect(json).not.toBeNull();
      expect(json.hookSpecificOutput.permissionDecision).toBe("allow");
      expect(json.hookSpecificOutput.additionalContext).toContain("Turn 2");
    });

    test("turn 4+ with no orch activity: escalates to permissionDecision ask", () => {
      runHook("user-prompt-submit", '{"session_id":"pre-t4"}', stateDir);
      runHook("user-prompt-submit", '{"session_id":"pre-t4"}', stateDir);
      runHook("user-prompt-submit", '{"session_id":"pre-t4"}', stateDir);
      runHook("user-prompt-submit", '{"session_id":"pre-t4"}', stateDir);
      const { json } = runHook(
        "pre-tool-use",
        '{"session_id":"pre-t4","tool_name":"Write"}',
        stateDir
      );
      expect(json).not.toBeNull();
      expect(json.hookSpecificOutput.permissionDecision).toBe("ask");
      expect(json.hookSpecificOutput.permissionDecisionReason).toContain(
        "Orchestrator discipline check"
      );
    });

    test("orch-active marker skips the nag regardless of turn", () => {
      runHook("user-prompt-submit", '{"session_id":"pre-skip"}', stateDir);
      runHook("user-prompt-submit", '{"session_id":"pre-skip"}', stateDir);
      runHook("user-prompt-submit", '{"session_id":"pre-skip"}', stateDir);
      runHook("user-prompt-submit", '{"session_id":"pre-skip"}', stateDir);
      // Simulate that this turn's orch activity happened
      writeFileSync(
        join(stateDir, ".orchestrator-state", "orch-active-pre-skip"),
        ""
      );
      const { stdout } = runHook(
        "pre-tool-use",
        '{"session_id":"pre-skip","tool_name":"Write"}',
        stateDir
      );
      expect(stdout.trim()).toBe(""); // silent, nag suppressed
    });

    test("preuse-warned marker prevents firing twice in one turn", () => {
      runHook("user-prompt-submit", '{"session_id":"pre-once"}', stateDir);
      runHook("user-prompt-submit", '{"session_id":"pre-once"}', stateDir);
      const first = runHook(
        "pre-tool-use",
        '{"session_id":"pre-once","tool_name":"Write"}',
        stateDir
      );
      const second = runHook(
        "pre-tool-use",
        '{"session_id":"pre-once","tool_name":"Edit"}',
        stateDir
      );
      expect(first.json).not.toBeNull();
      expect(second.stdout.trim()).toBe(""); // second call should be silent
    });
  });

  describe("post-tool-use", () => {
    test("writes orch-active marker on orchestrator MCP tool call", () => {
      runHook(
        "post-tool-use",
        '{"session_id":"post-1","tool_name":"mcp__plugin_orchestrator_memory__note"}',
        stateDir
      );
      const marker = join(
        stateDir,
        ".orchestrator-state",
        "orch-active-post-1"
      );
      expect(existsSync(marker)).toBe(true);
    });

    test("does NOT write marker on non-orchestrator tools", () => {
      runHook(
        "post-tool-use",
        '{"session_id":"post-2","tool_name":"Write"}',
        stateDir
      );
      const marker = join(
        stateDir,
        ".orchestrator-state",
        "orch-active-post-2"
      );
      expect(existsSync(marker)).toBe(false);
    });

    test("appends to bridge file on each orchestrator call", () => {
      runHook(
        "post-tool-use",
        '{"session_id":"post-3","tool_name":"mcp__plugin_orchestrator_memory__note"}',
        stateDir
      );
      runHook(
        "post-tool-use",
        '{"session_id":"post-3","tool_name":"mcp__plugin_orchestrator_memory__update_work_item"}',
        stateDir
      );
      const bridge = join(stateDir, ".orchestrator-state", "bridge-post-3");
      expect(existsSync(bridge)).toBe(true);
      const content = readFileSync(bridge, "utf8");
      expect(content).toContain("note");
      expect(content).toContain("update_work_item");
    });

    test("resets struggle counter on successful tool call", () => {
      // Seed a struggle counter
      writeFileSync(
        join(stateDir, ".orchestrator-state", "struggle-post-4"),
        "2"
      );
      runHook(
        "post-tool-use",
        '{"session_id":"post-4","tool_name":"mcp__plugin_orchestrator_memory__note"}',
        stateDir
      );
      const struggleFile = join(
        stateDir,
        ".orchestrator-state",
        "struggle-post-4"
      );
      expect(existsSync(struggleFile)).toBe(false);
    });
  });

  describe("post-tool-use-failure", () => {
    test("first failure increments counter but does not nag", () => {
      const { stdout, exitCode } = runHook(
        "post-tool-use-failure",
        '{"session_id":"fail-1"}',
        stateDir
      );
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe(""); // no output on first fail
      const struggleFile = join(
        stateDir,
        ".orchestrator-state",
        "struggle-fail-1"
      );
      expect(existsSync(struggleFile)).toBe(true);
      expect(readFileSync(struggleFile, "utf8").trim()).toBe("1");
    });

    test("second consecutive failure emits soft nudge", () => {
      runHook(
        "post-tool-use-failure",
        '{"session_id":"fail-2"}',
        stateDir
      );
      const { json } = runHook(
        "post-tool-use-failure",
        '{"session_id":"fail-2"}',
        stateDir
      );
      expect(json).not.toBeNull();
      expect(json.hookSpecificOutput.additionalContext).toContain(
        "Two tool calls failed"
      );
    });

    test("third+ consecutive failure emits stronger message", () => {
      runHook(
        "post-tool-use-failure",
        '{"session_id":"fail-3"}',
        stateDir
      );
      runHook(
        "post-tool-use-failure",
        '{"session_id":"fail-3"}',
        stateDir
      );
      const { json } = runHook(
        "post-tool-use-failure",
        '{"session_id":"fail-3"}',
        stateDir
      );
      expect(json.hookSpecificOutput.additionalContext).toContain("STOP");
    });
  });

  describe("pre-compact", () => {
    test("emits systemMessage", () => {
      const { exitCode, json } = runHook(
        "pre-compact",
        '{"session_id":"compact-1"}',
        stateDir
      );
      expect(exitCode).toBe(0);
      expect(json).not.toBeNull();
      expect(json.systemMessage).toContain("compaction");
    });
  });

  describe("stop", () => {
    test("blocks once on first call with housekeeping reason", () => {
      const { json } = runHook(
        "stop",
        '{"session_id":"stop-1"}',
        stateDir
      );
      expect(json).not.toBeNull();
      expect(json.decision).toBe("block");
      expect(json.reason).toContain("save_progress");
    });

    test("does not block on second call (once-per-session marker)", () => {
      runHook("stop", '{"session_id":"stop-2"}', stateDir);
      const { stdout } = runHook(
        "stop",
        '{"session_id":"stop-2"}',
        stateDir
      );
      expect(stdout.trim()).toBe("");
    });
  });

  describe("subagent-stop", () => {
    test("blocks once on first call with capture reason", () => {
      const { json } = runHook(
        "subagent-stop",
        '{"session_id":"subs-1"}',
        stateDir
      );
      expect(json).not.toBeNull();
      expect(json.decision).toBe("block");
      expect(json.reason).toContain("note");
    });

    test("does not block on second call (once-per-session marker)", () => {
      runHook("subagent-stop", '{"session_id":"subs-2"}', stateDir);
      const { stdout } = runHook(
        "subagent-stop",
        '{"session_id":"subs-2"}',
        stateDir
      );
      expect(stdout.trim()).toBe("");
    });
  });

  describe("_lib state dir", () => {
    test("drops .gitignore when state dir is created", () => {
      runHook(
        "session-start",
        '{"session_id":"gitignore-test"}',
        stateDir
      );
      const gitignore = join(stateDir, ".orchestrator-state", ".gitignore");
      expect(existsSync(gitignore)).toBe(true);
      expect(readFileSync(gitignore, "utf8").trim()).toBe("*");
    });
  });
});
