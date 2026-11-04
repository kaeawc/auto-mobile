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
 * nothing (`null`). `record` returns the undo for its write: when the device command rejects
 * (a field the platform refuses, a failed broadcast), the undo runs inside the tracked setup, so
 * a rejected override never lingers in the store for `get` or a later release (#17054).
 */
export async function runSessionStatusBarMutation<T>(options: {
  sessionManager: StatusBarSessionManager | undefined;
  sessionUuid: string | undefined;
  deviceId: string;
  record: (sessionId: string | null) => () => void;
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

/** Records, runs the mutation, and undoes the record when the mutation rejects. */
async function recordThenMutate<T>(
  record: () => () => void,
  mutation: () => Promise<T>,
): Promise<T> {
  const undo = record();
  try {
    return await mutation();
  } catch (error) {
    undo();
    throw error;
  }
}
