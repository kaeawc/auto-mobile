import type { SessionManager } from "./sessionManager";
import { daemonSimHidSessions } from "../utils/ios/simHid/IosSimulatorRawInput";
import type { SimHidSessions } from "../utils/ios/simHid/SimHidSessions";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";

/**
 * Warms the iOS Simulator HID helper when a session binds a simulator, so the first raw input
 * finds it running, and stops it when the session ends or loses the device (#19118).
 */
export function registerSimHidSessionLifecycle(
  manager: Pick<SessionManager, "onSessionCreated" | "onSessionRelease" | "onSessionDeviceUnbound">,
  sessions: Pick<SimHidSessions, "ready" | "release"> = daemonSimHidSessions,
): void {
  manager.onSessionCreated((session) => {
    if (
      session.platform === "ios" &&
      resolveIosDeviceKind({ deviceId: session.assignedDevice }) === "simulator"
    ) {
      // ready() starts the helper in the background and never throws; its start logs failures.
      sessions.ready(session.assignedDevice);
    }
  });
  manager.onSessionRelease((_sessionId, deviceId, _reason, options) => {
    if (!options?.upgradeOnly && deviceId) {
      sessions.release(deviceId);
    }
  });
  manager.onSessionDeviceUnbound((_sessionId, deviceId) => {
    if (deviceId) {
      sessions.release(deviceId);
    }
  });
}
