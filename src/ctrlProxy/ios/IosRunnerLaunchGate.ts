import { ENV, readEnvNumber } from "../../config/env";

export interface IosRunnerLaunchSlot {
  release(): void;
}

export interface IosRunnerLaunchGate {
  acquire(signal?: AbortSignal): Promise<IosRunnerLaunchSlot>;
}

export function resolveIosRunnerLaunchConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const value = readEnvNumber(ENV.IOS_RUNNER_LAUNCH_CONCURRENCY, env);
  return value !== undefined && Number.isSafeInteger(value) ? value : 2;
}

interface LaunchWaiter {
  grant(): void;
}

/** FIFO admission for expensive runner launches; runner reuse needs no admission. */
export class DefaultIosRunnerLaunchGate implements IosRunnerLaunchGate {
  private held = 0;
  private readonly waiters: LaunchWaiter[] = [];

  constructor(private readonly limit = resolveIosRunnerLaunchConcurrency()) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Launch limit must be positive");
    }
  }

  async acquire(signal?: AbortSignal): Promise<IosRunnerLaunchSlot> {
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
let sharedGate: IosRunnerLaunchGate | undefined;
export function getSharedIosRunnerLaunchGate(): IosRunnerLaunchGate {
  return (sharedGate ??= new DefaultIosRunnerLaunchGate());
}
