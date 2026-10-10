import type { DevicePool } from "../daemon/devicePool";
import type { PlatformDeviceManager } from "../devices/deviceUtils";
import type { BootedDevice } from "../models";
import { getAbortSignal } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";

export interface AdbOfflineHeldDevice {
  device: BootedDevice;
  /** The pooled AVD name, for configured-image lookup. */
  avdName: string;
  /** The non-`device` state `adb devices` lists the serial in (e.g. `offline`). */
  adbState: string;
}

/**
 * Held Android devices that `adb devices` still lists in a non-`device` state. Online-only
 * discovery drops them, so without this a client polling an inventory surface during the
 * disconnect monitor's offline budget sees the device as unheld (#11118). Shared by the
 * booted-devices resource and the listDevices tool so both list the same device (#11455).
 * Best effort: a failed state probe leaves the listing as discovery produced it.
 */
export async function adbOfflineHeldDevices(input: {
  platform: string;
  discovered: readonly BootedDevice[];
  devicePool: DevicePool | null | undefined;
  deviceManager: Pick<PlatformDeviceManager, "getAndroidListedDeviceStates">;
}): Promise<AdbOfflineHeldDevice[]> {
  const { platform, devicePool, deviceManager } = input;
  if (platform !== "android" || !devicePool || !deviceManager.getAndroidListedDeviceStates) {
    return [];
  }
  const discoveredIds = new Set(input.discovered.map((device) => device.deviceId));
  const held = devicePool
    .getAssignedDevices()
    .filter((pooled) => pooled.platform === "android" && !discoveredIds.has(pooled.id));
  if (held.length === 0) {
    return [];
  }
  let states: Map<string, string>;
  try {
    states = await deviceManager.getAndroidListedDeviceStates(
      held.map((pooled) => pooled.id),
      { signal: getAbortSignal() },
    );
  } catch (error) {
    logger.warn(
      `[AdbOfflineHeldDevices] Offline held-device probe failed: ${errorMessage(error)}`,
      error,
    );
    return [];
  }
  return held.flatMap((pooled) => {
    const adbState = states.get(pooled.id);
    if (!adbState) {
      return [];
    }
    return [
      {
        device: { deviceId: pooled.id, name: pooled.name, platform: "android" as const },
        avdName: pooled.avdName ?? pooled.name,
        adbState,
      },
    ];
  });
}
