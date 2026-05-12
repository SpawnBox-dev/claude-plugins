---
name: backup-plugin-db
description: Use when setting up the orchestrator plugin on a new machine (or refreshing an existing install) and the user wants nightly point-in-time snapshots of the plugin SQLite DB. Installs a WAL-safe snapshot script and a daily scheduler (systemd-user, cron, or Windows Scheduled Task) that writes to a user-chosen destination - typically a cloud-sync folder or a path on backed-up local storage.
---

# Install nightly snapshots of the orchestrator plugin DB(s)

## Overview

The orchestrator plugin uses **two** local SQLite databases:

| DB | Path | Holds |
|---|---|---|
| Global | `~/.claude/orchestrator/global.db` | Cross-project notes, user patterns, global state |
| Project | `<project-dir>/.orchestrator/project.db` | Per-project notes, decisions, work items, ADRs, embeddings |

In a typical install most of the volume lives in the project DB(s) — one
per project where Claude is invoked. If either file is corrupted,
accidentally deleted, or the machine dies, the knowledge base goes with
it. **Both files should be backed up.** Many users discover only after
losing data that they were snapshotting the global DB and ignoring the
project DBs that hold the bulk of their knowledge.

This skill installs a daily snapshot per DB. Run the helper once for the
global DB and once per project DB you care about. Each install gets its
own scheduler entry, its own destination subpath, and its own retention
policy.

The snapshot pipeline is:

- **WAL-safe**: uses SQLite's online backup API, so concurrent writes from
  the running MCP server don't tear the snapshot.
- **Atomic**: writes to a tempfile in the destination dir and renames into
  place, so cloud-sync clients never see a partial file.
- **User-chosen destination**: the script never invents a default. You pick
  where snapshots go. Typical choices:
  - A cloud-sync folder (OneDrive / Dropbox / Google Drive / iCloud / Syncthing)
  - A path on a backed-up local disk
  - A network share / NAS mount
- **Per-platform scheduler**: systemd-user timer on Linux/WSL/macOS-with-systemd,
  cron fallback otherwise, Windows Scheduled Task on Windows.

The snapshots themselves are safe to cloud-sync (they're frozen point-in-time
files). The **live DB at `~/.claude/orchestrator/global.db` is NOT safe to
cloud-sync** — SQLite file locking does not cross cloud-sync boundaries and
the WAL sidecar desyncs from the main file. Snapshot, don't mirror.

## When to use

- After installing the orchestrator plugin on a new machine
- After moving the plugin install to a new project / new home directory
- When the user wants to recover from a corrupted or deleted DB and there's
  no existing snapshot strategy
- As routine hygiene if the existing schedule needs to be re-pointed at a
  new destination

## Steps

### 1. Pick a destination

Ask the user where they want snapshots written. The destination must be:

- An existing directory (the helper will not create it)
- Writable by the current user
- NOT inside `~/.claude/orchestrator/` (the script refuses to write a
  snapshot next to the live DB it's snapshotting)

Cloud-drive examples to suggest (adapt to the user's setup):

| Platform | Typical cloud-drive paths |
|---|---|
| Windows | `C:\Users\<you>\OneDrive\<sub>` · `C:\Users\<you>\Dropbox\<sub>` |
| macOS | `~/Library/CloudStorage/OneDrive-Personal/<sub>` · `~/Dropbox/<sub>` · `~/Library/Mobile Documents/com~apple~CloudDocs/<sub>` |
| Linux | `~/Dropbox/<sub>` · `~/OneDrive/<sub>` (if rclone/onedrive client mounted) · `~/Syncthing/<sub>` |
| WSL2 | `/mnt/c/Users/<you>/OneDrive/<sub>` · any path on the Windows side |

These are suggestions only. The user is in charge of where snapshots land.

### 2. Locate the source scripts directory

This skill's helper scripts live in the `scripts/` subdir next to this
SKILL.md. The system message that loaded this skill displayed a
`Base directory for this skill:` header with the absolute path. Use that
path's `scripts/` subdirectory.

If the base dir isn't surfaced, the plugin cache layout is:

```bash
SCRIPTS_DIR=$(find ~/.claude/plugins/cache -path "*/orchestrator/*/skills/backup-plugin-db/scripts" -type d 2>/dev/null | sort | tail -1)
echo "$SCRIPTS_DIR"
```

### 3. Install one timer for the global DB

**Linux / WSL / macOS (bash):**

```bash
"$SCRIPTS_DIR/install-snapshot-timer.sh" \
    --cloud-root /path/to/destination \
    --retain-days 30
```

(`--retain-days` is optional; omit to keep snapshots forever.)

**Windows (PowerShell):**

```powershell
& "$SCRIPTS_DIR\install-snapshot-task.ps1" `
    -CloudRoot 'C:\Users\me\OneDrive\plugin-backups' `
    -RetainDays 30
```

This snapshots `~/.claude/orchestrator/global.db` daily and writes to
`<cloud-root>/<hostname>/global-YYYY-MM-DD.db`.

### 4. Install one timer per project DB you want backed up

For each project whose `.orchestrator/project.db` you want preserved,
run the helper again with `--source` (or `-Source`) and a distinct
`--name` (or `-TaskName`). Examples:

**Linux / WSL / macOS:**

```bash
"$SCRIPTS_DIR/install-snapshot-timer.sh" \
    --cloud-root /path/to/destination \
    --source /home/me/repos/myproject/.orchestrator/project.db \
    --name claude-db-snapshot-myproject \
    --retain-days 90
```

**Windows:**

```powershell
& "$SCRIPTS_DIR\install-snapshot-task.ps1" `
    -CloudRoot 'C:\Users\me\OneDrive\plugin-backups' `
    -Source 'D:\repos\myproject\.orchestrator\project.db' `
    -TaskName 'Claude DB nightly (myproject)' `
    -RetainDays 90
```

Each install lands at `<cloud-root>/<hostname>/project-YYYY-MM-DD.db`
(the filename uses the source's stem, so multiple project DBs from
different projects WILL collide if you point them at the same
`<cloud-root>`). For multi-project setups, give each install a distinct
`--cloud-root` subdir (e.g. `<cloud-root>/myproject/`) so the filenames
don't fight.

**Retention** (`--retain-days N` / `-RetainDays N`): after each
snapshot, the script deletes only files matching this same source's
`<stem>-YYYY-MM-DD.db` pattern that are older than N days. Files that
don't match the pattern are never touched. Omit the flag entirely to
keep all snapshots forever. Different DBs can have different retention
windows (e.g. 30 days for global, 90 days for a project you're actively
working on).

### 3a. Scheduler details

**bash helper:** auto-detects systemd-user. If present and the user bus
is alive, it installs `~/.config/systemd/user/<name>.{service,timer}`
and runs `systemctl --user enable --now <name>.timer`. Otherwise it
falls back to a user crontab entry tagged with the chosen `--name`
(idempotent — re-running replaces the prior entry).

**WSL2 / headless Linux note:** systemd-user timers stop firing when
the user logs out unless linger is enabled. The helper prints a warning
if Linger is OFF. To enable:

```bash
sudo loginctl enable-linger $(id -un)
```

**Windows helper:** registers a Scheduled Task with the given
`-TaskName`. It runs as the current user when logged in. Snapshots are
skipped on days when the user never logs in (the helper output shows
how to switch to `LogonType S4U` if always-run is required).

### 5. Verify the install

**One-off snapshot (sanity check):**

```bash
# bash
python3 "$SCRIPTS_DIR/snapshot-plugin-db.py" --cloud-root /path/to/destination
```

```powershell
# PowerShell
& pyw.exe "$SCRIPTS_DIR\snapshot-plugin-db.py" --cloud-root 'C:\path\to\destination'
```

Expected output (paths will differ):

```
[snapshot-plugin-db] source: /home/<you>/.claude/orchestrator/global.db
[snapshot-plugin-db] dest:   /path/to/destination/<hostname>/global-YYYY-MM-DD.db
[snapshot-plugin-db] wrote 475,136 bytes
```

**Confirm the scheduler is armed:**

```bash
# systemd-user
systemctl --user list-timers claude-orchestrator-db-snapshot.timer

# cron
crontab -l | grep claude-orchestrator-db-snapshot
```

```powershell
# Windows
Get-ScheduledTask -TaskName 'Claude orchestrator DB snapshot' | Get-ScheduledTaskInfo
```

### 6. (Optional) Run a read-back drill

A snapshot is only useful if it's restorable. Open the snapshot read-only
and confirm it has the expected shape:

```bash
sqlite3 /path/to/destination/<hostname>/global-YYYY-MM-DD.db \
  "PRAGMA integrity_check; SELECT count(*) FROM notes;"
```

`integrity_check` should print `ok`. The note count should be non-zero and
close to what `lookup` reports against the live DB.

For a full destructive restore drill, see "Common mistakes" below.

## Quick reference

| Step | What | Where |
|---|---|---|
| 1 | Pick a destination directory (user's choice) | `<cloud-or-backup-path>` |
| 2 | Locate scripts dir | `<base-dir>/scripts/` |
| 3 | Install timer for global DB (`--retain-days` optional) | systemd-user / cron / Task Scheduler |
| 4 | Install one timer per project DB (`--source` + distinct `--name`) | same |
| 5 | One-off `snapshot-plugin-db.py --cloud-root <path> [--source ...]` | Confirms script runs |
| 6 | `sqlite3 <snapshot> "PRAGMA integrity_check"` (or Python) | Confirms snapshot is valid |

## Common mistakes

- **Backing up only the global DB.** This is the most common omission.
  Most volume lives in `<project>/.orchestrator/project.db`. Run the
  helper a second time with `--source <project-db>` and a distinct
  `--name`.
- **Pointing `--cloud-root` at `~/.claude/orchestrator/`** or a parent of
  it. The script refuses; pick a destination outside the source DB's
  directory.
- **Collisions between project DBs in the same destination.** Two
  different projects both named `project.db` will both produce
  `project-YYYY-MM-DD.db` filenames. Either use distinct `--cloud-root`
  subdirs per project, or rename one source DB before snapshotting.
- **Cloud-syncing the live DB itself.** Don't. SQLite locking does not
  cross sync boundaries; the WAL sidecar desyncs from the main file; you'll
  end up with `<file>-conflict-<machine>.db` files and corrupted state.
  Snapshot to the cloud; never mirror the live file.
- **Forgetting `loginctl enable-linger` on WSL/server.** Without linger,
  systemd-user timers stop when you log out. The helper warns but doesn't
  enable it (requires sudo).
- **Re-running with a different `--name` and expecting the old timer to be
  cleaned up.** The helper's idempotency is keyed on the name. To replace
  the destination of an existing schedule, re-run with the same `--name`
  and the new `--cloud-root`. To run multiple schedules in parallel
  (e.g. two destinations), use distinct names.
- **Skipping verification.** Run step 4 immediately after install. A
  scheduled task that fires every night and silently writes to nowhere is
  the worst outcome.

## Destructive restore drill (optional, recommended quarterly)

The read-back check in step 5 confirms the snapshot is valid SQLite. To
prove it's a working restoration, swap it in:

```bash
# 1. Stop the running orchestrator MCP (close all Claude Code sessions
#    that have the plugin loaded, or kill the MCP process directly).
# 2. Move the live DB aside.
mv ~/.claude/orchestrator/global.db{,.predrill-backup}
# 3. Restore from the latest snapshot.
cp /path/to/destination/<hostname>/global-YYYY-MM-DD.db ~/.claude/orchestrator/global.db
# 4. Start a new Claude Code session; it will spin up the MCP fresh.
# 5. Confirm via `lookup` / briefing that the expected notes are present.
# 6. If happy: rm ~/.claude/orchestrator/global.db.predrill-backup
#    If not:   mv ~/.claude/orchestrator/global.db{.predrill-backup,}
```

The orchestrator MCP server runs schema migrations on startup, so a
snapshot from an older plugin version restores cleanly under a newer
plugin version.

## Notes

- **Per-machine by design.** Each machine maintains its own snapshot
  schedule writing to its own `<hostname>/` subdir. SQLite is not a
  multi-machine sync target.
- **Retention is per-install.** Pass `--retain-days N` to delete only
  this source's `<stem>-YYYY-MM-DD.db` snapshots older than N days. Files
  that don't match the pattern are never touched. Omit the flag to keep
  forever. Different DBs can have different retention windows by passing
  different values at install time. Same-day re-runs overwrite the
  current day's file atomically (the snapshot writes to a tempfile and
  atomic-renames into place).
- **Source override.** `--source <path>` works if you've relocated the
  plugin DB or want to snapshot a non-default install.
- **Same-day catch-up.** `Persistent=true` on the systemd timer (and
  `-StartWhenAvailable` on the Windows task) means a missed run fires on
  next boot. The atomic write keeps any pre-existing same-day snapshot
  safe until the new one is fully written.
- **`--flat`** drops the `<hostname>/` subdir. Useful only if you really
  intend to mingle snapshots from multiple machines in one folder; not
  recommended.
- **Cleanup.** To uninstall, disable the timer (`systemctl --user disable
  --now <name>.timer`) and remove the unit files, drop the crontab entry,
  or `Unregister-ScheduledTask -TaskName '<name>' -Confirm:$false` on
  Windows.
