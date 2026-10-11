import type { DevicePool } from "../daemon/devicePool";
import type { DeviceDiscoveryError, PlatformDeviceManager } from "../devices/deviceUtils";
import type { BootedDevice } from "../models";
import { BootedDeviceDiscoveryIncompleteError } from "../models/BootedDeviceDiscoveryIncompleteError";
import type { TransitionalSimulator } from "../models/TransitionalSimulator";
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
 * A failed state probe leaves the listing as discovery produced it, unless the caller counts
 * devices (`onProbeFailure: "throw"`): a count must be unknown, never zero, when the probe cannot
 * say whether a held device is still attached (#11573).
 */
export async function adbOfflineHeldDevices(input: {
  platform: string;
  discovered: readonly BootedDevice[];
  devicePool: DevicePool | null | undefined;
  deviceManager: Pick<PlatformDeviceManager, "getAndroidListedDeviceStates">;
  /**
   * What a failed probe means. `throw` refuses with `discovery_incomplete`; a callback receives
   * the failure so a listing can mark its observation incomplete and still list what it has;
   * `ignore` (default) lists what discovery produced.
   */
  onProbeFailure?: "ignore" | "throw" | ((failure: DeviceDiscoveryError) => void);
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
    const failure: DeviceDiscoveryError = {
      code: "failed",
      message: `Held-device state probe failed: ${errorMessage(error)}`,
    };
    if (input.onProbeFailure === "throw") {
      throw new BootedDeviceDiscoveryIncompleteError("android", failure);
    }
    if (typeof input.onProbeFailure === "function") {
      input.onProbeFailure(failure);
    }
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

export interface TransitionalHeldSimulator {
  device: BootedDevice;
  /** The `simctl` state, `Booting` or `Shutting Down`. */
  simulatorState: TransitionalSimulator["state"];
}

/**
 * Held iOS simulators that `simctl` lists `Booting` or `Shutting Down`. Booted discovery drops
 * them, so without this a session's own simulator vanishes from every inventory surface for the
 * length of the transition (#11573). Only simulators the pool assigns to a session are returned;
 * an unheld one stays unlisted as before. Reads the sweep's own listing: no extra simctl call.
 */
export function transitionalHeldSimulators(input: {
  transitional: readonly TransitionalSimulator[] | undefined;
  discovered: readonly BootedDevice[];
  devicePool: Pick<DevicePool, "getAssignedDevices"> | null | undefined;
}): TransitionalHeldSimulator[] {
  const { transitional, devicePool } = input;
  if (!transitional?.length || !devicePool) {
    return [];
  }
  const discoveredIds = new Set(input.discovered.map((device) => device.deviceId));
  const heldIds = new Set(
    devicePool
      .getAssignedDevices()
      .filter((pooled) => pooled.platform === "ios")
      .map((pooled) => pooled.id),
  );
  return transitional
    .filter(({ device }) => heldIds.has(device.deviceId) && !discoveredIds.has(device.deviceId))
    .map(({ device, state }) => ({ device, simulatorState: state }));
}
