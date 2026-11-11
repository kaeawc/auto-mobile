import type { BackStackInfo, BootedDevice } from "../../models";
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

/** What a caller knows about the device when it asks whether it is Android XR. */
export interface AndroidXrEvidence {
  device: XrDeviceIdentity;
  /** The device handle for the `pm has-feature` probe; absent when the caller has none. */
  adb?: AdbCommandRunner | null;
  /** The observed back stack, read only when the feature cannot be (no handle, failed probe). */
  backStack?: BackStackInfo;
  signal?: AbortSignal;
}

/** The one TypeScript answer to "is this an Android XR device?". */
export interface AndroidXrDetector {
  /**
   * True when the device declares {@link XR_SPATIAL_FEATURE}, read once per device and cached.
   * Without a device handle, or when the probe fails or is not understood, it falls back
   * (uncached, so the next call asks the device again) to the observed evidence: the provisional
   * `xr-headset`/`xr-glasses` form factor or XR System UI in the back stack. Never probes a
   * non-Android device.
   */
  isAndroidXr(evidence: AndroidXrEvidence): Promise<boolean>;
}

const isXrSystemUiName = (name: string | undefined): boolean =>
  !!name &&
  (name.startsWith("com.android.systemui.xr") || name.startsWith("com.android.systemui/.xr"));

/**
 * Whether the observed back stack holds Android XR System UI tasks or activities. This is
 * fallback evidence for {@link isAndroidXr}, not the decision: prefer the predicate wherever a
 * device handle exists.
 */
export function hasXrSystemUi(backStack: BackStackInfo | undefined): backStack is BackStackInfo {
  return (
    !!backStack &&
    (backStack.activities.some((activity) => isXrSystemUiName(activity.name)) ||
      backStack.tasks.some(
        (task) =>
          isXrSystemUiName(task.packageName) ||
          isXrSystemUiName(task.rootActivity) ||
          isXrSystemUiName(task.topActivity),
      ))
  );
}

function observedAndroidXr({ device, backStack }: AndroidXrEvidence): boolean {
  return (
    device.formFactor === "xr-headset" ||
    device.formFactor === "xr-glasses" ||
    hasXrSystemUi(backStack)
  );
}

/** Probes {@link XR_SPATIAL_FEATURE} once per device and caches a definite answer. */
export class CachedAndroidXrDetector implements AndroidXrDetector {
  private readonly cache = new Map<string, { readAt: number; value: boolean }>();

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly ttlMs: number = XR_DEVICE_CACHE_TTL_MS,
  ) {}

  async isAndroidXr(evidence: AndroidXrEvidence): Promise<boolean> {
    const { device, adb, signal } = evidence;
    if (device.platform !== "android") {
      return false;
    }
    const cached = this.cache.get(device.deviceId);
    if (cached && this.timer.now() - cached.readAt < this.ttlMs) {
      return cached.value;
    }
    if (!adb) {
      return observedAndroidXr(evidence);
    }
    const declared = await probeFeature(adb, device.deviceId, XR_SPATIAL_FEATURE, {
      signal,
      logTag: "AndroidXrDetector",
    });
    if (declared === null) {
      this.cache.delete(device.deviceId);
      return observedAndroidXr(evidence);
    }
    this.cache.set(device.deviceId, { readAt: this.timer.now(), value: declared });
    return declared;
  }
}

/** Process-wide detector, so each device is asked once per TTL across tools. */
export const defaultAndroidXrDetector: AndroidXrDetector = new CachedAndroidXrDetector();

/**
 * The single XR predicate every tool asks (tapOn, tapAny, tapAt and sendKeys routing): the
 * cached system feature, with the observed form factor and XR System UI as the fallback.
 */
export function isAndroidXr(
  evidence: AndroidXrEvidence,
  detector: AndroidXrDetector = defaultAndroidXrDetector,
): Promise<boolean> {
  return detector.isAndroidXr(evidence);
}
