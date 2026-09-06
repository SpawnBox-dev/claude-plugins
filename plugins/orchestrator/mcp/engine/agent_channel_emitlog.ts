/**
 * Per-emit routing log for the agent channel (WI 6cf7437a).
 *
 * WHY THIS EXISTS. The channel loses messages, and until now nothing could say
 * WHERE. The two candidate explanations produce identical evidence from every
 * surface we had:
 *
 *   (a) the producer consumed the transcript line but never called
 *       notification() for it, or
 *   (b) it called notification() and Claude Code never enqueued it.
 *
 * The offsets table cannot separate them: it advances by bytes CONSUMED, and
 * processEvent has paths that consume without emitting. The receiver's
 * `queue-operation` rows cannot separate them either - both cases look like
 * "no row at all", because Claude Code logs `enqueue` only once its handler
 * runs. Measured 2026-09-06: four of my seven turn-final texts had no queue row
 * of any kind on PA's side while PA's offset sat past every one of them.
 *
 * This log is the missing half. It records what the producer DECIDED for each
 * transcript line and what the transport did with it, keyed by an `emit_id`
 * that also travels in the notification meta - so a line here joins exactly to
 * the `<channel ... emit_id="...">` text in the RECEIVER's transcript. Exact
 * join, not a timestamp correlation: PA reports its warden's substring probe
 * gave different answers at different match lengths, and an id does not have
 * that failure mode.
 *
 * WHAT IS DELIBERATELY NOT LOGGED. Every tool_result line in every tracked
 * transcript is filtered out by filterEvent, and a busy fleet tracks ~100
 * transcripts; logging those would be megabytes per minute of noise that
 * buries the routed events. Only actual routing decisions are recorded:
 * emits, transport outcomes, and the two paths that DROP an event a receiver
 * might otherwise have expected (unknown_sender, paragraph_filtered).
 *
 * Diagnostic-only. Never throws: a logging failure must never disturb routing
 * (anti_pattern 798f741b - best-effort side effects killing their host).
 */
import { appendFileSync, readFileSync, statSync, renameSync, existsSync, unlinkSync } from "fs";
import { join } from "path";

/** Keep the log bounded. One rotation only - this is a rolling diagnostic
 *  window, not an archive, and an unbounded file in a shared project dir is
 *  its own defect. */
const MAX_BYTES = 4 * 1024 * 1024;

export const EMIT_LOG_BASENAME = "emit-log.jsonl";

export type EmitLogEvent =
  /** processEvent decided to route this line; notification() about to fire. */
  | "emit"
  /** The SDK's notification promise RESOLVED - i.e. the JSON-RPC write was
   *  handed to the transport. IT DOES NOT MEAN THE HARNESS ENQUEUED IT, and
   *  the whole point of this log dies if the two are conflated: Claude Code
   *  validates the payload against its own schema AFTER the write and drops a
   *  failing one silently, so `sent` with no `enqueue` row on the receiver is
   *  a REAL and expected combination, not a contradiction. (PA, 2026-09-06.)
   *  Read it as "we let go of it", never as "it arrived". */
  | "sent"
  /** The transport rejected it - the receiver never saw this one. */
  | "send_failed"
  /** Consumed but NOT routed: the sending session was absent from our fresh
   *  roster, so the line advanced the offset and produced nothing. This is the
   *  one producer path that is indistinguishable from a transport loss without
   *  this log. */
  | "unknown_sender"
  /** Consumed, addressed to us, but the per-paragraph filter left nothing. */
  | "paragraph_filtered";

export interface EmitLogRecord {
  ts: string;
  event: EmitLogEvent;
  /** Joins this record to the `emit_id` meta attribute visible in the
   *  receiver's transcript. Absent for drops that never reached emit(). */
  emit_id?: string;
  /** Who is doing the routing (this session). */
  receiver_id8: string;
  /** Whose transcript the line came from. */
  sender_id8?: string;
  /** Byte offset of the source line within the sender's transcript - lets a
   *  reader go straight to the originating line. */
  src_offset?: number;
  event_type?: string;
  content_len?: number;
  targets?: number;
  detail?: string;
}

let counter = 0;

/** Short, collision-resistant enough to join a rolling window, short enough to
 *  sit in notification meta without bloating every channel tag. */
export function newEmitId(): string {
  counter = (counter + 1) % 1_000_000;
  return (
    Date.now().toString(36) +
    "-" +
    counter.toString(36) +
    "-" +
    Math.floor(Math.random() * 46656).toString(36)
  );
}

export function emitLogPath(stateDir: string): string {
  return join(stateDir, EMIT_LOG_BASENAME);
}

/**
 * WI 6cf7437a (c) - THE TWO DETECTORS SEE DISJOINT FAILURES, so a report built
 * on either alone is a subset that reads as full coverage. PA, 2026-09-06.
 *
 *   unknown_sender  - the sender could not be identified, so the line was
 *                     consumed and discarded. It never reached newEmitId, so
 *                     NO emit_id was ever minted and NO gap appears anywhere.
 *                     Invisible to the counter detector by construction.
 *
 *   counter gap     - an emit_id WAS minted and the notification sent, but the
 *                     receiver has no enqueue row for it. Invisible to the
 *                     unknown_sender detector, because routing succeeded.
 *
 * The emit_id's middle segment is a per-process monotonic counter, so a gap in
 * the sequence a receiver actually saw means an emit that its own producer
 * made and its own harness never enqueued.
 *
 * CAVEAT THE CALLER MUST HONOUR: the counter resets on MCP restart, and the
 * leading timestamp segment changes with it. A sequence must therefore be
 * grouped by that prefix before gaps are counted, or every restart reads as a
 * huge fabricated loss. That is what `parseEmitId` + the grouping below exist
 * for; do not re-derive a "simpler" version that compares raw counters.
 */
export interface ParsedEmitId {
  /** Per-process epoch segment. Changes on every MCP restart. */
  epoch: string;
  /** Monotonic within one epoch. */
  seq: number;
}

export function parseEmitId(id: string): ParsedEmitId | null {
  const parts = id.split("-");
  if (parts.length < 2) return null;
  const seq = parseInt(parts[1], 36);
  if (!Number.isFinite(seq)) return null;
  return { epoch: parts[0], seq };
}

export interface CounterGapReport {
  /** How many emitted-and-sent notifications never appeared at the receiver. */
  missing: number;
  /** The specific sequence numbers absent, per epoch, for a human to chase. */
  gaps: Array<{ epoch: string; seq: number }>;
  /** Emit ids actually observed. Reported so a caller can say "0 of 0", which
   *  is a quiet window, distinctly from "0 of 400", which is real coverage. */
  observed: number;
}

/**
 * Given the emit_ids a receiver actually saw, reconstruct the ones its own
 * producer must have minted but that never arrived, from the sequence alone.
 *
 * NOT ON A RUNTIME PATH, and that is deliberate rather than an oversight.
 * summarizeLoss has the emit log, so it answers the same question exactly by
 * set difference (which ids did we send that never arrived) instead of
 * inferring interior sequence numbers - inference reports an id that was
 * emitted but never sent as a harness drop, double-counting one failure as
 * two. That bug was real and is pinned by a test.
 *
 * This is kept as the tested reference for a consumer that has ONLY the
 * receiver's transcript and no emit log - the warden's standing check. What it
 * encodes and a naive reimplementation will not is the restart-epoch trap: the
 * counter resets on MCP restart, so raw counters must never be compared across
 * epochs. Anyone rebuilding this check elsewhere should read these rules first.
 */
export function findCounterGaps(seenEmitIds: string[]): CounterGapReport {
  const byEpoch = new Map<string, Set<number>>();
  for (const id of seenEmitIds) {
    const p = parseEmitId(id);
    if (!p) continue;
    if (!byEpoch.has(p.epoch)) byEpoch.set(p.epoch, new Set());
    byEpoch.get(p.epoch)!.add(p.seq);
  }
  const gaps: Array<{ epoch: string; seq: number }> = [];
  let observed = 0;
  for (const [epoch, seqs] of byEpoch) {
    observed += seqs.size;
    // Only the interior is evidence. A missing seq BELOW the minimum seen just
    // means the window opened mid-stream, and one ABOVE the maximum has not
    // been emitted yet - counting either would manufacture losses out of where
    // we happened to start looking.
    const lo = Math.min(...seqs);
    const hi = Math.max(...seqs);
    for (let s = lo + 1; s < hi; s++) {
      if (!seqs.has(s)) gaps.push({ epoch, seq: s });
    }
  }
  return { missing: gaps.length, gaps, observed };
}

export interface LossReport {
  /** Lines consumed without routing, by sender id8. */
  discarded: Record<string, number>;
  discardedTotal: number;
  /** Emitted, sent, never enqueued at the receiver. */
  counterGaps: number;
  /** How many notifications this receiver's producer SENT in the window. The
   *  denominator travels with the figure: "3 missing" means very different
   *  things out of 4 and out of 400. */
  observedEmits: number;
}

/**
 * Render the two detectors as one line. Returns null when BOTH are clean, so a
 * quiet window says nothing at all rather than printing a reassuring zero that
 * nobody reads.
 */
export function formatLossReport(r: LossReport): string | null {
  if (r.discardedTotal === 0 && r.counterGaps === 0) return null;
  const parts: string[] = [];
  if (r.discardedTotal > 0) {
    const per = Object.entries(r.discarded)
      .sort((a, b) => b[1] - a[1])
      .map(([sid, n]) => `${sid.slice(0, 8)}:${n}`)
      .join(", ");
    parts.push(
      `${r.discardedTotal} message(s) were READ AND DISCARDED because their ` +
        `sender could not be identified (${per}). These never became ` +
        `notifications, so they leave NO gap at any receiver - this counter is ` +
        `the only thing that can see them.`,
    );
  }
  if (r.counterGaps > 0) {
    parts.push(
      `${r.counterGaps} notification(s) were emitted and sent but never ` +
        `enqueued here, out of ${r.observedEmits} sent. That loss is past ` +
        `this plugin's boundary - the send completed.`,
    );
  }
  return (
    `CHANNEL LOSS DETECTED. ${parts.join(" ")} ` +
    `Both figures come from the emit log at <state>/${EMIT_LOG_BASENAME}, ` +
    `joined to the receiver's queue-operation rows on emit_id. Treat any peer ` +
    `message from this window as possibly missing, and re-ask rather than ` +
    `assuming silence meant nothing was said.`
  );
}

/** Read the emit log back. Best-effort: a missing or partly-written file
 *  yields whatever parsed, never an exception - this is a diagnostic read on a
 *  file another process is appending to concurrently. */
export function readEmitLog(stateDir: string, path = emitLogPath(stateDir)): EmitLogRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: EmitLogRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn final line while another process appends. Skip it.
    }
  }
  return out;
}

/**
 * Combine both detectors for ONE receiver.
 *
 * `seenEmitIds` must be the ids that actually reached this session - read from
 * its own transcript's `<channel ... emit_id="...">` attributes, NOT from the
 * emit log, or the check becomes a tautology (the log would be compared
 * against itself and could never show a gap).
 */
export function summarizeLoss(
  records: EmitLogRecord[],
  receiverId8: string,
  seenEmitIds: string[],
): LossReport {
  const discarded: Record<string, number> = {};
  let discardedTotal = 0;
  for (const r of records) {
    if (r.receiver_id8 !== receiverId8) continue;
    if (r.event !== "unknown_sender") continue;
    const key = r.sender_id8 ?? "unknown";
    discarded[key] = (discarded[key] ?? 0) + 1;
    discardedTotal++;
  }
  // Only ids this receiver's own producer claims it SENT can be expected to
  // appear; an emit that never got sent is a different (already-logged)
  // failure and must not be double-counted as a harness drop.
  const sent = new Set(
    records.filter((r) => r.receiver_id8 === receiverId8 && r.event === "sent" && r.emit_id).map((r) => r.emit_id!),
  );

  // SET DIFFERENCE, NOT SEQUENCE INFERENCE. findCounterGaps below reconstructs
  // missing sequence numbers from the ids a receiver saw, which is the right
  // tool when the emit log is unavailable - the warden's receiver-only check.
  // Here the log IS available, so the exact answer is "which ids did we send
  // that never arrived". Inferring interior sequence numbers instead reports a
  // seq that was emitted but never sent as a harness drop, double-counting one
  // failure as two; caught by the "a gap needs the id to have been SENT" test.
  const seen = new Set(seenEmitIds);
  let missing = 0;
  for (const id of sent) if (!seen.has(id)) missing++;

  return { discarded, discardedTotal, counterGaps: missing, observedEmits: sent.size };
}

/**
 * Pull every `emit_id` ATTRIBUTE out of a receiver's own transcript.
 *
 * TWO TRAPS, both measured on real data:
 *
 * 1. Match the attribute, not the bare word. A `grep -c emit_id` over a
 *    transcript also counts PROSE ABOUT emit_id - my own first reading of 4
 *    hits was entirely my own writing, and taking it as coverage would have
 *    claimed the harness kept the key when nothing had tested it.
 *
 * 2. Accept the ESCAPED form. The channel tag lives inside a JSON string in
 *    the JSONL, so on disk it reads `emit_id=\"abc-1-z\"`, not
 *    `emit_id="abc-1-z"`. A pattern anchored on the unescaped form matches
 *    nothing and reads as ABSENCE rather than as a broken matcher - the
 *    failure mode where an instrument narrows its own input and looks
 *    self-consistent doing it. Callers that hand us JSON.parse'd content see
 *    the unescaped form, so both must work.
 */
export function extractSeenEmitIds(transcript: string): string[] {
  const out: string[] = [];
  const re = /emit_id=\\?"([a-z0-9-]+)\\?"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(transcript)) !== null) out.push(m[1]);
  return out;
}

export function appendEmitLog(stateDir: string, rec: EmitLogRecord): void {
  try {
    const path = emitLogPath(stateDir);
    try {
      if (statSync(path).size > MAX_BYTES) {
        const prev = path + ".1";
        if (existsSync(prev)) unlinkSync(prev);
        renameSync(path, prev);
      }
    } catch {
      // No file yet, or the rotate lost a race with another session's rotate.
      // Either way appending below is still correct.
    }
    appendFileSync(path, JSON.stringify(rec) + "\n");
  } catch {
    // Diagnostics must never break routing.
  }
}
