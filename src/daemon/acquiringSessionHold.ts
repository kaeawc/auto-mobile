import type { ExecutionTracker } from "./executionTracker";

/**
 * A {@link holdAcquiringSession} hold. `signal` aborts when the daemon cancels the held session's
 * work (its device was lost, the session was released), so the held steps stop at once instead
 * of running out their own deadline. `release` ends the hold; calling it again is a no-op.
 */
export interface AcquiringSessionHold {
  readonly signal: AbortSignal;
  release(): void;
}

/** Restarts a minted session's pre-first-heartbeat grace from now (#17885). */
export interface PreFirstHeartbeatGraceRestarter {
  restartPreFirstHeartbeatGrace(sessionId: string): void;
}

/**
 * Keeps a device session the acquiring call has minted but not yet returned from being reaped
 * while that call still works on it (#17885).
 *
 * `provisionDevice` binds its session and then runs post-bind steps (a device profile, Android
 * Auto projection) that can take far longer than the pre-first-heartbeat grace. The client
 * cannot heartbeat a session id it has not received yet, so the hold registers one execution
 * under the minted session for the rest of the run. The heartbeat monitor's existing
 * unsettled-execution veto then keeps the session, bounded by `deadlineMs` plus the veto's
 * deadline grace, so a run that wedges still cannot hold the device forever.
 *
 * The hold postpones the grace rather than using it up: on release the session's grace restarts
 * from now, so the client gets the full grace to send its first heartbeat after the call returns.
 * A session nobody picks up is still reaped as `missing-first-heartbeat` once that grace ends.
 */
export function holdAcquiringSession(
  tracker: Pick<ExecutionTracker, "startExecution" | "endExecution" | "setExecutionDeadline">,
  sessions: PreFirstHeartbeatGraceRestarter | undefined,
  {
    toolName,
    sessionUuid,
    deadlineMs,
  }: { toolName: string; sessionUuid: string; deadlineMs: number },
): AcquiringSessionHold {
  const execution = tracker.startExecution(toolName, undefined, sessionUuid);
  tracker.setExecutionDeadline(execution.id, () => deadlineMs);
  let released = false;
  return {
    signal: execution.abortController.signal,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      // Restart the grace before the veto lifts, so no scan sees the session unheld and stale.
      sessions?.restartPreFirstHeartbeatGrace(sessionUuid);
      tracker.endExecution(execution.id);
    },
  };
}
