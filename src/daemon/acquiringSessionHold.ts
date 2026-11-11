import type { ExecutionTracker } from "./executionTracker";

/** Ends an {@link holdAcquiringSession} hold; calling it again is a no-op. */
export type AcquiringSessionRelease = () => void;

/**
 * Keeps a device session the acquiring call has minted but not yet returned from being reaped
 * while that call still works on it (#17885).
 *
 * `provisionDevice` binds its session and then runs post-bind steps (a device profile, Android
 * Auto projection) that can take far longer than the pre-first-heartbeat grace. The client
 * cannot heartbeat a session id it has not received yet, so the hold registers one execution
 * under the minted session for the rest of the run. The heartbeat monitor's existing
 * unsettled-execution veto then keeps the session, bounded by `deadlineMs` plus the veto's
 * deadline grace, so a run that wedges still cannot hold the device forever. Once the hold is
 * released the session is judged like any other: a session nobody picks up is still reaped
 * as `missing-first-heartbeat`.
 */
export function holdAcquiringSession(
  tracker: Pick<ExecutionTracker, "startExecution" | "endExecution" | "setExecutionDeadline">,
  {
    toolName,
    sessionUuid,
    deadlineMs,
  }: { toolName: string; sessionUuid: string; deadlineMs: number },
): AcquiringSessionRelease {
  const execution = tracker.startExecution(toolName, undefined, sessionUuid);
  tracker.setExecutionDeadline(execution.id, () => deadlineMs);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    tracker.endExecution(execution.id);
  };
}
