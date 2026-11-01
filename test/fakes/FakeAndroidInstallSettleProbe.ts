import type { AndroidInstallSettleProbe } from "../../src/ctrlProxy/AndroidInstallSettleGate";

export class FakeAndroidInstallSettleProbe implements AndroidInstallSettleProbe {
  calls: string[] = [];
  packageReady = [true];
  bootReady = [true];
  userReady = [true];
  constructor(readonly events: string[] = []) {}
  private next(signal: string, values: boolean[]): boolean {
    this.calls.push(signal);
    this.events.push(signal);
    return values.length > 1 ? values.shift()! : values[0]!;
  }
  async packageManagerReady(_signal: AbortSignal): Promise<boolean> {
    return this.next("pm path android", this.packageReady);
  }
  async bootCompleted(): Promise<boolean> {
    return this.next("sys.boot_completed", this.bootReady);
  }
  async foregroundUserReady(): Promise<boolean> {
    return this.next("foreground user", this.userReady);
  }
}
