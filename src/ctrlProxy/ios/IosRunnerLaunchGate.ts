import { ENV, readEnvNumber } from "../../config/env";

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

export interface IosRunnerLaunchQueueView {
  queueStatus(owner: string): IosRunnerLaunchQueueStatus | undefined;
}

export function resolveIosRunnerLaunchConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const value = readEnvNumber(ENV.IOS_RUNNER_LAUNCH_CONCURRENCY, env);
  return value !== undefined && Number.isSafeInteger(value) ? value : 2;
}

interface LaunchWaiter {
  owner?: string;
  grant(): void;
}

/** FIFO admission for expensive runner launches; runner reuse needs no admission. */
export class DefaultIosRunnerLaunchGate implements IosRunnerLaunchGate, IosRunnerLaunchQueueView {
  private held = 0;
  private readonly waiters: LaunchWaiter[] = [];

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

  async acquire(signal?: AbortSignal, owner?: string): Promise<IosRunnerLaunchSlot> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(signal?.reason ?? new Error("iOS runner launch cancelled"));
      };
      const waiter: LaunchWaiter = {
        owner,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          this.held++;
          let released = false;
          resolve({
            release: () => {
              if (released) {
                return;
              }
              released = true;
              this.held--;
              this.waiters.shift()?.grant();
            },
          });
        },
      };
      if (this.held < this.limit) {
        waiter.grant();
      } else {
        this.waiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
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
