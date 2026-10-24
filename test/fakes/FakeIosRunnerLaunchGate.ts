import type {
  IosRunnerLaunchGate,
  IosRunnerLaunchQueueObserver,
  IosRunnerLaunchQueueView,
  IosRunnerLaunchQueueStatus,
  IosRunnerLaunchSlot,
} from "../../src/ctrlProxy/ios/IosRunnerLaunchGate";

export class FakeIosRunnerLaunchGate implements IosRunnerLaunchGate, IosRunnerLaunchQueueView {
  queued = new Map<string, IosRunnerLaunchQueueStatus>();

  queueStatus(owner: string): IosRunnerLaunchQueueStatus | undefined {
    return this.queued.get(owner);
  }
  private readonly observers = new Map<string, Set<IosRunnerLaunchQueueObserver>>();

  watchQueue(owner: string, observer: IosRunnerLaunchQueueObserver): () => void {
    const owned = this.observers.get(owner) ?? new Set<IosRunnerLaunchQueueObserver>();
    owned.add(observer);
    this.observers.set(owner, owned);
    return () => {
      owned.delete(observer);
    };
  }

  observerCount(owner: string): number {
    return this.observers.get(owner)?.size ?? 0;
  }

  /** Tests drive the queue lifecycle: the launch joined the queue behind other launches. */
  emitQueued(owner: string): void {
    for (const observer of this.observers.get(owner) ?? []) {
      observer.queued();
    }
  }

  /** Tests drive the queue lifecycle: the queued launch was granted its slot. */
  emitAdmitted(owner: string): void {
    for (const observer of this.observers.get(owner) ?? []) {
      observer.admitted();
    }
  }

  /** Tests drive the queue lifecycle: the queued launch was cancelled. */
  emitLeft(owner: string): void {
    for (const observer of this.observers.get(owner) ?? []) {
      observer.left();
    }
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
