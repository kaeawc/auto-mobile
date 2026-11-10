import type {
  AndroidXrDetector,
  XrDeviceIdentity,
} from "../../src/utils/android-cmdline-tools/androidXrDevice";

/** Answers a configured XR verdict without a `pm has-feature` probe; records every query. */
export class FakeAndroidXrDetector implements AndroidXrDetector {
  readonly queries: string[] = [];

  constructor(private xr = false) {}

  setXr(xr: boolean): void {
    this.xr = xr;
  }

  async isAndroidXr(
    _adb: unknown,
    device: XrDeviceIdentity,
    _signal?: AbortSignal,
  ): Promise<boolean> {
    this.queries.push(device.deviceId);
    return device.platform === "android" && this.xr;
  }
}
