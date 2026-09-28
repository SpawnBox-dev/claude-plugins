/**
 * A SIDECAR ON ITS WAY OUT MUST NOT DELETE ANOTHER SIDECAR'S PORT FILE.
 *
 * The port file is shared by every sidecar on the box and a newer one
 * overwrites it. The old exit hook unlinked it unconditionally, so an older
 * sidecar exiting cleanly removed the LIVE sidecar's pointer, and the next MCP
 * to start spawned a ~2 GB duplicate instead of adopting.
 *
 * The function under test is EXECUTED, not grepped: its source is lifted out
 * of embed_server.py and run by Python with only the stdlib it needs, so the
 * test does not depend on onnxruntime being installed.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const PY_SRC = readFileSync(join(import.meta.dir, "..", "..", "sidecar", "embed_server.py"), "utf8");

function findPython(): string | null {
  for (const cmd of ["python", "python3"]) {
    const r = spawnSync(cmd, ["-c", "print(1)"], { encoding: "utf8" });
    if (r.status === 0) return cmd;
  }
  return null;
}
const PY = findPython();

function liftFunction(): string {
  const start = PY_SRC.indexOf("def release_port_file(");
  const end = PY_SRC.indexOf("\nclass _Handler", start);
  if (start < 0 || end < 0) throw new Error("release_port_file not found in embed_server.py");
  return PY_SRC.slice(start, end);
}

/** Run release_port_file(path, port) and return what it returned. */
function release(path: string, port: number): string {
  const prog = [
    "import logging",
    "from pathlib import Path",
    "log = logging.getLogger('t')",
    liftFunction(),
    `print(release_port_file(Path(${JSON.stringify(path)}), ${port}))`,
  ].join("\n");
  const r = spawnSync(PY!, ["-c", prog], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

describe.skipIf(!PY)("sidecar releases the port file only while it names itself", () => {
  test("specimen: the file names a NEWER sidecar - it is left in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-release-"));
    try {
      const f = join(dir, "sidecar.port");
      writeFileSync(f, "60710");
      expect(release(f, 59307)).toBe("False");
      expect(readFileSync(f, "utf8")).toBe("60710");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("control: the file names this sidecar - it is deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-release-"));
    try {
      const f = join(dir, "sidecar.port");
      writeFileSync(f, "59307\n");
      expect(release(f, 59307)).toBe("True");
      expect(existsSync(f)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing file is not an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-release-"));
    try {
      expect(release(join(dir, "sidecar.port"), 59307)).toBe("False");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the exit hook is the owner-checked release, not a bare unlink", () => {
    expect(PY_SRC).toContain("atexit.register(release_port_file, port_path, actual_port)");
    expect(PY_SRC).not.toMatch(/def _cleanup\(\)/);
  });
});
