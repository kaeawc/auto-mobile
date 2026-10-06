/** How a device's keyguard is protected, as far as AutoMobile can tell/remember. */
export type DeviceLockType = "none" | "swipe" | "pin" | "password" | "pattern";

/**
 * Persistence seam for remembering how to unlock a device across a session.
 *
 * Backed by the `device_sessions` table in production; a fake in tests. Kept a
 * narrow interface (YAGNI) so WakeAndUnlock does not depend on the repository.
 */
export interface LockCredentialStore {
  /**
   * The credential remembered for a device, or `null` if none is recorded.
   * `identity` is the device's stable identity (see `stableDeviceIdentityOf`): a
   * credential is only replayed on the device it was learned on, so an unknown
   * (`undefined`) or different identity behind the same serial yields `null`.
   */
  getRecordedCredential(deviceId: string, identity: string | undefined): Promise<string | null>;
  /**
   * Remember how to unlock a device (lock type + optional credential), tagged
   * with the stable identity it was learned on.
   */
  rememberLock(
    deviceId: string,
    lockType: DeviceLockType,
    credential: string | null,
    identity: string | undefined,
  ): Promise<void>;
}

export interface WakeAndUnlockResult {
  success: boolean;
  platform: "android" | "ios";
  /** Whether the device was asleep before this call (Android; unknown on iOS). */
  wasAsleep: boolean;
  /** Whether the keyguard was obscuring the app before this call. */
  wasLocked: boolean;
  /** Whether the lock was credential-protected (Android; undefined if unknown). */
  secure?: boolean;
  /** Whether the device is unlocked after this call. */
  unlocked: boolean;
  /** True when a secure device was unlocked using a previously-remembered PIN. */
  usedRecordedCredential?: boolean;
  error?: string;
  /** Device unlocked, but the iOS runner may still need time before the next observe. */
  warning?: string;
}
