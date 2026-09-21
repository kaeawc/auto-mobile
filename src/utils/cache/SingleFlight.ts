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
  private readonly inFlight = new Map<K, Promise<V>>();

  async run(key: K, task: () => Promise<V>, signal?: AbortSignal): Promise<V> {
    signal?.throwIfAborted();

    let shared = this.inFlight.get(key);
    if (!shared) {
      const started = Promise.resolve().then(task);
      shared = started;
      this.inFlight.set(key, started);
      void started.then(
        () => this.clear(key, started),
        () => this.clear(key, started),
      );
    }

    return await this.waitForCaller(shared, signal);
  }

  private clear(key: K, completed: Promise<V>): void {
    if (this.inFlight.get(key) === completed) {
      this.inFlight.delete(key);
    }
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
