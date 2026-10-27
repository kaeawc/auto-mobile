import type { SessionManager } from "./sessionManager";
import {
  defaultDeviceConditionRegistry,
  type DeviceConditionRegistry,
} from "../features/deviceCondition/DeviceConditionRegistry";

/**
 * Restore any session-scoped device conditions on release or device unbind
 * (#14050), so a device never returns to the pool holding a session's root,
 * integrity or fault fixture. Hooks the same release/unbound seams as
 * `registerNetworkStateSessionCleanup`.
 *
 * The restore is synchronous-safe: with no injectors it is a no-op, and once
 * injectors land it tears down through the controller's own reverse-order reset.
 * It is registered as pending device cleanup so the next acquirer does not bind
 * the device mid-restore.
 */
export function registerDeviceConditionSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  registry: DeviceConditionRegistry = defaultDeviceConditionRegistry,
): void {
  manager.onSessionRelease((sessionId, deviceId) => {
    const owner = { deviceId, sessionUuid: sessionId };
    if (!registry.hasActiveConditions(owner)) {
      return;
    }
    manager.registerPendingDeviceCleanup(deviceId, registry.restore(owner), {
      name: "restore device condition",
      leftover: "the released session's device-condition fixtures",
    });
  });
  manager.onSessionDeviceUnbound((sessionId, deviceId) => {
    const owner = { deviceId, sessionUuid: sessionId };
    if (!registry.hasActiveConditions(owner)) {
      return;
    }
    manager.registerPendingDeviceCleanup(deviceId, registry.restore(owner), {
      name: "restore device condition",
      leftover: "the unbound session's device-condition fixtures",
    });
  });
}
