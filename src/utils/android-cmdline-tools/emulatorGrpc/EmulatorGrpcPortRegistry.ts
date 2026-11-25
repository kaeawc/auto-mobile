import { join } from "node:path";
import {
  releaseExclusiveLock,
  tryAcquireExclusiveLock,
  type ExclusiveLockOptions,
} from "../../fileLock";
import { defaultIdGenerator } from "../../IdGenerator";
import { defaultLockOwnerGenerationProbe } from "../../lockOwnerGeneration";
import { nodeLockFileSystem } from "../../lockFileSystem";
import { ensureSecureDirectorySync, getHostGlobalAutoMobileDir } from "../../tempDir";
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

/**
 * Where gRPC port locks live. A gRPC port is a host TCP port, so every daemon of this OS user
 * shares one directory whatever its ADB server or coordination directory; scoping it to either let
 * two daemons lease 8554 together (#19188).
 */
export function defaultEmulatorGrpcLeaseDir(homeDir?: string): string {
  return getHostGlobalAutoMobileDir("emulator-grpc", homeDir);
}

/** Per-port exclusive locks shared by every daemon of this OS user on the host. */
export class FileEmulatorGrpcPortRegistry implements EmulatorGrpcPortRegistry {
  constructor(private readonly deps: FileEmulatorGrpcPortRegistryDeps = {}) {}

  claim(port: number, owner: EmulatorGrpcPortOwner): EmulatorGrpcPortLease | undefined {
    const directory = this.deps.directory?.() ?? defaultEmulatorGrpcLeaseDir();
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
