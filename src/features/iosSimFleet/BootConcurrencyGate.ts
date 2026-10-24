export interface BootPermit {
  release(): void;
}

export interface BootConcurrencyStatus {
  limit: number;
  running: number;
  queued: number;
}

export interface BootConcurrencyPool {
  acquire(signal?: AbortSignal, owner?: string): Promise<BootPermit>;
  setLimit(limit: number): void;
  status(): BootConcurrencyStatus;
}

interface BootWaiter {
  owner?: string;
  grant(): void;
}

/**
 * FIFO permits for simulator first-boot bursts. The separate runner launch gate
 * guards xcodebuild after Booted; the boot-to-ready permit is released before
 * runner launch, so the two gates are never held nested (#15103).
 */
export class BootConcurrencyGate implements BootConcurrencyPool {
  private running = 0;
  private readonly waiters: BootWaiter[] = [];

  constructor(private limit = 1) {
    this.setLimit(limit);
  }

  status(): BootConcurrencyStatus {
    return { limit: this.limit, running: this.running, queued: this.waiters.length };
  }

  setLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Boot concurrency limit must be a positive integer");
    }
    this.limit = limit;
    this.drain();
  }

  async acquire(signal?: AbortSignal, owner?: string): Promise<BootPermit> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(signal?.reason);
      };
      const waiter: BootWaiter = {
        owner,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          this.running++;
          let released = false;
          resolve({
            release: () => {
              if (released) {
                return;
              }
              released = true;
              this.running--;
              this.drain();
            },
          });
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.drain();
    });
  }

  private drain(): void {
    while (this.running < this.limit && this.waiters.length > 0) {
      this.waiters.shift()!.grant();
    }
  }
}
