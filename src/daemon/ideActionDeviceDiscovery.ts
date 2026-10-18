import type { BootedDevice } from "../models";
import {
  AndroidBootedDeviceDiscoveryIncompleteError,
  BootedDeviceDiscoveryIncompleteError,
} from "../models/BootedDeviceDiscoveryIncompleteError";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import { expectingPooledSources, isDeviceSourceIncomplete } from "../utils/discoverySource";
import type { DaemonStateAccess } from "./daemonRequestHandlers";

/** The slice of daemon state the `ide/*` device lookup reads to know which sources the pool expects. */
export interface IdeActionDaemonState {
  isInitialized: DaemonStateAccess["isInitialized"];
  getDevicePool(): {
    getAllDevices?: ReturnType<DaemonStateAccess["getDevicePool"]>["getAllDevices"];
  };
}

/**
 * Booted devices for an `ide/*` action on one serial. The legacy listing turns a
 * failed sweep into `[]`, which surfaced as a misleading "Device not found". When
 * the serial is absent and the discovery source that would have observed it failed
 * (adb for Android; simctl or devicectl for iOS, by serial shape), the absence
 * proves nothing, so refuse with the retryable discovery error instead (#11122,
 * cf. #11103, #11535).
 */
export async function listBootedDevicesForIdeAction(
  daemonState: IdeActionDaemonState | undefined,
  platform: "android" | "ios",
  serial: string,
  signal?: AbortSignal,
): Promise<BootedDevice[]> {
  signal?.throwIfAborted();
  const manager = PlatformDeviceManagerFactory.getInstance();
  const discovery = expectingPooledSources(
    await manager.getBootedDevicesDetailed(platform),
    daemonState?.isInitialized() ? daemonState.getDevicePool().getAllDevices?.() : undefined,
  );
  if (
    !discovery.devices.map((device) => device.deviceId).includes(serial) &&
    // Tooling that is not installed on this host is not an unknown: no retry can list the serial (#11605).
    isDeviceSourceIncomplete(discovery, platform, serial)
  ) {
    const discoveryError = discovery.discoveryErrors?.[platform];
    throw platform === "android"
      ? new AndroidBootedDeviceDiscoveryIncompleteError(discoveryError)
      : new BootedDeviceDiscoveryIncompleteError(platform, discoveryError);
  }
  signal?.throwIfAborted();
  return discovery.devices;
}
