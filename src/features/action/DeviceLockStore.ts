import { DeviceLockRepository } from "../../db/deviceLockRepository";
import type { DeviceLockType, LockCredentialStore } from "./WakeAndUnlock";

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

  async getRecordedCredential(deviceId: string): Promise<string | null> {
    return this.repository.getCredential(deviceId);
  }

  async rememberLock(
    deviceId: string,
    lockType: DeviceLockType,
    credential: string | null,
  ): Promise<void> {
    await this.repository.rememberLock(deviceId, lockType, credential);
  }
}
