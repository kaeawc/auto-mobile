import { join } from "node:path";
import { readExclusiveLockContent } from "../utils/fileLock";
import { isProcessRunning } from "../utils/processLiveness";
import { getSharedAutoMobileDir } from "../utils/tempDir";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import {
  CTRL_PROXY_FORWARD_LEASE_SUBDIR,
  ctrlProxyForwardLeaseFileName,
} from "../features/observe/android/CtrlProxyForwardLease";

/**
 * Whether another live AutoMobile process drives a device this pool can see. Multi-device
 * allocation must not hand a plan a device another daemon is driving: on a shared adb server the
 * other daemon's emulator looks idle here, because this pool has no session on it.
 */
export interface ForeignDeviceOwnership {
  /** PID of another live process that owns `deviceId`, or undefined when no other process does. */
  foreignOwnerPid(deviceId: string): number | undefined;
}

export interface ForwardLeaseFileSource {
  lockPath(deviceId: string): string;
  readOwnerPid(path: string): number | undefined;
  isProcessRunning(pid: number): boolean;
}

const defaultForwardLeaseFileSource: ForwardLeaseFileSource = {
  // Read-only: resolving the path does not create the shared lease directory.
  lockPath: (deviceId) =>
    join(
      getSharedAutoMobileDir(CTRL_PROXY_FORWARD_LEASE_SUBDIR),
      ctrlProxyForwardLeaseFileName(deviceId),
    ),
  readOwnerPid: (path) => readExclusiveLockContent(path)?.pid,
  isProcessRunning: (pid) => isProcessRunning(pid),
};

/**
 * Reads the CtrlProxy forwarding lease (#10485) each daemon takes on a device it drives. A lease
 * held by a different live PID means another daemon is using the device; a dead holder's lease is
 * reclaimable and does not count. An owner that stops using the device releases its lease after
 * the idle window (#10506), so the device becomes allocatable again.
 */
export class ForwardLeaseForeignDeviceOwnership implements ForeignDeviceOwnership {
  constructor(
    private readonly selfPid: number = process.pid,
    private readonly source: ForwardLeaseFileSource = defaultForwardLeaseFileSource,
  ) {}

  foreignOwnerPid(deviceId: string): number | undefined {
    let lockPath: string;
    try {
      lockPath = this.source.lockPath(deviceId);
    } catch (error) {
      logger.warn(
        `Cannot resolve the CtrlProxy forwarding lease for ${deviceId}: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
    const pid = this.source.readOwnerPid(lockPath);
    if (pid === undefined || Number.isNaN(pid) || pid === this.selfPid) {
      return undefined;
    }
    return this.source.isProcessRunning(pid) ? pid : undefined;
  }
}
