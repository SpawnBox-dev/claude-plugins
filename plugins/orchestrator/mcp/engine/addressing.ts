/**
 * Pure addressing parser for the agent-channel filewatcher.
 *
 * Given an event's content text + the sender's session entry + the registry of
 * active sessions, returns a list of routing targets and metadata flags
 * (pa_addressed, override_command, unresolved_addresses).
 *
 * Recognized address forms:
 *   @PA / @PrimeAgent       - the prime
 *   @SA-<id8>               - a specific subordinate by 8-char prefix
 *   @SA-<id8>,@SA-<id8>     - multiple subordinates
 *   @all                    - every active session except sender
 *   PA, ... / PrimeAgent,   - conversational PA prefix (also addresses PA)
 *
 * Override commands (slash + natural language):
 *   /pa-pause, /pa-resume
 *   "PA, back off / stand down / take five / pause"
 *   "PA, come back in / resume / you can come back in"
 *
 * The sender is always excluded from targets (no self-broadcast).
 */

// Structural type so this module has no import dependency on
// agent_channel_state. agent_channel_state.SessionEntry is structurally
// compatible (it has these fields plus heartbeat/started_at/etc. that this
// parser doesn't need).
export interface SessionLike {
  session_id: string;
  id8: string;
  role: "prime" | "subordinate";
  name: string;
}

export interface AddressingResult {
  /** Resolved target session_ids (sender excluded). */
  targets: string[];
  /** True if event addresses PA (explicit @PA, @PrimeAgent, or "PA,"/"PrimeAgent," prefix). */
  pa_addressed: boolean;
  /** Override command if recognized. */
  override_command: "pause" | "resume" | null;
  /** id8s that didn't resolve to a known session - dropped from targets. */
  unresolved_addresses: string[];
}

const PA_PREFIX_RE = /^\s*(PA|PrimeAgent)\s*,/i;
const PAUSE_NL_RE = /^\s*(PA|PrimeAgent)\s*,?\s*(back\s*off|stand\s*down|take\s*five|pause)\b/i;
const RESUME_NL_RE = /^\s*(PA|PrimeAgent)\s*,?\s*(come\s*back|resume|you\s*can\s*(come\s*back|resume|return))\b/i;
const SLASH_PAUSE_RE = /^\s*\/pa-pause\b/i;
const SLASH_RESUME_RE = /^\s*\/pa-resume\b/i;
// 0.30.11: addresses must be in an "addressing context" - one of:
//   - start of content/line (optionally after a list bullet `-`/`*`)
//   - after a comma (recipient chain: "@A, @B sync up")
//   - after "and" / "&" with whitespace (recipient chain: "@A and @B sync up")
// This prevents descriptive mentions in the middle of prose - e.g. "my warm
// tick addresses @SA-95e6890e every 50min" or '"@PA warm" reply' - from being
// misinterpreted as actual addressing, which previously caused PA's thread
// questions to Jarid to leak into SAs' contexts via the channel router.
// (work_item b4c37849)
const ADDRESS_RE = /(?:(?:^|\n)[ \t]*(?:[-*][ \t]+)?|,[ \t]*|[ \t]+(?:and|&)[ \t]+)@(PA|PrimeAgent|all|SA-[a-f0-9]{8})\b/gim;

export function parseAddressing(
  content: string,
  sender: SessionLike,
  sessions: SessionLike[],
): AddressingResult {
  // Override commands take priority
  let override_command: "pause" | "resume" | null = null;
  if (SLASH_PAUSE_RE.test(content) || PAUSE_NL_RE.test(content)) {
    override_command = "pause";
  } else if (SLASH_RESUME_RE.test(content) || RESUME_NL_RE.test(content)) {
    override_command = "resume";
  }

  const targets = new Set<string>();
  const unresolved: string[] = [];
  let pa_addressed = false;

  // Conversational PA-prefix form (e.g. "PA, please...")
  if (PA_PREFIX_RE.test(content)) {
    const pa = sessions.find((s) => s.role === "prime");
    if (pa && pa.session_id !== sender.session_id) {
      targets.add(pa.session_id);
      pa_addressed = true;
    }
  }

  // Explicit @-addresses
  for (const match of content.matchAll(ADDRESS_RE)) {
    const tag = match[1].toLowerCase();
    if (tag === "pa" || tag === "primeagent") {
      const pa = sessions.find((s) => s.role === "prime");
      if (pa && pa.session_id !== sender.session_id) {
        targets.add(pa.session_id);
        pa_addressed = true;
      }
    } else if (tag === "all") {
      for (const s of sessions) {
        if (s.session_id !== sender.session_id) targets.add(s.session_id);
      }
    } else if (tag.startsWith("sa-")) {
      const id8 = tag.slice(3);
      const target = sessions.find((s) => s.id8 === id8);
      if (target && target.session_id !== sender.session_id) {
        targets.add(target.session_id);
      } else if (!target) {
        unresolved.push(id8);
      }
    }
  }

  return {
    targets: Array.from(targets),
    pa_addressed,
    override_command,
    unresolved_addresses: unresolved,
  };
}
