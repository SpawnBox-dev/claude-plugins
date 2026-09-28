/**
 * THE CLIENT FOLLOWS THE PORT FILE - and only to a sidecar that checks out.
 *
 * Specimen (2026-09-28): the port file had named 60710 since 01:32Z, and five
 * orchestrator MCPs started earlier were still bound to 59307, because a client
 * bound its URL once at startup. `system_status` and the opt-in reaper classify
 * by the port file, so they called the sidecar those five sessions used an
 * orphan. The first test below fails on that code (the call still lands on A).
 *
 * Real HTTP servers, not a fetch mock: which server ANSWERED is the thing under
 * test, and a mock cannot tell two URLs apart the way a socket can.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EmbeddingClient,
  ACTIVE_EMBED_DIM,
  ACTIVE_EMBED_MODEL_REPO,
} from "../../mcp/engine/embeddings";

interface Fake {
  url: string;
  port: number;
  hits: number;
  stop: () => void;
}

/** A sidecar stand-in whose vectors are filled with `mark`, so a result says
 *  which server produced it. */
function fakeSidecar(
  mark: number,
  opts: { dim?: number; model?: string | null; status?: string } = {},
): Fake {
  const dim = opts.dim ?? ACTIVE_EMBED_DIM;
  const f: Fake = { url: "", port: 0, hits: 0, stop: () => {} };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") {
        const body: Record<string, unknown> = { status: opts.status ?? "ready", dim };
        if (opts.model !== null) body.model = opts.model ?? ACTIVE_EMBED_MODEL_REPO;
        return Response.json(body);
      }
      if (path === "/embed") {
        const { texts } = (await req.json()) as { texts: string[] };
        f.hits++;
        return Response.json({ vectors: texts.map(() => Array(dim).fill(mark)) });
      }
      return new Response("not found", { status: 404 });
    },
  });
  f.port = server.port ?? 0;
  f.url = `http://127.0.0.1:${server.port}`;
  f.stop = () => server.stop(true);
  return f;
}

let dir = "";
const fakes: Fake[] = [];
function sidecar(mark: number, opts?: Parameters<typeof fakeSidecar>[1]): Fake {
  const f = fakeSidecar(mark, opts);
  fakes.push(f);
  return f;
}

/** Write the port file and move its mtime forward, so a change is visible
 *  even on a filesystem with coarse timestamps. */
let tick = 1_700_000_000;
function writePort(file: string, port: number): void {
  writeFileSync(file, String(port));
  tick += 10;
  utimesSync(file, tick, tick);
}

function setup(): string {
  dir = mkdtempSync(join(tmpdir(), "orch-portfile-"));
  return join(dir, "sidecar.port");
}

afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("EmbeddingClient follows the port file", () => {
  test("specimen: the port file moves to B, the next call lands on B", async () => {
    const file = setup();
    const a = sidecar(1);
    const b = sidecar(2);
    writePort(file, a.port);
    const client = new EmbeddingClient(a.url, { portFile: file });

    expect((await client.embed(["x"]))?.[0]?.[0]).toBe(1);

    writePort(file, b.port);
    const v = await client.embed(["x"]);
    expect(v?.[0]?.[0]).toBe(2);
    expect(client.url).toBe(b.url);
  });

  test("control: without a port file the client never moves", async () => {
    const file = setup();
    const a = sidecar(1);
    const b = sidecar(2);
    writePort(file, a.port);
    const client = new EmbeddingClient(a.url);

    writePort(file, b.port);
    expect((await client.embed(["x"]))?.[0]?.[0]).toBe(1);
    expect(b.hits).toBe(0);
  });

  test("a candidate with the wrong vector width is refused; the client stays on A", async () => {
    const file = setup();
    const a = sidecar(1);
    const wrong = sidecar(9, { dim: 384 });
    writePort(file, a.port);
    const client = new EmbeddingClient(a.url, { portFile: file });

    writePort(file, wrong.port);
    expect((await client.embed(["x"]))?.[0]?.[0]).toBe(1);
    expect(client.url).toBe(a.url);
  });

  test("a candidate reporting a different model is refused, even at the right width", async () => {
    const file = setup();
    const a = sidecar(1);
    const other = sidecar(9, { model: "BAAI/some-other-model" });
    writePort(file, a.port);
    const client = new EmbeddingClient(a.url, { portFile: file });

    writePort(file, other.port);
    expect((await client.embed(["x"]))?.[0]?.[0]).toBe(1);
    expect(other.hits).toBe(0);
  });

  test("a candidate that is not ready yet is refused; the client stays on A", async () => {
    const file = setup();
    const a = sidecar(1);
    const loading = sidecar(9, { status: "loading" });
    writePort(file, a.port);
    const client = new EmbeddingClient(a.url, { portFile: file });

    writePort(file, loading.port);
    expect((await client.embed(["x"]))?.[0]?.[0]).toBe(1);
  });

  test("a deleted port file names nothing and never unbinds a working client", async () => {
    const file = setup();
    const a = sidecar(1);
    writePort(file, a.port);
    const client = new EmbeddingClient(a.url, { portFile: file });

    rmSync(file);
    expect((await client.embed(["x"]))?.[0]?.[0]).toBe(1);
  });

  test("our sidecar dies and the file names a live one: the failed call is retried there", async () => {
    const file = setup();
    const a = sidecar(1);
    const b = sidecar(2);
    writePort(file, a.port);
    const client = new EmbeddingClient(a.url, { portFile: file });

    writePort(file, b.port);
    a.stop();
    expect((await client.embed(["x"]))?.[0]?.[0]).toBe(2);
  });

  test("a failure re-reads the file even when its mtime has not changed since we looked", async () => {
    // The mtime was recorded at construction while the file already named B,
    // so the pre-call check sees nothing new. Only the forced re-read after
    // A's failure can find B.
    const file = setup();
    const a = sidecar(1);
    const b = sidecar(2);
    writePort(file, b.port);
    const client = new EmbeddingClient(a.url, { portFile: file });

    a.stop();
    expect((await client.embed(["x"]))?.[0]?.[0]).toBe(2);
  });

  test("health() and isAvailable() report the sidecar the file names", async () => {
    const file = setup();
    const a = sidecar(1);
    const b = sidecar(2);
    writePort(file, a.port);
    const client = new EmbeddingClient(a.url, { portFile: file });

    writePort(file, b.port);
    a.stop();
    expect(await client.isAvailable()).toBe(true);
    expect(client.url).toBe(b.url);
  });
});
