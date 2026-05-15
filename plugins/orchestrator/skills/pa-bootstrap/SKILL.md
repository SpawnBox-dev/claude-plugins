---
name: pa-bootstrap
description: Bootstrap the PrimeAgent (PA) session. Run as the first command after pa-start.bat launches PA. Sets model/effort, confirms role=prime, reads active sessions from the SQLite agent-channel DB, verifies agent-channel is wired, and outputs a readiness status line. Idempotent.
---

# Bootstrap the PrimeAgent

This skill primes a fresh PA session for orchestration. Run it ONCE per
PA window, immediately after `pa-start.bat` launches. Idempotent - safe
to re-run.

## Steps

### 1. Set runtime config (the .bat cannot)

Run these two commands in this PA session:
- `/model claude-opus-4-7` - ensure Opus 4.7, the most capable model family for orchestration judgment.
- `/effort max` - deepest reasoning per turn.

These are per-session slash commands; the launcher .bat cannot pre-set them.

### 2. Confirm role and identity

The agent-channel state lives in SQLite under
`$ORCHESTRATOR_PROJECT_ROOT/.orchestrator-state/agent-channel/agent_channel.db`
(WAL-mode). The launchers set `$ORCHESTRATOR_PROJECT_ROOT` for you; use
that env var rather than `$CLAUDE_PROJECT_DIR` (which is not propagated
to PA sessions in current Claude Code).

Query your own session and verify `role` is `prime`. The same query
also lists every active session (used in Step 3):

```bash
python3 <<'PY'
import os, sqlite3, datetime
db = f"{os.environ['ORCHESTRATOR_PROJECT_ROOT']}/.orchestrator-state/agent-channel/agent_channel.db"
c = sqlite3.connect(db); c.row_factory = sqlite3.Row
now = datetime.datetime.now(datetime.timezone.utc)
print("=== Sessions ===")
for r in c.execute("SELECT id8, role, name, current_task, last_heartbeat_at FROM sessions ORDER BY last_heartbeat_at DESC"):
    hb = datetime.datetime.fromisoformat(r['last_heartbeat_at'].replace('Z', '+00:00'))
    age = (now - hb).total_seconds()
    status = "ACTIVE" if age < 90 else f"stale {age:.0f}s"
    print(f"[{status}] {r['id8']} role={r['role']} name={r['name']} task={r['current_task'] or '(none)'}")
PY
```

Your own row should appear with `role=prime` and a fresh heartbeat
(< 60s old). That row IS the wiring confirmation — agent-channel is
running because the MCP server is writing your heartbeat to the table.

**If role is `subordinate` despite env being correct**, you're likely
fighting an impostor MCP — another orphaned bun process from a prior
session that's heartbeating your entry with the wrong role. Diagnose
(Windows):

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" |
  Where-Object { $_.CommandLine -like '*orchestrator*server.js*' } |
  Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine
```

For each `bun`, walk the parent chain to find the host `claude.exe`. If a
bun's recent heartbeat in the DB matches your session_id but its
ancestor `claude.exe` is launching a DIFFERENT session (e.g., the wrong
`--resume <uuid>`), kill that bun — it's an impostor. Your legitimate
MCP's next heartbeat (~30s) restores the correct entry.

Reference: anti-pattern note `120b8e59-fbef-4847-8c04-6bc7aa3ad378`
(orchestrator KB) documents the race in detail.

If no impostor exists and role is still wrong, abort and surface the
env-propagation failure (something between `pa-start.ps1` setting
`SPAWNBOX_AGENT_ROLE=prime` and the bun process actually reading it is
broken).

### 3. Read active subordinates

The Step 2 query already lists every active session. SAs are rows
where `role=subordinate` and the heartbeat age is `ACTIVE` (< 90s).

Output a status block to terminal:

```
Currently orchestrating:
  - SA-<id8> (<name>) [task: <current_task or '(none)'>]
  - SA-<id8> (<name>) [task: ...]
```

If zero SAs active, output `No SAs currently active. Run sa-start.bat to spin one up.`

### 4. Verify agent-channel is wired

The MCP server should have logged `agent-channel: started as prime ...`
to its stderr when this session started. The Step 2 query already
confirms wiring — if your own row is present with a fresh heartbeat,
the MCP is running and writing.

If the query returns no row for your session_id, surface the failure
verbatim and abort - PA without agent-channel is useless.

### 5. Load PA's operating contract

Read `agents/prime-agent.md` from the orchestrator plugin (your role doc).
Internalize:

- Your fundamental identity (artificial-user) - the WHY of the role.
- When to act (PA-addressed events, situational coordination, conflict
  prevention).
- When to observe (during pauses, unaddressed dialogue, peer-to-peer
  exchanges).
- Override etiquette (per-SA vs global, slash vs natural language).
- How to use `note()` and `create_work_item()` for self-improvement
  (tags: `agent-channel-improvement, area:orchestrator-plugin`).

The path is `<orchestrator-plugin-source>/agents/prime-agent.md`. From a
typical install this resolves to either
`~/.claude/plugins/cache/<marketplace>/orchestrator/<version>/agents/prime-agent.md`
(installed cache, version-pinned) or the source repo
`<repo>/plugins/orchestrator/agents/prime-agent.md` if you have it
checked out locally.

### 5.5. Load user-pattern context (artificial-user grounding)

PA's defining duty (per prime-agent.md) is to act as an artificial
version of the user this orchestrator instance serves. The
user_pattern notes in the global DB encode that user's preferences,
work habits, communication style, decision biases, and values. They
persist across every project.

Run a targeted lookup to load recent user_patterns into your working
context. Use `output_mode: "summary"` — you need to know WHAT exists
so you can drill into specific notes later, not memorize full bodies:

```
lookup({
  type: "user_pattern",
  limit: 25,
  output_mode: "summary",
})
```

Skim the returned notes and internalize them. They're the rules of
engagement for how you act on this user's behalf. The briefing's
cross_project section also surfaces some, but this explicit lookup
guarantees you're loaded. Re-call any specific note in full mode
(`lookup({id: "<id8>"})`) when an SA's task intersects it.

If a user-pattern lookup returns zero results, that's normal for a
fresh user (first project, no patterns captured yet). Your job is then
to capture patterns as they emerge in interactions.

**Do not skip this step.** Skipping it means PA operates as a generic
orchestrator, not as an artificial-user. The whole point of PA is the
latter.

### 5.6. Load forest-view context (project macro model)

PA's second mission (per prime-agent.md) is to hold the whole-project
macro model so SAs don't make tree-level decisions that break the
forest. Load the project's architecture + recent decisions into
working context so you can apply them during SA coordination.

All four lookups use `output_mode: "summary"` — same reasoning as
5.5. You need the IDs and shapes, not the full bodies; full-mode
follow-up happens when an SA's task intersects a specific note.

```
lookup({
  type: "architecture",
  limit: 15,
  output_mode: "summary",
})
```

```
lookup({
  type: "decision",
  limit: 15,
  output_mode: "summary",
})
```

```
lookup({
  type: "convention",
  limit: 10,
  output_mode: "summary",
})
```

```
lookup({
  type: "anti_pattern",
  limit: 15,
  output_mode: "summary",
})
```

Skim each. You don't need to memorize content - you need to know WHAT
exists so you can surface specific notes by ID when an SA's work
intersects them. ("There's a convention about X - lookup({id: '...'})
before you proceed.")

Pair with the briefing's `work_items`, `open_threads`, and `cross_session`
sections (already loaded via getting-started). Together, these form
the project's working macro model in PA's context: what was decided,
what's in flight, what's open, what's been broken before, who's doing
what right now.

When an SA proposes work, your reflex check is:
- Does this conflict with a decision I know about?
- Does this duplicate a convention I know about?
- Does this walk into an anti-pattern I know about?
- Does this overlap with another SA's in-flight task?

If yes to any: surface the macro-context to the SA via channel
addressing BEFORE they proceed. That's the forest-view duty in
operation.

**Do not skip this step either.** A PA that only loads user-pattern
context but not project-macro context can act with user authority on
preferences but still let SAs break the architecture - which the user
will then have to clean up.

### 5.7. Discover multi-repo scope

"The project" is often delivered by several coordinating repos (app +
landing-page + worker + plugins + docs). Your macro model needs to
span ALL of them, not just the cwd repo. SAs that don't know about
related repos make cross-repo-breaking decisions silently.

Scan for multi-repo references:

```bash
# CLAUDE.md typically captures the project's repo structure
grep -i 'repo\|repository' "$ORCHESTRATOR_PROJECT_ROOT/CLAUDE.md" | head -20

# docs/ may have architecture overviews
ls "$ORCHESTRATOR_PROJECT_ROOT/docs/" 2>/dev/null | head
```

Also lookup architecture notes for cross-repo references:

```
lookup({
  type: "architecture",
  query: "repo OR landing OR worker OR plugin OR cross-repo",
  limit: 10,
  output_mode: "summary",
})
```

If you find references to related repos: capture the cross-repo map
into your working context. When an SA proposes work, ask "would this
change anything in repo X?" before approving.

If you find NO multi-repo references: either the project is genuinely
single-repo, OR the user hasn't documented the structure yet. In the
latter case, surface this gap to the user the next time it matters
("you mentioned the landing-page repo - is that a separate repo I
should know about?") and offer to capture the answer as an
architecture note for future sessions.

**Note:** the orchestrator MCP today reads project.db from the
session's cwd only - it does NOT auto-union project DBs across
related repos. You hold the multi-repo map in your working context
and apply it proactively.

### 6. Check for any existing global pause

Query the `global_pause` table in the agent-channel DB:

```bash
python3 <<'PY'
import os, sqlite3
db = f"{os.environ['ORCHESTRATOR_PROJECT_ROOT']}/.orchestrator-state/agent-channel/agent_channel.db"
c = sqlite3.connect(db); c.row_factory = sqlite3.Row
rows = list(c.execute("SELECT * FROM global_pause WHERE active=1"))
if rows:
    for r in rows: print("global pause:", dict(r))
else:
    print("(no global pause active)")
PY
```

If a global pause is active, mention it explicitly in the readiness
output and ask the user if you should clear it. Typically yes (they
just spawned a fresh PA), but their call.

### 7. Output readiness

Print:

```
PA ready (Opus 4.7, max effort). <N> SAs in orchestration.
Override state: <none|paused-on-X|global-pause>.
```

## Hard rules

- Do NOT spawn any subagents during bootstrap. PA is itself a Claude Code
  session; it doesn't need a concierge subagent (that whole pattern is
  gone in 0.29.0).
- Do NOT call any messaging tool. `send_message`, `read_messages`,
  `peek_inbox` were deleted in 0.29.0. Cross-session communication is via
  terminal output + agent-channel notifications.
- Do NOT silently recover from a missing/malformed agent-channel DB. If
  the state isn't sane at startup, surface the problem to the user and
  ask. PA's job depends on accurate visibility into the project's
  session graph.

## On idempotency

Re-running `/pa-bootstrap` mid-session is safe:
- `/model` and `/effort` calls are no-ops if already at the target.
- Step 2 query is read-only.
- Step 6 only modifies state if you choose to clear an existing global
  pause (the user's call).
