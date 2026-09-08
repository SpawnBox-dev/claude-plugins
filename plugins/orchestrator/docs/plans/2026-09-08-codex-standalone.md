**Plan: standalone Orchestrator for Codex**

Prepared 2026-09-08 against orchestrator 0.69.18, repository commit `58b397f`, and installed Codex CLI 0.153.3. Accepted design; standalone implementation is now locally installed. See [delivery evidence and remaining boundaries](./2026-09-08-codex-delivery.md). The implementation checklist below records the original target, not a claim that every release path has been exercised.

The target is a Codex session that works independently, without a PrimeAgent, while using the existing project's knowledge, user preferences, work items, retrieval, maintenance, and checkpoints. Claude Code remains a supported host with its current behavior. Live messaging, PA/SA coordination, permission relaying, launchers, and the context warden are outside this delivery.

**Architecture and package boundary**

Keep one implementation of the knowledge engine. Add an explicit runtime profile, with the existing Claude behavior as the backward-compatible default and an explicitly selected Codex standalone profile. Resolve the profile before module initialization performs process inspection, file writes, cleanup, or background startup. Do not infer it from whichever inherited environment variable happens to exist.

Build a separate, self-contained Codex package in the same repository. This is packaging isolation, not a fork of the engine:

```text
claude-plugins/
  .claude-plugin/marketplace.json       existing Claude catalog
  .agents/plugins/marketplace.json     new Codex catalog
  plugins/
    orchestrator/                     existing Claude package and shared source
      .claude-plugin/plugin.json
      .mcp.json
      hooks/hooks.json
      mcp/runtime/                    proposed runtime profiles/adapters
      mcp/server.ts
      dist/server.js
      scripts/build-codex.*            proposed deterministic packaging helper
      codex/                          authored Codex skills/config templates
    orchestrator-codex/                generated installable Codex package
      .codex-plugin/plugin.json
      .mcp.json
      package.json
      dist/server.js
      hooks/hooks.json
      hooks/session-start.*
      skills/
      sidecar/
```

Use `orchestrator-codex` as the proposed Codex package identifier and `spawnbox-dev-codex-plugins` as its marketplace identifier. Preserve the existing Claude identifiers. The Codex catalog initially lists only this package; porting docs-manager is separate work.

A separate package avoids default discovery of the Claude package's hooks, PA skills, agents, and launchers. All runtime dependencies must be inside the installed package or declared prerequisites; nothing may depend on a sibling source folder remaining present after installation. Generated files must not be maintained by hand.

**Capabilities to deliver**

| Capability | Intended Codex behavior |
| --- | --- |
| Knowledge retrieval | Keyword, semantic, ID, history, graph, and code-reference lookup; prior-art checks and task context preparation. |
| Knowledge capture and maintenance | Notes, decisions, conventions, anti-patterns, updates, append operations, supersession, deletion, thread closure, deduplication, and revisions through the existing tools. |
| Work model | Create/list/update/break down work items, priorities, due dates, and open threads. A session task declaration records local context without advertising fleet participation. |
| User model | Existing profile and preference tools against the selected global store. |
| Continuity | Startup/resume briefing, progress checkpoints, turn bridge, and context restoration after compaction. |
| Context at the time of an action | File-specific prior knowledge, work-item drift, edited-file tracking, and bounded reminders when relevant. |
| Maintenance | Curation candidates, explicit retro, signal/temperature behavior, and automatic maintenance where concurrent execution is proven safe. |
| Embeddings | Reuse the existing local sidecar with model/dimension checks and keyword fallback. |
| Diagnostics | Report host, standalone mode, package/runtime versions, resolved storage roots, session binding, hook delivery evidence, and embedding state. |

Standalone output must contain no instructions to contact PA, send channel envelopes, inspect Claude transcripts, launch agents, repair the Claude fleet, or grant authority to another agent. Review initialization instructions, tool descriptions, tool outputs, hooks, and skills; filtering skills alone is insufficient.

**1. Establish the compatibility baseline and release contract**

- Record the starting commit, tool schemas, Claude hook wiring, package identifiers, and generated-bundle behavior.
- Run the existing typecheck, build, and full suite in an isolated checkout with fixture storage. Identify tests that consult real home/project state before running them. The earlier analysis ran only three focused files: 150 tests passed; that is not a full-suite baseline.
- Exercise the current Claude package through a disposable stdio client and fixture databases. Retain expected initialization capabilities, tool availability, hook envelopes, and representative memory operations as regression evidence.
- Verify Codex's installed loader behavior for a local marketplace, namespaced MCP tool hooks, native Windows startup, and default component discovery. Also verify Git-backed installation later; it is a separate path.
- Reconcile the bundled plugin validator with the installed loader: the local authoring reference currently contradicts itself about a manifest `hooks` field. Use the documented default `hooks/hooks.json` layout and validate the actual installed artifact.

Completion evidence: a reproducible baseline, explicit supported host versions, and a package layout that both loaders interpret as intended.

**2. Introduce the standalone runtime profile without changing Claude defaults**

- Add a small runtime configuration boundary with a proposed explicit selector such as `ORCHESTRATOR_HOST=codex` and `ORCHESTRATOR_MODE=standalone`. The Codex package sets both at launch. Absence retains today's Claude behavior.
- Gate channel capability declarations, AgentChannel construction, permission relay registration, Claude process ancestry, duplicate-MCP reaping, transcript watching, fleet diagnostics, and fleet state garbage collection before they run.
- Keep shared tool handlers and database logic; avoid a broad rewrite of the large server module merely to create aesthetically separate hosts. Extract only the seams needed for safe initialization and host-specific behavior.
- Make diagnostics and cleanup host-aware. Codex shutdown closes its transport and owned resources, without editing the Claude registry or killing another host's process.
- Separate channel/fleet sections from useful historical cross-session knowledge. Prior notes remain available, but the Codex session does not claim membership in the PA/SA roster. Turn-bridge and action tracking must resolve the installed tool namespace rather than depend on the hardcoded Claude tool prefix.

Completion evidence: Codex initialization exposes the expected knowledge/work tools and no Claude channel capabilities; starting, using, and stopping it changes no fixture Claude fleet state. The Claude baseline still passes unchanged.

**3. Bind storage, sessions, and embeddings explicitly**

- Reuse SpawnBox's canonical `.orchestrator/project.db` and the existing global database once isolated validation passes. Do not duplicate the knowledge corpus or relocate existing Claude data as part of this port.
- Add an optional explicit global-store override while preserving the existing default. Keep all test stores outside the real home and project databases.
- Distinguish the canonical knowledge root from the current checkout root. `ORCHESTRATOR_PROJECT_ROOT` remains the knowledge-root override; introduce an explicit working-tree root for file checks if necessary. Reject accidental storage under either host's plugin cache. Use project configuration/environment, not hardcoded Jarid paths in the distributable package.
- Take session identity from verified Codex runtime information and lifecycle payloads. `CODEX_THREAD_ID` is present in this session's shell, but its propagation to plugin MCP processes must be measured. Keep authoritative process identity separate from per-call attribution. Never borrow the Claude `active-session` file or bind identity from the first arbitrary tool argument.
- Verify whether MCP connections are per task or reused. If reused, implement request-scoped identity; do not cache one task ID for all callers. Make missing identity explicit and reject attributed mutations that cannot be safely bound while leaving safe retrieval available.
- Namespace Codex transient state and checkpoint selection so resuming a Codex task cannot silently pick up an unrelated Claude session's checkpoint. Preserve broader project checkpoints as explicitly identified historical context. Avoid incompatible changes to existing session-ID and source-attribution formats.
- Preserve the shared embedding sidecar's existing model (`bge-base-en-v1.5`, 768 dimensions), stable discovery location, and startup lock. Keep Claude fleet orphan-reaping scripts out of the Codex package. Validate ownership before stopping any sidecar and prevent duplicate startup/download behavior.
- Test simultaneous maintenance against shared stores. Do not independently reset the existing retro cadence. If safe automatic coordination would require a broader change to all hosts, ship Codex with explicit retro and curation first, reporting automatic retro as deferred; do not claim a Codex-only lock coordinates older Claude processes.

Completion evidence: two Codex tasks have distinct attribution and checkpoints; restart/resume preserves the right context; a worktree reaches the intended corpus; Claude and Codex can read/write fixture knowledge concurrently without corrupting history or duplicating maintenance; sidecar fallback remains usable.

**4. Adapt useful lifecycle hooks end to end**

Use a Codex-specific event adapter and output serializer. Reuse applicable domain logic, but do not feed unsupported events or Claude-shaped fields through blindly.

| Codex event | Planned behavior and constraint |
| --- | --- |
| SessionStart: startup/resume/clear | A cross-platform command parses stdin JSON and injects concise startup instructions and identity. Do not depend on an MCP connection already being ready. A first-use tool/skill fallback performs the briefing once ready. |
| UserPromptSubmit | Restore the turn bridge, relevant context, and bounded capture/maintenance prompts. |
| PreToolUse | Normalize canonical tool names and patch contents; surface applicable prior knowledge before edits. |
| PostToolUse | Track completed edits, work drift, task activity, and bridge actions. Inspect actual failures; a nonzero shell result is not a success. |
| SessionStart: compact | Restore a concise checkpoint and relevant task context using Codex's model-visible output contract. |
| PreCompact/PostCompact | Persist deterministic available state and compaction markers; do not assume the model gets an extra tool-calling turn before compaction. |
| Stop | Ask for useful progress capture and curation when needed, with an explicit retry limit and degraded behavior when MCP is unavailable. No unconditional continuation loop. |
| SessionEnd | Short best-effort cleanup of owned state only; no model-generated summary or long maintenance job. |

Implement multi-file patch parsing, including add/delete/rename paths, with normalized repository-relative code references. Matcher aliases are insufficient: Codex reports `apply_patch` and patch text, while the old handler reads a single `file_path`. Deliver and record each affected file without flooding context. Do not claim comprehensive tracking of arbitrary file writes hidden inside shell commands; retain the explicit lookup/capture workflow for those paths.

Translate nonzero shell exit results from PostToolUse into applicable failure tracking. Defer Claude-only StopFailure and TaskCompleted parity. Native subagent hooks are optional follow-up scope, not a dependency of standalone operation.

Verify actual model-visible delivery, not merely JSON validity or UI warnings. In particular, `systemMessage` is not a substitute for additional model context. Hooks must not rely on unavailable tools to recover from their own failures. Expose counters for attempted, delivered, suppressed, and failed context where feasible so silence can be distinguished from a disconnected hook.

Completion evidence: a fixture note for a file appears before a real Codex patch, both files in a multi-file patch are recorded, a failed command exercises failure handling, and compaction/resume restores the correct checkpoint. Missing/untrusted hooks leave manual tools usable. Verify the same path through nested code-mode calls used by the app.

**5. Package the Codex workflows and marketplace**

- Adapt getting-started, orchestrating, every-turn, planning-approach, learned-something, made-a-decision, found-a-problem, something-went-wrong, what-was-decided, user-preference, closing-a-thread, and wrapping-up. Keep direct MCP workflows concise; remove concierge and PA dependencies.
- Exclude pa-bootstrap/pause/resume/takeover, sa-launch, install-launchers, consult-concierge, and Claude agent declarations. Convert the useful knowledge-maintenance procedure into a direct skill invoking existing tools.
- Supply server-wide instructions that describe standalone behavior accurately. Package installation should make the tools useful without requiring a giant copied CLAUDE.md. A small SpawnBox AGENTS.md pointer can provide project-specific guidance if desired; it must not import obsolete PA/channel instructions wholesale.
- Generate the new package deterministically from shared source and authored Codex templates. Bundle runtime code and all sidecar resources; declare Bun and optional Python/uv requirements and verify Windows launch quoting. Prefer direct Bun when available over an unpinned package fetched on every boot.
- Add the repo Codex catalog through the authoring helper, using `policy.installation=AVAILABLE`, `policy.authentication=ON_INSTALL`, and `category=Productivity`. These are catalog metadata, not enforcement of arbitrary project rules. Preserve the Claude catalog and docs-manager entry.

Completion evidence: installing only the generated package in a clean test location exposes the intended skills/tools and no Claude-specific components; removing or relocating the source repo does not break the installed runtime.

**6. Validate, release, install, and prove continuity**

Extend the existing build/version governance rather than replacing it. Keep one canonical release version, propagate it to both host packages and the applicable catalogs, and verify the MCP-reported version matches the installed package. Generated Codex package metadata must support the server's existing package.json version lookup. Apply local Codex cachebuster suffixes only to the generated Codex artifact, never to Claude's manifests or the shared canonical version.

Add release checks for both generated bundles, their source/artifact correspondence, required sidecar files, template/package consistency, manifest/version parity, and unchanged Claude component discovery. Preserve the requirement to rebuild checked-in dist artifacts whenever shared runtime source changes. Do not extend the Claude hot-deploy script to overwrite Codex caches; use Codex installation commands for Codex adoption.

Validation order:

1. Existing Claude tests and disposable Claude protocol baseline.
2. Adapter tests with realistic Codex event fixtures, including known-broken positive controls.
3. Built Codex stdio initialization, tool enumeration, capture, retrieval, revision, and checkpoint tests using temporary databases.
4. Native Codex CLI/app installation and lifecycle checks in a disposable project; test hook trust and startup races.
5. A disposable Git marketplace installation, update, pinned-ref rollback, and fresh-task pickup test. Marketplace refresh and installed-runtime adoption are separate things to prove.
6. A SQLite-aware consistent backup of the existing knowledge stores, followed by the first SpawnBox Codex session and a concurrent Claude smoke test. Do not copy an active DB file alone while ignoring WAL state.

The final acceptance scenario is: install from the repo marketplace, open a fresh Codex SpawnBox task, receive a briefing, retrieve a known decision, surface known context before a patch, capture a new finding, update a work item, save progress, and recover the right checkpoint after compaction and a later task. Throughout this sequence, Claude continues to use its existing memory tools and fleet without a changed launcher, lost registration, altered permission behavior, or process termination.

Rollback removes/disables the Codex plugin and returns to the previous package ref. Preserve knowledge created by both hosts; restoring a whole database would erase legitimate concurrent work and is not routine plugin rollback. Prefer no knowledge-schema changes for this port; if unavoidable, require additive backward-compatible migrations and a separate rollback review.

**Marketplace and governance correspondence**

Codex provides repo/personal catalogs, package manifests, installed caches, Git-backed sources with ref pinning, and CLI operations to add, refresh, install, and remove plugins. It also has hook-definition trust, host permissions, tool policies, and managed requirements. This is sufficiently close to retain the repository's third-party marketplace delivery model, although it is not an identical implementation of Claude's installer.

After the proposed catalog exists, local development would use:

```powershell
codex plugin marketplace add 'C:\Users\Jarid\OneDrive\AppDev\claude-plugins'
codex plugin add orchestrator-codex@spawnbox-dev-codex-plugins
```

After the Codex package/catalog has been released to the existing remote, a separate Git-backed install would use:

```powershell
codex plugin marketplace add SpawnBox-dev/claude-plugins --ref main
codex plugin add orchestrator-codex@spawnbox-dev-codex-plugins
```

Choose one source for that marketplace identifier; do not register local and Git copies under the same name concurrently. Use an actual release tag instead of main where a pinned rollout is wanted. To adopt an update from a tracked Git source, refresh the marketplace snapshot, reinstall the plugin, and verify it in a fresh task. Confirm the exact sequence against the installed version during phase 6; do not assume refreshing the catalog hot-swaps a running MCP process.

Hook trust is independent of package installation. Current Codex requires review/trust for new or changed non-managed hook definitions. Document the app's supported review UI and the CLI `/hooks` flow; do not bypass trust in the installer. The plugin preserves the host's current permissions and approval policy. It does not import the Claude launcher's bypass flags or PA permission relay.

Implementation order is 1 through 6. A tools-and-skills preview can be tested after phases 2, 3, and 5; it must clearly advertise reduced automatic hooks. The intended usable release includes phase 4 and the phase 6 acceptance scenario. No app-server bridge, background PA, or agent messaging work is required.

**Evidence and references**

Source anchors: `mcp/server.ts` (initialization, identity, tools, sidecar, fleet lifecycle); `mcp/tools/hook_event.ts` and `hooks/hooks.json` (event payloads/output); `mcp/db/connection.ts` (storage); `mcp/tools/orient.ts` (briefings/maintenance); `mcp/engine/agent_channel_state.ts` (fleet state); `mcp/engine/embeddings.ts` (model contract); `CLAUDE.md` (existing release requirements); `docs/DESIGN-PRINCIPLES.md` (capture/maintenance/retrieval invariants).

Official references checked 2026-09-08: [plugin packaging and marketplaces](https://developers.openai.com/plugins/build/plugins), [hooks and trust](https://learn.chatgpt.com/docs/hooks), [local MCP support](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). Installed CLI help confirmed `plugin add`, `plugin marketplace add --ref`, and `plugin marketplace upgrade`; these commands were inspected, not used to install anything.
