import { describe, test, expect } from "bun:test";
import { detectsRiskyHeredoc, HEREDOC_WARNING } from "../../mcp/tools/hook_event";

// ===========================================================================
// 0.37.0: warn at the moment of use, because the rule did not work.
//
// A Bash heredoc carrying backslash escapes silently REWRITES its payload -
// Git Bash, plus the interpreter reading stdin, plus backslash-bearing source
// is three escaping layers and each rewrites rather than fails. You get a
// plausible file, not an error.
//
// It happened SIX TIMES in one session on 2026-07-28. The fourth prompted a
// CLAUDE.md rule; the fifth and sixth were committed by the person who wrote
// that rule, the same day, one of them while writing the fix for the previous
// one.
//
// SA-90bf73bd's read is why this is code and not more documentation: "a rule
// stored as knowledge loses to a tool that's already in your hand" - so the
// fix isn't better wording anywhere, it's making the broken path fail loudly
// instead of silently rewriting content. Six repeats by the rule's own author
// is evidence, not sloppiness.
//
// THE POSITIVE CONTROLS BELOW ARE THE ACTUAL COMMANDS THAT FAILED. A detector
// validated only against invented examples is the "check that cannot fail"
// this fleet spent the day cataloguing - so each real case is pinned, and the
// negatives are pinned just as hard, because a warning that fires on every
// heredoc trains dismissal exactly like an always-on alert.
// ===========================================================================

describe("0.37.0: risky-heredoc detector", () => {
  describe("FIRES on the real cases from 2026-07-28", () => {
    test("Python heredoc replacing a string containing \\n", () => {
      const cmd = [
        "python - << 'PY'",
        'import io',
        's=s.replace(\'text: lines.join("\\n")\', "x")',
        "PY",
      ].join("\n");
      expect(detectsRiskyHeredoc(cmd)).toBe(true);
    });

    test("Python heredoc with a regex escape (\\s+)", () => {
      const cmd = "python - << 'PY'\ns.replace(/\\s+/g, ' ')\nPY";
      expect(detectsRiskyHeredoc(cmd)).toBe(true);
    });

    test("cat > file heredoc writing TypeScript with .split(\"\\n\")", () => {
      const cmd = [
        "cat >> tests/x.test.ts << 'TSEOF'",
        'const parts = tail.split("\\n");',
        "TSEOF",
      ].join("\n");
      expect(detectsRiskyHeredoc(cmd)).toBe(true);
    });

    test("heredoc containing a doubled backslash", () => {
      expect(detectsRiskyHeredoc("python - << 'PY'\nx = \"a\\\\nb\"\nPY")).toBe(true);
    });

    test("unquoted delimiter is caught too - it is strictly worse", () => {
      // An unquoted delimiter adds shell expansion on top of the collapse.
      expect(detectsRiskyHeredoc("cat > f << EOF\nline\\nbreak\nEOF")).toBe(true);
    });

    test("<<- (tab-stripping) form is caught", () => {
      expect(detectsRiskyHeredoc("cat <<- 'EOF'\n\\t indented\nEOF")).toBe(true);
    });
  });

  describe("STAYS SILENT where there is no risk - the half that rots if unguarded", () => {
    test("a heredoc of plain prose does not fire", () => {
      const cmd = "git commit -F - << 'EOF'\nfix: a normal commit message\n\nNo escapes here at all.\nEOF";
      expect(detectsRiskyHeredoc(cmd)).toBe(false);
    });

    test("backslashes WITHOUT a heredoc do not fire", () => {
      // grep patterns and Windows paths are everywhere; only the combination
      // is dangerous, because only a heredoc does the rewriting.
      expect(detectsRiskyHeredoc("grep -n '\\bword\\b' file.ts")).toBe(false);
      expect(detectsRiskyHeredoc('ls "C:\\Users\\Jarid"')).toBe(false);
    });

    test("an ordinary command does not fire", () => {
      expect(detectsRiskyHeredoc("bun test && git push")).toBe(false);
      expect(detectsRiskyHeredoc("")).toBe(false);
    });

    test("a heredoc whose only backslash is a shell escape does not fire", () => {
      // \$ and \` are shell-level escapes, not the source-code escapes that
      // get silently collapsed into control characters.
      expect(detectsRiskyHeredoc("cat << 'EOF'\ncost is \\$5\nEOF")).toBe(false);
    });
  });

  describe("the warning is actionable, not just alarming", () => {
    test("names the remedy rather than only the hazard", () => {
      expect(HEREDOC_WARNING).toContain("Write");
      expect(HEREDOC_WARNING).toContain("Edit");
    });

    test("says the failure is SILENT - that is why it keeps being ignored", () => {
      // A reader who thinks it would error if it mattered will proceed. The
      // load-bearing fact is that you get a plausible file, not an error.
      expect(HEREDOC_WARNING.toLowerCase()).toContain("silent");
      expect(HEREDOC_WARNING).toContain("not an error");
    });

    test("carries the evidence, so it reads as a finding rather than a nag", () => {
      expect(HEREDOC_WARNING).toContain("0 bytes");
    });
  });
});
