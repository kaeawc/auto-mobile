import type { ScreenLockCredentialType, ScreenLockRestoreReport } from "./ScreenLockTypes";

/** A credential a session set, kept so that session can change it and its release can clear it. */
export interface SessionScreenLock {
  deviceId: string;
  sessionId: string;
  type: ScreenLockCredentialType;
  credential: string;
}

/** Release reports kept for late `releaseSession` replies, as for keep-awake reports. */
const MAX_RESTORE_REPORTS = 64;

/**
 * In-memory record of the lock credentials sessions set (#14107), one per device. The credential
 * lives only here, for as long as its session holds the device: it is never persisted, so a
 * daemon restart loses it and the lock stays until someone clears it with the credential.
 */
export class ScreenLockRegistry {
  private readonly locks = new Map<string, SessionScreenLock>();
  private readonly restores = new Map<string, Promise<ScreenLockRestoreReport>>();

  get(deviceId: string): SessionScreenLock | undefined {
    return this.locks.get(deviceId);
  }

  record(lock: SessionScreenLock): void {
    this.locks.set(lock.deviceId, lock);
  }

  forget(deviceId: string): void {
    this.locks.delete(deviceId);
  }

  /** Remove and return the device's credential when `sessionId` set it. */
  takeOwnedBy(deviceId: string, sessionId: string): SessionScreenLock | undefined {
    const lock = this.locks.get(deviceId);
    if (lock?.sessionId !== sessionId) {
      return undefined;
    }
    this.locks.delete(deviceId);
    return lock;
  }

  /** Remember the clear a release started, for that release's result. */
  noteRestore(sessionId: string, restore: Promise<ScreenLockRestoreReport>): void {
    this.restores.delete(sessionId);
    this.restores.set(sessionId, restore);
    if (this.restores.size > MAX_RESTORE_REPORTS) {
      const oldest = this.restores.keys().next().value;
      if (oldest !== undefined) {
        this.restores.delete(oldest);
      }
    }
  }

  /** The outcome of the clear the session's release started, once it settles. */
  restoreReport(sessionId: string): Promise<ScreenLockRestoreReport> | undefined {
    return this.restores.get(sessionId);
  }
}

export const defaultScreenLockRegistry = new ScreenLockRegistry();
