/**
 * Represents an Android user profile on a device
 * Android supports multiple users (personal profile, work profiles, etc.)
 */
export interface AndroidUser {
  /**
   * User ID number (e.g., 0 for primary user, 10 for work profile)
   */
  userId: number;

  /**
   * User name/label (e.g., "Owner", "Work profile")
   */
  name: string;

  /**
   * User type flags as reported by Android
   * Common flags:
   * - 13: Primary user (personal profile)
   * - 30: Managed profile (work profile)
   */
  flags: number;

  /**
   * Classification derived from Android's flags, never from the numeric ID.
   * `unknown` is intentional when the platform does not provide enough
   * metadata to distinguish a secondary user from a managed profile.
   */
  profileType?: "primary" | "managed" | "secondary" | "unknown";

  /**
   * Whether the user is currently running
   */
  running: boolean;

  /**
   * Raw lifecycle state from `dumpsys user` when available, such as
   * `RUNNING_LOCKED` or `RUNNING_UNLOCKED`.
   */
  startState?: string;
}

export function classifyAndroidUser(flags: number): NonNullable<AndroidUser["profileType"]> {
  const FLAG_MAIN = 0x4000;
  if ((flags & 0x20) !== 0) {
    return "managed";
  }
  if ((flags & FLAG_MAIN) !== 0 || (flags & 0x1) !== 0) {
    return "primary";
  }
  if ((flags & 0x400) !== 0) {
    return "secondary";
  }
  return "unknown";
}
