import type { BootedDevice } from "../../models";
import type { AdbCommandRunner } from "./interfaces/AdbExecutor";
import { defaultTimer, type Timer } from "../SystemTimer";
import { probeFeature } from "./touchscreenFeature";

/** The system feature every Android TV build declares. */
export const LEANBACK_FEATURE = "android.software.leanback";

/**
 * System features do not change while a device is up; the expiry only guards a serial that a pool
 * reuses for a different AVD (a phone replaced by a TV on emulator-5554).
 */
export const ANDROID_TV_DEVICE_CACHE_TTL_MS = 5 * 60_000;

/** What a caller knows about the device when it asks whether it is an Android TV. */
export interface AndroidTvEvidence {
  device: Pick<BootedDevice, "deviceId" | "platform" | "formFactor">;
  /** The device handle for the `pm has-feature` probe; absent when the caller has none. */
  adb?: AdbCommandRunner | null;
  signal?: AbortSignal;
}

/** Answers "is this Android device an Android TV?". */
export interface AndroidTvDetector {
  /**
   * True when the known form factor is `tv`. A known non-TV form factor answers false without a
   * probe. With no form factor, reads {@link LEANBACK_FEATURE} once per device and caches a
   * definite answer; a failed or unrecognized probe answers false uncached. Never probes a
   * non-Android device.
   */
  isAndroidTv(evidence: AndroidTvEvidence): Promise<boolean>;
}

/** Probes {@link LEANBACK_FEATURE} once per device when the form factor is unknown. */
export class CachedAndroidTvDetector implements AndroidTvDetector {
  private readonly cache = new Map<string, { readAt: number; value: boolean }>();

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly ttlMs: number = ANDROID_TV_DEVICE_CACHE_TTL_MS,
  ) {}

  async isAndroidTv({ device, adb, signal }: AndroidTvEvidence): Promise<boolean> {
    if (device.platform !== "android") {
      return false;
    }
    if (device.formFactor !== undefined) {
      return device.formFactor === "tv";
    }
    const cached = this.cache.get(device.deviceId);
    if (cached && this.timer.now() - cached.readAt < this.ttlMs) {
      return cached.value;
    }
    if (!adb) {
      return false;
    }
    const declared = await probeFeature(adb, device.deviceId, LEANBACK_FEATURE, {
      signal,
      logTag: "AndroidTvDetector",
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
export const defaultAndroidTvDetector: AndroidTvDetector = new CachedAndroidTvDetector();
