import type { SessionManager } from "../daemon/sessionManager";
import { ActionableError } from "../models/ActionableError";

interface SessionLocationScope {
  sessionManager?: SessionManager;
  sessionUuid?: string;
  deviceId: string;
}

/** Retain the session identity so a late write cannot borrow a replacement's admission. */
export function createSessionLocationWriteAdmission(options: SessionLocationScope): () => boolean {
  const { sessionManager, sessionUuid, deviceId } = options;
  if (!sessionManager || !sessionUuid) {
    return () => true;
  }
  const session = sessionManager.getSession(sessionUuid);
  return () =>
    !!session &&
    sessionManager.isAdmittedForAutomation(session) &&
    session.assignedDevice === deviceId;
}

/** Admit location writes against the resolved device before tracking their setup. */
export async function runSessionLocationMutation<T>(
  options: SessionLocationScope & {
    mutation: () => Promise<T>;
  },
): Promise<T> {
  const { sessionManager, sessionUuid, deviceId, mutation } = options;
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
      "Cannot change location: session is released, releasing, rebound, or replaced.",
    );
  }
  let completed = false;
  let result!: T;
  await sessionManager.trackSessionSetup(session, async () => {
    result = await mutation();
    completed = true;
  });
  if (!completed) {
    throw new ActionableError(
      "Session began releasing or rebinding before the location mutation started.",
    );
  }
  return result;
}
