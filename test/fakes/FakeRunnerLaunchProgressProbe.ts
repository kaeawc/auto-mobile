import type { RunnerLaunchProgressProbe } from "../../src/ctrlProxy/ios/IosRunnerLaunchProgress";

export class FakeRunnerLaunchProgressProbe implements RunnerLaunchProgressProbe {
  samples: Array<number | null | Error> = [null];
  readonly calls: Array<{ pid: number; deviceId: string }> = [];
  async sample(pid: number, deviceId: string): Promise<number | null> {
    this.calls.push({ pid, deviceId });
    const value = this.samples.length > 1 ? this.samples.shift()! : (this.samples[0] ?? null);
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }
}
