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
import { appendFileSync, statSync, renameSync, existsSync, unlinkSync } from "fs";
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
