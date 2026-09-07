import { describe, expect, test } from "bun:test";
import {
  buildVocabulary,
  decideTags,
  formatTagAdvice,
  normalizeTagKey,
  splitNamespace,
  suggestEstablished,
  type TagStat,
} from "../../mcp/engine/tag_vocabulary";

// ===========================================================================
// WI cbf82684 - TAG GOVERNANCE.
//
// The fixture below is NOT invented. Every count is taken from the live
// corpus read read-only on 2026-09-07 with a positive control asserted, so
// these tests pin behaviour against the vocabulary that actually exists
// rather than against a shape I imagined.
// ===========================================================================

const LIVE: TagStat[] = [
  // The real collisions, with their real counts.
  { tag: "work_item", count: 1829 }, { tag: "work-item", count: 6 },
  { tag: "anti_pattern", count: 1018 }, { tag: "anti-pattern", count: 53 },
  { tag: "ux", count: 278 }, { tag: "UX", count: 7 },
  { tag: "lane:PORTAL", count: 202 }, { tag: "lane:portal", count: 1 },
  { tag: "wsl", count: 196 }, { tag: "WSL", count: 1 },
  { tag: "discord_sourced", count: 164 }, { tag: "discord-sourced", count: 7 },
  { tag: "open_thread", count: 136 }, { tag: "open-thread", count: 1 },
  { tag: "quality_gate", count: 79 }, { tag: "quality-gate", count: 30 },
  // Ordinary established vocabulary.
  { tag: "measured", count: 140 },
  { tag: "verified-live", count: 44 },
  { tag: "epic:spawnwave", count: 548 },
  { tag: "area:backend", count: 210 },
  { tag: "area:worker", count: 96 },
  { tag: "lane:DISCORD", count: 61 },
  // Singletons - 77% of the real corpus looks like this.
  { tag: "my-paper-strip-claim-RETRACTED", count: 1 },
  { tag: "second-widening-caught", count: 1 },
];

const vocab = buildVocabulary(LIVE);

describe("normalization primitives", () => {
  test("folds only case and separator, never digits or dates", () => {
    expect(normalizeTagKey("anti-pattern")).toBe(normalizeTagKey("anti_pattern"));
    expect(normalizeTagKey("UX")).toBe(normalizeTagKey("ux"));
    // The over-normalisation that inflated an earlier collision count 304 -> 503.
    expect(normalizeTagKey("2026-09-06")).not.toBe(normalizeTagKey("2026-09-07"));
    expect(normalizeTagKey("related:aabbccdd")).not.toBe(normalizeTagKey("related:11223344"));
  });

  test("a namespace is an identifier, not any string containing a colon", () => {
    expect(splitNamespace("lane:PORTAL")).toEqual({ ns: "lane", value: "PORTAL" });
    expect(splitNamespace("no-colon-here")).toBeNull();
    expect(splitNamespace(":leading")).toBeNull();
    expect(splitNamespace("trailing:")).toBeNull();
    // Prose and timestamps must not be parsed as namespaces.
    expect(splitNamespace("measured at 05:32Z")).toBeNull();
  });
});

describe("canonicalisation - the safe, automatic half", () => {
  test("folds a rare spelling into the established one", () => {
    const [d] = decideTags(["anti-pattern"], vocab);
    expect(d.action).toBe("canonicalised");
    expect(d.output).toBe("anti_pattern");
    expect(d.reason).toContain("1018");
  });

  test("DIRECTION IS BY USAGE, not alphabetical - the corpus votes", () => {
    // quality_gate(79) vs quality-gate(30): both established, majority wins.
    expect(decideTags(["quality-gate"], vocab)[0].output).toBe("quality_gate");
    // and the winner is left alone
    expect(decideTags(["quality_gate"], vocab)[0].action).toBe("kept");
  });

  test("lane:portal and lane:PORTAL stop being different lanes", () => {
    const [d] = decideTags(["lane:portal"], vocab);
    expect(d.output).toBe("lane:PORTAL");
    expect(d.action).toBe("canonicalised");
  });

  test("resolves BOTH halves of a namespaced tag in one pass", () => {
    // Neither the namespace spelling nor the value matches on its own.
    const [d] = decideTags(["Lane:portal"], vocab);
    expect(d.output).toBe("lane:PORTAL");
  });

  test("a namespace VALUE never seen before is kept, not invented", () => {
    const [d] = decideTags(["lane:NEWLANE"], vocab);
    expect(d.output).toBe("lane:NEWLANE");
  });

  test("two inputs that canonicalise to the same tag collapse to one", () => {
    const out = decideTags(["anti-pattern", "anti_pattern"], vocab);
    expect(out.length).toBe(1);
    expect(out[0].output).toBe("anti_pattern");
  });

  test("NEGATIVE CONTROL: two singletons do not pick a winner", () => {
    // Nothing is established, so there is no corpus vote to follow.
    const v = buildVocabulary([{ tag: "foo-bar", count: 1 }, { tag: "foo_bar", count: 1 }]);
    expect(decideTags(["foo_bar"], v)[0].action).not.toBe("canonicalised");
  });
});

describe("suggestion - the half that must NOT block", () => {
  test("a novel tag surfaces established vocabulary that shares meaning", () => {
    const [d] = decideTags(["discord-reported"], vocab);
    expect(d.action).toBe("novel");
    expect(d.output).toBe("discord-reported"); // kept as written - never blocked
    expect(d.candidates!.map((c) => c.tag)).toContain("discord_sourced");
  });

  test("suggestions never cross a namespace boundary", () => {
    const s = suggestEstablished("lane:BACKEND", vocab);
    for (const c of s) expect(c.tag.startsWith("lane:")).toBe(true);
    // and a bare tag is never offered a namespaced alternative
    for (const c of suggestEstablished("backend-thing", vocab)) {
      expect(c.tag.includes(":")).toBe(false);
    }
  });

  test("an established tag is never offered as a suggestion to itself", () => {
    expect(suggestEstablished("measured", vocab).map((c) => c.tag)).not.toContain("measured");
  });

  test("SINGLETONS ARE NEVER SUGGESTED - noise must not be laundered into advice", () => {
    const s = suggestEstablished("paper-strip-thing", vocab);
    expect(s.map((c) => c.tag)).not.toContain("my-paper-strip-claim-RETRACTED");
  });

  test("A TAG THAT MERELY EXISTS IS NOT EXEMPT - only an ESTABLISHED one is", () => {
    // The first version of this exempted anything with count >= 1, which
    // defeated the purpose: 77% of the real corpus is singletons, so "it
    // already exists" is true of three quarters of the noise. Reusing another
    // agent's one-off does not make it a facet.
    const v = buildVocabulary([
      ...LIVE,
      { tag: "discord-reported-once", count: 1 },
    ]);
    const [d] = decideTags(["discord-reported-once"], v);
    expect(d.action).toBe("novel");
    expect(d.candidates!.map((c) => c.tag)).toContain("discord_sourced");
    // ...and it is still STORED as written. Advice, never a block.
    expect(d.output).toBe("discord-reported-once");
  });

  test("an established tag stays silent even though it shares tokens widely", () => {
    // The exemption must key on the tag's OWN standing, not on absence of
    // neighbours - `discord_sourced` has plenty of neighbours and must not nag.
    const [d] = decideTags(["discord_sourced"], vocab);
    expect(d.action).toBe("kept");
    expect(d.candidates).toBeUndefined();
  });

  test("NEGATIVE CONTROL: a genuinely unrelated tag gets no suggestions", () => {
    const [d] = decideTags(["zzq-unrelated-token"], vocab);
    expect(d.action).toBe("kept");
    expect(d.candidates).toBeUndefined();
  });

  test("stopword-only overlap does not manufacture a match", () => {
    // "the"/"of" style overlap must not be enough on its own.
    const v = buildVocabulary([{ tag: "found-by-the-eyes", count: 50 }]);
    expect(suggestEstablished("the", v).length).toBe(0);
  });
});

describe("the advice string an agent actually reads", () => {
  test("SILENT on the ordinary case", () => {
    // Every tag established and correctly spelled -> nothing to say.
    expect(formatTagAdvice(decideTags(["work_item", "measured"], vocab))).toBeNull();
  });

  test("reports a canonicalisation as done, not as a request", () => {
    const msg = formatTagAdvice(decideTags(["anti-pattern"], vocab))!;
    expect(msg).toContain("anti_pattern");
    expect(msg).toContain("nothing was dropped");
  });

  test("frames novel tags as a choice and says they were kept", () => {
    const msg = formatTagAdvice(decideTags(["discord-reported"], vocab))!;
    expect(msg).toContain("discord_sourced");
    expect(msg).toContain("Kept as written");
  });
});

describe("the whole-write path", () => {
  test("a realistic mixed write: fixes spellings, flags novelty, keeps the rest", () => {
    const out = decideTags(
      ["work-item", "lane:portal", "discord-reported", "measured"],
      vocab,
    );
    const byInput = Object.fromEntries(out.map((d) => [d.input, d]));
    expect(byInput["work-item"].output).toBe("work_item");
    expect(byInput["lane:portal"].output).toBe("lane:PORTAL");
    expect(byInput["discord-reported"].action).toBe("novel");
    expect(byInput["measured"].action).toBe("kept");
    // Nothing is ever dropped: every input produces a stored tag.
    expect(out.length).toBe(4);
  });

  test("an empty or whitespace tag is discarded, not stored", () => {
    expect(decideTags(["", "   "], vocab).length).toBe(0);
  });
});
