---
name: docs
description: "After core/architectural work: create, update, or clean up project documentation using the docs-manager MCP. Use when significant systems were changed, new features were built, or architecture was modified."
---

You just finished significant work. Handle documentation now.

**Skip entirely if:** trivial fix, typo, one-line change, no conceptual shift.

## The standard flow

### 1. What docs are affected?

Check the index source map (`docs/index.md`) for docs covering files you touched. If unsure:
```
docs_index_reconcile()          # Shows orphaned docs and stale index entries
docs_check_staleness({ filePath: "backend/the-doc.md" })
```

### 2. Update or create

**Updating an existing doc** (the common case):
```
docs_prepare_update({ docPath: "backend/the-doc.md", sourcePaths: [...], reason: "..." })
```
This backs up the doc and gives type-aware guidance. Edit the doc, then:
```
docs_generate_history_entry({ title: "Updated for ...", changes: ["Changed X", "Added Y"] })
docs_validate({ filePath: "backend/the-doc.md" })
```

**Creating a new doc** (only when nothing covers this system):
```
docs_suggest_filename({ title: "...", type: "backend" })
docs_generate_template({ title: "...", type: "backend", sources: [...] })
```
Optionally pull facts from source to populate it:
```
docs_extract_source_facts({ sourcePaths: [...], docType: "backend" })
docs_generate_diagram({ type: "dataflow", data: { ... } })
```
Then register in the index:
```
docs_index_apply({ operation: "add", docPath: "...", docTitle: "...", sources: [...], category: "Backend" })
docs_validate({ filePath: "..." })
```

### 3. Archive if you removed something

```
docs_archive({ docPath: "backend/old.md", reason: "superseded", supersededBy: "backend/new.md" })
```

## When to go deeper

These tools exist for periodic maintenance or major reorganization - not every `/docs` run:

| Need | Tool |
|------|------|
| Full health check | `docs_analyze_health()`, `docs_scan_all_staleness()` |
| Doc claims don't match code | `docs_verify_against_source({ docPath: "..." })` |
| Docs seem disorganized | `docs_analyze_placement()`, `docs_reorganization_report()` |
| Overlapping docs | `docs_find_overlaps()`, `docs_merge_files(...)` |
| Move a doc | `docs_move_file(...)`, `docs_index_apply({ operation: "move", ... })` |
| Delete a doc | `docs_delete_file(...)` |
| What's archivable? | `docs_archive_suggest()`, `docs_archive_list()` |
| Restore something | `docs_archive_restore(...)`, `docs_backup_restore(...)` |
| Manual backup | `docs_backup_file(...)`, `docs_backup_snapshot()` |
| Clean old backups | `docs_backup_cleanup({ daysOld: 30 })` |

## Principles
- **Concepts over code**: Doc what the code can't express (rationale, trade-offs, gotchas)
- **Reuse over recreate**: Update existing docs, don't create duplicates
- **Index is truth**: Every doc must be in `docs/index.md`
- **Always validate**: Run `docs_validate` on anything you touched
