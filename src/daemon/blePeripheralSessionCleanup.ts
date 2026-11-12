import { defaultBlePeripheralManager } from "../features/blePeripheral/defaultBlePeripheralManager";
import type { BlePeripheralManager } from "../features/blePeripheral/BlePeripheralManager";
import type { SessionManager } from "./sessionManager";

/** Release/unbind kills host-owned sidecars even when device identity was replaced. */
export function registerBlePeripheralSessionCleanup(
  sessions: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  peripherals: Pick<
    BlePeripheralManager,
    "releaseSession" | "unbindSession"
  > = defaultBlePeripheralManager,
): void {
  const cleanup = (deviceId: string, stopping: Promise<void>) => {
    sessions.registerPendingDeviceCleanup(deviceId, stopping, {
      name: "stop BLE peripherals",
      leftover: "the released session's Bumble sidecars",
    });
  };
  sessions.onSessionRelease((owner, deviceId, _reason, options) => {
    if (!options.upgradeOnly) {
      cleanup(deviceId, peripherals.releaseSession(owner));
    }
  });
  sessions.onSessionDeviceUnbound((owner, deviceId) =>
    cleanup(deviceId, peripherals.unbindSession(owner)),
  );
}
