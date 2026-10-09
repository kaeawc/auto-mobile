import {
  resolveToolSelectionBaseSessionUuid,
  type ToolSelectionSessionManager,
} from "../features/toolSelection/selectionSessionResolver";
import type { ExecutionTracker } from "../server/executionTracker";
import type { DevicePool } from "./devicePool";
import type { ActiveSessionExecutionQuery, SessionManager } from "./sessionManager";

/** What the daemon's tool-call activity wiring reads from the session manager. */
export type ToolCallActivitySessionManager = ToolSelectionSessionManager &
  Pick<SessionManager, "recordToolCallEnded">;

/**
 * Idleness counts from the END of the last tool call (owner decision 2026-10-08), and a call's
 * end re-arms the owner-disconnect releases it deferred (#10712). `daemon.ts` subscribes this
 * from `start()`; harnesses that drive the daemon's tool path call the same function rather than
 * re-wiring the tracker themselves (#10839). Returns the unsubscribe.
 */
export function subscribeToolCallEndActivity(
  tracker: Pick<ExecutionTracker, "onSessionExecutionEnded">,
  sessionManager: ToolCallActivitySessionManager,
  devicePool: Pick<DevicePool, "sessionExecutionsEnded">,
): () => void {
  return tracker.onSessionExecutionEnded((sessionUuids, { admitted }) => {
    const sessionIds = new Set(
      sessionUuids.map((uuid) => resolveToolSelectionBaseSessionUuid(uuid, sessionManager) ?? uuid),
    );
    // A call refused at admission is not use: it must not revive a suspect or expired session
    // (#10824). It still re-arms the deferred releases its in-flight execution vetoed.
    for (const sessionId of sessionIds) {
      sessionManager.recordToolCallEnded(sessionId, { admitted });
    }
    // A deferred owner-disconnect release may be keyed by either id (#10712).
    devicePool.sessionExecutionsEnded(new Set([...sessionUuids, ...sessionIds]));
  });
}

/**
 * Whether a session has work in flight: a tracked tool call under its id (or its base session's,
 * for a derived `${base}:${label}` session), or a session-preserving recovery. The daemon's
 * session manager and release vetoes ask this; a call in flight is never released.
 */
export function hasActiveSessionExecution(
  tracker: Pick<
    ExecutionTracker,
    "hasActiveSessionUuidExecutions" | "hasActiveAutolockSessionExecutions"
  >,
  sessionManager: ToolSelectionSessionManager,
  devicePool: Pick<DevicePool, "isSessionRecoveryInFlight">,
  sessionId: string,
  query?: ActiveSessionExecutionQuery,
): boolean {
  const executionSessionId =
    resolveToolSelectionBaseSessionUuid(sessionId, sessionManager) ?? sessionId;
  return (
    devicePool.isSessionRecoveryInFlight(sessionId) ||
    tracker.hasActiveSessionUuidExecutions(sessionId, query) ||
    tracker.hasActiveAutolockSessionExecutions(sessionId, query) ||
    (executionSessionId !== sessionId &&
      (tracker.hasActiveSessionUuidExecutions(executionSessionId, query) ||
        tracker.hasActiveAutolockSessionExecutions(executionSessionId, query)))
  );
}
