import type { SessionManager } from "../daemon/sessionManager";
import { ActionableError } from "../models/ActionableError";

/** The slice of the session manager a tracked keyboard-profile write needs. */
export type SessionKeyboardProfileHost = Pick<
  SessionManager,
  "getSession" | "isAdmittedForAutomation" | "trackSessionSetup"
>;

/**
 * Admit a `keyboard setProfile` write against the session's device and track it
 * as session setup (#14705): release drains tracked setup before its cleanup
 * runs, so a release racing the write restores what the write recorded instead
 * of being overwritten by it. The mutation receives the owning session id;
 * sessionless calls get none.
 */
export async function runSessionKeyboardProfileMutation<T>(
  sessionManager: SessionKeyboardProfileHost | undefined,
  sessionUuid: string | undefined,
  deviceId: string,
  mutation: (owner?: string) => Promise<T>,
): Promise<T> {
  if (!sessionManager || !sessionUuid) {
    return mutation();
  }
  const session = sessionManager.getSession(sessionUuid);
  if (
    !session ||
    !sessionManager.isAdmittedForAutomation(session) ||
    session.assignedDevice !== deviceId
  ) {
    throw new ActionableError(
      "Cannot change the keyboard profile: session is released, releasing, rebound, or replaced.",
    );
  }
  let completed = false;
  let result!: T;
  await sessionManager.trackSessionSetup(session, async () => {
    result = await mutation(session.sessionId);
    completed = true;
  });
  if (!completed) {
    throw new ActionableError(
      "Session began releasing or rebinding before the keyboard-profile change started; nothing was changed.",
    );
  }
  return result;
}
