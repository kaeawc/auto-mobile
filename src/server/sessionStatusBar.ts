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
 * nothing (`null`). `record` returns a rejection handler for its write: when the device command
 * rejects, it runs with the error inside the tracked setup, so it can undo a record the device
 * never acted on before a release reads it (#17054).
 */
export async function runSessionStatusBarMutation<T>(options: {
  sessionManager: StatusBarSessionManager | undefined;
  sessionUuid: string | undefined;
  deviceId: string;
  record: (sessionId: string | null) => (error: unknown) => void;
  mutation: () => Promise<T>;
}): Promise<T> {
  const { sessionManager, sessionUuid, deviceId, record, mutation } = options;
  if (!sessionManager || !sessionUuid) {
    return recordThenMutate(() => record(null), mutation);
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
    result = await recordThenMutate(() => record(session.sessionId), mutation);
    completed = true;
  });
  if (!completed) {
    throw new ActionableError(
      "Session began releasing or rebinding before the status bar override started.",
    );
  }
  return result;
}

/** Records, runs the mutation, and hands a rejection to the record's handler. */
async function recordThenMutate<T>(
  record: () => (error: unknown) => void,
  mutation: () => Promise<T>,
): Promise<T> {
  const onReject = record();
  try {
    return await mutation();
  } catch (error) {
    onReject(error);
    throw error;
  }
}
