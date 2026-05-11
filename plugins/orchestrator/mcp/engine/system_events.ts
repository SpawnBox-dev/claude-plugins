import { existsSync, readFileSync, statSync } from "node:fs";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * File-based cross-MCP event bus (0.30.16+, work_item 32250d62 Phase 2).
 *
 * The agent_channel filewatcher reads Claude Code session JSONLs to route
 * assistant_text / tool_use / user_input events. That mechanism works for
 * events that originate as session-author writes - but NOT for events that
 * the orchestrator MCP itself wants to emit cross-process (e.g. routing a
 * permission_request from one SA's MCP to PA's MCP).
 *
 * This module is a lightweight append-only JSONL bus at
 * `<project>/.orchestrator-state/agent-channel/system_events.jsonl`. The
 * AgentChannel filewatcher reads it on every tick (alongside session
 * JSONLs) and emits to the local session via addressing rules.
 *
 * Each event has minimum fields:
 *   - `event_type`: discriminator (e.g. "permission_request_pending")
 *   - `from_session`: who wrote it
 *   - `to_session`: who should receive it (single target; broadcast not
 *     supported on this bus - use channel addressing in regular content
 *     events for broadcasts)
 *   - `ts`: ISO timestamp
 *   - payload fields are event-type-specific
 *
 * Limit: lines must be JSON-parseable single-line entries. Don't include
 * unescaped newlines in payload strings.
 */

export interface SystemEvent {
  event_type: string;
  from_session: string;
  to_session: string;
  ts: string;
  /** Event-type-specific payload */
  [key: string]: unknown;
}

/**
 * Path resolver: caller passes the agent-channel state dir; we own the
 * file name + ensure parent dir exists on write.
 */
export function systemEventsPath(stateDir: string): string {
  return join(stateDir, "system_events.jsonl");
}

/**
 * Append a single event. Newline-terminated. Multi-line payload values
 * (anywhere in nested JSON) are flattened to ensure JSON-per-line.
 */
export function appendSystemEvent(stateDir: string, event: SystemEvent): void {
  const path = systemEventsPath(stateDir);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // JSON.stringify never produces unescaped newlines in strings - it
  // emits \\n. So a single JSON.stringify line is always one line.
  appendFileSync(path, JSON.stringify(event) + "\n");
}

/**
 * Read new events since the caller's last offset. Returns the parsed
 * events PLUS the new offset so callers can persist it.
 *
 * If the file doesn't exist, returns { events: [], newOffset: 0 }.
 * If the file was truncated (size < lastOffset), resets offset to 0
 * and re-reads from start.
 */
export function readNewSystemEvents(
  stateDir: string,
  lastOffset: number,
): { events: SystemEvent[]; newOffset: number } {
  const path = systemEventsPath(stateDir);
  if (!existsSync(path)) {
    return { events: [], newOffset: 0 };
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { events: [], newOffset: lastOffset };
  }

  if (stat.size === lastOffset) {
    return { events: [], newOffset: lastOffset };
  }
  if (stat.size < lastOffset) {
    // Truncated; reset
    lastOffset = 0;
  }

  let buf: string;
  try {
    const raw = readFileSync(path);
    buf = raw.subarray(lastOffset).toString("utf8");
  } catch {
    return { events: [], newOffset: lastOffset };
  }

  const lines = buf.split("\n");
  const events: SystemEvent[] = [];
  let consumed = 0;
  // Last element after split is "" when buffer ends with \n, or a partial
  // line otherwise. Skip it - we'll re-read partial lines next tick once
  // they're complete.
  for (let i = 0; i < lines.length - 1; i++) {
    consumed += Buffer.byteLength(lines[i], "utf8") + 1; // +1 for \n
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as SystemEvent;
      if (
        typeof ev?.event_type === "string" &&
        typeof ev?.from_session === "string" &&
        typeof ev?.to_session === "string"
      ) {
        events.push(ev);
      }
    } catch {
      // Skip malformed lines - don't break the bus on a single bad entry.
      continue;
    }
  }
  return { events, newOffset: lastOffset + consumed };
}

/**
 * Test/diagnostic: clear the bus. Don't call this from production code.
 */
export function clearSystemEvents(stateDir: string): void {
  const path = systemEventsPath(stateDir);
  if (existsSync(path)) {
    writeFileSync(path, "");
  }
}
