import type { BootedDevice } from "../models";

/** Server-owned host caches participate in snapshot restore through this port. */
export interface DeviceIncarnationInvalidator {
  prepareForIncarnationChange(device: BootedDevice): Promise<void>;
  invalidate(device: BootedDevice): Promise<string | void>;
  settleIncarnationChange(device: BootedDevice, outcome: { ready: boolean }): Promise<void>;
}

let invalidator: DeviceIncarnationInvalidator = {
  prepareForIncarnationChange: async () => {},
  invalidate: async () => {},
  settleIncarnationChange: async () => {},
};

export function registerDeviceSnapshotIncarnationInvalidator(
  next: DeviceIncarnationInvalidator,
): () => void {
  const previous = invalidator;
  invalidator = next;
  return () => {
    invalidator = previous;
  };
}

/** Resolve at call time so dependencies created before server registration stay live. */
export const deviceSnapshotIncarnationInvalidator: DeviceIncarnationInvalidator = {
  prepareForIncarnationChange: (...args) => invalidator.prepareForIncarnationChange(...args),
  invalidate: (...args) => invalidator.invalidate(...args),
  settleIncarnationChange: (...args) => invalidator.settleIncarnationChange(...args),
};
