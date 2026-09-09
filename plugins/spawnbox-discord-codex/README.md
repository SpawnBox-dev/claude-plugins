# SpawnBox Discord HELP on Codex

This package ports the **SpawnBox.help** conversation agent to Codex. It is
separate from the production SpawnBox.app bot and Worker interaction handlers.
The transport foundation is MIT-licensed `Openclaw-Metis/codex-discord-mcp`, pinned
at `6d0813bfce26ffedf0a0d090802113fbe57e6754`; see `vendor/UPSTREAM.md`.

Installing the plugin adds five skills and an 18-tool MCP client. It does **not**
start Discord, acquire bot credentials or take over Claude's rooms. A separately
managed local service owns the Gateway and a native Codex app-server process.

## Behavior

- Admitted human messages, DMs, forum threads, attachments and configured
  diagnostic webhook embeds enter a transactional SQLite inbox. Bot self-replies
  and unauthorized sources are ignored. Admission uses Discord IDs, not text tags.
- Idle messages start native Codex work. Each room has a persistent task; incoming
  messages during a turn queue automatically. Conversation order is preserved and
  independent rooms can progress concurrently. The runner resumes after restart.
- Explicit reply/file tools are the only message output. Task commentary, shell
  output and final answers are never automatically forwarded. Deliberate silence
  is a recorded outcome. Missing capabilities and failed actions use a separate
  `needs_operator` outcome, visible as blocked work in local status.
- Replies have stable operation keys, per-chunk receipts and Discord nonces.
  Recent ambiguous sends reuse the nonce. Older ambiguity, or an uncertain channel
  creation, stays blocked for reconciliation. This is not an exactly-once claim.
- The service persists DM recipients, leases, work failures, coverage cursors and
  operator audit records. Catch-up pages through text and archived forum history.
  Initial startup begins responsibility at that point; it does not reply to every
  historical guild message. Earlier history remains available through read tools.
- HELP workflows cover audience-aware replies, paginated history, image/text
  attachments, generated files, public bug/feature filing, private support rooms,
  forum tags, evidence-preserving protective moderation and helper review drafts.
- The diagnostic broker runs fixed remote release-version/diagnostic SELECTs and
  R2 gets. It inventories zstd/tar packages without extracting archive paths,
  reads bounded text members and fetches screenshots separately. General SQL,
  shell execution, deployments and source writes are not exposed.

## Process and audience boundaries

The worker uses its own Codex home, read-only native sandbox and a reviewed
PreToolUse deny guard. Shell, Code Mode, computer use, other integrations and
multi-agent tools are disabled. Only enumerated broker and conversation-memory
tools are preauthorized in this dedicated profile. These settings do not change
the operator's ordinary Codex profile. Native hook errors are not treated as an
allow decision; startup requires the reviewed guard to be trusted.

The bot token and Cloudflare credentials stay in the service. Child environments
are built from an allowlist; the Codex worker receives neither token. MCP clients
receive only a random loopback credential. Every operation is bound to an active
native task and its admitted event. Public workers cannot fetch staff/private
history or select an arbitrary reply destination.

Orchestrator project and global memory are isolated per conversation. Shared
domain policies remain project-owned and are read through a bounded broker. This
includes a contained reader for installed skill instructions, so the restricted
worker can actually load the workflows listed in its native skill catalog. This
preserves room boundaries but does not automatically import the entire existing
fleet KB into every Discord task. Binary diagnostic database investigation,
cross-audience publication, helper role decisions, bans/kicks, broad access
changes and deployment remain explicit local operator work.

## Setup and operation

Requirements: Windows-qualified Codex CLI 0.153.3, Bun 1.3.10, Node 20+, the
standalone orchestrator package, and Python with `zstandard` for diagnostic logs.
The source project must retain its reviewed Wrangler installation for diagnostics.

1. Install from `spawnbox-dev-codex-plugins`, the repository's separate Codex
   marketplace. Keep the Claude marketplace and launchers intact.
2. Create a dedicated state directory and `config.json` matching `src/config.ts`.
   `scripts/import-help-config.ts` can read the existing HELP allowlist and verify
   the actual bot/guild metadata without modifying Claude. Review audience mapping
   before production use. Test routing must be disjoint from Claude's responding
   rooms.
3. Configure the dedicated worker using the installed package:

   ```powershell
   bun dist/cli.js setup --state C:/Users/Jarid/.codex/spawnbox-help-rehearsal --auth-home C:/Users/Jarid/.codex
   ```

   `--auth-home` optionally copies the existing Codex login into the dedicated
   home when it has no login. Otherwise authenticate that home separately. Setup
   copies reviewed runtime/skills and trusts only its exact eight hook definitions
   through native `hooks/list` and `config/batchWrite`. No Gateway starts here.
4. Start the listener or its retrying supervisor:

   ```powershell
   bun dist/cli.js supervise --state C:/Users/Jarid/.codex/spawnbox-help-rehearsal --help-settings C:/Users/Jarid/OneDrive/AppDev/mc-server-project/spawnbox/.claude/settings.local.json
   bun dist/cli.js status --state C:/Users/Jarid/.codex/spawnbox-help-rehearsal
   bun dist/cli.js stop --state C:/Users/Jarid/.codex/spawnbox-help-rehearsal
   ```

   The selected local settings load only `DISCORD_HELP_BOT_TOKEN` and the two
   Cloudflare variables. There is no `DISCORD_BOT_TOKEN` fallback. Background
   PowerShell launches should use `Start-Process -WindowStyle Hidden`. A persistent
   stop request prevents the supervisor from restarting; remove that marker only
   when deliberately restarting. Service logs and status stay local.

## Recovery and upgrades

Use status to inspect blocked events, uncertain sends and catch-up errors. Check
Discord before resolving an uncertain delivery. Supply the actual accepted ID:

```powershell
bun dist/cli.js reconcile --state <state> --operation <operation> --part 0 --message-id <verified-discord-id>
bun dist/cli.js retry --state <state> --event <event-id>
```

Only after verifying that Discord did not accept it, use
`--confirmed-not-delivered` instead of `--message-id`. Recovery commands update
local state and never send a message themselves. Retrying without resolving an
uncertain outbox entry is rejected. No pending work is discarded to cap queue size.

Stop the service before updating. Back up its SQLite DB through SQLite's backup
API, retain state outside plugin caches, install the new plugin version, and rerun
setup to refresh the dedicated runtime and reviewed hook hashes. Roll back the
package and runtime together; never restore a whole shared KB over newer work.
Newer unsupported state schemas are rejected. A production cutover must have one
responding owner per room; rollback stops Codex and restores the prior Claude
ownership, without modifying Worker commands or the application bot.

## Qualification

Run `npm ci --ignore-scripts`, `npm run typecheck`, `bun test tests`,
`python -m unittest discover -s tests -p test_diag_reader.py`, and `bun run build`.
Set `CODEX_EXECUTABLE` to the native executable for Windows subprocess tests.

`scripts/native-smoke.ts` uses a deterministic loopback Responses fixture with
the real Codex host, hooks, MCP and queue. It exercises inbound wake, persistent
task resume after a full process/DB reopen, explicit reply, deliberate silence,
orchestrator checkpoint and a denied native patch. It runs no inference and sends
no Discord messages. `scripts/installed-smoke.ts` qualifies the actual installed
plugin loader and passive disconnected behavior.

Mock/native acceptance is not live behavioral parity. The private rehearsal must
also prove real model responses, human follow-up, DM restart, embeds, attachments,
forum mutations and recovery under actual Discord permissions before production
ownership changes. See the repository delivery log for current evidence.

The current private rehearsal has passed real model wake/reply, human follow-up,
offline-arrival recovery in the same native task, embeds, text/image attachments,
generated files, reactions, forum creation, tags and archival. A separate real REST
fixture verifies private support-room permissions/reuse and evidence preservation
before deleting a disposable bot message. Live DM ownership, diagnostic package
contents and member timeouts still need scoped acceptance; production routing has
not changed.
The supervisor currently runs locally and does not register automatic Windows
logon startup. Stopping this host stops its listener until restarted.
