import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync, rmSync, utimesSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sweepStateDir, MARKER_MAX_AGE_MS, WL_BACKUP_KEEP } from "../../mcp/engine/state_gc";

// Backlog item M, open since 2026-07-27 and measured three times:
// 448 files -> 535 -> 730 (76 MB). Oldest debris dates to 2026-04-21. Nothing
// in the plugin has ever deleted a marker.
//
// It matters more than tidiness here because the state dir lives inside a
// ONEDRIVE-SYNCED project folder, so every dead marker is replicated to the
// cloud forever.
//
// This sweep DELETES FILES, so its safety properties are the tests: an
// ALLOWLIST of known-ephemeral prefixes (an unknown file is always kept), an
// age floor that cannot race a live write, and best-effort semantics that
// never throw into a caller.

let dir: string;
const HOUR = 60 * 60 * 1000;

function write(name: string, ageMs = 0) {
  const p = join(dir, name);
  writeFileSync(p, "x");
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(p, t, t);
  }
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-gc-"));
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("state dir GC: what it removes", () => {
  test("sweeps stale ephemeral markers", () => {
    write("active-session-1234", MARKER_MAX_AGE_MS + HOUR);
    write("turn-abc", MARKER_MAX_AGE_MS + HOUR);
    write("stop-abc", MARKER_MAX_AGE_MS + HOUR);
    write("subagent-stop-abc", MARKER_MAX_AGE_MS + HOUR);
    write("preuse-warn-abc", MARKER_MAX_AGE_MS + HOUR);
    write("bridge-abc", MARKER_MAX_AGE_MS + HOUR);
    write("orch-active-abc", MARKER_MAX_AGE_MS + HOUR);

    const res = sweepStateDir(dir);
    expect(res.removed).toBe(7);
    expect(readdirSync(dir).length).toBe(0);
  });

  test("reports what it did, so a silent no-op is distinguishable from a clean dir", () => {
    write("active-session-1", MARKER_MAX_AGE_MS + HOUR);
    const res = sweepStateDir(dir);
    expect(res.removed).toBe(1);
    expect(res.scanned).toBeGreaterThan(0);
  });
});

describe("state dir GC: what it must NEVER remove", () => {
  test("keeps live state regardless of age", () => {
    // These ARE the system. Age is not evidence of deadness for any of them.
    const keep = [
      "agent_channel.db",
      "agent_channel.db-wal",
      "agent_channel.db-shm",
      "warden-ledger.md",
      "offsets-abc12345.json",
      ".gitignore",
    ];
    for (const k of keep) write(k, MARKER_MAX_AGE_MS * 10);

    sweepStateDir(dir);
    for (const k of keep) expect(existsSync(join(dir, k))).toBe(true);
  });

  test("keeps UNKNOWN files - the list is an allowlist, not a denylist", () => {
    // A future file type must survive a sweep written before it existed.
    write("some-new-thing-nobody-told-the-gc-about", MARKER_MAX_AGE_MS * 10);
    write("important.md", MARKER_MAX_AGE_MS * 10);
    const res = sweepStateDir(dir);
    expect(res.removed).toBe(0);
    expect(readdirSync(dir).length).toBe(2);
  });

  test("keeps RECENT markers - the age floor cannot race a live session", () => {
    // A running session's marker is minutes old, never days.
    write("active-session-9999", 60_000);
    write("turn-fresh", 0);
    const res = sweepStateDir(dir);
    expect(res.removed).toBe(0);
    expect(readdirSync(dir).length).toBe(2);
  });

  test("a marker just under the threshold survives", () => {
    write("active-session-1", MARKER_MAX_AGE_MS - HOUR);
    expect(sweepStateDir(dir).removed).toBe(0);
  });
});

describe("state dir GC: warden-ledger backup rotation (item N)", () => {
  test("keeps the newest N backups and drops the rest", () => {
    for (let i = 0; i < WL_BACKUP_KEEP + 15; i++) {
      write(`.wl-backup-${i}.md`, (WL_BACKUP_KEEP + 15 - i) * HOUR);
    }
    const res = sweepStateDir(dir);
    const left = readdirSync(dir).filter((f) => f.startsWith(".wl-backup-"));
    expect(left.length).toBe(WL_BACKUP_KEEP);
    expect(res.rotated).toBe(15);
  });

  test("rotation keeps the NEWEST, not an arbitrary N", () => {
    write(".wl-backup-old.md", 500 * HOUR);
    write(".wl-backup-new.md", 1 * HOUR);
    for (let i = 0; i < WL_BACKUP_KEEP - 1; i++) write(`.wl-backup-mid${i}.md`, 10 * HOUR);

    sweepStateDir(dir);
    // Recovery value is in the most recent snapshot; the oldest is the one to lose.
    expect(existsSync(join(dir, ".wl-backup-new.md"))).toBe(true);
    expect(existsSync(join(dir, ".wl-backup-old.md"))).toBe(false);
  });

  test("under the keep-count, rotation does nothing", () => {
    write(".wl-backup-1.md", 100 * HOUR);
    write(".wl-backup-2.md", 200 * HOUR);
    const res = sweepStateDir(dir);
    expect(res.rotated).toBe(0);
    expect(readdirSync(dir).length).toBe(2);
  });

  test("the LIVE ledger is never treated as a backup", () => {
    write("warden-ledger.md", 1000 * HOUR);
    for (let i = 0; i < WL_BACKUP_KEEP + 5; i++) write(`.wl-backup-${i}.md`, (i + 1) * HOUR);
    sweepStateDir(dir);
    expect(existsSync(join(dir, "warden-ledger.md"))).toBe(true);
  });
});

describe("state dir GC: it must never break its caller", () => {
  test("a missing directory is not an error", () => {
    expect(() => sweepStateDir(join(dir, "does-not-exist"))).not.toThrow();
    expect(sweepStateDir(join(dir, "nope")).removed).toBe(0);
  });

  test("runs at most once per directory per process", () => {
    write("active-session-1", MARKER_MAX_AGE_MS + HOUR);
    expect(sweepStateDir(dir).removed).toBe(1);
    // Second call is a no-op guard, not a second scan - this runs off a
    // startup path, not a loop.
    const second = sweepStateDir(dir);
    expect(second.removed).toBe(0);
    expect(second.skipped).toBe(true);
  });
});
