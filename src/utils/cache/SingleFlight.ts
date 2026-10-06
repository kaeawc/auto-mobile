/**
 * Coalesces concurrent work for the same key without coupling the work's
 * lifetime to any one caller.
 *
 * A caller may stop waiting with its own AbortSignal, but the shared task keeps
 * running for the remaining waiters (and for a later waiter that joins before
 * it settles). This makes the first caller a waiter rather than an owner whose
 * cancellation could tear down everybody else's work.
 */
export class SingleFlight<K, V> {
  private readonly inFlight = new Map<K, Flight<V>>();

  /** Whether a flight for `key` is still joinable (running and not abandoned). */
  has(key: K): boolean {
    return this.inFlight.has(key);
  }

  delete(key: K): void {
    this.inFlight.delete(key);
  }

  clear(): void {
    this.inFlight.clear();
  }

  async run(
    key: K,
    task: (flightSignal?: AbortSignal) => Promise<V>,
    signal?: AbortSignal,
    options?: { cancelWhenAllWaitersAbort?: boolean },
  ): Promise<V> {
    signal?.throwIfAborted();

    let flight = this.inFlight.get(key);
    if (!flight) {
      const controller = options?.cancelWhenAllWaitersAbort ? new AbortController() : undefined;
      const created: Flight<V> = {
        promise: Promise.resolve().then(() => task(controller?.signal)),
        controller,
        cancelWhenAllWaitersAbort: options?.cancelWhenAllWaitersAbort ?? false,
        waiters: 0,
      };
      flight = created;
      this.inFlight.set(key, created);
      void created.promise.then(
        () => this.clearCompleted(key, created),
        () => this.clearCompleted(key, created),
      );
    }

    if (!flight.cancelWhenAllWaitersAbort) {
      return await this.waitForCaller(flight.promise, signal);
    }

    flight.waiters += 1;
    return await this.waitForCancelableCaller(key, flight, signal);
  }

  private clearCompleted(key: K, completed: Flight<V>): void {
    if (this.inFlight.get(key) === completed) {
      this.inFlight.delete(key);
    }
  }

  private waitForCancelableCaller(key: K, flight: Flight<V>, signal?: AbortSignal): Promise<V> {
    return new Promise<V>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      const releaseWaiter = (aborted = false) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        flight.waiters -= 1;
        if (aborted && flight.waiters === 0) {
          if (this.inFlight.get(key) === flight) {
            this.inFlight.delete(key);
          }
          flight.controller?.abort();
        }
      };
      const onAbort = () => {
        const reason =
          signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
        releaseWaiter(true);
        reject(reason);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (value) => {
          if (settled) {
            return;
          }
          releaseWaiter();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          releaseWaiter();
          reject(error);
        },
      );
      // Close the gap between the initial run() check and listener registration.
      if (signal?.aborted) {
        onAbort();
      }
    });
  }

  private waitForCaller(shared: Promise<V>, signal?: AbortSignal): Promise<V> {
    if (!signal) {
      return shared;
    }

    return new Promise<V>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      };
      const cleanup = () => signal.removeEventListener("abort", onAbort);

      signal.addEventListener("abort", onAbort, { once: true });
      shared.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }
}

interface Flight<V> {
  promise: Promise<V>;
  controller?: AbortController;
  cancelWhenAllWaitersAbort: boolean;
  waiters: number;
}
