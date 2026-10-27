import { defaultDaemonContext } from "../daemon/daemonContext";

/**
 * Whether the caller already held `lifecycleSessionUuid` (live, or resumable inside its device
 * restart recovery window) before an executePlan call acquired anything. Such a session is not
 * the plan's to release (#15333). Every other tool answers a plain `false`, so its resolution
 * stays on the same turn.
 */
export function callerHeldPlanSession(
  toolName: string,
  lifecycleSessionUuid: string | undefined,
): boolean | Promise<boolean> {
  if (toolName !== "executePlan" || lifecycleSessionUuid === undefined) {
    return false;
  }
  const sessionManager = defaultDaemonContext.sessionManager();
  if (sessionManager?.peekSession(lifecycleSessionUuid)) {
    return true;
  }
  return sessionManager?.isReleasedSessionInRestartRecoveryWindow(lifecycleSessionUuid) ?? false;
}

/** Throws the terminal answer when `sessionUuid` is a plan base that has already ended. */
export function refuseEndedPlanBase(sessionUuid: string, executionId?: string): void {
  const ended = defaultDaemonContext
    .sessionManager()
    ?.terminalAnswerForEndedSession(sessionUuid, executionId);
  if (ended) {
    throw ended;
  }
}
