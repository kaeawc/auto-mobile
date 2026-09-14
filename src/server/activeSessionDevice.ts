import { DaemonState } from "../daemon/daemonState";
import { resolveDirectSessionDevice } from "./directSessionDeviceRegistry";
import type { BootedDevice } from "../models";

/**
 * The device a live device session currently owns, as a session-scoped MCP
 * resource sees it. Shared by every `automobile:device-session/{sessionUuid}/…`
 * resource family so "bound to the caller's session" means the same thing for
 * screenshots (#6940) and execution logs (#7006).
 */
export interface ActiveSessionDevice {
  sessionUuid: string;
  device: BootedDevice;
  incarnation?: number;
}

export type ActiveSessionResolver = (sessionUuid: string) => ActiveSessionDevice | undefined;

let nextSessionIncarnation = 0;
const sessionIncarnations = new WeakMap<object, number>();

function getSessionIncarnation(session: object): number {
  const existing = sessionIncarnations.get(session);
  if (existing !== undefined) {
    return existing;
  }
  const incarnation = ++nextSessionIncarnation;
  sessionIncarnations.set(session, incarnation);
  return incarnation;
}

/**
 * Resolve a session UUID to the device it owns right now, or `undefined` when
 * the session is unknown, released, or no longer the device's owner. Pure
 * bookkeeping: it never discovers devices or constructs device clients.
 */
export function resolveActiveSessionDevice(sessionUuid: string): ActiveSessionDevice | undefined {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return resolveDirectSessionDevice(sessionUuid);
  }

  const session = daemonState.getSessionManager().getSession(sessionUuid);
  if (!session) {
    return undefined;
  }

  const pooledDevice = daemonState.getDevicePool().getDevice(session.assignedDevice);
  if (!pooledDevice || pooledDevice.sessionId !== sessionUuid) {
    return undefined;
  }

  return {
    sessionUuid,
    incarnation: getSessionIncarnation(session),
    device: {
      deviceId: pooledDevice.id,
      name: pooledDevice.name,
      platform: pooledDevice.platform,
      iosVersion: pooledDevice.iosVersion,
    },
  };
}
