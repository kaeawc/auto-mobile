import { ActionableError, BootedDevice } from "../../models";
import type { NotificationUIDetector } from "../../utils/interfaces/NotificationUIDetector";
import type {
  SystemTrayAdb,
  SystemTrayDependencies,
  SystemTrayIosClient,
} from "../systemTrayHelpers";
import {
  AndroidNotificationUIDetector,
  type AndroidNotificationUIDetectorDeps,
} from "./AndroidNotificationUIDetector";
import {
  IosNotificationUIDetector,
  type IosNotificationUIDetectorDeps,
} from "./IosNotificationUIDetector";

/**
 * Build the platform-appropriate {@link NotificationUIDetector} for
 * `device`. The detector adapts the broader {@link SystemTrayDependencies}
 * down to the minimal surface each implementation needs, and reads from
 * the supplied getter lazily so callers that mutate dependencies via
 * `setSystemTrayDependencies` between calls still see fresh fakes.
 */
export function createNotificationUIDetector(
  device: BootedDevice,
  getDependencies: () => SystemTrayDependencies,
): NotificationUIDetector {
  if (device.platform === "ios") {
    const deps: IosNotificationUIDetectorDeps = {
      requestSwipe: (x1, y1, x2, y2, duration) =>
        getIosClient(device, getDependencies).requestSwipe(x1, y1, x2, y2, duration),
      requestTapCoordinates: (x, y) =>
        getIosClient(device, getDependencies).requestTapCoordinates(x, y),
      now: () => getDependencies().timer.now(),
    };
    return new IosNotificationUIDetector(device, deps);
  }

  const deps: AndroidNotificationUIDetectorDeps = {
    executeAdbCommand: (command) => getAdb(device, getDependencies).executeCommand(command),
    getDeviceTimestampMs: () => getAdb(device, getDependencies).getDeviceTimestampMs(),
  };
  return new AndroidNotificationUIDetector(device, deps);
}

function getIosClient(
  device: BootedDevice,
  getDependencies: () => SystemTrayDependencies,
): SystemTrayIosClient {
  const { iosClientFactory } = getDependencies();
  if (!iosClientFactory) {
    throw new ActionableError("iOS CtrlProxy client not configured for systemTray");
  }
  return iosClientFactory(device);
}

function getAdb(
  device: BootedDevice,
  getDependencies: () => SystemTrayDependencies,
): SystemTrayAdb {
  return getDependencies().adbFactory(device);
}
