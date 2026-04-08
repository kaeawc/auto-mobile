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
 * When set to "1", startDevice generates a UUID that must be used
 * for all subsequent interactions with the device.
 */
const autolockOverride =
  process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK ??
  process.env.AUTO_MOBILE_DEVICE_POOL_AUTOLOCK;
export const DEVICE_POOL_AUTOLOCK_ENABLED = autolockOverride === "1";

/**
 * Device pool idle timeout in milliseconds.
 * When autolock is enabled, a device is freed if no interaction
 * occurs within this duration. Default: 60 seconds.
 */
const timeoutOverride =
  process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT ??
  process.env.AUTO_MOBILE_DEVICE_POOL_TIMEOUT;
const parsedTimeout = timeoutOverride
  ? Number.parseInt(timeoutOverride, 10)
  : NaN;
export const DEVICE_POOL_TIMEOUT_MS =
  Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? parsedTimeout * 1000
    : 60_000;
