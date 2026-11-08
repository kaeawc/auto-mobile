import { join } from "node:path";
import { ActionableError } from "../../../../models/ActionableError";
import { defaultIdGenerator } from "../../../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../../../utils/SystemTimer";
import { releaseExclusiveLock, tryAcquireExclusiveLock } from "../../../../utils/fileLock";
import { defaultLockOwnerGenerationProbe } from "../../../../utils/lockOwnerGeneration";

/** Serializes host key creation across signer instances and processes sharing a directory. */
export interface SigningKeyLock {
  withLock<T>(directory: string, work: () => Promise<T>): Promise<T>;
}

const SIGNING_KEY_LOCK_POLL_MS = 100;
const SIGNING_KEY_LOCK_TIMEOUT_MS = 60_000;

/** The canonical `O_EXCL` file lock on `<directory>/key.lock`, polled until a bounded deadline. */
export class FileSigningKeyLock implements SigningKeyLock {
  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly ownerToken: string = defaultIdGenerator.next(),
  ) {}
  async withLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
    const path = join(directory, "key.lock");
    const deadline = this.timer.now() + SIGNING_KEY_LOCK_TIMEOUT_MS;
    while (
      !tryAcquireExclusiveLock(path, {
        ownerToken: this.ownerToken,
        ownerGeneration: defaultLockOwnerGenerationProbe,
      })
    ) {
      if (this.timer.now() >= deadline) {
        throw new ActionableError(
          `Timed out waiting for the host signing key lock at ${path}. Another AutoMobile process is creating the key; retry, or remove the lock if no such process is running.`,
        );
      }
      await this.timer.sleep(SIGNING_KEY_LOCK_POLL_MS);
    }
    try {
      return await work();
    } finally {
      releaseExclusiveLock(path, process.pid, this.ownerToken);
    }
  }
}
