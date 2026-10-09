import type { BootedDevice } from "../models";
import { ActionableError } from "../models/ActionableError";
import { listBootedDevicesForResource } from "./resourceDeviceResolver";

export interface DeviceObservationAccess {
  listBooted(signal: AbortSignal | undefined): Promise<BootedDevice[]>;
  isAuthorized(device: BootedDevice): boolean;
}

export const defaultDeviceObservationAccess: DeviceObservationAccess = {
  listBooted: (signal) =>
    listBootedDevicesForResource("either", "observe", { signal, requireFresh: true }),
  // The local daemon socket admits observation reads regardless of pool ownership.
  isAuthorized: () => true,
};

/** Resolve a read-only target without session creation or device-pool ownership changes. */
export async function resolveDeviceForObservationRead(
  deviceId: string,
  signal: AbortSignal | undefined,
  access: DeviceObservationAccess = defaultDeviceObservationAccess,
): Promise<BootedDevice> {
  const devices = await access.listBooted(signal);
  signal?.throwIfAborted();
  const matches = devices.filter(
    (device) => device.deviceId === deviceId || device.name === deviceId,
  );
  if (matches.length !== 1) {
    throw new ActionableError(
      `Expected one booted device for '${deviceId}'; found ${matches.length}.`,
    );
  }
  assertObservationReadAccess(matches[0], access);
  return matches[0];
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
): {
  resolve(deviceId: string, signal?: AbortSignal): Promise<BootedDevice>;
  assertAuthorized(device: BootedDevice): void;
} {
  return {
    resolve: (deviceId, signal) => resolveDeviceForObservationRead(deviceId, signal, access),
    assertAuthorized: (device) => assertObservationReadAccess(device, access),
  };
}
