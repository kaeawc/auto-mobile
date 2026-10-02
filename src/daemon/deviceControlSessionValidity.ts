import type { Session } from "./sessionManager";

interface DeviceControlSessionManager {
  getSession(id: string): Session | null;
  isAdmittedForAutomation?(session: Session): boolean;
}

interface DeviceControlSessionIdentity {
  sessionUuid?: string;
  sessionIncarnation?: object;
  routingSessionUuid?: string;
  routingSessionIncarnation?: object;
  deviceId?: string;
}

export function isDeviceControlTargetOwnerValid(
  manager: DeviceControlSessionManager,
  identity: DeviceControlSessionIdentity,
): boolean {
  if (!identity.sessionUuid) {
    return true;
  }
  const session = manager.getSession(identity.sessionUuid);
  return Boolean(
    session &&
    session === identity.sessionIncarnation &&
    manager.isAdmittedForAutomation?.(session) !== false &&
    (!identity.deviceId || session.assignedDevice === identity.deviceId),
  );
}

export function isDeviceControlRoutingSessionValid(
  manager: DeviceControlSessionManager,
  identity: DeviceControlSessionIdentity,
): boolean {
  if (!identity.routingSessionUuid || identity.routingSessionUuid === identity.sessionUuid) {
    return true;
  }
  const session = manager.getSession(identity.routingSessionUuid);
  return Boolean(
    session &&
    session === identity.routingSessionIncarnation &&
    manager.isAdmittedForAutomation?.(session) !== false,
  );
}
