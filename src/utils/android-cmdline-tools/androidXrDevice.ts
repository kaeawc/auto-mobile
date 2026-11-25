import type { BackStackInfo, BootedDevice } from "../../models";
import type { AdbCommandRunner } from "./interfaces/AdbExecutor";
import { defaultTimer, type Timer } from "../SystemTimer";
import { probeFeature } from "./touchscreenFeature";
import { deviceIncarnationToken } from "../deviceIncarnation";

/**
 * The system feature an Android XR build declares. CtrlProxy gates its XR behaviour (no
 * cross-window occlusion) on the same feature, so TypeScript and Kotlin agree on which devices
 * are XR.
 */
export const XR_SPATIAL_FEATURE = "android.software.xr.api.spatial";

/**
 * The hardware feature the Android AI glasses image declares instead of {@link XR_SPATIAL_FEATURE}
 * (#19196). It marks a display-less or projected XR peripheral, not a spatial headset, so it is
 * deliberately not part of {@link isAndroidXr} (tap and text routing stay as CtrlProxy decides).
 */
export const XR_PERIPHERAL_FEATURE = "android.hardware.type.xr_peripheral";

/**
 * System features do not change while a device is up. A cached answer holds only for the device
 * pool incarnation it was read in, so a new boot on a reused serial is probed again; the expiry
 * guards the case with no incarnation (direct mode) where a serial is reused for a different
 * AVD (a phone replaced by a headset on emulator-5554).
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

/** Module-private fallback evidence: only {@link isAndroidXr} reads XR System UI in the back stack. */
function hasXrSystemUi(backStack: BackStackInfo | undefined): boolean {
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
  /** Keyed by serial; an entry answers only for the pool incarnation it was read in (#19187). */
  private readonly cache = new Map<
    string,
    { readAt: number; incarnation: string | undefined; value: boolean }
  >();

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly ttlMs: number = XR_DEVICE_CACHE_TTL_MS,
    private readonly incarnationOf: (
      deviceId: string,
    ) => string | undefined = deviceIncarnationToken,
  ) {}

  async isAndroidXr(evidence: AndroidXrEvidence): Promise<boolean> {
    const { device, adb, signal } = evidence;
    if (device.platform !== "android") {
      return false;
    }
    const incarnation = this.incarnationOf(device.deviceId);
    const cached = this.cache.get(device.deviceId);
    if (
      cached &&
      cached.incarnation === incarnation &&
      this.timer.now() - cached.readAt < this.ttlMs
    ) {
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
    this.cache.set(device.deviceId, { readAt: this.timer.now(), incarnation, value: declared });
    return declared;
  }
}

/** Process-wide detector, so each device is asked once per TTL across tools. */
export const defaultAndroidXrDetector: AndroidXrDetector = new CachedAndroidXrDetector();

/**
 * The single XR predicate every tool asks (tapOn, tapAny, tapAt, swipeOn and sendKeys routing): the
 * cached system feature, with the observed form factor and XR System UI as the fallback.
 */
export function isAndroidXr(
  evidence: AndroidXrEvidence,
  detector: AndroidXrDetector = defaultAndroidXrDetector,
): Promise<boolean> {
  return detector.isAndroidXr(evidence);
}
