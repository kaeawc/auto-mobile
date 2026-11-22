import type { BootedDevice } from "../../models";
import type { AdbCommandRunner } from "./interfaces/AdbExecutor";
import { defaultTimer, type Timer } from "../SystemTimer";
import { probeFeature } from "./touchscreenFeature";

/** The system feature every Wear OS build declares. */
export const WATCH_FEATURE = "android.hardware.type.watch";

/**
 * System features do not change while a device is up; the expiry only guards a serial that a pool
 * reuses for a different AVD (a phone replaced by a watch on emulator-5554).
 */
export const WEAR_OS_DEVICE_CACHE_TTL_MS = 5 * 60_000;

/** What a caller knows about the device when it asks whether it is a Wear OS watch. */
export interface WearOsEvidence {
  device: Pick<BootedDevice, "deviceId" | "platform" | "formFactor">;
  /** The device handle for the `pm has-feature` probe; absent when the caller has none. */
  adb?: AdbCommandRunner | null;
  signal?: AbortSignal;
}

/** Answers "is this Android device a Wear OS watch?". */
export interface WearOsDetector {
  /**
   * True when the known form factor is `watch`. A known non-watch form factor answers false
   * without a probe. With no form factor, reads {@link WATCH_FEATURE} once per device and caches
   * a definite answer; a failed or unrecognized probe answers false uncached. Never probes a
   * non-Android device.
   */
  isWearOs(evidence: WearOsEvidence): Promise<boolean>;
}

/** Probes {@link WATCH_FEATURE} once per device when the form factor is unknown. */
export class CachedWearOsDetector implements WearOsDetector {
  private readonly cache = new Map<string, { readAt: number; value: boolean }>();

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly ttlMs: number = WEAR_OS_DEVICE_CACHE_TTL_MS,
  ) {}

  async isWearOs({ device, adb, signal }: WearOsEvidence): Promise<boolean> {
    if (device.platform !== "android") {
      return false;
    }
    if (device.formFactor !== undefined) {
      return device.formFactor === "watch";
    }
    const cached = this.cache.get(device.deviceId);
    if (cached && this.timer.now() - cached.readAt < this.ttlMs) {
      return cached.value;
    }
    if (!adb) {
      return false;
    }
    const declared = await probeFeature(adb, device.deviceId, WATCH_FEATURE, {
      signal,
      logTag: "WearOsDetector",
    });
    if (declared === null) {
      this.cache.delete(device.deviceId);
      return false;
    }
    this.cache.set(device.deviceId, { readAt: this.timer.now(), value: declared });
    return declared;
  }
}

/** Process-wide detector, so each device is asked once per TTL across tools. */
export const defaultWearOsDetector: WearOsDetector = new CachedWearOsDetector();
