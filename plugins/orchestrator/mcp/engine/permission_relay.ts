import type { Database } from "bun:sqlite";

/**
 * PA-gated tool-permission relay (work_item 32250d62, shipping 0.30.15+).
 *
 * Claude Code's tool-permission protocol uses two MCP notifications:
 *   - INBOUND  (CC -> MCP): `notifications/claude/channel/permission_request`
 *   - OUTBOUND (MCP -> CC): `notifications/claude/channel/permission`
 *
 * When an SA's orchestrator MCP declares the `claude/channel/permission`
 * capability, CC routes its tool-permission requests through this relay
 * instead of prompting the terminal user. The relay:
 *
 *   1. Stores the request in a pending map keyed by request_id, with a
 *      timeout fallback to `defer_to_human`.
 *   2. Writes an immediate row to `permission_audit` for post-hoc audit.
 *   3. Returns a Promise that resolves when PA emits a verdict (via the
 *      agent-channel `permission_verdict` event routed back to this SA).
 *   4. On verdict, updates the audit row + resolves the Promise.
 *
 * The agent_channel module handles routing the request to PA and the
 * verdict back to this SA; this module is the pure protocol engine.
 *
 * Sessions WITHOUT the capability declared (standalone-orchestrator users
 * or single-agent setups) never instantiate PermissionRelay. The opt-in
 * is on the server.ts side, conditional on channel-mode being active.
 */

export type PermissionVerdict = "allow" | "deny" | "defer_to_human";

export interface PendingRequestInput {
  request_id: string;
  source_session: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

export interface VerdictInput {
  verdict: PermissionVerdict;
  pa_session: string;
  pa_reason?: string;
}

export interface ResolvedVerdict {
  verdict: PermissionVerdict;
  pa_session: string;
  pa_reason?: string;
}

export interface PermissionRelayOptions {
  /**
   * How long to wait for PA's verdict before defaulting to defer_to_human.
   * Defaults to 30 seconds. Pass a small value (e.g. 100ms) for unit tests.
   */
  defaultTimeoutMs?: number;
  /**
   * The session_id of THIS MCP's owning session. Used as `source_session`
   * when CC sends a permission_request - the SA that "owns" the request
   * is the one whose MCP received the inbound notification.
   */
  selfSessionId: string;
}

interface PendingEntry {
  source_session: string;
  resolve: (v: ResolvedVerdict) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Guard against double-resolution; first verdict wins. */
  resolved: boolean;
}

export class PermissionRelay {
  private pending = new Map<string, PendingEntry>();
  private readonly defaultTimeoutMs: number;

  constructor(
    private db: Database,
    private options: PermissionRelayOptions,
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  /**
   * Register a permission_request that just arrived from CC. Writes the
   * audit row, sets up the timeout, and returns a Promise that the
   * orchestrator MCP's notification handler can `await` before emitting
   * its `notifications/claude/channel/permission` response back to CC.
   *
   * If the same request_id is registered twice (e.g. CC retries on
   * transient failure), the existing pending Promise is returned -
   * both callers will see the same verdict when it lands. This
   * preserves first-Promise's resolve closure (which would otherwise
   * be orphaned on map.set overwrite) and keeps the audit row
   * consistent.
   */
  registerPending(input: PendingRequestInput): Promise<ResolvedVerdict> {
    // Collision handling: if request_id already pending, build a Promise
    // that mirrors the existing entry's resolve. Both callers settle
    // together when the verdict lands.
    const existing = this.pending.get(input.request_id);
    if (existing && !existing.resolved) {
      return new Promise<ResolvedVerdict>((resolve) => {
        const originalResolve = existing.resolve;
        existing.resolve = (v) => {
          originalResolve(v);
          resolve(v);
        };
      });
    }

    this.db.run(
      `INSERT OR IGNORE INTO permission_audit
        (request_id, source_session, requested_at, tool_name, description, input_preview)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.request_id,
        input.source_session,
        new Date().toISOString(),
        input.tool_name,
        input.description,
        input.input_preview,
      ],
    );

    return new Promise<ResolvedVerdict>((resolve) => {
      const entry: PendingEntry = {
        source_session: input.source_session,
        resolve,
        timer: null,
        resolved: false,
      };
      entry.timer = setTimeout(() => {
        // Timeout fallback: defer to human. The orchestrator MCP that
        // receives this verdict should emit `defer_to_human` semantics
        // to CC (or surface to terminal, depending on the SDK contract).
        if (entry.resolved) return;
        entry.resolved = true;
        this.db.run(
          `UPDATE permission_audit
             SET verdict = ?, resolved_at = ?, resolved_by = ?
           WHERE request_id = ?`,
          ["defer_to_human", new Date().toISOString(), "timeout", input.request_id],
        );
        this.pending.delete(input.request_id);
        entry.resolve({ verdict: "defer_to_human", pa_session: "<timeout>" });
      }, this.defaultTimeoutMs);
      this.pending.set(input.request_id, entry);
    });
  }

  /**
   * Apply PA's verdict to a pending request. No-op if request_id is
   * unknown (e.g. already timed out, or PA sent a verdict for an
   * SA-relayed request the local MCP never registered).
   *
   * Double-resolve is also a no-op (first verdict wins) - this guards
   * against the race between PA's verdict arriving and the timeout
   * firing.
   */
  resolveVerdict(request_id: string, input: VerdictInput): void {
    const entry = this.pending.get(request_id);
    if (!entry || entry.resolved) return;
    entry.resolved = true;
    if (entry.timer) clearTimeout(entry.timer);
    this.db.run(
      `UPDATE permission_audit
         SET verdict = ?, pa_session = ?, pa_reason = ?, resolved_at = ?, resolved_by = ?
       WHERE request_id = ?`,
      [
        input.verdict,
        input.pa_session,
        input.pa_reason ?? null,
        new Date().toISOString(),
        "pa",
        request_id,
      ],
    );
    this.pending.delete(request_id);
    entry.resolve({
      verdict: input.verdict,
      pa_session: input.pa_session,
      pa_reason: input.pa_reason,
    });
  }

  /**
   * Lookup which session originated a given request_id. Used by the
   * channel router when emitting verdicts back to the originating SA.
   * Returns null when the request is unknown to this relay (e.g. PA's
   * MCP looking up a request that lives in another SA's relay).
   */
  listSourceFor(request_id: string): string | null {
    const entry = this.pending.get(request_id);
    if (entry) return entry.source_session;
    const row = this.db
      .query("SELECT source_session FROM permission_audit WHERE request_id = ?")
      .get(request_id) as { source_session: string } | undefined;
    return row?.source_session ?? null;
  }

  /**
   * Test/diagnostic: count of currently-pending requests.
   */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Shutdown helper: settle all in-flight requests with a synthetic
   * shutdown verdict before clearing the map. Without settling, the
   * caller's `await registerPending(...)` would hang forever and the
   * Node.js event loop would stay alive (preventing clean MCP exit).
   *
   * The shutdown verdict is `defer_to_human` so the SA's notification
   * handler returns a sensible response to CC (which CC then routes to
   * the terminal prompt as a fallback).
   */
  cleanup(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      if (!entry.resolved) {
        entry.resolved = true;
        entry.resolve({ verdict: "defer_to_human", pa_session: "<shutdown>" });
      }
    }
    this.pending.clear();
  }
}
