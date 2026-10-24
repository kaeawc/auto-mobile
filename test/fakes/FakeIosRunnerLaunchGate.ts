import type {
  IosRunnerLaunchGate,
  IosRunnerLaunchQueueView,
  IosRunnerLaunchQueueStatus,
  IosRunnerLaunchSlot,
} from "../../src/ctrlProxy/ios/IosRunnerLaunchGate";

export class FakeIosRunnerLaunchGate implements IosRunnerLaunchGate, IosRunnerLaunchQueueView {
  queued = new Map<string, IosRunnerLaunchQueueStatus>();

  queueStatus(owner: string): IosRunnerLaunchQueueStatus | undefined {
    return this.queued.get(owner);
  }
  acquisitions = 0;
  held = 0;
  releases = 0;
  beforeAcquire: (signal?: AbortSignal, owner?: string) => Promise<void> = async () => {};

  async acquire(signal?: AbortSignal, owner?: string): Promise<IosRunnerLaunchSlot> {
    this.acquisitions++;
    await this.beforeAcquire(signal, owner);
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
