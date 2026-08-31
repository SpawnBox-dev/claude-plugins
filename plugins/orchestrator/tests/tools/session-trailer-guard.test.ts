import { describe, test, expect } from "bun:test";
import {
  detectsMissingSessionTrailer,
  commandCarriesSessionTrailer,
  SESSION_TRAILER_WARNING,
} from "../../mcp/tools/hook_event";

// ===========================================================================
// 0.69.3: the Claude-Session trailer, checked at the moment of commit.
//
// WORK ITEM ab0ad62e. The trailer is the authorship guarantee - the only link
// between a commit and the session that produced it - and it is typed by the
// agent every single time with nothing validating it. The item's standing
// success criterion is that the mechanism must be able to return "no" on a
// REAL specimen before it ships.
//
// PROVENANCE OF THE SPECIMENS, stated precisely because the distinction is
// the point. The four failing commits are REAL and were found by measuring
// the spawnbox repo on 2026-08-31: of the last 300 commits, 296 carry the
// trailer and these 4 do not. Their SUBJECT LINES below were READ from
// `git log`, not typed from memory. The surrounding `git commit -m ...`
// wrapper is a RECONSTRUCTION - the original command strings are not
// recoverable from git, only the messages they produced. So: messages are
// evidence, wrappers are reconstruction, and this comment exists so nobody
// later reads these as verbatim transcripts (anti_pattern e2ab6bed).
//
// The compliant specimen is fully real: ff4933b2's actual trailer line.
//
// WHY THE NEGATIVES ARE PINNED AS HARD AS THE POSITIVES. This warning ships
// to every project running the orchestrator, most of which have never heard
// of this convention. A check that fires on ordinary commits would become
// exactly the wallpaper that trains agents to dismiss ALL nudges - the
// habituation failure Jarid named in 3d7099db. The silent cases are the
// safety property, not the leftovers.
// ===========================================================================

// Real trailer line, read from ff4933b2.
const REAL_TRAILER =
  "Claude-Session: https://claude.ai/code/session_019DVqbz9oJMPZBsJ1snq7Bj";

describe("0.69.3: Claude-Session trailer detector", () => {
  describe("FIRES on the four real trailer-less commits (spawnbox, 2026-08-29)", () => {
    // Subject lines read from git log; -m wrapper reconstructed.
    const realSubjects = [
      "docs(account-skill): fold the five KB-archaeology records, add the copy-freeze gate",
      "chore(account-skill): record the tier-literal sweep in the ledger",
      "docs(account-skill): assert your scope before a zero counts, and fold the a5bb5c3f archaeology record",
      "feat(account-skill): owner is required on any record that can go RUN",
    ];

    for (const subject of realSubjects) {
      test(`fires on: ${subject.slice(0, 46)}...`, () => {
        expect(detectsMissingSessionTrailer(`git commit -m "${subject}"`)).toBe(true);
      });
    }

    test("fires on the combined short flag `-am`, which a naive /-m/ misses", () => {
      expect(detectsMissingSessionTrailer('git commit -am "chore: quick fix"')).toBe(true);
    });

    test("fires on --amend when a NEW message is supplied inline", () => {
      // The message is authored here, so its trailer is readable and absent.
      expect(
        detectsMissingSessionTrailer('git commit --amend -m "fix: reworded"')
      ).toBe(true);
    });

    test("fires on a heredoc-fed message with no trailer", () => {
      const cmd = [
        "git commit -F - << 'EOF'",
        "feat: a multi-line message",
        "",
        "Body text with no trailer at all.",
        "EOF",
      ].join("\n");
      expect(detectsMissingSessionTrailer(cmd)).toBe(true);
    });

    test("fires after a && chain, where the commit is not at position 0", () => {
      expect(
        detectsMissingSessionTrailer('git add -A && git commit -m "chore: staged"')
      ).toBe(true);
    });
  });

  describe("STAYS SILENT when the message is COMPLIANT", () => {
    test("the real ff4933b2 trailer suppresses it", () => {
      const cmd = [
        "git commit -F - << 'EOF'",
        "fix(emails): compare grace_period_ends_at as a date, not as text",
        "",
        "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>",
        REAL_TRAILER,
        "EOF",
      ].join("\n");
      expect(detectsMissingSessionTrailer(cmd)).toBe(false);
    });

    test("an inline -m carrying the trailer does not fire", () => {
      expect(
        detectsMissingSessionTrailer(`git commit -m "fix: x\n\n${REAL_TRAILER}"`)
      ).toBe(false);
    });
  });

  describe("STAYS SILENT when the message CANNOT BE SEEN - the f7bc27b8 lesson", () => {
    // "I cannot read it" and "it is missing" are different claims. The whole
    // defect on f7bc27b8 is a detector that reported one while measuring the
    // other; asserting a missing trailer on a message this hook never saw
    // would reproduce it inside its own remedy.

    test("a bare `git commit` (opens an editor) does not fire", () => {
      expect(detectsMissingSessionTrailer("git commit")).toBe(false);
    });

    test("`-F somefile` does not fire - the message is in the file, not here", () => {
      expect(detectsMissingSessionTrailer("git commit -F /tmp/msg.txt")).toBe(false);
    });

    test("--amend --no-edit does not fire - the message is inherited", () => {
      expect(detectsMissingSessionTrailer("git commit --amend --no-edit")).toBe(false);
    });

    test("-C HEAD (reuse-message) does not fire", () => {
      expect(detectsMissingSessionTrailer("git commit --amend -C HEAD")).toBe(false);
    });
  });

  describe("POSITION matters: `git -C <path> commit` is not `git commit -C <commit>`", () => {
    // Same two letters, opposite meanings, decided entirely by whether they
    // fall before or after the `commit` token. Reading flags from the whole
    // command instead of the tail silently suppresses every commit made from
    // another directory - a false NEGATIVE, which is the invisible direction.

    test("`git -C <path> commit -m` with no trailer STILL fires", () => {
      expect(
        detectsMissingSessionTrailer('git -C /repo commit -m "chore: from elsewhere"')
      ).toBe(true);
    });

    test("`git -C <path> commit` WITH the trailer stays silent", () => {
      expect(
        detectsMissingSessionTrailer(`git -C /repo commit -m "chore: x\n${REAL_TRAILER}"`)
      ).toBe(false);
    });
  });

  describe("STAYS SILENT on everything that is not a commit", () => {
    test("other git commands do not fire", () => {
      expect(detectsMissingSessionTrailer("git push origin main")).toBe(false);
      expect(detectsMissingSessionTrailer("git log -1 --format=%B")).toBe(false);
      expect(detectsMissingSessionTrailer("git status --porcelain")).toBe(false);
    });

    test("non-git commands do not fire", () => {
      expect(detectsMissingSessionTrailer("bun test && echo done")).toBe(false);
      expect(detectsMissingSessionTrailer("")).toBe(false);
    });

    test("a commit-shaped SUBSTRING inside another word does not fire", () => {
      // `git commitment` is not `git commit`; \b guards the token.
      expect(detectsMissingSessionTrailer("git commitment-check --all")).toBe(false);
    });
  });

  describe("the ARMING predicate, which keeps this off foreign repos", () => {
    test("a compliant commit command arms the convention", () => {
      expect(
        commandCarriesSessionTrailer(`git commit -m "x\n${REAL_TRAILER}"`)
      ).toBe(true);
    });

    test("a trailer-less commit does NOT arm it", () => {
      expect(commandCarriesSessionTrailer('git commit -m "x"')).toBe(false);
    });

    test("a non-commit command mentioning the trailer does not arm it", () => {
      // Otherwise `grep Claude-Session:` would arm a repo that never uses it.
      expect(commandCarriesSessionTrailer("grep -rn 'Claude-Session:' .")).toBe(false);
    });
  });

  describe("the warning is a FACT, not a gate - Jarid's design test (3d7099db)", () => {
    test("names the exact missing line, so the remedy needs no lookup", () => {
      expect(SESSION_TRAILER_WARNING).toContain("Claude-Session:");
      expect(SESSION_TRAILER_WARNING).toContain("Co-Authored-By");
    });

    test("says the failure is SILENT - a reader expecting an error will proceed", () => {
      expect(SESSION_TRAILER_WARNING.toLowerCase()).toContain("silently");
      expect(SESSION_TRAILER_WARNING).toContain("exits 0");
    });

    test("carries the measured base rate, so it reads as a finding not a nag", () => {
      expect(SESSION_TRAILER_WARNING).toContain("296");
      expect(SESSION_TRAILER_WARNING).toContain("300");
    });

    test("explicitly leaves judgment with the agent rather than caging it", () => {
      expect(SESSION_TRAILER_WARNING).toContain("not a gate");
      expect(SESSION_TRAILER_WARNING.toLowerCase()).toContain("judgment");
    });
  });
});
