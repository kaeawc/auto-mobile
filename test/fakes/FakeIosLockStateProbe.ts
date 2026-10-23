import type {
  IosLockStateProbe,
  IosLockStateReading,
} from "../../src/features/observe/ios/IosLockStateProbe";

export class FakeIosLockStateProbe implements IosLockStateProbe {
  reads = 0;
  reading: IosLockStateReading = { kind: "known", lock: { locked: true, keyguardShowing: true } };
  async read(): Promise<IosLockStateReading> {
    this.reads++;
    return this.reading;
  }
}
