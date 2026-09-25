import type { MatchingStrategy } from "../models/DeviceMatchCriteria";

export const DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS = 2;
export const MAX_DEVICE_RECOVERY_ATTEMPTS = 10;

/**
 * Default rolling window, in milliseconds, that the Android crash-recovery
 * budget counts attempts over. Kept separate from {@link DeviceRecoveryPolicy}
 * (resolved once at startup and asserted with `toEqual` in several tests) so
 * this purely Android-reboot-timing knob doesn't reshape that struct (#7545).
 */
export const DEFAULT_DEVICE_RECOVERY_WINDOW_MS = 15 * 60 * 1000;

export interface DeviceRecoveryPolicy {
  onLoss: boolean;
  maxAttempts: number;
}

export interface DeviceRecoveryPolicyParseResult {
  policy: DeviceRecoveryPolicy;
  warnings: string[];
}

type Environment = Record<string, string | undefined>;

const DEVICE_RECOVERY_ON_LOSS_KEYS = [
  "AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS",
  "AUTO_MOBILE_DEVICE_RECOVERY_ON_LOSS",
  "AUTOMOBILE_ANDROID_REBOOT_ON_DEATH",
  "AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH",
] as const;

function firstDefined(env: Environment, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (env[key] !== undefined) {
      return env[key];
    }
  }
  return undefined;
}

/**
 * Resolves recovery once when the daemon starts. The legacy Android setting is
 * retained as a migration fallback, but new clients must use the platform-neutral
 * recovery variables.
 */
export function parseDeviceRecoveryPolicy(env: Environment): DeviceRecoveryPolicyParseResult {
  const warnings: string[] = [];
  const onLossValue = firstDefined(env, DEVICE_RECOVERY_ON_LOSS_KEYS);
  let onLoss = false;
  if (onLossValue !== undefined) {
    if (onLossValue === "1") {
      onLoss = true;
    } else if (onLossValue !== "0") {
      warnings.push(
        `Invalid AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS value ${JSON.stringify(onLossValue)}; using 0.`,
      );
    }
  }

  const maxAttemptsValue = firstDefined(env, [
    "AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS",
    "AUTO_MOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS",
  ]);
  let maxAttempts = DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS;
  if (maxAttemptsValue !== undefined) {
    if (/^[1-9]\d*$/.test(maxAttemptsValue)) {
      const parsed = Number(maxAttemptsValue);
      if (parsed <= MAX_DEVICE_RECOVERY_ATTEMPTS) {
        maxAttempts = parsed;
      } else {
        warnings.push(
          `Invalid AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS value ${JSON.stringify(maxAttemptsValue)}; ` +
            `using ${DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS}.`,
        );
      }
    } else {
      warnings.push(
        `Invalid AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS value ${JSON.stringify(maxAttemptsValue)}; ` +
          `using ${DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS}.`,
      );
    }
  }

  return {
    policy: { onLoss, maxAttempts },
    warnings,
  };
}

export function getDeviceRecoveryPolicy(): DeviceRecoveryPolicy {
  return parseDeviceRecoveryPolicy(process.env).policy;
}

/**
 * Rolling window the Android crash-recovery budget counts attempts over.
 * Isolated crashes further apart than this age out of the budget instead of
 * accumulating for the whole daemon lifetime (#7545). Read at construction
 * time, same as `maxAttempts`, so retries and status agree.
 */
export function getDeviceRecoveryWindowMs(env: Environment = process.env): number {
  const override = firstDefined(env, [
    "AUTOMOBILE_DEVICE_RECOVERY_WINDOW_MS",
    "AUTO_MOBILE_DEVICE_RECOVERY_WINDOW_MS",
  ]);
  if (override !== undefined && /^[1-9]\d*$/.test(override)) {
    return Number(override);
  }
  return DEFAULT_DEVICE_RECOVERY_WINDOW_MS;
}

/**
 * A session already bound to an AutoMobile-owned virtual device survives a lost
 * runtime connection by default. The broad Android recovery policy above remains
 * opt-in for idle/unbound devices; an explicit zero disables both behaviors.
 */
export function isDeviceSessionContinuityEnabled(env: Environment = process.env): boolean {
  return firstDefined(env, DEVICE_RECOVERY_ON_LOSS_KEYS) !== "0";
}

/** Backward-compatible name for callers that predate iOS simulator continuity. */
export function isAndroidEmulatorSessionContinuityEnabled(env: Environment = process.env): boolean {
  return isDeviceSessionContinuityEnabled(env);
}

/**
 * Device pool matching strategy.
 * Controls how a device is selected when multiple candidates match.
 * - LATEST: prefer highest OS version (default)
 * - RANDOM: random selection
 * - MINIMUM: prefer lowest OS version that satisfies the constraint
 */
const matchingOverride =
  process.env.AUTOMOBILE_DEVICE_POOL_MATCHING ?? process.env.AUTO_MOBILE_DEVICE_POOL_MATCHING;
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
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK ?? process.env.AUTO_MOBILE_DEVICE_POOL_AUTOLOCK;
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
    process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT ?? process.env.AUTO_MOBILE_DEVICE_POOL_TIMEOUT;
  const parsed = override ? Number.parseInt(override, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 60_000;
}
