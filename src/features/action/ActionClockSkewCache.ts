import { logger } from "../../utils/logger";
import { deviceIncarnationToken } from "../../utils/deviceIncarnation";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { DeviceTimestampResult } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";

export const ACTION_CLOCK_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export type DeviceClockMeasurement = () => Promise<
  number | DeviceTimestampResult | null | undefined
>;

export interface ActionClockSkewProvider {
  getSkewMs(deviceId: string, measure: DeviceClockMeasurement): Promise<number | null>;
}

interface ClockSample {
  skewMs: number;
  measuredAt: number;
}

interface ClockEntry {
  incarnation: string | undefined;
  sample?: ClockSample;
  inFlight?: Promise<number | null>;
}

/** Per-device clock offsets, shared across action instances with single-flight refreshes. */
export class ActionClockSkewCache implements ActionClockSkewProvider {
  private readonly entries = new Map<string, ClockEntry>();

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly refreshIntervalMs = ACTION_CLOCK_REFRESH_INTERVAL_MS,
    private readonly incarnationToken: typeof deviceIncarnationToken = deviceIncarnationToken,
  ) {}

  getSkewMs(deviceId: string, measure: DeviceClockMeasurement): Promise<number | null> {
    const incarnation = this.incarnationToken(deviceId);
    const cached = this.entries.get(deviceId);
    const current = cached?.incarnation === incarnation ? cached : undefined;
    const sample = current?.sample;
    if (sample) {
      const age = this.timer.now() - sample.measuredAt;
      if (age >= 0 && age < this.refreshIntervalMs) {
        return Promise.resolve(sample.skewMs);
      }
    }
    if (current?.inFlight) {
      return current.inFlight;
    }
    // A failed refresh must not keep using the expired offset.
    const entry: ClockEntry = { incarnation };
    this.entries.set(deviceId, entry);
    entry.inFlight = this.measureSkew(deviceId, entry, measure);
    return entry.inFlight;
  }

  invalidate(deviceId: string): void {
    this.entries.delete(deviceId);
  }

  private async measureSkew(
    deviceId: string,
    entry: ClockEntry,
    measure: DeviceClockMeasurement,
  ): Promise<number | null> {
    try {
      const measured = await measure();
      // The source-aware ADB seam exposes its silent host fallback: it is not
      // a device-clock sample and must be retried on the next action.
      const deviceMs =
        typeof measured === "object" && measured !== null
          ? measured.source === "host"
            ? null
            : measured.timestampMs
          : measured;
      // A reconnect can retire this measurement while its read is still in flight.
      if (this.entries.get(deviceId) !== entry) {
        return null;
      }
      if (typeof deviceMs !== "number" || !Number.isFinite(deviceMs)) {
        this.entries.delete(deviceId);
        return null;
      }
      // Taken after the read so any round trip makes the converted floor earlier,
      // never later, than the true post-input device time. Cached host + skew
      // retains that conservative offset between measurements.
      const measuredAt = this.timer.now();
      entry.sample = { skewMs: deviceMs - measuredAt, measuredAt };
      entry.inFlight = undefined;
      return entry.sample.skewMs;
    } catch (error) {
      if (this.entries.get(deviceId) === entry) {
        this.entries.delete(deviceId);
      }
      logger.warn("[ActionClockSkewCache] Failed to read device clock; using host time", error);
      return null;
    }
  }
}

export const actionClockSkewCache = new ActionClockSkewCache();

const cachesByTimer = new WeakMap<Timer, ActionClockSkewCache>([
  [defaultTimer, actionClockSkewCache],
]);

/** Keep injected clocks in their own time domain while sharing across their action instances. */
export function getActionClockSkewCache(
  timer: Timer,
  injected?: ActionClockSkewProvider,
): ActionClockSkewProvider {
  if (injected) {
    return injected;
  }
  let cache = cachesByTimer.get(timer);
  if (!cache) {
    cache = new ActionClockSkewCache(timer);
    cachesByTimer.set(timer, cache);
  }
  return cache;
}
