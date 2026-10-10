import {
  resolveToolSelectionBaseSessionUuid,
  type ToolSelectionSessionManager,
} from "../features/toolSelection/selectionSessionResolver";
import type { ExecutionTracker } from "../server/executionTracker";
import type { DevicePool } from "./devicePool";
import type { ActiveSessionExecutionQuery, SessionManager } from "./sessionManager";
import type { SessionExecutionProbe } from "./unsettledExecutionVeto";

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

/**
 * The latest request deadline among a session's in-flight executions, over the same scope
 * {@link hasActiveSessionExecution} counts; a recovery in flight carries no deadline. With
 * `excludeReads`, reads' deadlines are left out, as the reads themselves are (#11322).
 */
export function latestSessionExecutionDeadlineMs(
  tracker: Pick<ExecutionTracker, "getLatestSessionExecutionDeadlineMs">,
  sessionManager: ToolSelectionSessionManager,
  devicePool: Pick<DevicePool, "isSessionRecoveryInFlight">,
  sessionId: string,
  options: { onSessionClock?: boolean; excludeReads?: boolean } = {},
): number | undefined {
  if (devicePool.isSessionRecoveryInFlight(sessionId)) {
    return Number.POSITIVE_INFINITY;
  }
  const executionSessionId =
    resolveToolSelectionBaseSessionUuid(sessionId, sessionManager) ?? sessionId;
  const deadlines = [...new Set([sessionId, executionSessionId])]
    .map((id) => tracker.getLatestSessionExecutionDeadlineMs(id, options))
    .filter((deadline): deadline is number => deadline !== undefined);
  return deadlines.length === 0 ? undefined : Math.max(...deadlines);
}

/**
 * How an unsettled-execution veto sees a session's in-flight work: whether any runs, and the
 * latest request deadline among them, which bounds the veto (#10712). The veto judges on the
 * session clock, so the deadlines are converted onto it (#11162).
 *
 * `excludeReads` is the heartbeat monitor's view (#11322): a read is answered whatever the owner
 * lease says, but it is watching, not use and not the owner's liveness, so it never keeps a
 * session whose owner stopped heartbeating. Only control calls do (#5343).
 */
export function sessionExecutionProbe(
  tracker: Pick<
    ExecutionTracker,
    | "hasActiveSessionUuidExecutions"
    | "hasActiveAutolockSessionExecutions"
    | "getLatestSessionExecutionDeadlineMs"
  >,
  sessionManager: ToolSelectionSessionManager,
  devicePool: Pick<DevicePool, "isSessionRecoveryInFlight">,
  options: { excludeReads?: boolean } = {},
): SessionExecutionProbe {
  const query: ActiveSessionExecutionQuery = options.excludeReads ? { excludeReads: true } : {};
  return {
    hasActiveExecutions: (sessionId) =>
      hasActiveSessionExecution(tracker, sessionManager, devicePool, sessionId, query),
    latestExecutionDeadlineMs: (sessionId) =>
      latestSessionExecutionDeadlineMs(tracker, sessionManager, devicePool, sessionId, {
        onSessionClock: true,
        ...query,
      }),
  };
}
