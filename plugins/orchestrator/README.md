# Orchestrator

A Claude Code plugin that acts as a persistent product co-pilot. Learns your project and you. Makes every agent interaction better.

## Architecture

Orchestrator maintains three evolving models across sessions:

- **Product model** - Systems, architecture, dependencies, conventions, anti-patterns
- **User model** - Intent patterns, decision style, strengths, blind spots
- **Work model** - In-flight items, commitments, decisions, neglected areas

Everything is stored in two SQLite databases (project-scoped + global) with FTS5 full-text search and vector embeddings for semantic retrieval. Notes are linked into a knowledge graph with typed relationships (depends_on, conflicts_with, supersedes, etc.).

### Search & Retrieval

Hybrid search combines two paths:

- **FTS5 BM25** - keyword matching with weighted fields (keywords 2x, content 1x, context 0.5x)
- **Vector cosine similarity** - 1024-dimensional embeddings via ONNX bge-m3 sidecar

Results are merged via **Reciprocal Rank Fusion** (RRF), then diversified with **Maximal Marginal Relevance** (MMR) to prevent similar notes from clustering. **ANTS** (Adaptive Note Temperature System) gives a signal boost to frequently-accessed notes.

When the embedding sidecar is unavailable, search degrades gracefully to FTS5-only.

### Embedding Sidecar

A Python HTTP server (`sidecar/embed_server.py`) runs the ONNX bge-m3 model locally on CPU. Managed automatically:

- Spawned via `uvx` on MCP server startup (handles Python env + deps)
- Falls back to direct `python`/`python3` if uvx unavailable
- Model cached after first download (~1.5GB from HuggingFace)
- Health check: `GET /health` - Embed: `POST /embed`
- Graceful degradation: if sidecar doesn't start, all features work via FTS5

### Session Tracking

Cross-session awareness via `session_log` and `session_registry` tables:

- Tracks which notes were surfaced in each session
- Annotates search results: `[already sent N turn(s) ago]`, `[sent to N other session(s)]`
- In-memory per-session turn counters for progressive disclosure
- 7-day cleanup for stale sessions

### MCP Tools

| Tool | Purpose |
|------|---------|
| `briefing` | Session startup briefing - open threads, recent decisions, work items, user profile, drift warnings |
| `note` | Persist knowledge - decisions, patterns, anti-patterns, conventions. Auto-embeds, auto-links, dedup-checks |
| `lookup` | Query the knowledge graph with hybrid search (FTS5 + vector). Supports session_id for dedup tracking |
| `plan` | Curated context package for tasks and subagent hydration |
| `check_similar` | Find prior art before implementing - semantic similarity against decisions/conventions/anti-patterns |
| `system_status` | Health check - note counts, embedding coverage, sidecar status, active sessions |
| `install_embeddings` | First-run setup - detect/install Python and uv dependencies for embedding support |
| `save_progress` | Checkpoint for next session - what was done, open questions, next steps |
| `close_thread` | Resolve an open thread with cascade |
| `update_note` | Modify note content/tags/confidence in place. Re-embeds on content change |
| `delete_note` | Remove wrong/outdated knowledge |
| `user_profile` | View/set/remove structured user observations by dimension |
| `create_work_item` | Track a concrete task with priority and optional due date |
| `update_work_item` | Change status/priority/content/due date/tags/context/confidence (cascades on status=done) |
| `breakdown` | Split complex work into parent + children work items |
| `retro` | Knowledge maintenance - consolidation, signal decay (ANTS), gap analysis, dedup |
| `list_open_threads` | List all open threads with status and signal |
| `list_work_items` | List work items filtered by status/priority |

### Engine

The engine layer handles the intelligence behind the tools:

- **Hybrid Search** (`hybrid_search.ts`) - Cosine similarity, RRF fusion, MMR diversity, ANTS signal boost
- **ANTS Signal** (`signal.ts`) - Adaptive Note Temperature System: pheromone-inspired signal deposit/decay, vacation-safe (14-day cap)
- **Embeddings** (`embeddings.ts`) - Sidecar client, embed on insert/update, batch backfill, graceful fallback
- **Session Tracker** (`session_tracker.ts`) - Session registration, surfacing log, cross-session annotations, cleanup
- **Scorer** - Ranks notes by relevance (recency, access frequency, keyword overlap, confidence)
- **Linker** - FTS5 search + hybrid search path, auto-links notes by keyword overlap
- **Deduplicator** - Jaccard similarity (0.6 threshold) at insert time, batch merge in retro
- **Composer** - Assembles briefings with context budgeting

### Memory Concierge

An Opus/Sonnet subagent (`agents/memory-concierge.md`) that curates knowledge retrieval:

- Invoked via `orchestrator:consult-concierge` skill for complex/broad queries
- Resumed across turns to maintain knowledge state (knows what it already told you)
- Progressive disclosure: top 3 on first query, deeper cuts on follow-ups
- Detects context compaction and proactively refreshes critical knowledge
- Cross-session awareness: highlights discoveries from other active sessions
- Sonnet for routine queries, Opus for complex judgment (contradiction detection, cross-domain synthesis)

## How It Works

1. **Session start** - A hook fires automatically, calling `briefing` to produce a briefing. If embeddings are inactive, the briefing includes setup guidance.

2. **During work** - The `orchestrating` skill guides agents to `lookup` (simple queries) or `consult-concierge` (complex queries) before acting. `note` captures decisions, patterns, and commitments with auto-embedding and similarity alerting. `check_similar` catches prior art before implementing.

3. **Session tracking** - Every `lookup` with a `session_id` logs which notes were surfaced, enabling dedup annotations (`[already sent N turn(s) ago]`) and cross-session awareness.

4. **Session end** - The Stop hook prompts for `save_progress` and knowledge capture. Notes are classified by type with specific guidance (decisions, conventions, anti-patterns, user preferences).

5. **Maintenance** - `retro` runs periodically to consolidate duplicates, decay stale confidence, and identify gaps.

## Quick Start

### Install

```
/plugin marketplace add SpawnBox-dev/claude-plugins
/plugin install orchestrator
```

### Bootstrap

Run the `/orchestrator-init` command to bootstrap the knowledge graph from your project's existing CLAUDE.md and documentation.

### Start working

The plugin activates automatically. The session-start hook orients Claude on every new conversation. The orchestrating skill ensures knowledge is captured and surfaced throughout your work.

### Slash Commands

| Command | Purpose |
|---------|---------|
| `/orchestrator-init` | Bootstrap knowledge graph from existing project docs |
| `/status` | Show knowledge graph stats and health |
| `/knowledge` | Browse and search stored knowledge |
| `/reflect` | Trigger maintenance - consolidation, decay, gap analysis |

### Embedding Setup

Embeddings enable semantic search (finding notes by meaning, not just keywords). On first run:

1. The plugin tries to start the embedding sidecar automatically
2. If Python/uv aren't installed, it logs guidance and degrades to keyword-only search
3. Call `install_embeddings` tool to check/install dependencies
4. Call `system_status` to verify embedding coverage

Requirements: Python 3.10+ and uv (auto-installed via `pip install uv` if Python is available).

## Development

```bash
# Type check
bun run typecheck

# Run tests (114 tests)
bun test

# Build (bundles to dist/server.js)
bun run build

# Start MCP server (stdio)
bun run dev
```

## File Structure

```
orchestrator-plugin/
  .claude-plugin/plugin.json    # Plugin metadata + version
  .mcp.json                     # MCP server config
  mcp/
    server.ts                   # MCP tool registrations, sidecar lifecycle
    types.ts                    # Note types, dimensions, interfaces
    utils.ts                    # Keyword extraction, formatting, IDs
    db/
      connection.ts             # Project + global DB connections
      schema.ts                 # 10 migrations (notes, FTS5, embeddings, sessions)
    engine/
      embeddings.ts             # Sidecar client (EmbeddingClient, blobToVector)
      hybrid_search.ts          # Cosine, RRF, MMR, activation boost
      session_tracker.ts        # Session log, registry, annotations
      composer.ts               # Briefing assembly
      deduplicator.ts           # Jaccard similarity, merge duplicates
      linker.ts                 # FTS5 search, hybrid search, auto-linking
      signal.ts                 # ANTS: Adaptive Note Temperature System - deposit, decay, vacation protection
      scorer.ts                 # Confidence decay, promotion
    tools/
      orient.ts                 # Briefing handler
      remember.ts               # Note insert with embedding + similarity alert
      recall.ts                 # Search with session annotation
      prepare.ts                # Context package for subagent hydration
      reflect.ts                # Maintenance handler
      check_similar.ts          # Similarity check handler
  sidecar/
    embed_server.py             # Python ONNX embedding server
    requirements.txt            # Python deps
  agents/
    memory-concierge.md         # Concierge agent definition
    orchestrator-reflect.md     # Reflect agent definition
  skills/                       # 13 skills for orchestrated workflow
  hooks/                        # Session lifecycle hooks (start, stop, compact, submit)
  commands/                     # Slash commands
  tests/                        # 114 tests across 14 files
  dist/
    server.js                   # Bundled MCP server (~0.76 MB)
```
