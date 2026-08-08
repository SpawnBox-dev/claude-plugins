import { statSync, readFileSync } from "node:fs";

/**
 * Propagate Claude Code's `/rename` into the agent-channel registry name
 * (work item c086c27b; design + live measurements in insight cc1d3816).
 *
 * WHY THIS EXISTS. The registry `name` is read ONCE at MCP startup from
 * ORCHESTRATOR_AGENT_NAME - which the launchers default to
 * `SA-<launch timestamp>` - and then re-upserted on every heartbeat. Jarid's
 * standing habit is to `/rename` each session immediately AFTER launch, so the
 * roster showed six sessions as bare timestamps while every one of them had a
 * meaningful name on screen. The write path was always fine; only the VALUE
 * was a stale launch-time snapshot.
 *
 * THE HOOK. A `/rename` lands durably in the RENAMED session's own transcript
 * as a user-role record whose content is a plain-string system reminder. No new
 * plumbing needed - it is already on disk.
 *
 * THE TRAP, AND WHY THE GUARD IS STRUCTURAL. The same sentence appears in any
 * session that merely DISCUSSES renames. On the live transcript that produced
 * this module, searching for the phrase returned SIX hits of which ONE was
 * real: the others were a `tool_result` carrying work item c086c27b's own body
 * (which quotes the reminder with a placeholder, so a naive regex names the
 * session "X") and this session's own grep commands. The work item describing
 * the bug is a working exploit against the naive fix to it.
 *
 * So the discriminator is the record's SHAPE, not its text: a genuine reminder
 * is a top-level `user` record whose `content` is a STRING, while every
 * contaminated hit lives inside a `tool_use` / `tool_result` ARRAY. An agent
 * can reproduce any text from inside a tool payload; it cannot make its tool
 * payload become a top-level user string. DO NOT "harden" this by matching a
 * longer text snippet - that is the same mistake one layer down.
 */

/**
 * The harness's exact reminder. The trailing clause is REQUIRED: it is the
 * difference between the harness's own wording and someone paraphrasing it.
 */
const RENAME_RE =
  /The user named this session "([^"]*)"\. This may indicate the session's focus or intent\./g;

/**
 * Is `index` inside an unclosed `<channel ...>` envelope?
 *
 * Position-based rather than a whole-record reject, because one content string
 * can legitimately carry both a channel injection and this session's own
 * reminder. If the nearest preceding `<channel` is later than the nearest
 * preceding `</channel>`, we are inside an open envelope - i.e. reading a
 * PEER's content, not our own.
 */
function isInsideChannelEnvelope(content: string, index: number): boolean {
  const before = content.slice(0, index);
  return before.lastIndexOf("<channel") > before.lastIndexOf("</channel>");
}

/**
 * Extract the CURRENT session title from raw transcript JSONL, or null.
 *
 * Returns the LAST genuine rename: a session can be renamed repeatedly and the
 * most recent one is its name. Structural guards are applied per record, so a
 * later forgery inside a tool payload cannot displace an earlier real rename.
 */
export function parseLatestRename(transcriptText: string): string | null {
  let found: string | null = null;

  for (const line of transcriptText.split("\n")) {
    if (!line || line.indexOf("named this session") === -1) continue;

    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      // Partial or corrupt line (the file is tailed while being appended).
      continue;
    }

    // GUARD 1: only a user-role record. Assistant output never carries one.
    if (rec?.type !== "user" || rec?.message?.role !== "user") continue;

    // GUARD 2 - the load-bearing one. The genuine reminder's content is a
    // STRING. Anything an agent echoed is nested in a tool_use/tool_result
    // array, which fails here regardless of what text it contains.
    const content = rec?.message?.content;
    if (typeof content !== "string") continue;

    // GUARD 3: the full canonical sentence, not the bare phrase. A record may
    // legitimately combine hook output with the reminder, so scan within.
    RENAME_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RENAME_RE.exec(content)) !== null) {
      // GUARD 4: reject matches sitting INSIDE a <channel> envelope.
      //
      // Found only by running this parser against the live fleet: PA's
      // transcript yielded TWO qualifying records - its own rename
      // ("2026-08-08-PA") and, later, the CREATOR session's rename arriving as
      // a routed `event_type="user_input"` channel event. Last-match-wins then
      // named PA after a peer.
      //
      // The lesson is bigger than this parser: THE AGENT CHANNEL LAUNDERS PEER
      // CONTENT INTO FIRST-PARTY SHAPE. A routed event is injected as a
      // top-level user-role STRING - structurally identical to something the
      // harness itself authored - so guards 1-3, which are otherwise exactly
      // right, cannot tell the two apart. Any future check that trusts "it is
      // a plain user string, so this session's own harness wrote it" inherits
      // this same hole.
      if (isInsideChannelEnvelope(content, m.index)) continue;
      const name = m[1].trim();
      if (name) found = name;
    }
  }

  return found;
}

/**
 * Decide the registry name from the three sources that can supply one.
 *
 * PRECEDENCE (lane-owner ruling, ratified by PA): a `/rename` WINS over both
 * the launcher env and any preserved prior name. The env is a launch-time
 * snapshot whose default is the useless timestamp this fix exists to replace;
 * the rename is a later, explicit human act. A session launched with a
 * meaningful `--name` and never renamed is unaffected either way.
 *
 * The `priorName` arm mirrors the existing preservation branch in
 * agent_channel (restore a prior non-auto name over a default one across an
 * MCP restart). It must sit BELOW the rename, or the fix would silently revert
 * the first time an MCP reconnected and re-read the env.
 */
export function resolveSessionName(opts: {
  envName: string;
  priorName?: string | null;
  renamed?: string | null;
}): string {
  if (opts.renamed && opts.renamed.trim()) return opts.renamed.trim();

  const isDefaultish =
    opts.envName.startsWith("auto-") || /^(SA|PA)-\d{4}-\d{2}-\d{2}-/.test(opts.envName);
  if (opts.priorName && opts.priorName !== opts.envName && !opts.priorName.startsWith("auto-") && isDefaultish) {
    return opts.priorName;
  }

  return opts.envName;
}

/**
 * Read a transcript and return its latest rename, or null.
 *
 * `knownSize` short-circuits the common case: the file has not grown since the
 * last check, so nothing can have been renamed. Callers pass the size they got
 * back last time. Returns the size actually read so the caller can cache it.
 *
 * Never throws - a missing/locked transcript is a normal condition (the file
 * appears slightly after session start) and must not disturb the heartbeat.
 */
export function readLatestRename(
  transcriptPath: string,
  knownSize?: number,
): { name: string | null; size: number } {
  try {
    const size = statSync(transcriptPath).size;
    if (knownSize !== undefined && size === knownSize) {
      return { name: null, size };
    }
    return { name: parseLatestRename(readFileSync(transcriptPath, "utf8")), size };
  } catch {
    return { name: null, size: knownSize ?? -1 };
  }
}
