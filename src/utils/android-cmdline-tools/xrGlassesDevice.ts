import { defaultTimer, type Timer } from "../SystemTimer";
import { probeFeature } from "./touchscreenFeature";
import { deviceIncarnationToken } from "../deviceIncarnation";
import {
  XR_DEVICE_CACHE_TTL_MS,
  XR_PERIPHERAL_FEATURE,
  type AndroidXrEvidence,
} from "./androidXrDevice";

/** What a caller knows about the device when it asks whether it is Android XR glasses. */
export type XrGlassesEvidence = Pick<AndroidXrEvidence, "device" | "adb" | "signal">;

/** Answers "is this Android device a pair of Android XR (AI) glasses?". */
export interface XrGlassesDetector {
  /**
   * True when the known form factor is `xr-glasses`; a known other form factor answers false
   * without a probe. With no form factor, reads {@link XR_PERIPHERAL_FEATURE} once per device
   * incarnation and caches a definite answer; a failed probe answers false uncached. Never probes
   * a non-Android device.
   */
  isXrGlasses(evidence: XrGlassesEvidence): Promise<boolean>;
}

/** Probes {@link XR_PERIPHERAL_FEATURE} once per device when the form factor is unknown. */
export class CachedXrGlassesDetector implements XrGlassesDetector {
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

  async isXrGlasses({ device, adb, signal }: XrGlassesEvidence): Promise<boolean> {
    if (device.platform !== "android") {
      return false;
    }
    if (device.formFactor !== undefined) {
      return device.formFactor === "xr-glasses";
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
      return false;
    }
    const declared = await probeFeature(adb, device.deviceId, XR_PERIPHERAL_FEATURE, {
      signal,
      logTag: "XrGlassesDetector",
    });
    if (declared === null) {
      this.cache.delete(device.deviceId);
      return false;
    }
    this.cache.set(device.deviceId, { readAt: this.timer.now(), incarnation, value: declared });
    return declared;
  }
}

/** Process-wide glasses detector, so each device is asked once per TTL across tools. */
export const defaultXrGlassesDetector: XrGlassesDetector = new CachedXrGlassesDetector();
