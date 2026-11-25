import type { BootedDevice } from "../../models";
import type { AdbCommandRunner } from "./interfaces/AdbExecutor";
import { defaultTimer, type Timer } from "../SystemTimer";
import { probeFeature } from "./touchscreenFeature";

/** The system feature every Android Automotive OS build declares. */
export const AUTOMOTIVE_FEATURE = "android.hardware.type.automotive";

/**
 * System features do not change while a device is up; the expiry only guards a serial that a pool
 * reuses for a different AVD (a phone replaced by an Automotive image on emulator-5554).
 */
export const ANDROID_AUTOMOTIVE_DEVICE_CACHE_TTL_MS = 5 * 60_000;

/** What a caller knows about the device when it asks whether it is Android Automotive. */
export interface AndroidAutomotiveEvidence {
  device: Pick<BootedDevice, "deviceId" | "platform" | "formFactor">;
  /** The device handle for the `pm has-feature` probe; absent when the caller has none. */
  adb?: AdbCommandRunner | null;
  signal?: AbortSignal;
}

/** Answers "is this Android device an Android Automotive OS head unit?". */
export interface AndroidAutomotiveDetector {
  /**
   * True when the known form factor is `automotive`. A known non-automotive form factor answers
   * false without a probe. With no form factor, reads {@link AUTOMOTIVE_FEATURE} once per device
   * and caches a definite answer; a failed or unrecognized probe answers false uncached. Never
   * probes a non-Android device.
   */
  isAndroidAutomotive(evidence: AndroidAutomotiveEvidence): Promise<boolean>;
}

/** Probes {@link AUTOMOTIVE_FEATURE} once per device when the form factor is unknown. */
export class CachedAndroidAutomotiveDetector implements AndroidAutomotiveDetector {
  private readonly cache = new Map<string, { readAt: number; value: boolean }>();

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly ttlMs: number = ANDROID_AUTOMOTIVE_DEVICE_CACHE_TTL_MS,
  ) {}

  async isAndroidAutomotive({ device, adb, signal }: AndroidAutomotiveEvidence): Promise<boolean> {
    if (device.platform !== "android") {
      return false;
    }
    if (device.formFactor !== undefined) {
      return device.formFactor === "automotive";
    }
    const cached = this.cache.get(device.deviceId);
    if (cached && this.timer.now() - cached.readAt < this.ttlMs) {
      return cached.value;
    }
    if (!adb) {
      return false;
    }
    const declared = await probeFeature(adb, device.deviceId, AUTOMOTIVE_FEATURE, {
      signal,
      logTag: "AndroidAutomotiveDetector",
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
export const defaultAndroidAutomotiveDetector: AndroidAutomotiveDetector =
  new CachedAndroidAutomotiveDetector();
