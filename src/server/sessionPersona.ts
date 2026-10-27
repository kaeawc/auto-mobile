import type { SessionManager } from "../daemon/sessionManager";
import { ActionableError } from "../models/ActionableError";

/** The slice of the session manager a tracked persona write needs. */
export type SessionPersonaHost = Pick<
  SessionManager,
  "getSession" | "isAdmittedForAutomation" | "trackSessionSetup"
>;

/**
 * Admit a `manufacturerProfile` write against the session's device and track it as
 * session setup (#14055): release drains tracked setup before its cleanup runs,
 * so a release racing the write restores what the write recorded instead of
 * being overwritten by it. The mutation receives the owning session id;
 * sessionless calls get none.
 */
export async function runSessionPersonaMutation<T>(
  sessionManager: SessionPersonaHost | undefined,
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
      "Cannot apply or reset a manufacturer profile: session is released, releasing, rebound, or replaced.",
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
      "Session began releasing or rebinding before the manufacturer profile change started; nothing was changed.",
    );
  }
  return result;
}
