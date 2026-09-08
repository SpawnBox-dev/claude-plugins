# Codex standalone delivery — 2026-09-08

The shared-engine standalone port is implemented on `codex/orchestrator-discord`. Release metadata is prepared as 0.70.0. Locally installed development artifact: `0.70.0+codex.20260908174911`, marketplace `spawnbox-dev-codex-plugins`. Claude's installed package and launchers have not been replaced. This branch has not been published to the remote marketplace.

The Codex package exposes 20 knowledge, work, preference and maintenance tools, 12 skills and seven command hooks. It skips the Claude channels, permission relay, transcript identity, fleet cleanup and process reaping paths. Checkpoints use native request identity and only recover the current task's records. Shared source changes preserve the default Claude profile; database startup additionally handles concurrent WAL initialization and rechecks migrations under a write lock.

## Verified evidence

- Full fixture suite: **1,559 passing tests, zero failures**, 123 files and 3,690 assertions. Typecheck and both bundles pass.
- A clean native Codex 0.153.3 installation exposes only the intended components. Runtime execution uses the installed artifact, not the source tree.
- Real app-server calls supply `_meta.threadId`; MCP startup does not receive `CODEX_THREAD_ID`. Concurrent tasks have separate attribution and checkpoint recovery.
- Deterministic Responses fixtures drive real Codex turns: relevant knowledge appears before `apply_patch`; edit tracking requests a bounded Stop continuation; native tool discovery finds `save_progress`; the checkpoint is stored under the correct task.
- All seven lifecycle events execute. Real compaction is followed by a SessionStart recovery containing the saved checkpoint; archive/resume preserves that checkpoint. Hooks use `additionalContext`, not UI-only system messages.
- The native edit payload is `tool_input.command`; parser tests also cover multiple files, moves, deletions and escaping paths. Nonzero shell outputs are recognized as failures. Work-item reminders reuse the shared helper.
- Claude and Codex storage adapters initialize and write a fresh database concurrently. Model and actual embedding dimensions are checked before Codex adopts a shared sidecar.
- Generated package inventory and content checks pass; plugin and all skill validators pass.
- Both live databases were snapshotted through SQLite's backup API and passed `quick_check`. The live SpawnBox corpus contains 11,150 records at verification time; an existing Discord-plugin KB record was retrieved through the installed Codex bundle.
- The embedding sidecar started successfully through uvx, reporting `BAAI/bge-base-en-v1.5`, 768 dimensions. It remained healthy after the requesting MCP client closed.
- The seven installed hook definitions were reviewed against the generated bundle and trusted through Codex's native configuration API, using the exact hashes returned by `hooks/list`. No hook-trust bypass or approval-policy change was used.

## Practical boundaries

Native `.codex-plugin` MCP arguments in 0.153.3 do not expand `PLUGIN_ROOT` or `CLAUDE_PLUGIN_ROOT`, although hooks do. The generated startup expression resolves the exact installed cache version and preserves the project cwd. It is tied to this marketplace name; catalog renaming must regenerate that path. Tests cover the actual installed Windows loader.

Automatic retro remains disabled in Codex; explicit `retro` is available. Automatic shell-write discovery, Claude-specific failure/task-completed hooks and native subagent lifecycle parity are not claimed. File-based edits and manual capture cover independent operation. Git-backed marketplace publication, pinned remote rollback and a separate Desktop UI acceptance run remain release follow-ups; CLI/app-server acceptance is complete. Current running tasks must start a fresh task to load newly installed skills and MCP tools.

For use, configuration, update and rollback instructions, see [the package guide](../../codex/README.md). Rollback should preserve shared knowledge rather than restore a whole database over legitimate concurrent work.

The next delivery is the Discord HELP bridge, following the [accepted parity plan](./2026-09-08-discord-codex-gap-analysis.md). A tools-only Discord package is not its completion criterion. Live messages and production bot cutover have not been performed.
