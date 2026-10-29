import type { SessionManager } from "../daemon/sessionManager";
import { ActionableError } from "../models/ActionableError";

/** The slice of the session manager a tracked sensor write needs. */
export type SessionSensorHost = Pick<
  SessionManager,
  "getSession" | "isAdmittedForAutomation" | "trackSessionSetup"
>;

/** How the refusals name the change; the sensor wording is the default. */
export interface SessionMutationWording {
  /** Completes "Cannot …": e.g. "change an emulator sensor". */
  action: string;
  /** Names the change: e.g. "sensor change". */
  change: string;
}

const SENSOR_WORDING: SessionMutationWording = {
  action: "change an emulator sensor",
  change: "sensor change",
};

/**
 * Admit a `setSensor` write against the session's device and track it as session
 * setup (#14114), as `runSessionLocationMutation` does for location: release
 * drains tracked setup before its cleanup runs, so a release racing the write
 * restores what the write recorded instead of being overwritten by it. The
 * mutation receives the owning session id; sessionless calls get none.
 */
export async function runSessionSensorMutation<T>(
  sessionManager: SessionSensorHost | undefined,
  sessionUuid: string | undefined,
  deviceId: string,
  mutation: (owner?: string) => Promise<T>,
  wording: SessionMutationWording = SENSOR_WORDING,
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
      `Cannot ${wording.action}: session is released, releasing, rebound, or replaced.`,
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
      `Session began releasing or rebinding before the ${wording.change} started; nothing was changed.`,
    );
  }
  return result;
}
