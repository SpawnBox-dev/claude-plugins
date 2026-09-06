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
import {
  appendFileSync,
  readFileSync,
  statSync,
  renameSync,
  existsSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
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
  | "paragraph_filtered"
  /**
   * A transcript line could not be JSON-parsed, so it was skipped - and the
   * offset advanced past it anyway, which makes the loss permanent and
   * invisible. Previously a bare `catch { continue }`.
   *
   * Expected count in a healthy fleet: ZERO. That is why logging every one
   * costs nothing and why a single occurrence is worth chasing.
   */
  | "parse_failed"
  /**
   * `filterEvent` returned null for an assistant entry that DID carry
   * non-empty text - i.e. a line that should have routed and did not.
   *
   * The general filterEvent-null case is deliberately NOT logged: it fires on
   * every tool_result line across ~100 tracked transcripts and would bury the
   * signal. This narrow case is the opposite - it should never happen, so its
   * count is zero until something is wrong.
   */
  | "filter_dropped"
  /**
   * An offset row for a transcript this process was ALREADY tracking went
   * missing, so the watcher re-initialised to EOF and skipped every byte
   * written since its last tick.
   *
   * This is the only one of the three whose signature matches the measured
   * losses: the sender resolves (no unknown_sender), the lines parse (no
   * parse_failed), and filterEvent accepts them (no filter_dropped) - they are
   * simply never iterated. `src_offset` carries the EOF it jumped to.
   */
  | "offset_reset"
  /**
   * A byte range that NO pass ever read: this pass started ABOVE where the
   * previous pass over the same transcript ended.
   *
   * THE ONLY RECORD THAT IS NOT ABOUT A DECISION. Every other event says what
   * was decided about a line; this says a line was never LOOKED AT. That
   * distinction was unanswerable when a skipped entry produced no
   * unknown_sender, no parse_failed, no filter_dropped and no offset_reset -
   * every decision path stayed silent, leaving "read and lost somewhere
   * unlogged" and "never read" indistinguishable.
   *
   * SILENT WHEN HEALTHY, which is why it can live on the highest-volume path
   * in the file. Passes normally start exactly where the last one ended, so
   * the healthy case writes nothing at all and every record is a finding.
   * `scan_from`/`scan_to` bound the unread range.
   */
  | "scan_gap"
  /**
   * THE RECEIPT. The RECEIVER observed a channel tag carrying this emit_id
   * land in its OWN transcript.
   *
   * This is the primitive whose absence made the entire delivery investigation
   * archaeology. Until now "was it delivered" was answered by joining an
   * emit-log record to a queue-operation row written by a different process -
   * an inference from a side effect, which is what let an enqueue race produce
   * two false alarms in one afternoon and nearly trigger a four-version
   * rollback.
   *
   * A receipt is DIRECTLY EMITTED BY THE PARTY THAT WOULD KNOW. Delivery
   * becomes a join over two facts each asserted by the process that observed
   * it, rather than a reconstruction. Sender says `sent`; receiver says
   * `received`; anything with one and not the other is unambiguous.
   */
  | "received"
  /**
   * A message was re-sent because no receipt arrived within the grace window.
   *
   * WHY RETRY IS THE RIGHT REMEDY HERE, and why it was not obvious earlier:
   * loss turned out to be UNCORRELATED with message size, class and character
   * content (measured 2026-09-06 - delivered and lost length distributions are
   * p25/med/p75 = 98/115/183 vs 98/115/182, and no character class separates
   * them). Uniform loss independent of payload is the signature of a lossy
   * TRANSPORT, not a filter, a parser or a classifier. You do not fix a lossy
   * transport by classifying better; you fix it by detecting non-delivery and
   * sending again. The receipt is what makes detection possible at all.
   */
  | "retry"
  /** This watcher conceded the session to a newer instance and stood down. */
  | "retired";

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
  /** `scan` only: start of the byte range this pass read. */
  scan_from?: number;
  /** `scan` only: end of the range CONSUMED (exclusive). A trailing partial
   *  line is deliberately outside it - it is carried to the next tick. */
  scan_to?: number;
  /** `scan` only: how many lines were handed to processEvent. */
  lines?: number;
}

/**
 * Was a given byte offset in a sender's transcript inside a range that NO pass
 * ever read? Returns the gap record covering it, or null.
 *
 * A function rather than a grep because the answer is a range-containment test
 * across many records, and eyeballing it invites the off-by-one that would
 * flip the verdict on the one question this whole instrument exists to answer.
 */
export function findGapCovering(
  records: EmitLogRecord[],
  senderId8: string,
  offset: number,
): EmitLogRecord | null {
  for (const r of records) {
    if (r.event !== "scan_gap" || r.sender_id8 !== senderId8) continue;
    if (typeof r.scan_from !== "number" || typeof r.scan_to !== "number") continue;
    if (offset >= r.scan_from && offset < r.scan_to) return r;
  }
  return null;
}

/** Total bytes this watcher provably never read, per sender. Zero in a healthy
 *  fleet, which is what makes a non-zero value worth acting on. */
export function unreadByteTotals(records: EmitLogRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) {
    if (r.event !== "scan_gap") continue;
    if (typeof r.scan_from !== "number" || typeof r.scan_to !== "number") continue;
    const key = r.sender_id8 ?? "unknown";
    out[key] = (out[key] ?? 0) + (r.scan_to - r.scan_from);
  }
  return out;
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
  /** Emitted, sent, never enqueued at the receiver. Meaningless unless
   *  `measured` is true - see below. */
  counterGaps: number;
  /** How many notifications this receiver's producer SENT in the window. The
   *  denominator travels with the figure: "3 missing" means very different
   *  things out of 4 and out of 400. */
  observedEmits: number;
  /**
   * Whether the receiver's transcript was actually READ.
   *
   * THIS FIELD EXISTS BECAUSE ITS ABSENCE FABRICATED A TOTAL LOSS. If the
   * transcript read throws, the seen-set is empty, so every sent id looks
   * missing and the report announces that EVERY message was lost - a maximal,
   * alarming, entirely false number. And it is worse than a crash would be:
   * the block still produces output, so the failure impersonates a finding
   * (the "swallowed catch reads as a pass" shape, in its most damaging
   * direction). An unreadable transcript must say UNMEASURED, never a number.
   */
  measured: boolean;
  /** Earliest instant the seen-window genuinely covers, or null when the whole
   *  transcript was read. Bounds the `sent` set so both halves describe the
   *  same window. */
  since?: string | null;
}

/** What a receiver actually saw, plus the honest metadata about how much of
 *  its own transcript that reading covered. */
export interface SeenWindow {
  ids: string[];
  /** Earliest instant this window genuinely contains; null if it covers the
   *  whole file. */
  since: string | null;
  /** False when the transcript could not be read at all. */
  measured: boolean;
}

/**
 * Read a bounded tail of a receiver's transcript and report BOTH the emit_ids
 * in it and the instant that tail actually starts at.
 *
 * WHY THE WINDOW TRAVELS WITH THE IDS, rather than bounding both files by
 * bytes (PA's ruling, 2026-09-06). Two byte windows over two files with
 * different growth rates cannot agree, and they drift apart at a rate nobody
 * is watching. The asymmetric hazard is what settles it: a transcript window
 * NARROWER than the emit-log window manufactures FALSE GAPS, and a false gap
 * is the costlier error - undercounting loses a signal, overcounting destroys
 * the credibility of the only instrument that separates real loss from noise.
 *
 * So the caller does not pick two constants and keep them in sync by
 * remembering to. It takes whatever window the tail genuinely covers and
 * filters the sent-set to match, which makes the two halves agree BY
 * CONSTRUCTION and makes "an old emit_id fell out of the window" impossible
 * rather than merely unlikely.
 */
export function readSeenWindow(transcriptPath: string, maxBytes = 4 * 1024 * 1024): SeenWindow {
  let raw: string;
  let truncated = false;
  try {
    const size = statSync(transcriptPath).size;
    if (size > maxBytes) {
      const fd = openSync(transcriptPath, "r");
      try {
        const buf = Buffer.allocUnsafe(maxBytes);
        const read = readSync(fd, buf, 0, maxBytes, size - maxBytes);
        raw = buf.subarray(0, read).toString("utf8");
        truncated = true;
      } finally {
        closeSync(fd);
      }
    } else {
      raw = readFileSync(transcriptPath, "utf8");
    }
  } catch {
    // The one case this whole field exists for.
    return { ids: [], since: null, measured: false };
  }

  // A byte-offset tail almost always starts mid-line. Drop that fragment: its
  // timestamp is unrecoverable and its emit_id may be cut in half, which would
  // silently drop a real id and read as a gap.
  if (!truncated) {
    // Whole file. `since: null` means exactly that, and nothing else.
    return { ids: extractSeenEmitIds(raw), since: null, measured: true };
  }

  // A byte-offset tail almost always starts mid-line. Drop that fragment: its
  // timestamp is unrecoverable and its emit_id may be cut in half, which would
  // silently drop a real id and read as a gap. If there is no newline at all,
  // one line was larger than the whole window and nothing survives.
  const nl = raw.indexOf("\n");
  raw = nl === -1 ? "" : raw.slice(nl + 1);

  const since = earliestTimestamp(raw);
  if (since === null) {
    // AN UNANCHORABLE WINDOW IS UNMEASURED, NOT CLEAN. This is the same
    // principle as the read failure above, and it has to be applied here too
    // because the consequence is identical and worse-looking: with
    // `measured: true` and `since: null`, summarizeLoss's `!window.since`
    // branch applies NO filter, comparing a BOUNDED seen-set against an
    // UNBOUNDED sent-set. Every out-of-frame emit then looks missing.
    //
    // EXECUTED SPECIMENS (PA, reproduced here before this fix): a tail with
    // ids but no timestamp key reported 1 of 2; a transcript whose single line
    // exceeded the window reported 2 of 2 - a total fabricated loss with
    // `measured` true, i.e. exactly the defect the UNMEASURED path was added
    // to remove, re-entering through truncation instead of through a catch.
    // A >4MB single line is not exotic when the files are 91MB and one large
    // tool result produces it.
    //
    // So `since: null` now has ONE meaning - "whole file" - and every other
    // outcome routes to the honest path.
    return { ids: [], since: null, measured: false };
  }
  return { ids: extractSeenEmitIds(raw), since, measured: true };
}

/**
 * First ISO timestamp in a transcript slice, in the ONE shape whose
 * lexicographic order matches chronological order.
 *
 * THE SHAPE IS ASSERTED, NOT TRUSTED (PA, 2026-09-06). summarizeLoss compares
 * `r.ts >= window.since` as STRINGS, which is only sound while both sides are
 * UTC with a `Z` suffix. A `+02:00` offset form sorts by its literal digits
 * and silently misorders - it would not throw, it would quietly include or
 * exclude the wrong emits and shift a loss count nobody could explain.
 *
 * A tail whose first timestamp is not that shape therefore yields null, which
 * routes to UNMEASURED - the honest answer - rather than to a comparison that
 * is wrong in a way no test would catch later.
 *
 * Matches the escaped and unescaped forms for the same reason
 * extractSeenEmitIds does: on disk this sits inside a JSON string.
 */
function earliestTimestamp(slice: string): string | null {
  const m = /\\?"timestamp\\?":\\?"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\\?"/.exec(slice);
  return m ? m[1] : null;
}

/**
 * Messages this session SENT that have no receipt yet and are old enough that
 * a receipt should have arrived - i.e. the retry set.
 *
 * PURE, and takes the records rather than a path, so the retry decision is
 * testable without a live fleet. That matters more than usual here: a retry
 * loop that misjudges "unacknowledged" duplicates traffic on a transport that
 * is already dropping under load, which is the one way this change could make
 * things worse rather than better.
 *
 * @param graceMs how long to wait before deciding a receipt is not coming.
 *   Must exceed the receiver's poll interval plus its turn latency, or a
 *   healthy slow delivery gets re-sent. Measured p90 was 13s, max 42s.
 * @param maxAttempts a hard ceiling. An undeliverable message must eventually
 *   STOP being retried: infinite retry against a persistently broken receiver
 *   is a self-inflicted flood, and the emit log would grow without bound.
 */
export function pendingRetries(
  records: EmitLogRecord[],
  selfId8: string,
  nowMs: number,
  graceMs = 60_000,
  maxAttempts = 3,
): Array<{ emit_id: string; attempts: number; sentAt: string }> {
  const sent = new Map<string, string>();
  const acked = new Set<string>();
  const attempts = new Map<string, number>();

  for (const r of records) {
    if (!r.emit_id) continue;
    if (r.event === "sent" && r.receiver_id8 === selfId8) {
      if (!sent.has(r.emit_id)) sent.set(r.emit_id, r.ts);
    } else if (r.event === "received") {
      // A receipt counts NO MATTER WHICH session recorded it - the receiver
      // asserts it, not us. Filtering receipts by our own id would discard
      // exactly the evidence we are looking for.
      acked.add(r.emit_id);
    } else if (r.event === "retry") {
      attempts.set(r.emit_id, (attempts.get(r.emit_id) ?? 0) + 1);
    }
  }

  const out: Array<{ emit_id: string; attempts: number; sentAt: string }> = [];
  for (const [id, ts] of sent) {
    if (acked.has(id)) continue;
    const age = nowMs - new Date(ts).getTime();
    if (!Number.isFinite(age) || age < graceMs) continue; // too fresh to judge
    const n = attempts.get(id) ?? 0;
    if (n >= maxAttempts) continue; // give up rather than flood
    out.push({ emit_id: id, attempts: n, sentAt: ts });
  }
  return out;
}

/** Worst-affected sender first, so the peer losing the most is not buried. */
function formatPerSender(discarded: Record<string, number>): string {
  return Object.entries(discarded)
    .sort((a, b) => b[1] - a[1])
    .map(([sid, n]) => `${sid.slice(0, 8)}:${n}`)
    .join(", ");
}

/**
 * Render the two detectors as one line. Returns null when BOTH are clean AND
 * the reading was actually taken, so a quiet window says nothing at all rather
 * than printing a reassuring zero nobody reads. An UNMEASURED reading is never
 * silent - see the guard at the top.
 */
export function formatLossReport(r: LossReport): string | null {
  // UNMEASURED IS NOT CLEAN AND IT IS NOT A NUMBER. Falling silent here would
  // claim the channel was checked and found healthy; printing counterGaps
  // would claim every sent message was lost. Both are assertions the data
  // cannot support, and the second is the one that fabricates an alarm.
  if (!r.measured) {
    const disc =
      r.discardedTotal > 0
        ? ` Separately, ${r.discardedTotal} message(s) WERE read and discarded ` +
          `because their sender could not be identified (${formatPerSender(r.discarded)}); ` +
          `that half is measured and is real.`
        : "";
    // Two causes reach here and the wording must fit BOTH: the transcript
    // could not be read at all, or it was read but the window it covers could
    // not be anchored in time (a tail with no timestamp, or a single line
    // larger than the window). Saying only "could not be read" would be a
    // small false statement in the second case, in a message whose entire
    // purpose is not overstating what is known.
    return (
      `CHANNEL DELIVERY COULD NOT BE MEASURED. This session's own transcript ` +
      `could not be read, or the portion read could not be anchored to a ` +
      `start time, so there is no way to tell which of the ` +
      `${r.observedEmits} notification(s) sent to it actually arrived. This is ` +
      `a broken instrument, NOT a finding of loss and NOT an all-clear - do ` +
      `not read it as either.${disc}`
    );
  }
  if (r.discardedTotal === 0 && r.counterGaps === 0) return null;
  const parts: string[] = [];
  if (r.discardedTotal > 0) {
    const per = formatPerSender(r.discarded);
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
  window: SeenWindow,
): LossReport {
  const seenEmitIds = window.ids;
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
  //
  // ...and only those sent WITHIN THE WINDOW the seen-set actually covers. An
  // emit older than the tail we read is not missing, it is out of frame, and
  // counting it would manufacture the false gaps this bounding exists to
  // prevent.
  const sent = new Set(
    records
      .filter((r) => r.receiver_id8 === receiverId8 && r.event === "sent" && r.emit_id)
      .filter((r) => !window.since || r.ts >= window.since)
      .map((r) => r.emit_id!),
  );

  // If the transcript could not be read, the seen-set is empty for a reason
  // that has nothing to do with delivery. Report the discards, which are
  // measured independently, and say plainly that the other half is unknown.
  if (!window.measured) {
    return {
      discarded,
      discardedTotal,
      counterGaps: 0,
      observedEmits: sent.size,
      measured: false,
      since: window.since,
    };
  }

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

  return {
    discarded,
    discardedTotal,
    counterGaps: missing,
    observedEmits: sent.size,
    measured: true,
    since: window.since,
  };
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
