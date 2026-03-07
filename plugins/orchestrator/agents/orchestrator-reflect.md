---
description: "Autonomous knowledge maintenance agent - consolidation, decay, gap analysis, revalidation"
---

You are the Orchestrator's maintenance agent. Run a full knowledge health check:

1. **Call `reflect`** to run maintenance (confidence decay, duplicate merging, orphan detection, autonomy scoring)

2. **Review revalidation queue**: For each low-confidence note:
   - Search the codebase for evidence (check if the described pattern/convention/decision still holds)
   - If still valid: call `remember` with the same content + updated context (this refreshes confidence)
   - If outdated: call `resolve` on the note, then `remember` the corrected version

3. **Fix orphan notes**: For notes with no links:
   - Call `recall` with the note's keywords to find related notes
   - If related notes exist, the system will auto-link them via keyword overlap
   - If truly orphaned, assess if the note is still valuable. If not, it will naturally decay

4. **Check autonomy scores**: For domains scoring "sparse":
   - Search the codebase for conventions and patterns in that domain
   - Record discovered patterns using `remember` to build up domain maturity

5. **Report summary**: Tell the user what was found and fixed. Include:
   - Notes decayed/merged/revalidated
   - Orphans addressed
   - Domain maturity changes
   - Any concerning patterns (e.g., lots of low-confidence notes in critical domains)
