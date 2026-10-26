import { ENV, readEnvNumber } from "../../config/env";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

export interface IosRunnerLaunchSlot {
  release(): void;
}

export interface IosRunnerLaunchGate {
  acquire(signal?: AbortSignal, owner?: string): Promise<IosRunnerLaunchSlot>;
}

export interface IosRunnerLaunchQueueStatus {
  /** 1-based place among waiting launches. */
  position: number;
  /** Held slots plus waiters in front of this launch. */
  ahead: number;
  limit: number;
}

/** Queue transitions of one owner's launches; an immediately admitted launch fires none. */
export interface IosRunnerLaunchQueueObserver {
  /** The launch had to wait for a slot and joined the queue. */
  queued(): void;
  /** A queued launch was granted its slot and is about to start. */
  admitted(): void;
  /** A queued launch was cancelled before it was granted a slot. */
  left(): void;
}

export interface IosRunnerLaunchQueueView {
  queueStatus(owner: string): IosRunnerLaunchQueueStatus | undefined;
  /** True while `owner` holds a launch slot, i.e. its runner launch is admitted and still starting. */
  isLaunching(owner: string): boolean;
  /** Observe the queue transitions of `owner`'s launches; returns the unsubscribe function. */
  watchQueue(owner: string, observer: IosRunnerLaunchQueueObserver): () => void;
}

export function resolveIosRunnerLaunchConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const value = readEnvNumber(ENV.IOS_RUNNER_LAUNCH_CONCURRENCY, env);
  return value !== undefined && Number.isSafeInteger(value) ? value : 2;
}

interface LaunchWaiter {
  owner?: string;
  /** True once the waiter joined the queue, so its grant is an admission after a wait. */
  queued: boolean;
  grant(): void;
}

/** FIFO admission for expensive runner launches; runner reuse needs no admission. */
export class DefaultIosRunnerLaunchGate implements IosRunnerLaunchGate, IosRunnerLaunchQueueView {
  private held = 0;
  private readonly waiters: LaunchWaiter[] = [];
  private readonly observers = new Map<string, Set<IosRunnerLaunchQueueObserver>>();
  private readonly launching = new Map<string, number>();

  constructor(private readonly limit = resolveIosRunnerLaunchConcurrency()) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Launch limit must be positive");
    }
  }

  queueStatus(owner: string): IosRunnerLaunchQueueStatus | undefined {
    const index = this.waiters.findIndex((waiter) => waiter.owner === owner);
    return index < 0
      ? undefined
      : { position: index + 1, ahead: this.held + index, limit: this.limit };
  }

  isLaunching(owner: string): boolean {
    return (this.launching.get(owner) ?? 0) > 0;
  }

  private markLaunching(owner: string | undefined, delta: 1 | -1): void {
    if (owner === undefined) {
      return;
    }
    const next = (this.launching.get(owner) ?? 0) + delta;
    if (next > 0) {
      this.launching.set(owner, next);
    } else {
      this.launching.delete(owner);
    }
  }

  watchQueue(owner: string, observer: IosRunnerLaunchQueueObserver): () => void {
    const owned = this.observers.get(owner) ?? new Set<IosRunnerLaunchQueueObserver>();
    owned.add(observer);
    this.observers.set(owner, owned);
    return () => {
      owned.delete(observer);
      if (owned.size === 0 && this.observers.get(owner) === owned) {
        this.observers.delete(owner);
      }
    };
  }

  private notify(owner: string | undefined, event: keyof IosRunnerLaunchQueueObserver): void {
    const watching = owner === undefined ? undefined : this.observers.get(owner);
    for (const observer of [...(watching ?? [])]) {
      try {
        observer[event]();
      } catch (error) {
        // An observer must never wedge the FIFO hand-off to the next launch.
        logger.warn(`[IOSCtrlProxy] Launch queue observer failed: ${errorMessage(error)}`, error);
      }
    }
  }

  async acquire(signal?: AbortSignal, owner?: string): Promise<IosRunnerLaunchSlot> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          this.notify(owner, "left");
        }
        reject(signal?.reason ?? new Error("iOS runner launch cancelled"));
      };
      const waiter: LaunchWaiter = {
        owner,
        queued: false,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          this.held++;
          this.markLaunching(owner, 1);
          let released = false;
          resolve({
            release: () => {
              if (released) {
                return;
              }
              released = true;
              this.held--;
              this.markLaunching(owner, -1);
              this.waiters.shift()?.grant();
            },
          });
          if (waiter.queued) {
            this.notify(owner, "admitted");
          }
        },
      };
      if (this.held < this.limit) {
        waiter.grant();
      } else {
        waiter.queued = true;
        this.waiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
        this.notify(owner, "queued");
      }
    });
  }
}

// One daemon launches runners on a host; cross-daemon coordination is out of scope.
let sharedGate: DefaultIosRunnerLaunchGate | undefined;
export function getSharedIosRunnerLaunchGate(): IosRunnerLaunchGate {
  return (sharedGate ??= new DefaultIosRunnerLaunchGate());
}

export function getSharedIosRunnerLaunchQueueView(): IosRunnerLaunchQueueView {
  return (sharedGate ??= new DefaultIosRunnerLaunchGate());
}
