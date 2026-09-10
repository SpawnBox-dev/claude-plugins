# Orchestrator for Codex

Persistent project knowledge, work tracking, preferences and continuity for an independent Codex task. This package shares the Orchestrator knowledge engine with Claude Code. It does not require a PrimeAgent.

## Install and use

Requires Bun 1.3 or later and Codex 0.153.3 or later. The native loader and lifecycle path were verified on Windows with 0.153.3; newer versions should run the native smoke test before rollout.

From the marketplace repository root:

```powershell
codex plugin marketplace add .
codex plugin add orchestrator-codex@spawnbox-dev-codex-plugins
```

Review the seven installed hook definitions in Codex's `/hooks` view. Installation and hook trust are separate. Start a fresh Codex task in the project, then use `system_status` and `briefing`. The manual tools remain useful while hooks are untrusted. The plugin does not alter the host's approval or sandbox settings.

The tools support note capture, lookup by search/ID/code reference, revisions, supersession, thread closure, work items, preferences, explicit maintenance and task-scoped checkpoints. Native hooks provide startup context, prompt retrieval, file context, work-item reminders, failure nudges, bounded progress capture, and compaction recovery. Shell writes cannot all be inferred; explicitly capture important work performed through shell scripts.

## Storage and worktrees

By default, knowledge lives in the current project's `.orchestrator/project.db`. Global knowledge and preferences share `~/.claude/orchestrator/global.db`. Existing Claude data is not moved. `ORCHESTRATOR_GLOBAL_DB` selects another global store.

Explicit `scope=project` is honored for every note type in Codex, including
tool_capability and user_pattern, and does not write the global user model.
When scope is omitted those two types retain their legacy global defaults.
Inline supersedes retain the original note's scope, and plan includes current
project capabilities alongside global ones. Claude's existing type routing is
unchanged. Use explicit project scope for project-specific evidence.

For an isolated checkout that should use another project's corpus, create `.orchestrator/codex.json` in that checkout:

```json
{"knowledgeRoot":"C:/path/to/canonical/project"}
```

`ORCHESTRATOR_PROJECT_ROOT` overrides the knowledge root; `ORCHESTRATOR_WORKTREE_ROOT` overrides the checkout used for file checks. Project configuration resolves relative paths from the checkout. Cache directories are rejected as knowledge roots. Take a SQLite backup before first adoption of an existing corpus; `scripts/backup-kb.py` in the source package preserves a consistent WAL snapshot.

Codex supplies `_meta.threadId` on MCP calls. State and checkpoints use a `codex-` namespace. Missing identity rejects attributed writes. The plugin does not guess another task's identity from Claude state or an arbitrary tool argument.

## Embeddings

The optional local Python sidecar uses `BAAI/bge-base-en-v1.5`, 768 dimensions. Install `uv` for automatic environment setup, or install the packaged `sidecar/requirements.txt` into the Python environment used by the host. Codex reuses the shared sidecar only after checking its model and vector width. An incompatible live service is preserved; keyword retrieval remains available. `ORCHESTRATOR_EMBEDDINGS=off` disables automatic startup. `install_embeddings` retries setup.

Automatic retro is disabled in Codex because an independent lock cannot coordinate older Claude maintenance processes. Use `retro` explicitly. Claude launchers, channels, permission relay and fleet processes retain their existing behavior.

## Packaging and updates

Edit shared source and the authored `codex/` templates in `plugins/orchestrator`, then run:

```powershell
bun run typecheck
bun run build
bun run build:codex
bun run check:codex
bun run test:codex
bun run test:codex-native
```

The native test installs into an isolated Codex home and uses a deterministic local Responses fixture. It exercises real host behavior without model credentials, Discord access or the live corpus. Set `CODEX_EXECUTABLE` to the native executable when `codex` resolves to a shell wrapper. Run the complete existing test suite with fixture home/project paths before release. `npm ci --ignore-scripts` is the tested fallback when Bun leaves an incomplete Windows dependency tree.

The canonical release version remains aligned across the shared package, Claude manifest and Claude catalog. A Codex development cachebuster belongs only on the generated Codex manifest; rebuild after changing it so the runtime package and startup path match, then reinstall through `codex plugin add`. Rebuild checks detect stale bundles, templates and metadata. Refreshing a marketplace does not update an already running task's MCP process.

Codex 0.153.3 expands plugin paths for hooks but does not expand `PLUGIN_ROOT` in native `.mcp.json` arguments. The generated launcher resolves the exact version under the named marketplace's installed cache while preserving the project's working directory. It never selects the newest directory by timestamp and needs no source checkout at runtime. Keep the marketplace name `spawnbox-dev-codex-plugins`; a renamed catalog requires a corresponding launcher rebuild. This compatibility shim can be removed when native MCP path expansion is verified.

To roll back, reinstall a previous package version or disable this plugin. Preserve knowledge written by both hosts; a whole-database restore is not routine package rollback. The current delivery has been validated through local installation; remote Git publication and production Discord cutover are separate steps.
