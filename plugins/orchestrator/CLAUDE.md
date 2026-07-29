## Orchestrator Plugin

You are an orchestrator first, and a coding assistant second.

### 🚨 BUILD GATE - read before touching this plugin

**`.mcp.json` runs `dist/server.js`, NOT `mcp/server.ts`.** dist/server.js is the bundled artifact that ships to users via the marketplace; it is checked into git and consumed by `/plugin install` / `/plugin update`.

**If you change anything under `mcp/`, you MUST run `bun run build` before committing.** If you commit source-only without rebuilding dist, the runtime keeps executing the old bundle forever - no /plugin update or session restart will pick up your changes. This trap cost the v0.29.x rollout: every commit from 0.29.0 through 0.29.3 was decorative because dist/server.js wasn't rebuilt; users running `/plugin update` got new docs but the same Apr-28 bundle.

**Verification:**
```bash
bun run typecheck && bun run build && bun test
git status -s dist/server.js  # should show 'M' if you changed any mcp/* file
```

If the M flag isn't there after a source change, you forgot to rebuild. Do not commit until dist/server.js is in the staged changeset.

**Automated backstop:** `tests/dist-freshness.test.ts` FAILS in the suite when `dist/server.js` is older than the newest `mcp/` source file - so a stale bundle can no longer pass `bun test` and reach a commit. If that test fails, the fix is always `bun run build` (risk `206a0af3`: this exact staleness made 0.30.56-0.30.65's code inert at runtime for a month; caught by a code-reviewer on a flap-code change).

### Do not write files through a shell heredoc in this environment

**Use `Write` for new files and `Edit` for changes. Not `python - << 'PY'`, not `cat > file << 'EOF'`.**

This is a tooling rule earned four times in one session (2026-07-28), each time costing more than the defect being fixed:

- A Python heredoc **truncated `orient.ts` to 0 bytes** - `io.open(p,"w")` truncates before the `UnicodeEncodeError` fires on a lone surrogate, so the failure destroys the file and then reports.
- A collapsed `\\` -> `\` made TypeScript read `\r` as a control character and "proved" a `normalizeCodeRef` bug **that did not exist** - real reasoning time spent chasing a defect the tooling invented.
- `lines.join("\n")` in an anchor string arrived as a literal newline, so the match silently failed.
- The same collapse twice more inside `.split("\n")`, producing unterminated string literals in a test file.

**Why it is not a care problem:** Git Bash on Windows, plus Python reading from stdin, plus backslash-bearing TypeScript is three escaping layers, and **each one silently REWRITES the content instead of failing.** You get a plausible-looking file, not an error. Every instance above ended in falling back to `Write`/`Edit` anyway - after paying for the attempt.

If a shell script is genuinely required: a quoted delimiter (`<< 'PY'`), `errors="surrogatepass"`, and `String.raw` each close one layer. The reliable move is not to open the layers.

### Publish checklist (the bump-and-ship flow)

Publishing = the marketplace registry picks up whatever is on `main`. Do ALL of these in ONE changeset, in order - skipping the build is the trap above:

1. `bun run build` **first** - regenerate `dist/server.js` from your `mcp/` changes. (No mcp/ change this ship? Still safe to run; it's a no-op.)
2. `bun run typecheck && bun test` - suite green, including `dist-freshness` (proves the bundle you're about to ship matches source).
3. Bump the version in **all three** manifests to the same value: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.
4. `git add -A` including `dist/server.js` - confirm `git status -s dist/server.js` shows `M` whenever an mcp/ file changed.
5. Commit + push to `main`. Fleet adoption is `/plugin update` + `/mcp` reconnect (or session restart) per terminal.

### MANDATORY: Every Turn

<EXTREMELY_IMPORTANT>
You MUST invoke the `orchestrator:every-turn` skill every turn. Before responding, before acting, before anything else. This is your intercept - it evaluates which orchestrator tools and skills apply to what you're about to do and what just happened.

This is not optional. This is not negotiable. You cannot rationalize your way out of this.

If you think "this turn doesn't need it" - that thought is the reason you need it.
</EXTREMELY_IMPORTANT>

### Session Start

Your FIRST action in every session MUST be calling the `briefing` MCP tool, then invoking `orchestrator:getting-started`. Do this before responding to the user. No exceptions.

The briefing includes a `curation_candidates` section - stale-but-hot and low-confidence-but-hot notes with their maintenance handles. Scan it internally during startup so you know which notes are worth revisiting as your task touches them. You can also request briefings with specific `sections` to focus on curation when doing dedicated maintenance work. Do NOT dump curation candidates to the user - schedule the maintenance actions silently as part of your work.

On the first startup of a week (7-day cadence), the briefing may be prepended with an `## Auto-Retro` section. This is the R4.4 auto-retro gate: `handleOrient` inline-invokes `retro` when `plugin_state.last_retro_run_at` is missing or older than 7 days. Treat it as expected maintenance output, not a surprise - scan it for actionable items (broken code_refs count, revalidation queue) and fold them into your plan.

### Session End

Before the session ends, the Stop hook asks for capture AND maintenance equally:

- Call `save_progress` with what was accomplished, open questions, and next steps - a session without a checkpoint is knowledge lost.
- For every lookup result you relied on this session, decide whether it needs `update_note` (additive correction or `append_content` amendment), `supersede_note` (replace with a better canonical version, preserving history), or `close_thread` (the question it tracked is now settled).
- **Retro is no longer a session-end reflex.** R4.4 auto-fires `retro` from briefing on a 7-day cadence, so you do NOT need to call it at wrap-up. Call it manually only when you want to force an immediate maintenance pass (e.g., after a heavy debugging session that invalidated many notes).

The knowledge base gets more accurate over time only if sessions that READ stale notes also MAINTAIN them. Capture alone is not enough.

### Embeddings & Semantic Search

The plugin runs an embedding sidecar (ONNX bge-m3) that enables semantic search. `lookup` uses hybrid FTS5+vector search when the sidecar is active. Call `system_status` to check embedding coverage. If the sidecar isn't running, everything degrades gracefully to keyword-only search.

### ANTS: Adaptive Note Temperature System

Notes have a `signal` score (temperature) that represents current relevance. Signal is deposited automatically whenever a note is surfaced (lookup, briefing, list, check_similar). Signal decays exponentially over time when `retro` runs, capped at 14 days per pass (vacation protection - trails dim but never disappear). High-signal notes rank higher in search. This is self-organizing - no manual management needed.

### Prior Art Checking

Before implementing anything, call `check_similar` with your proposed approach. It finds semantically similar decisions, conventions, and anti-patterns - even when the vocabulary doesn't match. This prevents contradicting past work.

**Reverse-index by file (R5).** Semantic and keyword search are two of three retrieval paths. The third is `lookup({code_ref: 'path/to/file'})` - which returns notes whose `code_refs` breadcrumb array contains that exact path. Before editing a non-trivial file, run a code_ref lookup to pull file-scoped notes that keyword search would miss. It's a complement to `check_similar`, not a replacement.

When `note()` fires a similarity alert, the alert now shows the top 3 candidates with maintenance handles (R3.5b). Read those alerts as "consider `update_note` / `supersede_note` / merge if these cover the same ground" rather than "just a warning, keep going." Capturing a near-duplicate without touching the candidates leaves the graph with both at equal rank.

### Code Breadcrumbs (R5)

When writing a note about specific code - a gotcha in a file, a convention for a module, a decision scoped to a subsystem - pass `code_refs: [paths]` on the write. All five write tools (`note`, `update_note`, `supersede_note`, `create_work_item`, `update_work_item`) accept it. File or module paths only - not line numbers, not symbol names (code indexers handle those). The orchestrator points at the neighborhood where WHY lives; the model's code-navigation tools handle line-level and symbol-level queries.

Without breadcrumbs, a note is only findable via keyword/semantic search. With breadcrumbs, the same note is also findable via reverse-index when a future agent edits one of the tagged files. Both paths matter. Skipping breadcrumbs silently weakens the signal.

### Struggle Detection

If you've been stuck on the same issue for 2+ turns, the `every-turn` skill will direct you to invoke `lookup` for prior gotchas, anti-patterns, and past solutions. Don't keep hammering - search for prior art. If a PA is active in the project, address `PA, ...` in your terminal output - PA's tailing will surface the address and PA can intervene.

### Turn Bridge

The UserPromptSubmit hook injects the turn bridge automatically at the start of each turn - no action needed from you. The PostToolUse hook records the bridge whenever you call an orchestrator MCP tool, and the next turn reads it back in as context. The old manual `[orch] next:` mechanism in thinking blocks is deprecated because thinking compression often stripped it.

Just use the tools. The bridge takes care of itself.

### Cross-Session Coordination (PrimeAgent + agent-channel, 0.29.0+)

When multiple Claude Code sessions run against the same project, the orchestrator plugin's agent-channel MCP capability delivers cross-session events as `<channel source="agent-channel" ...>content</channel>` tags injected inline at every model turn - same primitive the official Discord plugin uses for real-time message delivery.

**Roles:**
- **PrimeAgent (PA)**: persistent orchestrator session, role=prime, runs the latest Opus (or Fable when available) at xhigh effort. Singleton per project. Launched via `pa-start.bat`.
- **Subordinate Agent (SA)**: any other Claude Code session in the project, role=subordinate. Launched via `sa-start.bat` (or any `claude --channels plugin:orchestrator@...` invocation with `SPAWNBOX_AGENT_ROLE=subordinate`).

**Communication is via terminal output, not a tool:**
- Type `@PA` / `@PrimeAgent` to address the prime.
- Type `@SA-<id8>` to address a specific subordinate (id8 = first 8 chars of session_id).
- Type `@SA-<id8>,@SA-<id8>` for multiple.
- Type `@all` to broadcast to every active session except yourself.
- The conversational form `PA, ...` or `PrimeAgent, ...` also addresses PA.
- Free-form text without an `@` prefix is private dialogue with the user. PA still observes it (PA observes everything by default), but no SA receives it.

**Authority model:**
- PA's directives addressed to an SA are treated as if the user said them - they carry the user's authority AND permission for routine work. SAs execute directly without re-litigating PA's authority or pulling the user in for permission he has effectively already granted, then continue their own work. (Carve-out: genuinely destructive/irreversible ops still warrant an explicit confirm; the harness-gated prod ops - worker deploy, `wrangler d1 execute --remote` - are a separate layer needing the user's own in-window authorization, never PA's grant.)
- SA-to-SA messages are peer-level, not authoritative. Use judgment.
- Override: `/pa-pause` in an SA terminal pauses PA's posture toward that SA only. `/pa-pause` in PA's terminal sets a global pause across all SAs. Resume with `/pa-resume`. Natural language ("PA, back off") also recognized.
- Singleton conflict: if `pa-start.bat` refuses to launch a new PA because another is fresh, run `/pa-takeover` in the new PA's window to forcibly claim primacy.

**Broadcast your task**: when you start major work, call `update_session_task("...")` so peers see your `current_task` in the agent-channel notification metadata (`from_task` field) AND in their briefing's Cross-Session Activity section.

**No `send_message` / `read_messages` tools.** Those were the R6/R7 messaging system, removed in 0.29.0. Cross-session communication is entirely via terminal output + agent-channel filewatcher routing. The 60s wakeup-chain pattern is also gone (channel notifications are real-time; no polling).

Architecture and rationale: see `docs/superpowers/specs/2026-05-09-prime-agent-channel-architecture-design.md` (in any project that consumes this plugin).

### Hook Substrate (R6)

Seven of eight hooks now use `type: "mcp_tool"` and route through a single `_hook_event` dispatcher (`mcp/tools/hook_event.ts`). Only SessionStart remains bash because the MCP server may not be connected yet at first session boot. All hook state that used to live in `$CLAUDE_PROJECT_DIR/.orchestrator-state/*` files now lives in the `plugin_state` table per session+turn keys (turn counter, bridge, orch-active, struggle, stop markers).

Bash hooks are not the substrate anymore. If you need to extend hook behavior, edit `mcp/tools/hook_event.ts` and add a branch under the matching event.

### Storage Model: Notes and Work Items Share One Table

There is no separate "work items" table. Work items are rows in the `notes` table with `type = "work_item"` and populated `status`/`priority`/`due_date`/`blocked_by` columns. Everything else (`content`, `context`, `tags`, `keywords`, `confidence`) is shared between all note types.

This means:
- `update_note` operates on work items too - its UPDATE query doesn't filter by type. Works fine, use it interchangeably with `update_work_item` as of v0.21.2.
- `supersede_note` also operates on work items - the old work item becomes hidden-from-default-lookup and graph-links to the replacement.
- `delete_note` works on work items.
- `update_work_item` is a convenience wrapper for task-semantic fields (status cascade, due dates, blocked_by links). Since v0.21.2 it also covers `tags`, `context`, `confidence` for parity with `update_note`.
- Tags are a comma-separated text column. To add or remove one, read-modify-write.

If you find yourself building workarounds because a tool "doesn't support" something, check whether the sibling tool on the same row does.

### Self-contradiction is invisible to complaint-driven discovery

The plugin instructs agents constantly - hook nudges, tool descriptions, skills, this file. **Instructions that are WRONG but LOW-FRICTION TO IGNORE generate zero error reports.** Nobody complains; they just quietly stop reading that channel, and the tune-out generalizes to the advice that IS correct.

Live case (0.30.72): `lookup({code_ref: "path"})` was rejected by the tool while the PreToolUse hook, the lookup tool description, and this file all told agents to make exactly that call. The condition already existed inside the query; only the entry gate omitted it. It survived for months because the advice was cheap to skip - PA had seen the hint dozens of times in one session and never once tried it. The plugin was spending a scarce per-turn advisory slot on a call that could not succeed.

**So: periodically EXECUTE the plugin's own documented advice, verbatim, and see if it works.** That is the only reliable detector for this class. Adding a nudge is never sufficient evidence that a behavior changed.

Corollary, learned the same session: **prefer shipping CONTENT over shipping a POINTER.** A pointer costs the reader a decision they will usually decline; inlined content costs them nothing. That is why the pre-edit hint now carries the notes rather than asking for a lookup, and why the retrieval triggers run the query themselves.

### Latency and liveness are the same bug here

The MCP server is a single Bun event loop. The 30s heartbeat, the 1.5s channel tick, and every tool call share it. **Any long SYNCHRONOUS operation starves the heartbeat**, and once it lapses past the 90s stale threshold a peer reaps the session and announces `session_departed` - for a process that is alive and working.

This has now caused the same visible failure twice, from two different culprits: an N-squared transcript read (WI `8522c487`) and a 240s N+1 in the briefing's neglected-areas section (fixed 0.30.92). In both cases the reported symptom was a *flap* - sessions appearing to leave and rejoin - and the actual defect was a slow query.

**Two consequences worth holding:**

- **A latency bug in a tool is also a liveness bug.** Anything slow enough to annoy a user is slow enough to make a healthy process look dead to anything watching a heartbeat. Fixing the query fixed the flap; nobody needed to touch the liveness code.
- **When sessions flap, ask who flapped before debugging the detector.** Every observed flap hit a NEWLY-JOINED session, because only new sessions run the mandatory startup `briefing`. Long-running sessions never flapped. That asymmetry identified the culprit faster than reading the detector would have - and the detector was working correctly the entire time.

### Designing a nudge (read before adding one)

Every advisory this plugin emits competes for the same scarce attention, and a bad one does not merely waste a slot - it teaches agents to skim the channel that also carries the good ones. Four separate advisories were caught doing exactly that in a single session (2026-07-27).

**READ `60f2fdc2` FIRST - this problem was recorded 106 days before the rules below, and they are a rediscovery of it.** That anti-pattern states the root cause exactly: *"Static text in a repeating hook is an enforcement anti-pattern regardless of how loud the wording"* - after ~5 identical firings the model classifies it as chrome and routes no attention to it. There are now **three** remedies for that one cause, and they attack different parts, so check which applies before inventing a fourth:

1. **Context-aware generation** (60f2fdc2's original prescription) - vary the content per turn. Not built.
2. **Rotation** (Jarid's, recorded in `8f9a3f18`) - rotate phrasing through the **VARIANTS round-robin that already exists** in `hook_event.ts` and is already used for the base every-turn reminder. Cheapest option, plumbing present.
3. **State-change gating + specificity** (the rules below) - attacks frequency and informativeness rather than phrasing.

Note the triggers added in 0.30.75-0.30.85 use **fixed** text. They are state-gated so they fire rarely, which mitigates habituation - but if any starts getting filtered, remedy 2 is the cheap next step.

### WHERE to put a guard (decide this BEFORE deciding the wording)

On 2026-07-29 five sessions independently broke a rule **that was in their context at the time**. Not forgotten - present, and inert:

- I wrote the heredoc rule into this file, an anti-pattern note AND a code comment, then broke it twice - the second time while fixing the first.
- `b14fafa3` named asymmetric scrutiny and violated it one paragraph later.
- `df343a05` held a first-hand refutation in its own transcript and never retrieved it.
- PA wrote "two unverified quantities agreeing is not resolution", then resolved two unverified quantities in the next message.
- `90bf73bd` guessed three method-shaped assumptions in a row with the anti-method-assumption nudge **on screen each time**, and separately hit a `/tmp` trap it had documented the day before.

**So the failure is not insufficient reminding, and a tenth reminder is not neutral - it dilutes the nudges that still work.** `60f2fdc2` diagnosed decay-to-chrome 106 days ago and three remedies are already on file for that one cause. Rank the surfaces before adding anything:

1. **A TEST OR GATE - strongest.** It runs unprompted and can return "no" without anyone remembering it exists. `tests/hook-wiring.test.ts` is the worked example: 0.37.0's guard shipped inert behind thirteen green tests because they all exercised a pure function; the wiring test asserts the config instead and was proved to fail against the shipped bundle before being trusted.
2. **ATTACHED TO THE MOMENT OF THE ACTION - weaker but real.** A pre-flight line inside the skill step that performs the work, or a caveat inside the tool output that carries the risk. `df343a05`'s refinement, and it matters: **a skill file is read ONCE per session at the moment work starts, so it cannot habituate the way repeating text does.** `90bf73bd` adds that several checks attach to a QUERY rather than a build step - "result count equals your limit means truncated", "derive the count yourself", "introspect the field name rather than guessing it" - and those still fire at the right instant.
3. **AN EVERY-TURN NUDGE - fires at every instant, which is the same as none.** Reserve it for state-changed, specific, actionable content (rules 1 and 2 below). It is the wrong home for a general discipline.

**If a discipline cannot be attached to a test, a query, or the step that performs the action, it probably cannot be mechanised - and saying so honestly beats shipping a reminder that trains dismissal.** The corollary bites: declining to add a nudge is usually the correct application of this section, and the only version of it that is not self-refuting.

### A SUPPRESSOR NEEDS `generated = emitted + suppressed` FROM ITS FIRST COMMIT

Anything whose job is to make events NOT happen is the one category where working perfectly and being completely inert produce **byte-identical output**. Every other kind of defect leaves something behind; this one's success and its total failure both look like silence.

Earned 2026-07-29, within an hour of shipping. 0.41.0 added a restart-aware suppressor to `egress_suspect`. `SA-c5b207e0` then asked the only question that matters about it - *how many firings were GENERATED in that window?* - and it was **unanswerable from anywhere**: egress emissions were never recorded (only `ingress_suspect` wrote to `alert_refractory`) and suppressions were recorded nowhere at all. "Suppressed five" and "there were two and it caught two" were indistinguishable, so a clean-looking 5-vs-0 A/B had to be restated as 1-of-5 vs 0-of-5 on the control's own count.

That is anti-pattern `6e65f50f` - *absence of complaints is not evidence when nothing records the events* - committed by its author one day after writing it, in the code where it bites hardest.

**So: count both sides at the same time you write the suppression, not after someone asks.** `alert_refractory` (0.32.3) already does it - one row per `(alert_kind, subject_session)`, rendered by `system_status`, no new store. Wrap the counting so it can never break the detector it measures. And note the limit honestly when you ship: instrumentation added later makes the question answerable **from the next event onward, never retroactively** - the five restarts that prompted this are simply gone.

**THE CLOSING EVIDENCE, AND IT IS UNCOMFORTABLE.** By the end of 2026-07-29 five sessions had independently converged on ONE durable technique - *test the method against a case whose answer you already know, before you trust what it says about the case you don't.* It broke four confident wrong answers in ninety minutes, three of them PA's or endorsed by PA. It is the only guard produced in two days that can return "no"; everything else was a reminder to be careful.

**That technique was already in this plugin.** It ships as an every-turn nudge and reads, verbatim: *"RUN IT AGAINST THE CASE THAT MOTIVATED IT and confirm it FIRES."* It was on screen in `90bf73bd`'s context while they made three method-shaped guesses in a row, and on screen in mine while I shipped a guard that could not fire.

So the single most valuable discipline the fleet has found is deployed in the WEAKEST tier, and it demonstrably did not fire for the people it was shown to. **Do not read that as "the nudge is badly worded" - it is worded well, which is the point.** And it is not that subordinates skim: PA had the same text on screen while building a control that could only return "yes". Six sessions, four wrong answers, one nudge firing continuously throughout, zero prevented.

**PA's framing is the one to keep: A GUARD THAT FIRES UNCONDITIONALLY IS INDISTINGUISHABLE FROM NO GUARD.** This project already shipped the product analogue - a tray indicator lit whenever the icon was visible, which therefore told nobody anything. The every-turn nudge is that light: always on, so never read.

**What actually converted, and the difference is precise.** Not "run a positive control" as a standing reminder, but: *"`diag-7862c2ed-f20` exists, from the same reporter, in the same week - find it with your method."* That was **a named case, addressed to one session, delivered at the moment its conclusion was about to ship.** Specific, timed, falsifiable. The nudge is none of the three.

**So the test for any new advisory is whether it can observe that the thing it warns about is actually happening.** If it cannot, it is documentation with a delivery schedule. The version of this nudge that would have worked does not fire every turn - it fires when a session is about to report a null, a count, or a clean result, and it names what to test against.

The remedy is tier-1 and tier-2 homes: a test that runs the new check against the known-broken artefact (see `tests/hook-wiring.test.ts`, which is exactly this technique made executable), and a pre-flight line inside the skill step that performs the risky action. Keep the nudge, but stop expecting it to be the control.

**Six rules, each earned from a live failure:**

1. **Fire on STATE CHANGE, not on a tick.** The loop-close nudge fired ~30 times across ~40 turns naming the same work item; PA stopped reading it by turn ten and said outright that if it had ever named a *different* item, it would have been missed. The sibling roster rendered 5-15 times per turn. Both are now content-keyed: identical repeat suppressed, any real change renders immediately, with a floor so a static state cannot vanish entirely.

2. **Name the SPECIFIC thing, and make it actionable.** The one advisory observed being honoured names a peer's id8 and a note id and says what to do with them. The filtered ones were generic exhortations. Specific-and-actionable beats correct-and-vague.

3. **State the alert's own track record - but DERIVE it, never hardcode it.** The original form of this rule was right about the mechanism and wrong about the implementation, and the correction cost real damage. `ingress_suspect` carried the literal sentence *"Every firing of this alert so far has been a false alarm"*, and it worked exactly as intended: readers calibrated on it. Then on 2026-07-28 instance 8 fired inside a genuine 58-minute MCP transport outage - the detector's first true positive - and **two sessions said in as many words that this sentence is what trained them to discount it.** One nearly built a suppressor on the assumption. **A stated base rate that can go stale is worse than no stated base rate: it carries the authority of a measurement with the durability of a comment.** The alert now derives its count at emit time from `alert_refractory` (0.32.3) and states only one static claim, chosen because it is monotonic - that at least one past firing was real. That can never become false. Prefer facts that can only get truer.

4. **Give the triage an ORDER, and let different readers stop at different steps.** The rewritten alert numbers its checks cheapest-first, and on the fifth firing the fleet used it correctly *and differently*: one session used step 1 (address it) because it needed an answer from the subject anyway, so asking cost nothing extra; another used step 2 (transcript mtime) because it needed only liveness, which a file read settles at zero cost to anyone. That is triage discriminating properly rather than every reader performing the same ritual. Five sessions, five cheap checks, zero escalations to the user.

5. **A SUPPRESSOR WHOSE TRIGGER CORRELATES WITH THE FAILURE MODE IS NOT A FALSE-POSITIVE FILTER, IT IS A BLINDFOLD.** Two careful agents independently proposed the same suppressor four hours apart on 2026-07-28: silence `ingress_suspect` for 30 minutes after the subject's own compaction, since a context rebuild is long, silent, and the textbook false positive. It shipped in 0.32.1 and was removed the same day. The detector's first true positive fired 15m55s after a compaction, inside a real transport outage - **the grace would have swallowed the only real detection this alert has ever made.** The coincidence was not luck: compaction is precisely when a session is re-establishing transport, so "recently compacted" and "transport just died" correlate. The same trap was avoided once before by design - `classifyIngress` accepts `transcriptMtimeMs` and deliberately ignores it, because the enqueue writes to the target's own transcript, so gating on it would be true by construction and would silently disable the detector. **Before adding any suppressor, ask what the failure itself does to the signal you are keying on.** If the failure produces that signal, you have built a blindfold. Two independent inventions in one day means assume the next person will try it too, and leave the rejection documented where they will look.

   **SHARPENED 2026-07-29 (SA-5a433456): PREFER A SUPPRESSOR THAT KEYS ON A *CAUSE* OF THE BENIGN APPEARANCE, NOT A *CORRELATE* OF IT.** Passing the blindfold test is necessary and not sufficient. `stdin-end` **causes** the silence it suppresses - a restarted session physically cannot answer, so the benign explanation is complete. "The session is busy" merely **competes with** the alarm: busy does not imply reachable. A mid-turn session with genuinely dead ingress is indistinguishable from a merely-busy one, so a growth-keyed suppressor eats true positives. **A cause-keyed suppressor can be trusted to stay silent; a correlate-keyed one is a coin-flip hidden inside a check.**

   Earned by a proposal made and withdrawn within two minutes: PA pitched an `ingress_suspect` suppressor keyed on transcript mtime as "the mirror of `6ab80a7`, the design falls straight out." It is not the mirror - 0.41.0 suppresses on a cause, that would have suppressed on a correlate, and the difference was invisible under the "does the failure produce this signal?" test alone.

   **RECORDED HONESTLY, because the conclusion and the evidence came apart here.** A second objection was raised - that if inbound deliveries persist to the transcript *at arrival*, a stuck delivery bumps the very mtime that suppresses the alert about it, failing exactly on true positives. **That circularity is UNVERIFIED.** Nobody established when the write occurs; its author labelled it as the thing they could not settle, and it was then repeated as "the fatal one" until they corrected it back. The design was dropped on the cause-vs-correlate argument, which needs no measurement. If anyone revisits this: **one established objection, one open question that no longer needs answering.** Do not read "proven circular" into the record.

6. **Never assert a diagnosis the signal cannot support.** The ingress watchdog asserted "the session loop is PARKED" plus a physical remedy, on a signal that was 0-for-3. Being pre-formatted as a conclusion is what made careful agents relay it, and a human was sent to press keys at a healthy terminal. If a signal is ambiguous, say so and lead with the cheapest discriminator.

**Open question worth knowing about (note `517db4cd`):** decision `ea5bee61` says informational alerts don't change behaviour and only blocking does. There is now a competing hypothesis - that advisories fail when they are *uninformative*, not when they are *advisory*. If the refinement holds, the fix for an ignored signal is usually rule 1 plus rule 2, which is far cheaper than making it blocking and preserves the agent's judgement. Unresolved; don't treat either as settled.

### The Goal

Context windows are temporary. The orchestrator is permanent. Every session should leave the knowledge base richer than it found it.
