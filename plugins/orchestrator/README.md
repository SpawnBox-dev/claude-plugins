# Orchestrator

A Claude Code plugin that acts as a persistent product co-pilot. Learns your project and you. Makes every agent interaction better.

## Architecture

Orchestrator maintains three evolving models across sessions:

- **Product model** - Systems, architecture, dependencies, conventions, anti-patterns
- **User model** - Intent patterns, decision style, strengths, blind spots
- **Work model** - In-flight items, commitments, decisions, neglected areas

Everything is stored in a SQLite database with FTS5 full-text search. Notes are linked into a knowledge graph with typed relationships (depends_on, conflicts_with, supersedes, etc.) and scored by relevance using recency, access frequency, and confidence decay.

### Five MCP Tools

| Tool | Purpose |
|------|---------|
| `orient` | Session startup briefing - open threads, recent decisions, drift warnings, onboarding detection |
| `remember` | Persist knowledge - decisions, patterns, recipes, anti-patterns, conventions |
| `recall` | Query the knowledge graph with progressive disclosure (summary first, detail on demand) |
| `prepare` | Curated context package for tasks and subagent hydration (conventions, gates, anti-patterns) |
| `reflect` | Knowledge maintenance - consolidation, confidence decay, gap analysis, deduplication |

### Engine

The engine layer handles the intelligence behind the tools:

- **Scorer** - Ranks notes by relevance (recency, access frequency, keyword overlap, confidence)
- **Linker** - Discovers and maintains relationships between notes
- **Deduplicator** - Detects near-duplicate notes and merges or supersedes them
- **Composer** - Assembles context packages with the right density for the task

## How It Works

1. **Session start** - A hook fires automatically, calling `orient` to produce a briefing: open threads, recent decisions, neglected areas, and drift warnings. First-run sessions trigger onboarding detection.

2. **During work** - The orchestrating skill guides Claude to `remember` decisions, patterns, and commitments as they happen. `recall` surfaces past context proactively. `prepare` hydrates subagents with conventions, quality gates, and anti-patterns before they start work.

3. **Maintenance** - `reflect` runs periodically (via the `/reflect` command or the reflect agent) to consolidate redundant notes, decay stale confidence scores, and identify gaps in coverage.

## Quick Start

### Install

```
/install-plugin /path/to/orchestrator-plugin
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

## Development

```bash
# Type check
bun run typecheck

# Run tests
bun test

# Start MCP server (stdio)
bun run dev
```
