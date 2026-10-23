import type {
  IosRunnerLaunchGate,
  IosRunnerLaunchSlot,
} from "../../src/ctrlProxy/ios/IosRunnerLaunchGate";

export class FakeIosRunnerLaunchGate implements IosRunnerLaunchGate {
  acquisitions = 0;
  held = 0;
  releases = 0;
  beforeAcquire: (signal?: AbortSignal) => Promise<void> = async () => {};

  async acquire(signal?: AbortSignal): Promise<IosRunnerLaunchSlot> {
    this.acquisitions++;
    await this.beforeAcquire(signal);
    signal?.throwIfAborted();
    this.held++;
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.held--;
        this.releases++;
      },
    };
  }
}
