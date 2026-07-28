/**
 * Reduce a real session transcript to the STRUCTURE parseIngressTail reads,
 * discarding every message body.
 *
 * WHY THIS EXISTS. The 2026-07-28 outage produced the first real ingress-failure
 * transcript this fleet has ever captured - the fixture classifyIngress's own
 * comment says has never existed. It is also unusable as a committed test
 * artifact: SA-b14fafa3 scanned the slice they built and found 11 card
 * last-four fragments and 107 corporate ledger figures, because the 13:40-15:00Z
 * window overlaps another lane's financial handoffs. A fixture that enters a
 * test suite gets committed, so that path ends in a disclosure.
 *
 * REDACTION WOULD BE THE WRONG FIX. It is a blocklist - it removes what someone
 * thought to look for, and its failures are silent and unbounded. This is an
 * ALLOWLIST: it emits only the four things the parser actually reads and
 * reconstructs each line from scratch, so no original text can survive by
 * omission. The safety is structural, not vigilance-based.
 *
 * WHAT parseIngressTail READS (verified against mcp/engine/agent_channel.ts,
 * not assumed):
 *   - `timestamp`                       - ordering and the orphan-age maths
 *   - `type`                            - "queue-operation" vs a real entry
 *   - `operation`                       - "enqueue" / "dequeue" accounting
 *   - `message.content[].type === "tool_use"` on assistant entries - mid-turn
 * Nothing else influences the verdict. Text, names, tool inputs, tool results
 * and every numeric literal are dropped.
 *
 * CORRECTNESS BAR: the sanitized file must produce output IDENTICAL to the
 * original under parseIngressTail. A smaller fixture that parses differently is
 * not a sanitized fixture, it is a different test. This script asserts that
 * equivalence and refuses to write when it fails.
 *
 * Usage: bun run scripts/structuralize-ingress-fixture.ts <input.jsonl> <output.jsonl>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseIngressTail } from "../mcp/engine/agent_channel";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: structuralize-ingress-fixture.ts <input.jsonl> <output.jsonl>");
  process.exit(2);
}

const original = readFileSync(input, "utf-8");

const structural: string[] = [];
let dropped = 0;
for (const raw of original.split("\n")) {
  const line = raw.trim();
  if (!line) continue;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    // A malformed line is skipped by the parser too, so dropping it preserves
    // behaviour. Counted rather than silently discarded.
    dropped++;
    continue;
  }

  // Rebuilt from scratch - never a copy of the source object - so nothing
  // rides along in a field this script does not know about.
  const out: Record<string, unknown> = {};
  if (typeof o?.timestamp === "string") out.timestamp = o.timestamp;
  if (typeof o?.type === "string") out.type = o.type;

  if (o?.type === "queue-operation") {
    if (typeof o?.operation === "string") out.operation = o.operation;
  } else if (o?.type !== "user") {
    // Only the PRESENCE of a tool_use block matters; its id, name and input
    // are all irrelevant to the verdict and all potentially sensitive.
    const content = o?.message?.content;
    const hasToolUse =
      Array.isArray(content) && content.some((b: any) => b?.type === "tool_use");
    if (Array.isArray(content)) {
      out.message = { content: [{ type: hasToolUse ? "tool_use" : "text" }] };
    }
  }
  structural.push(JSON.stringify(out));
}

const sanitized = structural.join("\n") + "\n";

// EQUIVALENCE GATE. Same verdict in, same verdict out, or this is not a
// sanitized copy of the fixture.
const before = parseIngressTail(original);
const after = parseIngressTail(sanitized);
const same =
  before.lastRealActivityTs === after.lastRealActivityTs &&
  before.oldestOrphanEnqueueTs === after.oldestOrphanEnqueueTs &&
  before.lastRealIsMidTurn === after.lastRealIsMidTurn;

console.log("original :", JSON.stringify(before));
console.log("sanitized:", JSON.stringify(after));
console.log(`lines: ${structural.length} kept, ${dropped} unparseable`);
console.log(`bytes: ${original.length} -> ${sanitized.length}`);

if (!same) {
  console.error("REFUSING TO WRITE: parser output differs. Not a faithful slice.");
  process.exit(1);
}

writeFileSync(output, sanitized, "utf-8");
console.log("parser-equivalent. wrote", output);
