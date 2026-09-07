/**
 * TAG GOVERNANCE (WI cbf82684). Make an agent's tag choice deterministic by
 * telling it, at the moment of writing, what vocabulary already exists.
 *
 * THE MEASUREMENT THAT MOTIVATES THIS (live, 2026-09-07, controls asserted):
 * 22,644 distinct tags across 10,806 tagged notes, and 17,448 of them - 77.1% -
 * are used EXACTLY ONCE. In the sixteen hours after the problem was first
 * measured, 223 new notes added 1,382 new distinct tags, ~1,238 of which are
 * singletons. Seven careful agents, all trying to be precise, all making it
 * worse in the same night.
 *
 * SO THIS IS AN AFFORDANCE PROBLEM, NOT A DISCIPLINE PROBLEM. A free-text tag
 * is the cheapest possible action and nothing at the call site lists what is
 * already in use. An agent needing "a customer reported this" cannot discover
 * that `discord_sourced` (164 uses) exists, so it writes `customer-reported`.
 * That is `feedback_construct_over_discipline` applied to tagging: a rule that
 * must be REMEMBERED fails once per session, so replace it with a mechanism.
 *
 * WHY THIS IS PURELY LEXICAL AND NOT EMBEDDING-BACKED. Jarid's word was
 * DETERMINISTIC. Embedding similarity is neither deterministic nor always
 * available - the sidecar can be down, and a governance layer that silently
 * stops governing when a subprocess dies is the same class of failure as an
 * alert that cannot fire. Everything here is a pure function of the tag string
 * and the existing vocabulary, so it behaves identically on every machine and
 * every run. A semantic layer can be added ON TOP later; it must not be the
 * floor.
 *
 * IT SUGGESTS, IT DOES NOT BLOCK (Jarid's ruling, 2026-09-07). Canonicalising
 * a SPELLING is safe and automatic - `lane:portal` and `lane:PORTAL` are the
 * same lane and treating them as two is simply a bug. Proposing a DIFFERENT
 * tag is a judgement about meaning, and the note gate's precedent of blocking
 * is too heavy here: a large share of the singleton mass is legitimate one-off
 * narrative (`my-paper-strip-claim-RETRACTED`), which is useful and must not be
 * linted away. It is not a facet; it just lives in the facet field.
 */

export interface TagStat {
  tag: string;
  count: number;
}

export interface TagVocabulary {
  /** exact spelling -> number of applications */
  counts: Map<string, number>;
  /** normalized key -> spellings, most-used first */
  byKey: Map<string, string[]>;
  /** namespace (lowercased) -> canonical namespace spelling, most-used first */
  namespaces: Map<string, string>;
  /** "ns" -> (normalized value -> canonical value spelling) */
  namespaceValues: Map<string, Map<string, string>>;
}

/**
 * Fold the two differences that never carry meaning: case, and the CHOICE
 * between `-` and `_` at a position where both spellings have a separator.
 *
 * SEPARATORS ARE UNIFIED, NOT REMOVED, and that distinction is load-bearing.
 * An earlier version stripped them, which made `yakuzer__` and `yakuzer` the
 * same token - a Discord handle folded into a different Discord handle, which
 * is a claim about WHO SOMEONE IS rather than how a word is spelled. The live
 * dry run surfaced five such applications, plus `event-bus`/`eventbus`,
 * `lemonsqueezy`/`lemon-squeezy` and `SmartTooltip`/`smarttooltip`.
 *
 * Adding or removing a separator changes the token. `foot-gun` and `footgun`
 * plainly mean the same thing, but which one is canonical is a PREFERENCE, and
 * this function's output is applied automatically to other people's notes. It
 * may only fold differences that are unambiguously the same token written two
 * ways. Everything else is a suggestion for a human, which is what the
 * `novel` path is for.
 *
 * Also deliberately NOT folding digits or dates: that would collapse
 * `2026-09-06` into `2026-09-07`, and masking ids would collapse unrelated
 * `related:<id8>` tags - the over-normalisation that inflated an earlier count
 * of these collisions from 304 to 503 before it was caught.
 */
export function normalizeTagKey(tag: string): string {
  return tag.toLowerCase().replace(/[-_]/g, "-");
}

/** Split `ns:value` once, or null when the tag carries no namespace. */
export function splitNamespace(tag: string): { ns: string; value: string } | null {
  const i = tag.indexOf(":");
  if (i <= 0 || i === tag.length - 1) return null;
  const ns = tag.slice(0, i);
  // A namespace is an identifier, never a sentence. This keeps timestamps and
  // prose containing a colon out of the namespace machinery.
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(ns)) return null;
  return { ns, value: tag.slice(i + 1) };
}

/**
 * Build the lookup structures from raw counts. Ordering is by USAGE, so the
 * canonical spelling is the one the corpus already voted for rather than the
 * one that happens to sort first.
 */
export function buildVocabulary(stats: TagStat[]): TagVocabulary {
  const counts = new Map<string, number>();
  for (const s of stats) {
    if (!s.tag) continue;
    counts.set(s.tag, (counts.get(s.tag) ?? 0) + s.count);
  }

  const byKey = new Map<string, string[]>();
  for (const tag of counts.keys()) {
    const k = normalizeTagKey(tag);
    const arr = byKey.get(k);
    if (arr) arr.push(tag);
    else byKey.set(k, [tag]);
  }
  for (const arr of byKey.values()) {
    arr.sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b));
  }

  // Namespaces, and the values used within each.
  const nsCounts = new Map<string, Map<string, number>>();
  const nsValueCounts = new Map<string, Map<string, Map<string, number>>>();
  for (const [tag, c] of counts) {
    const split = splitNamespace(tag);
    if (!split) continue;
    const nsKey = split.ns.toLowerCase();
    const spellings = nsCounts.get(nsKey) ?? new Map<string, number>();
    spellings.set(split.ns, (spellings.get(split.ns) ?? 0) + c);
    nsCounts.set(nsKey, spellings);

    const vKey = normalizeTagKey(split.value);
    const perNs = nsValueCounts.get(nsKey) ?? new Map<string, Map<string, number>>();
    const vSpellings = perNs.get(vKey) ?? new Map<string, number>();
    vSpellings.set(split.value, (vSpellings.get(split.value) ?? 0) + c);
    perNs.set(vKey, vSpellings);
    nsValueCounts.set(nsKey, perNs);
  }

  const pickTop = (m: Map<string, number>): string =>
    [...m.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0][0];

  const namespaces = new Map<string, string>();
  for (const [k, m] of nsCounts) namespaces.set(k, pickTop(m));

  const namespaceValues = new Map<string, Map<string, string>>();
  for (const [nsKey, perNs] of nsValueCounts) {
    const out = new Map<string, string>();
    for (const [vKey, m] of perNs) out.set(vKey, pickTop(m));
    namespaceValues.set(nsKey, out);
  }

  return { counts, byKey, namespaces, namespaceValues };
}

export type TagAction =
  /** Already the established spelling, or genuinely novel with nothing close. */
  | "kept"
  /** Rewritten to the spelling the corpus already uses. Automatic and safe. */
  | "canonicalised"
  /** Novel, but established tags exist that may mean the same thing. */
  | "novel";

export interface TagDecision {
  input: string;
  /** What will actually be stored. */
  output: string;
  action: TagAction;
  /** Populated for `canonicalised`: why it changed. */
  reason?: string;
  /** Populated for `novel`: established tags worth considering instead. */
  candidates?: TagStat[];
}

/** A tag must be this well-used before it is offered as an alternative. Below
 *  this, "established" would mean "someone else's singleton", which is how a
 *  suggestion engine launders noise into a recommendation. */
export const ESTABLISHED_MIN_USES = 10;

/** Tokens too generic to imply two tags mean the same thing. Matching on these
 *  alone produces confident nonsense (`found-by-eyes` -> `found-2026-08-09`). */
const STOPWORDS = new Set([
  "a", "an", "the", "is", "in", "of", "to", "by", "on", "at", "for", "and", "or",
  "not", "no", "it", "its", "this", "that", "was", "were", "be", "been",
  "with", "from", "as", "we", "our",
]);

function tokens(tag: string): string[] {
  const split = splitNamespace(tag);
  const body = split ? split.value : tag;
  return body
    .toLowerCase()
    .split(/[-_:.\s]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Established tags that share meaningful tokens with a novel one.
 *
 * Requires a shared token that is not a stopword, and ranks by how much of the
 * NOVEL tag is explained by the candidate - so `customer-reported` surfaces
 * `discord_sourced` only if they share vocabulary, and a tag sharing one word
 * out of six does not outrank one sharing two out of three.
 */
export function suggestEstablished(
  tag: string,
  vocab: TagVocabulary,
  limit = 3,
  minUses = ESTABLISHED_MIN_USES,
): TagStat[] {
  const mine = new Set(tokens(tag));
  if (mine.size === 0) return [];
  const mySplit = splitNamespace(tag);

  const scored: Array<{ tag: string; count: number; score: number }> = [];
  for (const [candidate, count] of vocab.counts) {
    if (count < minUses) continue;
    if (candidate === tag) continue;
    const cSplit = splitNamespace(candidate);
    // Never propose across a namespace boundary: `lane:PORTAL` and `portal`
    // are different kinds of statement, and a suggestion that crosses that
    // line is worse than none.
    if (!!mySplit !== !!cSplit) continue;
    if (mySplit && cSplit && mySplit.ns.toLowerCase() !== cSplit.ns.toLowerCase()) continue;

    const theirs = tokens(candidate);
    if (theirs.length === 0) continue;
    let shared = 0;
    for (const t of new Set(theirs)) if (mine.has(t)) shared++;
    if (shared === 0) continue;
    // Coverage of the novel tag, tie-broken by how focused the candidate is.
    const score = shared / mine.size + shared / new Set(theirs).size / 100;
    scored.push({ tag: candidate, count, score });
  }

  scored.sort((a, b) => (b.score - a.score) || (b.count - a.count) || a.tag.localeCompare(b.tag));
  return scored.slice(0, limit).map(({ tag, count }) => ({ tag, count }));
}

/**
 * Decide what to store for each supplied tag, and what to tell the caller.
 *
 * Canonicalisation runs in two passes because a namespaced tag has two
 * independently-misspellable halves: `Lane:portal` needs both the `lane`
 * namespace and the `PORTAL` value resolved, and neither pass alone gets there.
 */
export function decideTags(inputTags: string[], vocab: TagVocabulary): TagDecision[] {
  const out: TagDecision[] = [];
  const emitted = new Set<string>();

  for (const raw of inputTags) {
    const input = raw.trim();
    if (!input) continue;

    let output = input;
    let reason: string | undefined;

    // Pass 1: whole-tag spelling. The corpus's most-used spelling wins.
    const group = vocab.byKey.get(normalizeTagKey(input));
    if (group && group.length > 0 && group[0] !== input) {
      // Only fold toward a spelling that is actually established; otherwise a
      // pair of singletons would pick a winner for no reason.
      const dominant = group[0];
      if ((vocab.counts.get(dominant) ?? 0) > (vocab.counts.get(input) ?? 0)) {
        output = dominant;
        reason = `established spelling (${vocab.counts.get(dominant)} uses)`;
      }
    }

    // Pass 2: namespace halves, when the whole tag was not already resolved.
    if (output === input) {
      const split = splitNamespace(input);
      if (split) {
        const nsKey = split.ns.toLowerCase();
        const canonNs = vocab.namespaces.get(nsKey);
        const canonVal = vocab.namespaceValues.get(nsKey)?.get(normalizeTagKey(split.value));
        const ns = canonNs ?? split.ns;
        const val = canonVal ?? split.value;
        if (ns !== split.ns || val !== split.value) {
          output = `${ns}:${val}`;
          reason =
            canonVal && canonVal !== split.value
              ? `established value in the \`${ns}:\` namespace`
              : `established namespace spelling \`${ns}:\``;
        }
      }
    }

    if (emitted.has(output)) continue; // canonicalisation can collapse two inputs into one
    emitted.add(output);

    if (output !== input) {
      out.push({ input, output, action: "canonicalised", reason });
      continue;
    }

    // A tag is exempt from advice only once it is ESTABLISHED - not merely
    // because it exists. Treating "count >= 1" as established was the first
    // version of this and it defeated the purpose: 17,448 of the 22,644 tags in
    // this corpus are used exactly once, so "it already exists" is true of
    // three quarters of the noise. A singleton is not vocabulary an agent can
    // discover or filter on; it is a previous agent's one-off, and reusing it
    // twice does not make it a facet.
    const known = vocab.counts.get(output) ?? 0;
    if (known >= ESTABLISHED_MIN_USES) {
      out.push({ input, output, action: "kept" });
      continue;
    }

    const candidates = suggestEstablished(output, vocab);
    out.push({
      input,
      output,
      action: candidates.length > 0 ? "novel" : "kept",
      candidates: candidates.length > 0 ? candidates : undefined,
    });
  }

  return out;
}

/**
 * The line an agent actually reads. Returns null when there is nothing worth
 * saying - silence on the ordinary case is what keeps the noisy case legible,
 * and a governance notice that fires on every write is one people learn to
 * skip.
 */
export function formatTagAdvice(decisions: TagDecision[]): string | null {
  const fixed = decisions.filter((d) => d.action === "canonicalised");
  const novel = decisions.filter((d) => d.action === "novel" && d.candidates?.length);
  if (fixed.length === 0 && novel.length === 0) return null;

  const lines: string[] = [];
  if (fixed.length > 0) {
    lines.push(
      `[tags] normalized to the spelling already in use: ` +
        fixed.map((d) => `\`${d.input}\` -> \`${d.output}\``).join(", ") +
        `. Stored as shown; nothing was dropped.`,
    );
  }
  if (novel.length > 0) {
    lines.push(
      `[tags] these are NEW vocabulary. If an established tag already means the ` +
        `same thing, prefer it - 77% of this corpus's tags are used exactly once, ` +
        `which is what makes tags unsearchable:`,
    );
    for (const d of novel) {
      const alts = d.candidates!.map((c) => `\`${c.tag}\` (${c.count})`).join(", ");
      lines.push(`  \`${d.output}\` - established nearby: ${alts}`);
    }
    lines.push(
      `  Kept as written. A genuinely one-off annotation is fine here; a facet ` +
        `you will want to filter on later is not.`,
    );
  }
  return lines.join("\n");
}
