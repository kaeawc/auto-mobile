import type { BootedDevice } from "../../models";
import type { AdbCommandRunner } from "./interfaces/AdbExecutor";
import { defaultTimer, type Timer } from "../SystemTimer";
import { probeFeature } from "./touchscreenFeature";

/**
 * The system feature an Android XR build declares. CtrlProxy gates its XR behaviour (no
 * cross-window occlusion) on the same feature, so TypeScript and Kotlin agree on which devices
 * are XR.
 */
export const XR_SPATIAL_FEATURE = "android.software.xr.api.spatial";

/**
 * System features do not change while a device is up; the expiry only guards a serial that a pool
 * reuses for a different AVD (a phone replaced by a headset on emulator-5554).
 */
export const XR_DEVICE_CACHE_TTL_MS = 5 * 60_000;

export type XrDeviceIdentity = Pick<BootedDevice, "deviceId" | "platform" | "formFactor">;

/** The one TypeScript answer to "is this an Android XR device?". */
export interface AndroidXrDetector {
  /**
   * True when the device declares {@link XR_SPATIAL_FEATURE}. Only when the probe fails or is not
   * understood does it fall back to the provisional `ro.build.characteristics` form factor
   * (`xr-headset`/`xr-glasses`), uncached so the next call asks the device again. Never probes a
   * non-Android device.
   */
  isAndroidXr(
    adb: AdbCommandRunner,
    device: XrDeviceIdentity,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

function isXrFormFactor(formFactor: BootedDevice["formFactor"]): boolean {
  return formFactor === "xr-headset" || formFactor === "xr-glasses";
}

/** Probes {@link XR_SPATIAL_FEATURE} once per device and caches a definite answer. */
export class CachedAndroidXrDetector implements AndroidXrDetector {
  private readonly cache = new Map<string, { readAt: number; value: boolean }>();

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly ttlMs: number = XR_DEVICE_CACHE_TTL_MS,
  ) {}

  async isAndroidXr(
    adb: AdbCommandRunner,
    device: XrDeviceIdentity,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (device.platform !== "android") {
      return false;
    }
    const cached = this.cache.get(device.deviceId);
    if (cached && this.timer.now() - cached.readAt < this.ttlMs) {
      return cached.value;
    }
    const declared = await probeFeature(adb, device.deviceId, XR_SPATIAL_FEATURE, {
      signal,
      logTag: "AndroidXrDetector",
    });
    if (declared === null) {
      this.cache.delete(device.deviceId);
      return isXrFormFactor(device.formFactor);
    }
    this.cache.set(device.deviceId, { readAt: this.timer.now(), value: declared });
    return declared;
  }
}

/** Process-wide detector, so each device is asked once per TTL across tap tools. */
export const defaultAndroidXrDetector: AndroidXrDetector = new CachedAndroidXrDetector();
