import type { Database } from "bun:sqlite";
import {
  sendMessage as engineSend,
  drainInbox as engineDrain,
  type SendMessageInput,
  type MessagePriority,
} from "../engine/messaging";
import type { SessionTracker } from "../engine/session_tracker";

export interface SendMessageArgs {
  from_session: string;
  to_session?: string;
  body: string;
  scope_code_ref?: string;
  scope_task_contains?: string;
  priority?: MessagePriority;
  ttl_seconds?: number;
}

export function handleSendMessage(db: Database, args: SendMessageArgs): string {
  const scope =
    args.scope_code_ref || args.scope_task_contains
      ? {
          code_ref: args.scope_code_ref,
          task_contains: args.scope_task_contains,
        }
      : undefined;

  const input: SendMessageInput = {
    from_session: args.from_session,
    to_session: args.to_session,
    body: args.body,
    scope,
    priority: args.priority,
    ttl_seconds: args.ttl_seconds,
  };
  const msg = engineSend(db, input);

  const target = msg.to_session ?? "broadcast";
  return `Message ${msg.id.slice(0, 8)} sent (-> ${target}, priority: ${msg.priority}).`;
}

export interface ReadMessagesArgs {
  session_id: string;
}

export function handleReadMessages(db: Database, args: ReadMessagesArgs): string {
  // R7.8: explicit read = "show me everything queued". Bypass scope filtering.
  // The R7.5 scope filter is correct on the auto-drain path (PostToolUse /
  // UserPromptSubmit) where context-aware opportunistic delivery is the whole
  // point - but on a user-driven read with no available context, it would
  // silently hide every scoped message and return "Inbox empty." Field-observed
  // bug: see work_item be30d33d.
  const msgs = engineDrain(db, args.session_id, { bypassScope: true });
  if (msgs.length === 0) return "Inbox empty.";

  const lines = msgs.map((m) => {
    const target = m.to_session ? `direct` : `broadcast`;
    const age = ageOf(m.created_at);
    const scopeStr = m.scope
      ? ` (scope: ${[
          m.scope.code_ref ? `code_ref=${m.scope.code_ref}` : null,
          m.scope.task_contains ? `task~${m.scope.task_contains}` : null,
        ]
          .filter(Boolean)
          .join(", ")})`
      : "";
    return `- **${m.priority.toUpperCase()}** [${target}]${scopeStr} from ${m.from_session.slice(0, 8)} ${age} ago: ${m.body}`;
  });

  return `Drained ${msgs.length} message(s):\n${lines.join("\n")}`;
}

function ageOf(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export interface UpdateSessionTaskArgs {
  session_id: string;
  task: string;
}

export function handleUpdateSessionTask(
  tracker: SessionTracker,
  args: UpdateSessionTaskArgs
): string {
  tracker.updateCurrentTask(args.session_id, args.task);
  return `Current task updated.`;
}
