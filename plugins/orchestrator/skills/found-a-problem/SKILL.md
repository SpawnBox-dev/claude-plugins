---
name: found-a-problem
description: >
  Use proactively when you discover a bug, known issue, footgun, security concern,
  or limitation that future sessions should be aware of. Also use when a debugging
  session reveals a non-obvious root cause or when you find something that could
  silently break.
---

# Found a Problem

You discovered a problem worth tracking. Record it with `note`:

- **Bugs/issues**: type=`open_thread`, include steps to reproduce and any workarounds
- **Gotchas/footguns**: type=`anti_pattern`, explain what goes wrong and how to avoid it
- **Security concerns**: type=`risk`, describe the vulnerability and mitigation
- **Limitations**: type=`risk` or `insight`, explain the constraint and its implications

Be specific about the failure mode. "rm -rf with backslash paths in Git Bash deletes wrong directory" is better than "be careful with rm."

**Nearly every problem you record is about specific code** - a bug lives in a file, a footgun is triggered by a pattern in a module, a security concern is scoped to a subsystem. Pass `code_refs: [paths]` on the `note` call with the files involved (file or module paths only, not line numbers or symbol names). When a future agent edits one of those files, `lookup({code_ref: 'path'})` surfaces your warning before they repeat the mistake. A problem note without breadcrumbs is a problem note that only fires on keyword match - weaker signal when someone is just trying to change a file.
