import type { SessionManager } from "../daemon/sessionManager";
import { ActionableError } from "../models/ActionableError";

/** The slice of the session manager a tracked App Links write needs. */
export type SessionAppLinksHost = Pick<
  SessionManager,
  "getSession" | "isAdmittedForAutomation" | "trackSessionSetup"
>;

/**
 * Admit a `setAppLinks` write against the session's device and track it as
 * session setup (#14110), as `runSessionLocationMutation` does for location:
 * release drains tracked setup before its cleanup runs, so a release racing the
 * write restores what the write recorded instead of being overwritten by it.
 * The mutation receives the owning session id; sessionless calls get none.
 */
export async function runSessionAppLinksMutation<T>(
  sessionManager: SessionAppLinksHost | undefined,
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
      "Cannot change App Links state: session is released, releasing, rebound, or replaced.",
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
      "Session began releasing or rebinding before the App Links change started; nothing was changed.",
    );
  }
  return result;
}
