import { join } from "node:path";
import { adbServerScope } from "../../adbServerScope";
import {
  releaseExclusiveLock,
  tryAcquireExclusiveLock,
  type ExclusiveLockOptions,
} from "../../fileLock";
import { defaultIdGenerator } from "../../IdGenerator";
import { defaultLockOwnerGenerationProbe } from "../../lockOwnerGeneration";
import { nodeLockFileSystem } from "../../lockFileSystem";
import { ensureSecureDirectorySync, getAdbServerScopedAutoMobileDir } from "../../tempDir";
import type { EmulatorGrpcPortLease } from "../EmulatorPortReservations";

export interface EmulatorGrpcPortOwner {
  readonly pid: number;
  readonly launchedAt: number;
}

/** The registry owns a port throughout the emulator's pre-bind boot window. */
export interface EmulatorGrpcPortRegistry {
  claim(port: number, owner: EmulatorGrpcPortOwner): EmulatorGrpcPortLease | undefined;
}

interface FileEmulatorGrpcPortRegistryDeps extends Pick<
  ExclusiveLockOptions,
  "fileSystem" | "isProcessRunning" | "idGenerator" | "now" | "ownerGeneration"
> {
  directory?: () => string;
  ensureDirectory?: (directory: string) => void;
}

/** Per-port exclusive locks shared by private daemons using the same ADB server. */
export class FileEmulatorGrpcPortRegistry implements EmulatorGrpcPortRegistry {
  constructor(private readonly deps: FileEmulatorGrpcPortRegistryDeps = {}) {}

  claim(port: number, owner: EmulatorGrpcPortOwner): EmulatorGrpcPortLease | undefined {
    const directory =
      this.deps.directory?.() ?? getAdbServerScopedAutoMobileDir(adbServerScope(), "emulator-grpc");
    (this.deps.ensureDirectory ?? ensureSecureDirectorySync)(directory);
    const lockPath = join(directory, `${port}.lock`);
    // The lock primitive backs off silently on unreadable samples. Surface I/O errors so the
    // reservation scan can warn with the cause, while a missing file remains claimable.
    try {
      (this.deps.fileSystem ?? nodeLockFileSystem).readText(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const token = (this.deps.idGenerator ?? defaultIdGenerator).next();
    if (
      !tryAcquireExclusiveLock(lockPath, {
        ...this.deps,
        ownerGeneration: this.deps.ownerGeneration ?? defaultLockOwnerGenerationProbe,
        pid: owner.pid,
        ownerToken: token,
        metadata: String(owner.launchedAt),
      })
    ) {
      return undefined;
    }
    let released = false;
    return {
      port,
      release: () => {
        if (!released) {
          releaseExclusiveLock(lockPath, owner.pid, token, this.deps.fileSystem);
          released = true;
        }
      },
    };
  }
}
