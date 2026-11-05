import { getDeviceToolsDependencies } from "../features/deviceLifecycle/deviceLifecycleCore";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";

/**
 * Tells booted-device and device-image resource subscribers that a watchOS, tvOS or visionOS
 * simulator was created, cold-booted or deleted, as Android/iOS provisioning does. The change is
 * already committed, so a failed notification is logged and never fails the tool call.
 */
export function notifyAppleSimulatorInventoryChanged(change: string): void {
  void getDeviceToolsDependencies()
    .notifyResourcesChanged()
    .catch((error: unknown) => {
      logger.warn(
        `[DeviceTools] Failed to notify resource changes after ${change}: ${errorMessage(error)}`,
        error,
      );
    });
}

/** provisionDevice changed the inventory when it created the simulator or cold-booted it. */
export function notifyAfterAppleSimulatorProvision(
  simulator: string,
  created: boolean,
  booted: { boot: { acquisition: string } } | undefined,
): void {
  if (created || booted?.boot.acquisition === "cold-boot") {
    notifyAppleSimulatorInventoryChanged(`provisioning ${simulator}`);
  }
}
