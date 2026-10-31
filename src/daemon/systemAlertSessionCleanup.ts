import type { SessionManager } from "./sessionManager";
import {
  defaultSystemAlertPolicyRegistry,
  type SystemAlertPolicyRegistry,
} from "../features/action/systemAlerts/SystemAlertPolicy";

export interface SystemAlertSessionCleanupOptions {
  registry?: SystemAlertPolicyRegistry;
}

/**
 * Clear the `systemAlerts` policy a session set when that session is released or moves off the
 * device (#14106), so the device's next session does not inherit auto-answered permission prompts.
 * The policy lives only in daemon memory and touches nothing on the device, so this is a
 * synchronous registry removal with no pending device cleanup.
 */
export function registerSystemAlertSessionCleanup(
  manager: Pick<SessionManager, "onSessionRelease" | "onSessionDeviceUnbound">,
  options: SystemAlertSessionCleanupOptions = {},
): void {
  const registry = options.registry ?? defaultSystemAlertPolicyRegistry;
  const cleanup = (sessionId: string, deviceId: string): void => {
    registry.clearOwnedBy(deviceId, sessionId);
  };
  // A terminal upgrade of a finished release must not touch the device's next owner (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, releaseOptions) => {
    if (!releaseOptions?.upgradeOnly) {
      cleanup(sessionId, deviceId);
    }
  });
  manager.onSessionDeviceUnbound(cleanup);
}
