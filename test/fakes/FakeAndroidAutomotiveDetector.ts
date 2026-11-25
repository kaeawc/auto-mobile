import type {
  AndroidAutomotiveDetector,
  AndroidAutomotiveEvidence,
} from "../../src/utils/android-cmdline-tools/androidAutomotiveDevice";

/** Answers a configured Android Automotive verdict without a `pm has-feature` probe; records every query. */
export class FakeAndroidAutomotiveDetector implements AndroidAutomotiveDetector {
  readonly queries: string[] = [];

  constructor(private automotive = false) {}

  async isAndroidAutomotive({ device }: AndroidAutomotiveEvidence): Promise<boolean> {
    this.queries.push(device.deviceId);
    return device.platform === "android" && this.automotive;
  }
}
