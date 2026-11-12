import { join } from "node:path";
import { ActionableError } from "../models/ActionableError";
import { defaultIdGenerator } from "./IdGenerator";
import { defaultTimer, type Timer } from "./SystemTimer";
import { releaseExclusiveLock, tryAcquireExclusiveLock } from "./fileLock";
import { defaultLockOwnerGenerationProbe } from "./lockOwnerGeneration";

/** Serializes work on one directory across instances and processes sharing it. */
export interface DirectoryLock {
  withLock<T>(directory: string, work: () => Promise<T>): Promise<T>;
}

export interface FileDirectoryLockOptions {
  /** Lock file name created inside the directory. */
  fileName: string;
  /** What the lock guards, for the timeout error (e.g. "the host signing key lock"). */
  description: string;
  /** What the other holder is doing, for the timeout error. */
  holderActivity: string;
  timeoutMs: number;
  pollMs?: number;
  timer?: Timer;
  ownerToken?: string;
}

/** The canonical `O_EXCL` file lock on `<directory>/<fileName>`, polled until a bounded deadline. */
export class FileDirectoryLock implements DirectoryLock {
  private readonly timer: Timer;
  private readonly ownerToken: string;

  constructor(private readonly options: FileDirectoryLockOptions) {
    this.timer = options.timer ?? defaultTimer;
    this.ownerToken = options.ownerToken ?? defaultIdGenerator.next();
  }

  async withLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
    const path = join(directory, this.options.fileName);
    const deadline = this.timer.now() + this.options.timeoutMs;
    while (
      !tryAcquireExclusiveLock(path, {
        ownerToken: this.ownerToken,
        ownerGeneration: defaultLockOwnerGenerationProbe,
      })
    ) {
      if (this.timer.now() >= deadline) {
        throw new ActionableError(
          `Timed out waiting for ${this.options.description} at ${path}. ${this.options.holderActivity}; retry, or remove the lock if no such process is running.`,
        );
      }
      await this.timer.sleep(this.options.pollMs ?? 100);
    }
    try {
      return await work();
    } finally {
      releaseExclusiveLock(path, process.pid, this.ownerToken);
    }
  }
}
