import { releaseExclusiveLock, tryAcquireExclusiveLock } from "../fileLock";
import { defaultIdGenerator } from "../IdGenerator";
import { defaultLockOwnerGenerationProbe } from "../lockOwnerGeneration";

/**
 * Cross-process claim on a private netsimd instance number, held from selection until that
 * netsimd has exited, so two daemons never start (or read the ini of) the same instance.
 */
export interface NetsimInstanceClaims {
  tryClaim(lockPath: string): boolean;
  release(lockPath: string): void;
}

/** The canonical `O_EXCL` file lock; a claim left by a dead daemon is reclaimed by PID liveness. */
export class FileNetsimInstanceClaims implements NetsimInstanceClaims {
  constructor(private readonly ownerToken: string = defaultIdGenerator.next()) {}
  tryClaim(lockPath: string): boolean {
    return tryAcquireExclusiveLock(lockPath, {
      ownerToken: this.ownerToken,
      ownerGeneration: defaultLockOwnerGenerationProbe,
    });
  }
  release(lockPath: string): void {
    releaseExclusiveLock(lockPath, process.pid, this.ownerToken);
  }
}
