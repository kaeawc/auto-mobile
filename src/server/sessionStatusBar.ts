import type { SessionManager } from "../daemon/sessionManager";
import { ActionableError } from "../models/ActionableError";

/** The session surface a status-bar override needs to attribute and sequence itself. */
export type StatusBarSessionManager = Pick<
  SessionManager,
  "getSession" | "isAdmittedForAutomation" | "trackSessionSetup"
>;

/**
 * Run a status-bar override under the caller's session (#14105). The override is tracked as
 * session setup, so a concurrent release drains it before the release-time clear runs; the
 * owning session id is recorded before the device command so a release that wins the race still
 * clears whatever the command managed to apply. A sessionless call runs untracked and owns
 * nothing (`null`).
 */
export async function runSessionStatusBarMutation<T>(options: {
  sessionManager: StatusBarSessionManager | undefined;
  sessionUuid: string | undefined;
  deviceId: string;
  record: (sessionId: string | null) => void;
  mutation: () => Promise<T>;
}): Promise<T> {
  const { sessionManager, sessionUuid, deviceId, record, mutation } = options;
  if (!sessionManager || !sessionUuid) {
    record(null);
    return mutation();
  }
  const session = sessionManager.getSession(sessionUuid);
  if (
    !session ||
    !sessionManager.isAdmittedForAutomation(session) ||
    session.assignedDevice !== deviceId
  ) {
    throw new ActionableError(
      "Cannot change the status bar: session is released, releasing, rebound, or replaced.",
    );
  }
  let completed = false;
  let result!: T;
  await sessionManager.trackSessionSetup(session, async () => {
    record(session.sessionId);
    result = await mutation();
    completed = true;
  });
  if (!completed) {
    throw new ActionableError(
      "Session began releasing or rebinding before the status bar override started.",
    );
  }
  return result;
}
