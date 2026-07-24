import { DeviceSessionRepository } from "../../db/deviceSessionRepository";
import type { DeviceLockType, LockCredentialStore } from "./WakeAndUnlock";

/**
 * {@link LockCredentialStore} backed by the `device_sessions` table.
 *
 * Adapts the DB repository to the narrow store interface WakeAndUnlock depends
 * on, keeping the feature free of any DB import (issue #4360).
 */
export class DeviceSessionLockStore implements LockCredentialStore {
  private readonly repository: DeviceSessionRepository;

  constructor(repository: DeviceSessionRepository = new DeviceSessionRepository()) {
    this.repository = repository;
  }

  async getRecordedCredential(deviceId: string): Promise<string | null> {
    return this.repository.getDeviceLockCredential(deviceId);
  }

  async rememberLock(deviceId: string, lockType: DeviceLockType, credential: string | null): Promise<void> {
    await this.repository.rememberDeviceLock(deviceId, lockType, credential);
  }
}
