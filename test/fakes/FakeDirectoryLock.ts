import type { DirectoryLock } from "../../src/utils/directoryLock";

/** Serializes holders in arrival order, like the file lock, and records each acquisition. */
export class FakeDirectoryLock implements DirectoryLock {
  readonly acquired: string[] = [];
  /** Runs once the lock is held and before the work, e.g. to model another process finishing first. */
  onAcquire?: (directory: string) => void | Promise<void>;
  error?: Error;
  private tail: Promise<unknown> = Promise.resolve();

  withLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (this.error) {
        throw this.error;
      }
      this.acquired.push(directory);
      await this.onAcquire?.(directory);
      return work();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
