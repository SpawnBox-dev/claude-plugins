import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { applyMigrations } from "../../mcp/db/schema";
import { EmbeddingClient } from "../../mcp/engine/embeddings";
import { generateId, now } from "../../mcp/utils";

// 0.44.1 - the repair path shipped in 0.44.0 could not actually repair.
//
// MEASURED against the live sidecar (7083-note KB, CPU ONNX bge-m3):
//   batch=8  -> 24.7s
//   batch=16 -> 34.0s   } both exceed embed()'s hardcoded 30s AbortController
//   batch=32 -> 92.4s   } <- backfill's hardcoded default
// Payloads were tiny (32 notes = 12.7KB total), so this is not a size problem;
// the model is simply slow. batchSize 32 against a 30s abort is structurally
// unsatisfiable on this hardware, and EVERY batch failed.
//
// The severe part was not the failure - it was that the failure was SHAPED
// LIKE SUCCESS. backfill logged to stderr, continued, and returned a plain
// count. A caller seeing 0 could not distinguish "nothing needed repair" from
// "every single batch failed". A check that cannot say no.

function makeDb(): Database {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  return db;
}

function insertNote(db: Database, content: string) {
  const id = generateId();
  const ts = now();
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
     VALUES (?, 'insight', ?, NULL, '', '', 'medium', 0, ?, ?)`,
    [id, content, ts, ts]
  );
  return id;
}

describe("0.44.1: backfill distinguishes 'nothing to do' from 'everything failed'", () => {
  test("total failure is NOT reported as a clean zero", async () => {
    const db = makeDb();
    insertNote(db, "a");
    insertNote(db, "b");

    const client = new EmbeddingClient("http://127.0.0.1:1");
    (client as any).embed = async () => null; // every batch fails

    const res = await client.backfill(db);
    expect(res.embedded).toBe(0);
    // The load-bearing assertion: the caller can SEE that work was attempted
    // and lost. Pre-fix this returned the bare number 0.
    expect(res.attempted).toBeGreaterThan(0);
    expect(res.failed).toBeGreaterThan(0);
    expect(res.batchesFailed).toBeGreaterThan(0);
  });

  test("nothing-to-do is a clean zero with nothing attempted", async () => {
    const db = makeDb();
    const client = new EmbeddingClient("http://127.0.0.1:1");
    let called = false;
    (client as any).embed = async () => {
      called = true;
      return null;
    };

    const res = await client.backfill(db);
    expect(res.embedded).toBe(0);
    expect(res.attempted).toBe(0);
    expect(res.failed).toBe(0);
    expect(res.batchesFailed).toBe(0);
    expect(called).toBe(false);
    // Contrast with the test above: same embedded=0, totally different meaning.
    // That distinction is the whole point of the change.
  });

  test("partial failure reports both sides", async () => {
    const db = makeDb();
    for (let i = 0; i < 12; i++) insertNote(db, `note ${i}`);

    const client = new EmbeddingClient("http://127.0.0.1:1");
    let call = 0;
    (client as any).embed = async (texts: string[]) => {
      call++;
      return call === 1 ? texts.map(() => new Float32Array([0.5])) : null;
    };

    const res = await client.backfill(db, 8);
    expect(res.embedded).toBe(8);
    expect(res.failed).toBe(4);
    expect(res.attempted).toBe(12);
    expect(res.batchesTotal).toBe(2);
    expect(res.batchesFailed).toBe(1);
  });

  test("success path still reports the count", async () => {
    const db = makeDb();
    insertNote(db, "x");
    insertNote(db, "y");
    const client = new EmbeddingClient("http://127.0.0.1:1");
    (client as any).embed = async (texts: string[]) => texts.map(() => new Float32Array([0.1]));

    const res = await client.backfill(db);
    expect(res.embedded).toBe(2);
    expect(res.failed).toBe(0);
    expect(res.batchesFailed).toBe(0);
    const rows = db.query("SELECT COUNT(*) c FROM embeddings").get() as { c: number };
    expect(rows.c).toBe(2);
  });
});

describe("0.44.1: batch size and timeout fit the measured envelope", () => {
  const SRC = readFileSync(join(import.meta.dir, "..", "..", "mcp", "engine", "embeddings.ts"), "utf8");

  test("default batch size is small enough to finish inside the timeout", () => {
    const m = SRC.match(/backfill\(\s*db:\s*Database,\s*batchSize:\s*number\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    const batch = parseInt(m![1], 10);
    // 32 measured at 92.4s; 16 at 34.0s. Anything above 8 has no headroom.
    expect(batch).toBeLessThanOrEqual(8);
  });

  test("the embed timeout has real headroom over the measured batch cost", () => {
    const m = SRC.match(/EMBED_TIMEOUT_MS\s*=\s*([\d_]+)/);
    expect(m).not.toBeNull();
    const timeout = parseInt(m![1].replace(/_/g, ""), 10);
    // batch=8 measured 24.7s under load; 30s left almost none.
    expect(timeout).toBeGreaterThanOrEqual(60_000);
  });
});

describe("0.44.1: stderr EPIPE cannot kill the MCP server", () => {
  const SERVER = readFileSync(join(import.meta.dir, "..", "..", "mcp", "server.ts"), "utf8");

  test("an error handler is attached to stderr (and stdout)", () => {
    // DISCORD (SA-622e7298) found 808 EPIPE uncaughtExceptions across PIDs.
    // emitLifecycleLine ALREADY try/catches its stderr write - which is why
    // this is subtle rather than an oversight: process.stderr.write raises
    // EPIPE ASYNCHRONOUSLY as an unhandled 'error' event, so try/catch cannot
    // see it and an unhandled uncaughtException can terminate the process.
    // A benign "reader went away" then becomes real egress death.
    //
    // Exact mirror of the 0.44.0 append bug: that one had .catch() for the
    // async path and threw sync; this one has try/catch for the sync path and
    // fails async. A best-effort side effect needs BOTH guards.
    expect(/process\.stderr\.on\(\s*["']error["']/.test(SERVER)).toBe(true);
    expect(/process\.stdout\.on\(\s*["']error["']/.test(SERVER)).toBe(true);
  });
});

describe("0.44.1: egress_suspect alert carries the method note's procedure", () => {
  const SRC = readFileSync(join(import.meta.dir, "..", "..", "mcp", "engine", "agent_channel.ts"), "utf8");

  function alertText(): string {
    const i = SRC.indexOf("[egress_suspect]");
    expect(i).toBeGreaterThan(-1);
    return SRC.slice(i, i + 2600);
  }

  test("it tells the reader to ADDRESS the subject - the only resolving step", () => {
    // Per e24d8156: passive steps only ever NARROW; addressing the session is
    // the sole ACTIVE probe. The alert previously never mentioned it and
    // routed straight from a passive re-sample to interrupting the human,
    // which is the move the method note explicitly forbids.
    expect(/address/i.test(alertText())).toBe(true);
  });

  test("the address step comes BEFORE any suggestion to involve the user", () => {
    const t = alertText();
    const address = t.search(/address/i);
    const human = t.search(/tell the user/i);
    expect(address).toBeGreaterThan(-1);
    expect(human).toBeGreaterThan(-1);
    expect(address).toBeLessThan(human);
  });

  test("it prints the base rate so the reader's prior is calibrated", () => {
    expect(/0 (real )?(faults|of)/i.test(alertText())).toBe(true);
  });

  test("it names bulk sidecar jobs as a known wait-out cause", () => {
    expect(/sidecar|embedding/i.test(alertText())).toBe(true);
  });
});
