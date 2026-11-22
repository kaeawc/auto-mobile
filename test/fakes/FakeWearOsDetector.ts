import type {
  WearOsDetector,
  WearOsEvidence,
} from "../../src/utils/android-cmdline-tools/wearOsDevice";

/** Answers a configured Wear OS verdict without a `pm has-feature` probe; records every query. */
export class FakeWearOsDetector implements WearOsDetector {
  readonly queries: string[] = [];

  constructor(private watch = false) {}

  setWatch(watch: boolean): void {
    this.watch = watch;
  }

  async isWearOs({ device }: WearOsEvidence): Promise<boolean> {
    this.queries.push(device.deviceId);
    return device.platform === "android" && this.watch;
  }
}
