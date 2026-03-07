---
name: docs
description: "After core/architectural work: create, update, or clean up project documentation using the docs-manager MCP. Use when significant systems were changed, new features were built, or architecture was modified."
---

You just finished significant work. Now handle documentation. Follow this process:

## 1. Assess what changed

Review the work you just completed (or ask the user). Identify:
- Which systems/modules were touched
- Whether this was new architecture, a behavioral change, or a bug fix
- Whether existing docs cover these systems (check `docs/index.md` source map)

**Skip docs entirely if:** trivial fix, typo, one-line change, no conceptual shift.

## 2. Check existing docs for staleness

For each system you touched, check if docs exist and whether they're stale:

```
mcp__docs-manager__docs_check_staleness({ filePath: "backend/relevant-doc.md" })
```

If unsure which docs are affected, reconcile the index:
```
mcp__docs-manager__docs_index_reconcile()
```

## 3. Update existing docs (preferred over creating new ones)

If a doc exists and covers the system you changed:

```
mcp__docs-manager__docs_prepare_update({
  docPath: "backend/the-doc.md",
  sourcePaths: ["src-tauri/src/core/the-module.rs"],
  reason: "Updated X behavior in Y system"
})
```

This creates a backup and gives you type-aware guidance. Then edit the doc to reflect what changed - focus on **concepts, rationale, and gotchas**, not code mirrors.

## 4. Create new docs (only when needed)

If no doc covers a new system or major feature:

```
mcp__docs-manager__docs_generate_template({
  title: "System Name",
  type: "backend|frontend|architecture|api|database|datapack|guide",
  sources: ["src-tauri/src/core/new-thing.rs"]
})
```

Write the doc, then register it in the index:
```
mcp__docs-manager__docs_index_apply({
  operation: "add",
  docPath: "backend/new-doc.md",
  docTitle: "System Name",
  sources: ["src-tauri/src/core/new-thing.rs"],
  category: "Backend"
})
```

## 5. Validate

Run validation on any doc you created or modified:
```
mcp__docs-manager__docs_validate({ filePath: "backend/the-doc.md" })
```

## 6. Archive obsolete docs

If your work made an existing doc obsolete:
```
mcp__docs-manager__docs_index_apply({
  operation: "archive",
  docPath: "backend/old-doc.md",
  archivePath: "archive/old-doc.md",
  archiveReason: "superseded"
})
```

## Decision guide

| Situation | Action |
|-----------|--------|
| Changed behavior of documented system | Update existing doc |
| Built a new system/feature | Create new doc |
| Refactored without behavior change | Check staleness, update if stale |
| Bug fix | Skip unless it revealed a gotcha worth documenting |
| Removed a system | Archive the doc |

## Remember
- **Concepts over code**: Doc what the code can't express (rationale, trade-offs, gotchas)
- **Reuse over recreate**: Update existing docs, don't create duplicates
- **Index is truth**: Every doc must be in `docs/index.md`
