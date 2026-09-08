import type { Database } from "bun:sqlite";
import { relative, resolve, isAbsolute } from "node:path";
import { SessionTracker } from "../engine/session_tracker";
import { findRelatedNotes } from "../engine/linker";
import { findNotesDescribingEditedFiles, detectsRetrievalTrigger, composeScopeRetrievalText, detectsRiskyHeredoc, HEREDOC_WARNING, detectsHistoryRewrite, composeHistoryRewriteText, composeWorkItemDriftNudge } from "../tools/hook_event";
import { codexSessionId } from "./profile";

export interface CodexHookInput {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  turn_id?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  stop_hook_active?: boolean;
}

export function affectedFiles(input: unknown, cwd: string): string[] {
  const obj = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const patch = typeof input === "string" ? input : [obj.command, obj.patch, obj.input].find(x => typeof x === "string") as string | undefined;
  const paths: string[] = [];
  if (typeof obj.file_path === "string") paths.push(obj.file_path);
  if (patch) for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)) paths.push(match[1].trim());
  return [...new Set(paths.map(file => relative(cwd, resolve(cwd, file)).replace(/\\/g, "/")))]
    .filter(file => file && file !== ".." && !file.startsWith("../") && !isAbsolute(file)).slice(0, 60);
}

export function failedTool(response: unknown): boolean {
  if (typeof response === "string") return /(?:exit_code["']?\s*[:=]\s*|Exit code:\s*|Process exited with code )([1-9]\d*)/.test(response);
  if (!response || typeof response !== "object") return false;
  const obj = response as Record<string, unknown>;
  return obj.isError === true || (typeof obj.exit_code === "number" && obj.exit_code !== 0) || failedTool(obj.output);
}

export function handleCodexHook(db: Database, input: CodexHookInput): Record<string, unknown> {
  const sid = codexSessionId(input.session_id);
  if (!sid) throw new Error("Codex hook has no valid task identity");
  const event = input.hook_event_name;
  const tracker = new SessionTracker(db, () => []);
  const get = <T>(key: string, fallback: T): T => {
    const row = db.query("SELECT value FROM plugin_state WHERE key = ?").get(`codex_${key}_${sid}`) as { value: string } | null;
    try { return row ? JSON.parse(row.value) as T : fallback; } catch { return fallback; }
  };
  const put = (key: string, value: unknown) => db.run(
    "INSERT INTO plugin_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    [`codex_${key}_${sid}`, JSON.stringify(value), new Date().toISOString()],
  );
  const envelope = (text: string) => text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text.slice(0, 10000) } } : {};
  const checkpoint = () => (db.query("SELECT id,content FROM notes WHERE type='checkpoint' AND source_session=? ORDER BY created_at DESC LIMIT 1").get(sid) as { id: string; content: string } | null);
  put(`hook_${event}`, { count: get<{ count: number }>(`hook_${event}`, { count: 0 }).count + 1, at: new Date().toISOString() });

  if (event === "SessionStart") {
    tracker.registerSession(sid);
    const cp = checkpoint();
    const snapshot = get<string>("snapshot", "");
    const task = tracker.getSession(sid)?.current_task;
    return envelope([
      `[orchestrator] Independent Codex task ${sid}. Use briefing to load project knowledge, then lookup/check_similar alongside current source. Capture findings and save_progress at milestones.`,
      task ? `Current task: ${task}` : "",
      cp ? `Your saved checkpoint ${cp.id}:\n${cp.content.slice(0, 5000)}` : "",
      input.source === "compact" ? snapshot : "",
    ].filter(Boolean).join("\n\n"));
  }
  if (event === "UserPromptSubmit") {
    const turn = get<number>("turn", 0) + 1;
    put("turn", turn);
    const prompt = input.prompt || "";
    const parts: string[] = [];
    if (detectsRetrievalTrigger(prompt)) {
      // Reuse the knowledge retrieval mechanism without the fleet dispatcher.
      parts.push(composeScopeRetrievalText(findRelatedNotes(db, prompt, 3)));
    }
    const bridge = get<string>("bridge", "");
    if (bridge) parts.push(`[orchestrator] Previous action: ${bridge}`);
    if (turn % 15 === 0) parts.push("[orchestrator] Capture new findings while the evidence is fresh; amend knowledge you found outdated.");
    return envelope(parts.filter(Boolean).join("\n\n"));
  }
  const name = input.tool_name || "";
  const edit = /(?:apply_patch|Write|Edit|MultiEdit|NotebookEdit)$/.test(name);
  const files = edit ? affectedFiles(input.tool_input, input.cwd) : [];
  if (event === "PreToolUse") {
    const parts: string[] = [];
    if (files.length) {
      const notes = findNotesDescribingEditedFiles(db, files, 6);
      if (notes.length) parts.push("[orchestrator] Prior knowledge for the files being edited:\n" + notes.map(n => `${n.file}: ${n.id} — ${n.content.slice(0, 800)}`).join("\n"));
    }
    const args = input.tool_input && typeof input.tool_input === "object" ? input.tool_input as Record<string, unknown> : {};
    const command = String(args.cmd || args.command || "");
    if (detectsRiskyHeredoc(command)) parts.push(HEREDOC_WARNING);
    if (detectsHistoryRewrite(command)) parts.push(composeHistoryRewriteText());
    return envelope(parts.join("\n\n"));
  }
  if (event === "PostToolUse") {
    const failed = failedTool(input.tool_response);
    if (failed) {
      const failures = get<number>("failures", 0) + 1;
      put("failures", failures);
      return envelope(failures % 2 === 0 ? "[orchestrator] Repeated tool failures: check prior gotchas with lookup and re-read the current evidence before retrying." : "");
    }
    put("failures", 0);
    if (files.length) {
      put("edited", [...new Set([...get<string[]>("edited", []), ...files])].slice(-60));
      put("dirty", true);
      put("bridge", `Edited ${files.join(", ")}`);
      const drift = files.slice(0, 12).map(file => composeWorkItemDriftNudge(db, sid, { event: "PostToolUse", session_id: sid, tool_name: "Edit", payload: { file_path: file } })).filter(Boolean);
      return envelope(drift.join("\n\n"));
    } else if (/orchestrator.*(?:note|save_progress|work_item|session_task|lookup)/.test(name)) {
      put("bridge", name);
      if (/save_progress$/.test(name)) put("dirty", false);
    }
    return {};
  }
  if (event === "PreCompact" || event === "SessionEnd") {
    const task = tracker.getSession(sid)?.current_task || "No task declaration";
    const notes = db.query("SELECT id,type,substr(content,1,220) AS content FROM notes WHERE source_session=? ORDER BY updated_at DESC LIMIT 8").all(sid);
    put("snapshot", `Deterministic continuity snapshot: ${task}\nEdited files: ${get<string[]>("edited", []).join(", ")}\nRecent records: ${JSON.stringify(notes)}`);
    return {};
  }
  if (event === "Stop" && get<boolean>("dirty", false) && !input.stop_hook_active) {
    const turn = input.turn_id || String(get<number>("turn", 0));
    if (get<string>("stop_requested", "") === turn) return {};
    put("stop_requested", turn);
    const notes = findNotesDescribingEditedFiles(db, get<string[]>("edited", []), 5);
    return { decision: "block", reason: "Save useful progress with orchestrator save_progress before finishing. If the tool is unavailable, state that briefly and finish. " + (notes.length ? `Review whether these records need updating after your edits: ${notes.map(n => n.id).join(", ")}.` : "") };
  }
  return {};
}
