import type { SessionManager, SessionExecutionMetadata } from "../daemon/sessionManager";

/** A late read using a held device sessionlessly must not run control admission to bind. */
export function sessionForToolBinding(
  manager: Pick<SessionManager, "deviceHeldForLateRead" | "getSessionForNewExecution">,
  sessionUuid: string,
  execution: SessionExecutionMetadata,
  deviceReadOnly: boolean,
) {
  if (deviceReadOnly && manager.deviceHeldForLateRead(sessionUuid, execution) !== undefined) {
    return undefined;
  }
  return manager.getSessionForNewExecution(sessionUuid, execution);
}
