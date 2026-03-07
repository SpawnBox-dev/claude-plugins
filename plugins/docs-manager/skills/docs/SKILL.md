---
name: docs
description: "After core/architectural work: create, update, or clean up project documentation using the docs-manager MCP. Use when significant systems were changed, new features were built, or architecture was modified."
---

You just finished significant work. Now handle documentation using the full docs-manager MCP toolkit.

## 1. Assess what changed

Review the work you just completed (or ask the user). Identify:
- Which systems/modules were touched
- Whether this was new architecture, a behavioral change, or a bug fix
- Whether existing docs cover these systems (check `docs/index.md` source map)

**Skip docs entirely if:** trivial fix, typo, one-line change, no conceptual shift.

## 2. Check health and staleness

Start with the big picture, then drill into specifics:

**Overall health** (periodic or after major work):
```
docs_analyze_health()           # Orphans, stubs, missing sources, unlinked docs
docs_scan_all_staleness()       # Freshness of every doc at once
docs_find_overlaps()            # Duplicate coverage across docs
docs_analyze_placement()        # Are docs in the right category folders?
```

**Single doc check** (when you know which doc is affected):
```
docs_check_staleness({ filePath: "backend/relevant-doc.md" })
docs_verify_against_source({ docPath: "backend/relevant-doc.md" })  # Compare claims vs actual code
```

**Index integrity**:
```
docs_index_reconcile()          # Find orphaned docs and stale index entries
```

## 3. Update existing docs (preferred over creating new ones)

If a doc exists and covers the system you changed:

```
docs_prepare_update({
  docPath: "backend/the-doc.md",
  sourcePaths: ["src-tauri/src/core/the-module.rs"],
  reason: "Updated X behavior in Y system"
})
```

This creates a backup and gives type-aware guidance. Then edit the doc focusing on **concepts, rationale, and gotchas** - not code mirrors.

After editing, add a history entry and update verification:
```
docs_generate_history_entry({
  title: "Updated for new behavior",
  changes: ["Changed X to Y", "Added section on Z"]
})

docs_generate_verification_notes({
  method: "code-review",
  verifiedItems: ["Function signatures", "Data flow description"],
  driftChecks: ["Check src-tauri/src/core/the-module.rs for changes"]
})
```

Finally, validate and register:
```
docs_validate({ filePath: "backend/the-doc.md" })
docs_index_apply({ operation: "add", docPath: "backend/the-doc.md", ... })  # if not already in index
```

## 4. Create new docs (only when needed)

If no doc covers a new system or major feature:

**Get naming and structure guidance first:**
```
docs_suggest_filename({ title: "My New System", type: "backend" })
docs_suggest_sections({ type: "backend", title: "My New System" })
```

**Generate the template:**
```
docs_generate_template({
  title: "System Name",
  type: "backend|frontend|architecture|api|database|datapack|guide",
  sources: ["src-tauri/src/core/new-thing.rs"]
})
```

**Extract facts from source code to populate the doc:**
```
docs_extract_source_facts({
  sourcePaths: ["src-tauri/src/core/new-thing.rs"],
  docType: "backend"
})
```

**Add diagrams where they help understanding:**
```
docs_generate_diagram({
  type: "dataflow|architecture|state|sequence",
  data: { ... }
})
```

**Write the doc, then register it in the index:**
```
docs_index_apply({
  operation: "add",
  docPath: "backend/new-doc.md",
  docTitle: "System Name",
  sources: ["src-tauri/src/core/new-thing.rs"],
  category: "Backend"
})
```

**Validate the finished doc:**
```
docs_validate({ filePath: "backend/new-doc.md" })
```

## 5. Reorganize and clean up

**Move misplaced docs:**
```
docs_move_file({ oldPath: "backend/wrong-place.md", newPath: "frontend/right-place.md" })
docs_index_apply({ operation: "move", docPath: "backend/wrong-place.md", newPath: "frontend/right-place.md" })
```

**Merge overlapping docs:**
```
docs_merge_files({
  sourcePaths: ["backend/part-1.md", "backend/part-2.md"],
  targetPath: "backend/combined.md",
  mergedContent: "..."
})
```

**Get a full reorganization report** (for major cleanup):
```
docs_reorganization_report()    # Comprehensive analysis with recommendations
```

## 6. Archive or remove obsolete docs

**Check what's archivable:**
```
docs_archive_suggest()          # Stale + unlinked candidates
```

**Archive (preserves in archive/ folder):**
```
docs_archive({ docPath: "backend/old-doc.md", reason: "superseded", supersededBy: "backend/new-doc.md" })
```

**Or update index only:**
```
docs_index_apply({
  operation: "archive",
  docPath: "backend/old-doc.md",
  archivePath: "archive/old-doc.md",
  archiveReason: "superseded"
})
```

**Remove completely** (when archive isn't warranted):
```
docs_delete_file({ docPath: "backend/trivial-doc.md", reason: "No longer relevant" })
```

**List or restore archived docs:**
```
docs_archive_list()
docs_archive_restore({ archivePath: "archive/old-doc.md" })
```

## 7. Backup management

Backups are created automatically by `docs_prepare_update`, but you can manage them manually:
```
docs_backup_file({ filePath: "backend/important-doc.md" })  # Manual backup
docs_backup_snapshot()                                        # Snapshot all docs
docs_backup_list({ filePath: "backend/important-doc.md" })   # List backups
docs_backup_restore({ backupPath: ".backups/..." })          # Restore
docs_backup_cleanup({ daysOld: 30 })                         # Clean old backups
```

## Decision guide

| Situation | Action | Key Tools |
|-----------|--------|-----------|
| Changed behavior of documented system | Update existing doc | `prepare_update`, `generate_history_entry`, `validate` |
| Built a new system/feature | Create new doc | `suggest_filename`, `generate_template`, `extract_source_facts`, `index_apply` |
| Refactored without behavior change | Check staleness, update if stale | `check_staleness`, `verify_against_source` |
| Bug fix revealed a gotcha | Update relevant doc's gotchas section | `prepare_update`, `validate` |
| Removed a system | Archive the doc | `archive`, `index_apply(archive)` |
| Periodic maintenance | Health check + cleanup | `analyze_health`, `scan_all_staleness`, `find_overlaps`, `archive_suggest` |
| Docs feel disorganized | Reorganize | `analyze_placement`, `reorganization_report`, `move_file`, `merge_files` |

## Remember
- **Concepts over code**: Doc what the code can't express (rationale, trade-offs, gotchas)
- **Reuse over recreate**: Update existing docs, don't create duplicates
- **Index is truth**: Every doc must be in `docs/index.md` - use `index_reconcile` to verify
- **Validate before committing**: Always run `docs_validate` on modified docs
- **History matters**: Use `generate_history_entry` so future readers see what changed and when
