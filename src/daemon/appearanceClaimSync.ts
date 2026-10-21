import type { DevicePool } from "./devicePool";
import type { PassiveWorkPolicy } from "./PassiveWorkPolicy";
import type { SessionManager } from "./sessionManager";
import { syncAppearanceForDevice, type AppearanceSyncTarget } from "./AppearanceSyncScheduler";
import { resolveAppearanceSessionKey } from "./appearanceSessionKey";

/** The daemon collaborators a claim reads, resolved per claim: the pool is created after wiring. */
export interface AppearanceClaimSyncHost {
  devicePool(): Pick<DevicePool, "getDevice">;
  passiveWorkPolicy(): Pick<PassiveWorkPolicy, "allows">;
}

export interface AppearanceClaimSyncDependencies {
  /** Applies the holder's resolved mode; must not reject. */
  sync: (target: AppearanceSyncTarget) => Promise<void>;
  resolveSessionKey: (sessionId: string) => string | undefined;
}

// Lambdas, so the module bindings are read at each claim (a test may replace the scheduler's).
const defaultDependencies: AppearanceClaimSyncDependencies = {
  sync: (target) => syncAppearanceForDevice(target),
  resolveSessionKey: (sessionId) => resolveAppearanceSessionKey(sessionId),
};

/**
 * Applies a session's appearance to the device it claims (#11363): when the session is created on
 * the device, which is how an observer's `setActiveDevice` claims one, and when it is rebound to
 * another device. `setActiveDevice` never runs device readiness, so without this the explicit
 * light/dark an observer stored would wait for nothing: the host-sync tick only re-applies a config
 * that follows the host.
 */
export function registerAppearanceClaimSync(
  sessionManager: Pick<
    SessionManager,
    "onSessionCreated" | "onDeviceOwnershipChange" | "getSessionForDevice"
  >,
  host: AppearanceClaimSyncHost,
  dependencies: AppearanceClaimSyncDependencies = defaultDependencies,
): void {
  const applyOnClaim = (sessionId: string, deviceId: string): void => {
    if (!host.passiveWorkPolicy().allows("android", "appearance-sync", deviceId)) {
      return;
    }
    const device = host.devicePool().getDevice(deviceId);
    if (device?.platform !== "android") {
      return;
    }
    void dependencies.sync({
      deviceId: device.id,
      name: device.id,
      platform: "android",
      incarnation: device.incarnation,
      sessionKey: dependencies.resolveSessionKey(sessionId),
    });
  };
  sessionManager.onSessionCreated((session) => {
    applyOnClaim(session.sessionId, session.assignedDevice);
  });
  // A rebind is the only ownership change that invalidates frames in full, for both the device it
  // left and the one it moved to (the signal the prototype tools observe rebinds by). Only the
  // device the session now holds has a holder to apply for.
  sessionManager.onDeviceOwnershipChange((deviceId, frameInvalidation) => {
    if (frameInvalidation !== "full") {
      return;
    }
    const holder = sessionManager.getSessionForDevice(deviceId);
    if (holder) {
      applyOnClaim(holder, deviceId);
    }
  });
}
