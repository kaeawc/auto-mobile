import type { MatchingStrategy } from "../models/DeviceMatchCriteria";

/**
 * Device pool matching strategy.
 * Controls how a device is selected when multiple candidates match.
 * - LATEST: prefer highest OS version (default)
 * - RANDOM: random selection
 * - MINIMUM: prefer lowest OS version that satisfies the constraint
 */
const matchingOverride =
  process.env.AUTOMOBILE_DEVICE_POOL_MATCHING ??
  process.env.AUTO_MOBILE_DEVICE_POOL_MATCHING;
const validStrategies: MatchingStrategy[] = ["LATEST", "RANDOM", "MINIMUM"];
export const DEVICE_POOL_MATCHING: MatchingStrategy =
  matchingOverride && validStrategies.includes(matchingOverride as MatchingStrategy)
    ? (matchingOverride as MatchingStrategy)
    : "LATEST";

/**
 * Device pool autolock.
 * When enabled, startDevice generates a UUID that must be used
 * for all subsequent interactions with the device, and the device is
 * auto-released after an idle timeout. Read at call time so the daemon
 * picks up env changes without a restart.
 */
export function isDevicePoolAutolockEnabled(): boolean {
  const override =
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK ??
    process.env.AUTO_MOBILE_DEVICE_POOL_AUTOLOCK;
  return override === "1";
}

/**
 * Restart a pool-owned Android emulator after its process exits or its serial
 * is confirmed missing. Read at call time to support daemon configuration
 * changes without a restart.
 */
export function isAndroidRebootOnDeathEnabled(): boolean {
  const override =
    process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH ??
    process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
  return override === "1";
}

/**
 * Device pool idle timeout in milliseconds.
 * When autolock is enabled, a device is freed if no interaction
 * occurs within this duration. Default: 60 seconds.
 */
export function getDevicePoolTimeoutMs(): number {
  const override =
    process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT ??
    process.env.AUTO_MOBILE_DEVICE_POOL_TIMEOUT;
  const parsed = override ? Number.parseInt(override, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 60_000;
}
