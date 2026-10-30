import type { BootedDevice, Platform } from "../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  defaultDeviceTraits,
  type DeviceTraits,
  type TraitFormFactor,
} from "../utils/android-cmdline-tools/deviceTraits";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";

/**
 * Identifying build props of a booted Android device (#14046). Absent when the device was not
 * probed (iOS, quarantined, offline) or the read failed; a null field is a prop the device
 * left empty.
 */
export interface BootedDeviceTraits {
  manufacturer: string | null;
  brand: string | null;
  model: string | null;
  sdk: number | null;
  abi: string | null;
  /** `"watch"`, `"automotive"` or `"tv"` when the build announces it; null otherwise. */
  formFactor: TraitFormFactor | null;
}

export interface WithTraits {
  traits?: BootedDeviceTraits;
}

export interface Dependencies {
  /** A fake reader opts resource tests into the traits probe without touching real adb. */
  injectedDeviceTraits?: DeviceTraits | null;
}

export const DEVICE_TRAITS_TIMEOUT_MS = 3_000;

export interface DeviceTraitsEnrichment<T> {
  /** The device to address, or null when this entry must not be probed. */
  target: (device: T) => BootedDevice | null;
  /** Production probes are on; a fake device manager turns them off. */
  serviceStatusEnabled: boolean;
  timer: Timer;
  deps: Dependencies;
  adbFactory?: AdbClientFactory;
}

async function readTraits(
  reader: DeviceTraits,
  adbFactory: AdbClientFactory,
  device: BootedDevice,
  timer: Timer,
): Promise<BootedDeviceTraits | undefined> {
  try {
    const traits = await raceWithDeadline(
      reader.read(adbFactory.create(device), device.deviceId, {
        timeoutMs: DEVICE_TRAITS_TIMEOUT_MS,
      }),
      { timer, timeoutMs: DEVICE_TRAITS_TIMEOUT_MS, label: "Device traits probe" },
    );
    const { manufacturer, brand, model, sdk, abi, formFactor } = traits;
    return { manufacturer, brand, model, sdk, abi, formFactor };
  } catch (error) {
    // Traits are descriptive; a failed read only leaves them off this entry.
    logger.warn(
      `[BootedDeviceResources] Device traits unavailable for ${device.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return undefined;
  }
}

/** Attach {@link BootedDeviceTraits} to every probeable Android entry, in place. */
export async function enrich<T extends { platform: Platform } & WithTraits>(
  devices: T[],
  options: DeviceTraitsEnrichment<T>,
): Promise<void> {
  const reader =
    options.deps.injectedDeviceTraits ??
    (options.serviceStatusEnabled ? defaultDeviceTraits : null);
  if (!reader) {
    return;
  }
  const adbFactory = options.adbFactory ?? defaultAdbClientFactory;
  const traits = await Promise.all(
    devices.map(async (device) => {
      const target = device.platform === "android" ? options.target(device) : null;
      return target ? await readTraits(reader, adbFactory, target, options.timer) : undefined;
    }),
  );
  for (let i = 0; i < devices.length; i++) {
    const value = traits[i];
    if (value) {
      devices[i] = { ...devices[i], traits: value };
    }
  }
}
