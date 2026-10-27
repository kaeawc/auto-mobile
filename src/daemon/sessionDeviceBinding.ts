import type { Session } from "./sessionManager/sessionTypes";

export type SessionDeviceIdentity = Pick<
  Session,
  "sessionId" | "assignedDevice" | "stableDeviceId" | "deviceGeneration" | "previousDeviceId"
>;

/** Client-verifiable binding within the current daemon lifetime. */
export function sessionDeviceBinding(session: SessionDeviceIdentity) {
  return {
    sessionUuid: session.sessionId,
    deviceId: session.assignedDevice,
    ...(session.stableDeviceId !== undefined ? { stableDeviceId: session.stableDeviceId } : {}),
    generation: session.deviceGeneration ?? 0,
    ...(session.previousDeviceId !== undefined
      ? { previousDeviceId: session.previousDeviceId }
      : {}),
  };
}

/**
 * Diagnostic surfaces retain their established device/session field names. A session that has
 * never changed serial adds nothing, so steady-state responses stay byte-identical.
 */
export function sessionDeviceInfo(session: SessionDeviceIdentity) {
  const { stableDeviceId, generation, previousDeviceId } = sessionDeviceBinding(session);
  if (generation === 0) {
    return {};
  }
  return {
    deviceGeneration: generation,
    ...(stableDeviceId !== undefined ? { stableDeviceId } : {}),
    ...(previousDeviceId !== undefined ? { previousDeviceId } : {}),
  };
}
