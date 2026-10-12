import { matchRunningReadTarget, providedReadTargetNotFound } from "../devices/runningReadTarget";
import type { BootedDevice, SomePlatform } from "../models";
import { ActionableError } from "../models/ActionableError";
import {
  listBootedDevicesForResource,
  listBootedDevicesForReadWithStatus,
  type BootedResourceReadListing,
} from "./resourceDeviceResolver";
import { BootedDeviceDiscoveryIncompleteError } from "../models/BootedDeviceDiscoveryIncompleteError";
import { sequenceBackoff, type BackoffInput } from "../utils/Backoff";
import { type Timer } from "../utils/SystemTimer";
import { DefaultRetryExecutor } from "../utils/retry/RetryExecutor";

export interface DeviceObservationAccess {
  listBooted(signal: AbortSignal | undefined): Promise<BootedDevice[]>;
  listBootedWithStatus?(signal: AbortSignal | undefined): Promise<BootedResourceReadListing>;
  isAuthorized(device: BootedDevice): boolean;
}

export const defaultDeviceObservationAccess: DeviceObservationAccess = {
  listBooted: (signal) =>
    listBootedDevicesForResource("either", "observe", { signal, requireFresh: true }),
  listBootedWithStatus: (signal) => listBootedDevicesForReadWithStatus("either", "observe", signal),
  // The local daemon socket admits observation reads regardless of pool ownership.
  isAuthorized: () => true,
};

export interface DeviceReadRetryOptions {
  timer?: Timer;
  backoff?: BackoffInput;
}

function incompleteReadPlatform(listing: BootedResourceReadListing, platform: SomePlatform) {
  return (["android", "ios"] as const).find(
    (p) =>
      (platform === "either" || platform === p) &&
      !listing.scanned[p] &&
      (platform !== "either" || listing.discoveryErrors?.[p]?.code !== "unavailable"),
  );
}

function retryableReadDiscovery(error: unknown): boolean {
  return (
    error instanceof BootedDeviceDiscoveryIncompleteError &&
    error.discoveryError?.code !== "unavailable"
  );
}

/** Retry only unproven absence; a fresh match on a healthy platform answers immediately. */
async function findObservationReadTarget(
  deviceId: string,
  signal: AbortSignal | undefined,
  access: DeviceObservationAccess,
  platform: SomePlatform,
  retry: DeviceReadRetryOptions,
): Promise<{ device: BootedDevice | undefined; devices: BootedDevice[] }> {
  try {
    return await new DefaultRetryExecutor(retry.timer).executeOrThrow(
      async () => {
        signal?.throwIfAborted();
        const listing = access.listBootedWithStatus
          ? await access.listBootedWithStatus(signal)
          : { devices: await access.listBooted(signal), scanned: { android: true, ios: true } };
        signal?.throwIfAborted();
        const fresh = listing.devices.filter((device) => listing.scanned[device.platform]);
        const device = matchRunningReadTarget(fresh, deviceId, platform);
        if (!device) {
          const failedPlatform = incompleteReadPlatform(listing, platform);
          if (failedPlatform) {
            throw new BootedDeviceDiscoveryIncompleteError(
              failedPlatform,
              listing.discoveryErrors?.[failedPlatform],
            );
          }
        }
        return { device, devices: fresh };
      },
      {
        maxAttempts: 3,
        delays: retry.backoff ?? sequenceBackoff([250, 750]),
        signal,
        shouldRetry: retryableReadDiscovery,
        expectedFailure: {
          reason: "read discovery remains incomplete",
          matches: (error) => error instanceof BootedDeviceDiscoveryIncompleteError,
        },
      },
    );
  } catch (error) {
    // Cancellation preserves the caller's exact reason, including a bare abort's DOMException.
    signal?.throwIfAborted();
    throw error;
  }
}

/** Resolve a read-only target without session creation or device-pool ownership changes. */
export async function resolveDeviceForObservationRead(
  deviceId: string,
  signal: AbortSignal | undefined,
  access: DeviceObservationAccess = defaultDeviceObservationAccess,
  platform: SomePlatform = "either",
  retry: DeviceReadRetryOptions = {},
): Promise<BootedDevice> {
  const { device, devices } = await findObservationReadTarget(
    deviceId,
    signal,
    access,
    platform,
    retry,
  );
  if (!device) {
    throw providedReadTargetNotFound(deviceId, platform, devices);
  }
  assertObservationReadAccess(device, access);
  return device;
}

export function assertObservationReadAccess(
  device: BootedDevice,
  access: DeviceObservationAccess = defaultDeviceObservationAccess,
): void {
  if (!access.isAuthorized(device)) {
    throw new ActionableError("Observation access denied.");
  }
}

/**
 * The read-only device path for a device-aware tool (#10830): resolve the target from the booted
 * list and authorize it, without acquiring, readying or pinning a device.
 */
export function sessionlessDeviceReadFor(
  access: DeviceObservationAccess = defaultDeviceObservationAccess,
  retry: DeviceReadRetryOptions = {},
): {
  resolve(deviceId: string, signal?: AbortSignal, platform?: SomePlatform): Promise<BootedDevice>;
  findRunning?(
    deviceId: string,
    signal?: AbortSignal,
    platform?: SomePlatform,
  ): Promise<BootedDevice | undefined>;
  assertAuthorized(device: BootedDevice): void;
} {
  return {
    resolve: (deviceId, signal, platform) =>
      resolveDeviceForObservationRead(deviceId, signal, access, platform, retry),
    findRunning: async (deviceId, signal, platform) => {
      const { device } = await findObservationReadTarget(
        deviceId,
        signal,
        access,
        platform ?? "either",
        retry,
      );
      return device;
    },
    assertAuthorized: (device) => assertObservationReadAccess(device, access),
  };
}
