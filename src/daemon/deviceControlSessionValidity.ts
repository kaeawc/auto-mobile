import { isSessionReleasing } from "./sessionReleaseState";
import type { Session } from "./sessionManager";

interface DeviceControlSessionManager {
  getSession(id: string): Session | null;
  getReleasingSession?(sessionId: string): unknown | null;
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
    !isSessionReleasing(manager, identity.sessionUuid, session) &&
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
    !isSessionReleasing(manager, identity.routingSessionUuid, session),
  );
}
