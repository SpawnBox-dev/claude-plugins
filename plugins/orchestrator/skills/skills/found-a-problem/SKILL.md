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
