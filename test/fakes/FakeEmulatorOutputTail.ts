import type { EmulatorOutputTail } from "../../src/utils/android-cmdline-tools/EmulatorOutputTail";

export class FakeEmulatorOutputTail implements EmulatorOutputTail {
  text: string | undefined;
  readonly reads: Array<{ deviceId: string; pid: number }> = [];

  tailFor(deviceId: string, pid: number): string | undefined {
    this.reads.push({ deviceId, pid });
    return this.text;
  }
}
