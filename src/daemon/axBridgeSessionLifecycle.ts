import type { SessionManager } from "./sessionManager";
import { serverConfig } from "../utils/ServerConfig";
import { defaultIdGenerator } from "../utils/IdGenerator";
import { defaultTimer } from "../utils/SystemTimer";
import { AXBridgeSessions } from "../utils/ios/AXBridgeSessions";
import { DefaultAXBridgePreflight } from "../utils/ios/AXBridgePreflight";
import { DefaultAXBridgeProcessLauncher } from "../utils/ios/AXBridgeProcessLauncher";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import { logger } from "../utils/logger";

export const daemonAXBridgeSessions = new AXBridgeSessions({
  enabled: () => serverConfig.isIosAxBridgeEnabled(),
  preflight: new DefaultAXBridgePreflight(),
  launcher: new DefaultAXBridgeProcessLauncher(),
  idGenerator: defaultIdGenerator,
  timer: defaultTimer,
});

export function registerAXBridgeSessionLifecycle(
  manager: Pick<
    SessionManager,
    | "onSessionCreated"
    | "onSessionRelease"
    | "onSessionDeviceUnbound"
    | "onDeviceOwnershipChange"
    | "getSessionForDevice"
    | "peekSession"
  >,
  sessions: AXBridgeSessions = daemonAXBridgeSessions,
): void {
  const start = (sessionId: string, deviceId: string): void => {
    if (resolveIosDeviceKind({ deviceId }) !== "simulator") {
      return;
    }
    void sessions.start(sessionId, deviceId).catch((error: unknown) => {
      logger.warn(`AXBridge unavailable for session ${sessionId}`, error);
    });
  };
  manager.onSessionCreated((session) => {
    if (session.platform === "ios") {
      start(session.sessionId, session.assignedDevice);
    }
  });
  manager.onDeviceOwnershipChange((deviceId, invalidation) => {
    if (invalidation !== "full") {
      return;
    }
    const sessionId = manager.getSessionForDevice(deviceId);
    if (sessionId && manager.peekSession(sessionId)?.platform === "ios") {
      start(sessionId, deviceId);
    }
  });
  manager.onSessionRelease((sessionId, _deviceId, _reason, options) => {
    if (!options?.upgradeOnly) {
      sessions.release(sessionId);
    }
  });
  manager.onSessionDeviceUnbound((sessionId) => sessions.release(sessionId));
}
