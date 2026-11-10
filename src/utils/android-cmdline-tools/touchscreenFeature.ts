import type { AdbCommandRunner } from "./interfaces/AdbExecutor";
import { defaultTimer, type Timer } from "../SystemTimer";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";
import { adbFailureOutput } from "./adbFailureOutput";

/** The package-manager feature a device declares when it has a touchscreen. */
export const TOUCHSCREEN_FEATURE = "android.hardware.touchscreen";

/**
 * Features that mark an Android TV. TV emulator images declare a touchscreen though they have no
 * touch input device (#17316), so a TV is driven as touchless whatever it says about touch.
 */
export const TV_FEATURES = ["android.software.leanback", "android.hardware.type.television"];

/**
 * Hardware features do not change while a device is up; the expiry only guards a serial that a
 * pool reuses for a different AVD (a phone replaced by a TV on emulator-5554).
 */
export const TOUCHSCREEN_FEATURE_CACHE_TTL_MS = 5 * 60_000;

const PROBE_TIMEOUT_MS = 3_000;

/** Interpret `pm has-feature` output: true/false, or null for anything else. */
export function parseHasFeature(raw: string): boolean | null {
  const value = raw.trim();
  if (value === "true") {
    return true;
  }
  return value === "false" ? false : null;
}

/**
 * Interpret the stdout a rejected `pm has-feature` carried. The same stream can repeat along the
 * error's cause chain, so every non-empty line must agree.
 */
export function parseFailedHasFeature(raw: string): boolean | null {
  const answers = new Set(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  return answers.size === 1 ? parseHasFeature([...answers][0]) : null;
}

/** Whether an Android device declares a touchscreen. */
export interface TouchscreenFeature {
  /**
   * True or false as the device declares it, except that a TV (leanback or television feature)
   * reads as false; null when the probe failed or its answer was not
   * understood. Callers that need a yes/no treat null as a touchscreen, so a failed probe leaves
   * touch input in place.
   */
  hasTouchscreen(
    adb: AdbCommandRunner,
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<boolean | null>;
}

interface CacheEntry {
  readAt: number;
  value: boolean;
}

type FeatureAnswer = boolean | null;

/**
 * Probes `pm has-feature android.hardware.touchscreen`, then the TV features when it says true,
 * and caches a definite answer per device.
 */
export class CachedTouchscreenFeature implements TouchscreenFeature {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly ttlMs: number = TOUCHSCREEN_FEATURE_CACHE_TTL_MS,
  ) {}

  async hasTouchscreen(
    adb: AdbCommandRunner,
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<boolean | null> {
    const cached = this.cache.get(deviceId);
    if (cached && this.timer.now() - cached.readAt < this.ttlMs) {
      return cached.value;
    }
    const touchscreen = await probeFeature(adb, deviceId, TOUCHSCREEN_FEATURE, { signal });
    if (touchscreen === null) {
      this.cache.delete(deviceId);
      return null;
    }
    if (touchscreen === false) {
      return this.remember(deviceId, false);
    }
    for (const tvFeature of TV_FEATURES) {
      const isTv = await probeFeature(adb, deviceId, tvFeature, { signal });
      if (isTv === null) {
        // Unknown TV-ness keeps the declared touchscreen, uncached so the next call asks again.
        this.cache.delete(deviceId);
        return true;
      }
      if (isTv) {
        return this.remember(deviceId, false);
      }
    }
    return this.remember(deviceId, true);
  }

  private remember(deviceId: string, value: boolean): boolean {
    this.cache.set(deviceId, { readAt: this.timer.now(), value });
    return value;
  }
}

/** One `pm has-feature` probe: the device's answer, or null when it failed or was not understood. */
export async function probeFeature(
  adb: AdbCommandRunner,
  deviceId: string,
  feature: string,
  { signal, logTag = "TouchscreenFeature" }: { signal?: AbortSignal; logTag?: string } = {},
): Promise<FeatureAnswer> {
  let value: FeatureAnswer;
  try {
    const result = await adb.executeCommand(`shell pm has-feature ${feature}`, {
      noRetry: true,
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    value = parseHasFeature(result.stdout);
  } catch (error) {
    signal?.throwIfAborted();
    // `pm has-feature` prints `false` and exits 1 for a missing feature, which adb reports as a
    // failed command; that output is the answer, not a probe failure.
    value = parseFailedHasFeature(adbFailureOutput(error).stdout);
    if (value === null) {
      logger.warn(
        `[${logTag}] ${feature} probe failed for ${deviceId}: ${errorMessage(error)}`,
        error,
      );
      return null;
    }
  }
  if (value === null) {
    logger.warn(`[${logTag}] unrecognized pm has-feature ${feature} output for ${deviceId}`);
  }
  return value;
}

/** Process-wide probe, so each device is asked once per TTL. */
export const defaultTouchscreenFeature: TouchscreenFeature = new CachedTouchscreenFeature();
