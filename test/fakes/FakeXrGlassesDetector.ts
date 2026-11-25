import type {
  XrGlassesDetector,
  XrGlassesEvidence,
} from "../../src/utils/android-cmdline-tools/xrGlassesDevice";

/** Answers a configured XR glasses verdict without a `pm has-feature` probe; records every query. */
export class FakeXrGlassesDetector implements XrGlassesDetector {
  readonly queries: string[] = [];

  constructor(private readonly glasses = false) {}

  async isXrGlasses({ device }: XrGlassesEvidence): Promise<boolean> {
    this.queries.push(device.deviceId);
    return device.platform === "android" && this.glasses;
  }
}
