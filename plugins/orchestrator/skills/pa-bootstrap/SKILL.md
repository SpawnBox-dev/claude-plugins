---
name: pa-bootstrap
description: Bootstrap the PrimeAgent (PA) session. Run as the first command after pa-start.bat launches PA. Sets model/effort, confirms role=prime, reads active sessions from the SQLite agent-channel registry (agent_channel.db), verifies agent-channel is wired, and outputs a readiness status line. Idempotent.
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

**Primary signal (always present, version-independent): the role env var.**
`process.env.ORCHESTRATOR_AGENT_ROLE` (or the legacy `SPAWNBOX_AGENT_ROLE`)
is `prime` for a PA launched via `pa-start.bat`. The SessionStart context
and `getting-started` step 2 already surface this. You do NOT need to read
any file to know your role.

> NOTE: the pre-0.30.35 flat files `sessions.json` / `state.json` were
> RETIRED by the 0.30.35 SQLite migration. All agent-channel state now
> lives in the single SQLite DB
> `$CLAUDE_PROJECT_DIR/.orchestrator-state/agent-channel/agent_channel.db`
> (WAL mode). Their **absence is expected and is NOT a failure** - do not
> `cat` them and do not treat "file does not exist" as a problem.

**Authoritative confirmation (optional - use when role looks wrong or you
suspect an impostor):** query the SQLite registry directly. `sqlite3` is
available on the host:

```bash
sqlite3 "$CLAUDE_PROJECT_DIR/.orchestrator-state/agent-channel/agent_channel.db" \
  "SELECT session_id,id8,role,name,current_task FROM sessions
   WHERE (julianday('now')-julianday(last_heartbeat_at))*86400 < 90
   ORDER BY last_heartbeat_at DESC;"
```

Your role = the `role` of the row whose `session_id` equals
`$CLAUDE_SESSION_ID`. It should be `prime`.

**If role is `subordinate` despite env being correct**, you're likely
fighting an impostor MCP — another orphaned bun process from a prior
session that's heartbeating your entry with the wrong role. Diagnose:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" |
  Where-Object { $_.CommandLine -like '*orchestrator*server.js*' } |
  Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine
```

For each `bun`, walk the parent chain to find the host `claude.exe`. If a
bun's `sessions` row matches your session_id but its ancestor `claude.exe`
is launching a DIFFERENT session (e.g., the wrong `--resume <uuid>`), kill
that bun — it's an impostor. Your legitimate MCP's next heartbeat (~30s)
restores the correct entry.

Reference: anti-pattern note `120b8e59-fbef-4847-8c04-6bc7aa3ad378`
(orchestrator KB) documents the race in detail.

If no impostor exists and role is still wrong, abort and surface the
env-propagation failure (something between `pa-start.ps1` setting
`ORCHESTRATOR_AGENT_ROLE=prime` and the bun process actually reading it is
broken).

### 3. Read active subordinates

The injected `[orch] N sibling sessions active` block (UserPromptSubmit
context, every turn) and the live `<channel source="plugin:orchestrator:core">`
events already surface the active roster - read those first. For an
authoritative enumeration, reuse the step-2 query: every row from that
`sessions` SELECT with `role=subordinate` is an active SA (the
`< 90`-second heartbeat filter is already in the query).

Output a status block to terminal:

```
Currently orchestrating:
  - SA-<id8> (<name>) [task: <current_task or '(none)'>]
  - SA-<id8> (<name>) [task: ...]
```

If zero SAs active, output `No SAs currently active. Run sa-start.bat to spin one up.`

### 4. Verify agent-channel is wired

Agent-channel liveness is proven by **live evidence**, not a file read:

- Continuous `<channel source="plugin:orchestrator:core">` events arriving
  inline each turn (peer chatter, session join/depart, addressed messages).
- The injected `[orch] N sibling sessions active` block in your turn context.
- A successful `@`-addressing round-trip (you address a peer, they respond).

If any of those are present, agent-channel is functional. For a deeper
check, the step-2 `sessions` query shows your own row with a fresh
`last_heartbeat_at` (< 60s old).

**Abort ONLY if there is genuinely no agent-channel:** no inline channel
events at all AND the `sessions` query returns no self row (or `sqlite3` /
the DB file itself is missing). Do NOT abort merely because the legacy
`sessions.json` / `state.json` are absent - that absence is the EXPECTED
post-0.30.35 state, not a failure. (A literal "the flat file is gone, so
abort" reading is the exact stale-skill hazard this rewrite removes -
insight `86cc8894`.) When you do abort, surface the failure verbatim - PA
without agent-channel is useless.

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

Run a targeted lookup to load recent + high-confidence user_patterns
into your working context:

```
lookup({
  type: "user_pattern",
  limit: 25,
  output_mode: "summary",
})
```

> `output_mode: "summary"` is REQUIRED here. A raw type-only enumeration
> at this limit returns an 80-124K-char payload that exceeds the
> tool-output cap and forces a file-spill; summary mode keeps it in-band
> (id8 + truncated content per row), which is all you need to know WHAT
> exists - deep-dive a specific one later with `lookup({id})`.

Skim the returned notes and internalize them. They're the rules of
engagement for how you act on this user's behalf. The briefing's
cross_project section also surfaces some, but this explicit lookup
guarantees you're loaded.

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

```
lookup({ type: "architecture", limit: 15, output_mode: "summary" })
lookup({ type: "decision",     limit: 15, output_mode: "summary" })
lookup({ type: "convention",   limit: 10, output_mode: "summary" })
lookup({ type: "anti_pattern", limit: 15, output_mode: "summary" })
```

> `output_mode: "summary"` is REQUIRED on each (same reason as 5.5): a raw
> type-only enumeration at these limits exceeds the tool-output cap and
> forces a file-spill. Summary mode gives you id8 + truncated content per
> row - enough to know WHAT exists; pull a specific note in full with
> `lookup({id})` when an SA's work intersects it.

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
grep -i 'repo\|repository' "$CLAUDE_PROJECT_DIR/CLAUDE.md" | head -20

# docs/ may have architecture overviews
ls "$CLAUDE_PROJECT_DIR/docs/" 2>/dev/null | head
```

Also lookup architecture notes for cross-repo references:

```
lookup({
  type: "architecture",
  query: "repo OR landing OR worker OR plugin OR cross-repo",
  limit: 10,
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

Pause state lives in the SQLite DB (the `global_pause` singleton row +
the `sa_pause` table), not the retired `state.json`. Also: every channel
notification carries `pa_global_pause` / `sa_paused` meta flags, so an
active pause is visible in live evidence too. Query authoritatively:

```bash
sqlite3 "$CLAUDE_PROJECT_DIR/.orchestrator-state/agent-channel/agent_channel.db" \
  "SELECT active,since,set_by_session FROM global_pause WHERE id=1;
   SELECT sa_session_id FROM sa_pause;"
```

No `active=1` row in `global_pause` (or no row at all) = no global pause.
Any `sa_pause` rows = those specific SAs are paused. If a global pause is
active, mention it explicitly in the readiness output and ask the user if
you should clear it. Typically yes (they just spawned a fresh PA), but
their call.

### 7. Output readiness

Print:

```
PA ready (Opus 4.7, max effort). <N> SAs in orchestration.
Override state: <none|paused-on-X|global-pause>.
```

## Comms-flag convention (user-facing output)

PA emits a lot of text the user sees - readiness lines, status narration,
inner reasoning, directives aimed at SAs, and the occasional item that
genuinely needs the USER's eyes. To let the user triage at a glance, prefix
any line that is genuinely **for the user** with one of these flags:

- 🟢 **FYI** - informational; no action needed.
- 🔵 **DECISION** - a choice you've made or are recording that they should know.
- 🟠 **NEEDS-YOU** - you need an input or decision from the user to proceed.
- ✅ **DONE** - a piece of work completed and verified.
- ❓ **QUESTION** - a direct question for the user.
- 🔴 **ALERT** - something is wrong / urgent / needs attention now.

Everything else - SA coordination, status narration, thinking-out-loud -
stays **unflagged**. The flags are the user's filter for "what do I actually
need to look at," so don't over-flag: if every line carries one, the signal
is gone. Reserve them for genuinely user-directed content.

## Hard rules

- Do NOT spawn any subagents during bootstrap. PA is itself a Claude Code
  session; it doesn't need a concierge subagent (that whole pattern is
  gone in 0.29.0).
- Do NOT call any messaging tool. `send_message`, `read_messages`,
  `peek_inbox` were deleted in 0.29.0. Cross-session communication is via
  terminal output + agent-channel notifications.
- Do NOT silently recover from a genuinely insane registry. "Insane" =
  no live channel evidence AND the `agent_channel.db` `sessions` query
  returns no self row (or the DB / `sqlite3` is missing). A *missing
  legacy `sessions.json` / `state.json`* is NOT insane - it is the
  expected post-0.30.35 state. If the registry is genuinely insane,
  surface the problem to the user and ask. PA's job depends on accurate
  visibility into the project's session graph.

## On idempotency

Re-running `/pa-bootstrap` mid-session is safe:
- `/model` and `/effort` calls are no-ops if already at the target.
- The `agent_channel.db` queries in steps 2/3/6 are read-only SELECTs.
- Pause state is only modified if you choose to clear an existing global
  pause (the user's call) - never as a side effect of bootstrap.
