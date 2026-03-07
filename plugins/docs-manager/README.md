# docs-manager

A Claude Code plugin for AI-optimized documentation management.

## What it does

Provides MCP tools for managing project documentation with:
- **Schema validation** - frontmatter and body structure checks
- **Staleness tracking** - git-based freshness detection with trust badges
- **Template generation** - type-aware doc templates with frontmatter
- **Index management** - add, move, archive docs with atomic index updates
- **Backup & restore** - automatic backups before updates
- **Archive management** - deprecate and restore docs
- **Source verification** - compare docs against source code facts

## Skills

### `/docs`
After completing core or architectural work, run `/docs` to walk through the full documentation lifecycle: assess changes, check staleness, update or create docs, validate, and archive obsolete docs.

## Installation

```
/install-plugin https://github.com/SpawnBox-dev/claude-plugins plugins/docs-manager
```

## Configuration

The MCP server auto-detects your project type and docs folder. For custom configuration, create a `docs-manager.config.json` in your project root.

Supports env var overrides:
- `DOCS_ROOT` - path to docs folder
- `PROJECT_ROOT` - path to project root

## Requirements

- Node.js >= 18
