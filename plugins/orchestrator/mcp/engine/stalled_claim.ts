/**
 * 0.42.0: THE HAND-BACK GATE. A blocker RESTATED without an intervening
 * attempt is a claim that has stopped being examined.
 *
 * Jarid's directive, routed via PA on 2026-07-30: the existing struggle
 * guidance is real but detects only REPEATED FAILURE - "same approach 2+
 * times", "same error", "3+ turns", "editing what you just edited" - and the
 * hook counter fires exclusively on PostToolUseFailure. A premature hand-back
 * emits none of those. There is no failed call and no retry loop, just fluent
 * text saying someone else will have to do this. THE COSTLIEST UNDER-TRYING
 * FAILURE IS INVISIBLE TO THE DETECTOR BUILT FOR UNDER-TRYING.
 *
 * FOUR REAL INSTANCES IN ONE DAY, from three lanes:
 *   - FALSE (PA): a spreadsheet handed back while an authenticated browser
 *     session AND the download URL were both already held. Thirty seconds once
 *     they were combined.
 *   - TRUE (PA): a PDF, hours later. Attachment MCP carries metadata only, URL
 *     cookie-guarded, programmatic click landed nothing. Routes enumerated,
 *     not-tried list empty, residual value priced. A real wall.
 *   - FALSE (SA-5a433456): "server_hash far-end verification needs Jarid's
 *     machine", carried a full DAY through a checkpoint and three status
 *     reports. Done in twenty minutes once the asset - an agent session on his
 *     machine with CDP access - was enumerated against the task. Emitted no
 *     struggle signal of any kind, because there was no struggle: not blocked,
 *     MISTAKEN ABOUT WHO COULD ACT.
 *   - FALSE (SA-df343a05): "the file search timed out and was not retried",
 *     restated five times over hours. The directory was a sibling of the one
 *     being searched. One `ls` of the parent.
 *
 * WHY THIS KEYS ON REPETITION AND NOT ON PHRASING. SA-df343a05's caution, and
 * it is the design constraint: "verified at one source of three" and "remains
 * genuinely unknown" are GOOD epistemic hygiene almost always. A detector keyed
 * on that language fires constantly on correct behaviour and becomes the
 * always-on tray light - see CLAUDE.md, a guard that fires unconditionally is
 * indistinguishable from no guard. The signal is not the phrase. It is THE
 * PHRASE REPEATED ACROSS CHECKPOINTS WITH NO INTERVENING ATTEMPT. A first
 * statement always passes silently; only a restatement is challenged.
 *
 * WHY save_progress AND NOT A HOOK. Hooks cannot see assistant text - Stop
 * receives only `event` and `session_id`. save_progress receives the words
 * themselves and the prior checkpoint is already stored, so restatement is
 * mechanically detectable here and nowhere else. It is also exactly where
 * SA-5a433456's instance would have died: theirs went INTO a checkpoint and
 * hardened by repetition from there. Guard at the write, not at the
 * recollection.
 *
 * ENUMERATE, DO NOT FORBID. PA's discriminator is load-bearing: the guidance
 * must demand the enumeration, never block the hand-back. Agents grind forever
 * on real walls otherwise, which is the opposite failure and a worse one. This
 * is advisory text appended to a SUCCESSFUL save - the checkpoint always
 * stores, because losing a checkpoint costs more than any nudge saves.
 */

/** Markers that a line is asserting no agent-executable route remains. Covers
 *  BOTH forms SA-df343a05 identified: a hand-back to a HUMAN, and a
 *  self-hand-back to UNKNOWN. The second is the sneakier one - labelling a
 *  value unknown is the humble-sounding move, so nobody challenges it. */
const BLOCKER_MARKERS = [
  // \b not a trailing space, and no assumption about possessives. The first
  // version was `needs? (?:the )?(?:...|jarid) ` with a literal space, and it
  // MISSED the real instance it was written from - "needs Jarid's machine" -
  // because the apostrophe is not a space. Caught by the fixture on the first
  // run. Match how the data is actually written, not how you happened to type
  // it; a literal catches exactly one formatting.
  /\bneeds?\s+(?:the\s+)?(?:human|user|jarid|his|her|their)\b/i,
  /\bwaiting on\s+(?:the\s+)?(?:human|user|jarid)\b/i,
  /\bonly\s+(?:the\s+)?(?:human|user|jarid)\b.{0,20}\bcan\b/i,
  /\brequires?\s+(?:the\s+)?(?:human|user|jarid)\b/i,
  /\bblocked on\b/i,
  /\bawaiting\b/i,
  /\bnot (?:yet )?(?:verified|retried|attempted|checked)\b/i,
  /\bunverified\b/i,
  /\bunknown\b/i,
  /\bcould not (?:be )?(?:determined|established|resolved)\b/i,
  /\bgave up\b/i,
];

export interface StalledClaim {
  /** The line as written in the NEW checkpoint. */
  text: string;
}

/** Content tokens, for deciding whether two lines assert the same thing. */
function tokens(line: string): Set<string> {
  return new Set(
    line
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3)
  );
}

/** PURE: do these two lines assert the SAME blocked claim? Jaccard over content
 *  tokens. Deliberately fuzzy - the real instances were restated in varying
 *  words ("needs Jarid's machine" / "needs his machine to verify"), so exact
 *  matching would miss the case this exists for. 0.5 is strict enough that two
 *  different blockers in the same domain do not collide. */
export function sameClaim(a: string, b: string, threshold = 0.5): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union > 0 && shared / union >= threshold;
}

/** PURE: lines in `text` that assert a blocker. */
export function extractBlockerLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[-*\s]+/, "").trim();
    if (line.length < 12) continue;
    if (BLOCKER_MARKERS.some((re) => re.test(line))) out.push(line);
  }
  return out;
}

/**
 * PURE: blockers present in BOTH the new checkpoint and the previous one.
 *
 * The intersection is the whole design. A blocker stated for the first time is
 * not evidence of anything - it is usually just true. A blocker stated again,
 * unchanged, after a whole session of work, is a claim nobody re-derived.
 */
export function findRestatedBlockers(
  previousCheckpoint: string | null | undefined,
  newCheckpoint: string
): StalledClaim[] {
  if (!previousCheckpoint) return [];
  const prior = extractBlockerLines(previousCheckpoint);
  if (prior.length === 0) return [];
  const out: StalledClaim[] = [];
  for (const line of extractBlockerLines(newCheckpoint)) {
    if (prior.some((p) => sameClaim(p, line))) out.push({ text: line });
  }
  return out;
}

/**
 * The advisory. Asks for an ASSET re-enumeration specifically - not "try
 * harder", which is what a blocked agent already believes it is doing.
 *
 * PA's framing, and the reason the wording is about assets rather than effort:
 * "a blocked agent's instinct is retrying APPROACHES; the unlock is usually
 * combining two ASSETS it already holds." All three false instances were
 * exactly that - an authenticated session plus a URL; an agent session on the
 * right machine plus a task assumed to need that machine; knowing where the
 * repos sit plus a search that kept failing in the wrong one.
 */
export function formatStalledClaimAdvisory(claims: StalledClaim[]): string {
  if (claims.length === 0) return "";
  const lines = claims.map((c) => `  - "${c.text.slice(0, 150)}"`).join("\n");
  return (
    `\n\n[RESTATED BLOCKER - carried forward unchanged from your last checkpoint]\n` +
    lines +
    `\nThis was already blocked last checkpoint and is blocked again in the same words. ` +
    `A restated blocker is a claim that has stopped being examined - not necessarily wrong, ` +
    `but no longer derived.\n` +
    `Before it hardens: RE-ENUMERATE ASSETS, not approaches. What do you now hold - ` +
    `authenticated sessions, open tabs, credentials, tools, files, a peer's running stack - ` +
    `that you did not hold when you first wrote this? The instinct when blocked is to retry ` +
    `the approach; the unlock is usually combining two assets you already have.\n` +
    `Then answer one question: WHAT CHANGED SINCE I LAST ASSERTED THIS? If nothing did and ` +
    `the wall is real, say so explicitly with the routes you ruled out - that is a fine ` +
    `answer and it survives this check. Real instances of it being WRONG: a file "search ` +
    `timed out, not retried" restated five times, where the directory was a sibling of the ` +
    `one being searched; and "needs the human's machine" carried a full day by a session ` +
    `already running on that machine.`
  );
}
