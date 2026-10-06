import { DeviceLockRepository } from "../db/deviceLockRepository";
import {
  registerDeviceIncarnationListener,
  type DeviceIncarnationListener,
} from "../utils/deviceIncarnation";
import type { DeviceLockType, LockCredentialStore } from "../models/WakeAndUnlock";

/**
 * {@link LockCredentialStore} backed by the device-keyed `device_locks` table.
 *
 * Adapts the DB repository to the narrow store interface WakeAndUnlock depends
 * on, keeping the feature free of any DB import (issue #4360).
 */
export class DeviceLockStore implements LockCredentialStore {
  private readonly repository: DeviceLockRepository;

  constructor(repository: DeviceLockRepository = new DeviceLockRepository()) {
    this.repository = repository;
  }

  async getRecordedCredential(
    deviceId: string,
    identity: string | undefined,
  ): Promise<string | null> {
    return this.repository.getCredential(deviceId, identity);
  }

  async rememberLock(
    deviceId: string,
    lockType: DeviceLockType,
    credential: string | null,
    identity: string | undefined,
  ): Promise<void> {
    await this.repository.rememberLock(deviceId, lockType, credential, identity);
  }
}

export const DEVICE_LOCK_LISTENER_NAME = "android-device-lock-credentials";

/**
 * A different device now holds this serial (port reuse): the PIN learned on its
 * predecessor must never be typed into the new device's bouncer (#10065).
 */
export function createDeviceLockIdentityListener(
  repository: Pick<DeviceLockRepository, "forget">,
): DeviceIncarnationListener {
  return {
    name: DEVICE_LOCK_LISTENER_NAME,
    onDeviceIdentityReplaced: (deviceId) => {
      void repository.forget(deviceId);
    },
    // Snapshot restore and same-device re-pool keep the guest, and so its PIN.
    onDeviceIncarnationChanged: () => {},
  };
}

registerDeviceIncarnationListener(createDeviceLockIdentityListener(new DeviceLockRepository()));
