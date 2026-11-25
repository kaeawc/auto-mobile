import type {
  AndroidTvDetector,
  AndroidTvEvidence,
} from "../../src/utils/android-cmdline-tools/androidTvDevice";

/** Answers a configured Android TV verdict without a `pm has-feature` probe; records every query. */
export class FakeAndroidTvDetector implements AndroidTvDetector {
  readonly queries: string[] = [];

  constructor(private tv = false) {}

  async isAndroidTv({ device }: AndroidTvEvidence): Promise<boolean> {
    this.queries.push(device.deviceId);
    return device.platform === "android" && this.tv;
  }
}
