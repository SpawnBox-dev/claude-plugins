#!/usr/bin/env bun
/**
 * CLEAR-ROUTING CHECK - the acceptance test for WI cb376ece.
 *
 * THE QUESTION: a lane posted a unique token. Did that post ROUTE through the
 * agent channel to anyone, and which roster row owns the transcript it was
 * written in?
 *
 * WHY IT EXISTS. On 2026-09-27 two lanes ran /clear. /clear starts a new
 * transcript under a new id without restarting MCP servers, and before
 * 26dfeb3 no roster row owned the new file, so every post in it was dropped as
 * unknown_sender. The lanes looked healthy because messages TO them still
 * arrived. The only honest test of the fix is end to end: the lane runs
 * /clear, posts a token, and the token shows up as a delivered channel message
 * in another session's transcript.
 *
 * WHAT IT READS (read-only; the registry is COPIED first, never opened live):
 *   - every top-level transcript in the project's ~/.claude/projects dir
 *     modified since --since (default: 24h ago)
 *   - a copy of agent_channel.db (+ -wal/-shm) for the roster
 *   - emit-log.jsonl for unknown_sender records about the sender's file
 *
 * VERDICTS (exit code):
 *   ROUTED     0  the token appears as the lane's own assistant text in
 *                 transcript T, AND inside a delivered <channel ...> record in
 *                 at least one OTHER transcript.
 *   DROPPED    1  the token was posted in T but no other transcript received
 *                 it. Printed with T's owning row (or NONE), whether T began
 *                 with /clear, and the unknown_sender count for T.
 *   NOT_FOUND  2  no transcript carries the token as assistant text.
 *
 * Usage:
 *   bun scripts/clear-routing-check.mjs --token <TOKEN> [--since <ISO>] [--wait <sec>]
 *   bun scripts/clear-routing-check.mjs --selftest
 *
 * --wait polls until ROUTED or the timeout, for use right after the lane posts.
 * --selftest runs the two recorded 2026-09-27/28 specimens and fails unless the
 * pre-fix one reads DROPPED and the healthy one reads ROUTED. A check that
 * cannot fire is indistinguishable from one that found nothing.
 */
import { readdirSync, statSync, existsSync, copyFileSync, mkdtempSync, rmSync, createReadStream, readFileSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { createInterface } from "readline";
import { Database } from "bun:sqlite";

const PROJECT_ROOT =
  process.env.ORCHESTRATOR_PROJECT_ROOT ||
  process.env.CLAUDE_PROJECT_DIR ||
  join("C:", "Users", "Jarid", "OneDrive", "AppDev", "mc-server-project", "spawnbox");
const STATE = join(PROJECT_ROOT, ".orchestrator-state", "agent-channel");
const HASH = PROJECT_ROOT.replace(/[:\\/]/g, "-");
const PROJECTS = join(homedir(), ".claude", "projects", HASH);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Copy-first read of the roster (live SQLite in WAL - never open it in place). */
function readRoster() {
  const dir = mkdtempSync(join(tmpdir(), "crc-"));
  try {
    for (const ext of ["", "-wal", "-shm"]) {
      const src = join(STATE, `agent_channel.db${ext}`);
      if (existsSync(src)) copyFileSync(src, join(dir, `agent_channel.db${ext}`));
    }
    const db = new Database(join(dir, "agent_channel.db"), { readonly: true });
    const cols = db.query("PRAGMA table_info(sessions)").all().map((c) => c.name);
    const hasTid = cols.includes("transcript_id");
    const rows = db
      .query(`SELECT session_id, id8, name, role, last_heartbeat_at${hasTid ? ", transcript_id" : ""} FROM sessions`)
      .all();
    db.close();
    return { rows, hasTid };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function assistantTexts(rec) {
  if (rec?.type !== "assistant") return [];
  const c = rec?.message?.content;
  if (!Array.isArray(c)) return [];
  return c.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text);
}

async function scanFile(path, token) {
  const sid = path.split(/[\\/]/).pop().replace(/\.jsonl$/, "");
  const out = { sid, posted: null, received: [], beganWithClear: false };
  let n = 0;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    n++;
    if (n <= 15 && line.includes("<command-name>/clear</command-name>")) out.beganWithClear = true;
    if (!line.includes(token)) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!out.posted && assistantTexts(rec).some((t) => t.includes(token))) {
      out.posted = rec.timestamp ?? "?";
      continue;
    }
    // A DELIVERY: the harness recorded an injected channel message carrying it.
    const body = typeof rec?.content === "string" ? rec.content
      : typeof rec?.message?.content === "string" ? rec.message.content : "";
    if (body.includes("<channel") && body.includes(token)) {
      const from = /from_session="([^"]+)"/.exec(body)?.[1] ?? "?";
      out.received.push({ at: rec.timestamp ?? "?", from });
    }
  }
  return out;
}

function unknownSenderCount(sid8, sinceIso) {
  let count = 0;
  for (const f of ["emit-log.jsonl.1", "emit-log.jsonl"]) {
    const p = join(STATE, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.includes('"unknown_sender"') || !line.includes(sid8)) continue;
      try {
        const r = JSON.parse(line);
        if (r.event === "unknown_sender" && r.sender_id8 === sid8 && r.ts >= sinceIso) count++;
      } catch {}
    }
  }
  return count;
}

export async function check(token, sinceIso, opts = {}) {
  const sinceMs = Date.parse(sinceIso);
  const files = readdirSync(PROJECTS)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(PROJECTS, f))
    .filter((p) => {
      try { return statSync(p).mtimeMs >= sinceMs; } catch { return false; }
    })
    .filter((p) => !opts.exclude?.some((x) => p.includes(x)));
  const scans = [];
  for (const p of files) scans.push(await scanFile(p, token));

  // The ORIGINAL post is the earliest one; later assistant text carrying the
  // token is someone quoting it back (the acceptance test asks PA to do that).
  const senders = scans
    .filter((s) => s.posted)
    .sort((a, b) => String(a.posted).localeCompare(String(b.posted)));
  if (senders.length === 0) return { verdict: "NOT_FOUND", files: files.length };
  const sender = senders[0];
  const { rows, hasTid } = readRoster();
  const owner =
    rows.find((r) => r.session_id === sender.sid) ||
    rows.find((r) => hasTid && r.transcript_id === sender.sid) ||
    null;

  // A receipt is a delivery FROM THE SENDER'S OWN ADDRESS. Anyone else's
  // channel message that merely QUOTES the token is not one: on 09-28 this
  // script's own author quoted the pre-fix specimen to PA at 02:20Z, and the
  // selftest then read that dropped post as ROUTED.
  const senderAddrs = new Set([sender.sid, owner?.session_id].filter(Boolean));
  const receipts = scans
    .filter((s) => s.sid !== sender.sid)
    .flatMap((s) => s.received.map((r) => ({ ...r, in: s.sid.slice(0, 8) })))
    .filter((r) => senderAddrs.has(r.from));
  return {
    verdict: receipts.length > 0 ? "ROUTED" : "DROPPED",
    transcript: sender.sid,
    posted_at: sender.posted,
    began_with_clear: sender.beganWithClear,
    owning_row: owner
      ? `${owner.id8} (${owner.name})${owner.session_id === sender.sid ? " by session_id" : " by transcript_id"}`
      : "NONE",
    registry_has_transcript_id: hasTid,
    receipts,
    unknown_sender_since_post: unknownSenderCount(sender.sid.slice(0, 8), sender.posted),
  };
}

function print(r) {
  console.log(JSON.stringify(r, null, 1));
}

// ── SYNTHETIC-TURN AUDIT (WI cb376ece part 2, commit 62c6054) ────────────────
//
// THE QUESTION: since <since>, did any turn the HARNESS wrote reach a peer as
// `user_input`? Every emit in emit-log carries the sender and the byte offset
// of its source line, so each one can be read back and judged by the record
// itself, not by the router that emitted it.
//
// The four markers are restated here ON PURPOSE rather than imported from
// agent_channel_filter.ts: an audit that reuses the code under test can never
// disagree with it.
function syntheticKind(rec) {
  if (rec?.isCompactSummary === true) return "compaction_summary";
  if (rec?.origin?.kind === "task-notification") return "task_notification";
  if (rec?.promptSource === "system") return "system_prompt";
  if (rec?.isMeta === true) return "meta";
  return null;
}

function readLineAt(path, offset) {
  const fd = openSync(path, "r");
  try {
    const chunks = [];
    let pos = offset;
    for (;;) {
      const buf = Buffer.alloc(65536);
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(10);
      if (nl >= 0) { chunks.push(buf.subarray(0, nl)); break; }
      chunks.push(buf.subarray(0, n));
      pos += n;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function syntheticAudit(sinceIso) {
  const { rows } = readRoster();
  const files = readdirSync(PROJECTS).filter((f) => f.endsWith(".jsonl"));
  const emits = new Map();
  for (const f of ["emit-log.jsonl.1", "emit-log.jsonl"]) {
    const p = join(STATE, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.includes('"user_input"') || !line.includes('"emit"')) continue;
      try {
        const r = JSON.parse(line);
        if (r.event === "emit" && r.event_type === "user_input" && r.ts >= sinceIso && !emits.has(r.emit_id)) emits.set(r.emit_id, r);
      } catch {}
    }
  }
  const out = { since: sinceIso, user_input_emits: emits.size, human_or_unmarked: 0, synthetic: [], unresolved: 0 };
  for (const e of emits.values()) {
    // The source is the sender's own transcript, or the one its row declares
    // after a /clear (transcript_id).
    const row = rows.find((r) => r.id8 === e.sender_id8);
    const cands = files.filter((f) => f.startsWith(e.sender_id8) || (row?.transcript_id && f.startsWith(row.transcript_id)));
    let rec = null;
    for (const f of cands) {
      try {
        const r = JSON.parse(readLineAt(join(PROJECTS, f), e.src_offset));
        if (r?.type === "user") { rec = r; break; }
      } catch {}
    }
    if (!rec) { out.unresolved++; continue; }
    const kind = syntheticKind(rec);
    if (kind) out.synthetic.push({ emit_id: e.emit_id, ts: e.ts, sender_id8: e.sender_id8, kind });
    else out.human_or_unmarked++;
  }
  out.verdict = out.synthetic.length ? "SYNTHETIC_ROUTED" : "CLEAN";
  return out;
}

// The recorded specimens (2026-09-27/28). Phrases unique to ONE original post,
// not a token that was later quoted around the fleet.
// PRE-FIX: DESK's @PA envelope at 2026-09-27T18:12:59Z from its /clear'd
// transcript 89c514ba - PA never received it (PA 18:35Z on cb376ece).
// HEALTHY: VIDEO's @PA envelope at 2026-09-28T01:41:10Z from 28c6b633, after
// Jarid's /mcp re-registered it - it reached PA through the channel.
const SPECIMENS = [
  {
    name: "pre-fix /clear (89c514ba, 2026-09-27 18:12Z)",
    token: "Queue noted: W1, then W2-A, then DAEMON, then the desk",
    expect: "DROPPED",
    since: "2026-09-27T01:00:00Z",
  },
  {
    name: "healthy after /mcp (28c6b633, 2026-09-28 01:41Z)",
    token: "Your compacted summary is out of date on four points",
    expect: "ROUTED",
    since: "2026-09-28T01:00:00Z",
  },
];

if (import.meta.main) {
  const self = process.env.CLAUDE_CODE_SESSION_ID;
  const exclude = self ? [self] : [];
  if (process.argv.includes("--selftest")) {
    let ok = true;
    for (const s of SPECIMENS) {
      if (!s.token) { console.log(`SKIP ${s.name}: token env var not set`); ok = false; continue; }
      const r = await check(s.token, s.since, { exclude });
      const pass = r.verdict === s.expect;
      ok &&= pass;
      console.log(`${pass ? "PASS" : "FAIL"} ${s.name}: expected ${s.expect}, got ${r.verdict} (row ${r.owning_row ?? "-"}, clear=${r.began_with_clear}, receipts=${r.receipts?.length ?? 0}, unknown_sender=${r.unknown_sender_since_post ?? "-"})`);
    }
    // The audit must FIRE on the two pre-fix specimens (PA's compaction
    // summary, VIDEO's Monitor event) and must NOT flag human input in the
    // same window, or it cannot tell the fix from its absence. The window
    // starts 09-27 because 05:50Z..06:30Z on 09-28 held no human-typed emit
    // at all (unaddressed typing to PA emits nothing), so a narrower window
    // had no negative control.
    const a = syntheticAudit("2026-09-27T00:00:00Z");
    const ids = new Set(a.synthetic.map((s) => s.emit_id));
    const fired = ids.has("muku4py5-fl-8nu") && ids.has("mukue0oz-krt-ti5");
    const discriminates = a.human_or_unmarked > 0;
    ok &&= fired && discriminates;
    console.log(`${fired && discriminates ? "PASS" : "FAIL"} synthetic audit on the pre-fix window: specimens flagged=${fired}, human/unmarked left unflagged=${a.human_or_unmarked}, synthetic=${a.synthetic.length}, unresolved=${a.unresolved}`);
    process.exit(ok ? 0 : 1);
  }
  if (process.argv.includes("--synthetic-audit")) {
    const r = syntheticAudit(arg("--since") ?? new Date(Date.now() - 3600_000).toISOString());
    print(r);
    process.exit(r.verdict === "CLEAN" ? 0 : 1);
  }
  const token = arg("--token");
  if (!token) { console.error("usage: --token <TOKEN> [--since ISO] [--wait sec] | --selftest"); process.exit(64); }
  const since = arg("--since") ?? new Date(Date.now() - 24 * 3600_000).toISOString();
  const waitSec = Number(arg("--wait") ?? 0);
  const deadline = Date.now() + waitSec * 1000;
  let r;
  for (;;) {
    r = await check(token, since, { exclude });
    if (r.verdict === "ROUTED" || Date.now() >= deadline) break;
    await Bun.sleep(5000);
  }
  print(r);
  process.exit(r.verdict === "ROUTED" ? 0 : r.verdict === "DROPPED" ? 1 : 2);
}
