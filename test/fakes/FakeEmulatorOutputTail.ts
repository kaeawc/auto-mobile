import type { EmulatorOutputTail } from "../../src/utils/android-cmdline-tools/EmulatorOutputTail";
import { classifyHostMicrophoneFailure } from "../../src/utils/android-cmdline-tools/emulatorGrpc/classifyHostMicrophoneFailure";

export class FakeEmulatorOutputTail implements EmulatorOutputTail {
  text: string | undefined;
  readonly reads: Array<{ deviceId: string; pid: number }> = [];

  hostMicrophoneFailed(deviceId: string, pid: number): boolean {
    this.reads.push({ deviceId, pid });
    return this.text !== undefined && classifyHostMicrophoneFailure(this.text);
  }

  tailFor(deviceId: string, pid: number): string | undefined {
    this.reads.push({ deviceId, pid });
    return this.text;
  }
}
