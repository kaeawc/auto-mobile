import type { DeviceClockAdapter } from "../../src/features/utility/DeviceClock";

export class FakeDeviceClockAdapter implements DeviceClockAdapter {
  instantMs = Date.parse("2001-01-01T00:00:00Z");
  automaticTime: 0 | 1 = 1;
  root = true;
  rootedByUs = true;
  writeError?: Error;
  readOffsetMs = 0;
  readonly calls: string[] = [];
  async canRoot(): Promise<boolean> {
    this.calls.push("probeRoot");
    return this.root;
  }
  async ensureRoot(): Promise<
    { success: true; rootedByUs: boolean } | { success: false; error: string }
  > {
    this.calls.push("root");
    return this.root
      ? { success: true, rootedByUs: this.rootedByUs }
      : { success: false, error: "Root refused" };
  }
  async unroot(): Promise<void> {
    this.calls.push("unroot");
  }
  async readInstantMs(): Promise<number> {
    this.calls.push("readInstant");
    return this.instantMs + this.readOffsetMs;
  }
  async readAutomaticTime(): Promise<0 | 1> {
    this.calls.push("readAuto");
    return this.automaticTime;
  }
  async setAutomaticTime(value: 0 | 1): Promise<void> {
    this.calls.push(`auto:${value}`);
    this.automaticTime = value;
  }
  async setInstantMs(value: number): Promise<void> {
    this.calls.push(`instant:${value}`);
    if (this.writeError) {
      throw this.writeError;
    }
    this.instantMs = Math.floor(value / 1000) * 1000;
  }
}
