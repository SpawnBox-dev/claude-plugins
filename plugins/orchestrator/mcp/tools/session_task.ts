/**
 * update_session_task tool handler.
 *
 * Updates a session's current_task field in session_registry. Used by the
 * agent-channel filewatcher to populate the from_task metadata on channel
 * notifications, so peers see what each session is working on.
 */

import type { SessionTracker } from "../engine/session_tracker";

export interface UpdateSessionTaskArgs {
  session_id: string;
  task: string;
}

export function handleUpdateSessionTask(
  tracker: SessionTracker,
  args: UpdateSessionTaskArgs,
): string {
  tracker.updateCurrentTask(args.session_id, args.task);
  return "Current task updated.";
}
