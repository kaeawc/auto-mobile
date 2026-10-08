import { join } from "node:path";
import {
  readExclusiveLockContent,
  takeOverExclusiveLock,
  tryAcquireExclusiveLock,
  type LockContent,
} from "../utils/fileLock";
import { defaultIdGenerator } from "../utils/IdGenerator";
import { isProcessRunning } from "../utils/processLiveness";
import { ensureSecureSharedAutoMobileDirSync, getSharedAutoMobileDir } from "../utils/tempDir";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import {
  CTRL_PROXY_FORWARD_LEASE_SUBDIR,
  ctrlProxyForwardLeaseFileName,
} from "../features/observe/android/CtrlProxyForwardLease";
import {
  decodeForwardLeaseOwnerMetadata,
  encodeForwardLeaseOwnerMetadata,
  getCtrlProxyForwardLeaseOwnerSocketPath,
  type ForwardLeaseOwnerProbe,
  type ForwardLeaseOwnerReport,
} from "../features/observe/shared/ctrlProxyForwardLeaseOwnership";
import { DaemonDeviceLeaseOwnerProbe } from "./deviceLeaseOwnerQuery";

/**
 * Whether another live AutoMobile process drives a device this pool can see. Multi-device
 * allocation must not hand a plan a device another daemon is driving: on a shared adb server the
 * other daemon's emulator looks idle here, because this pool has no session on it.
 */
export interface ForeignDeviceOwnership {
  /**
   * Re-read who owns these devices, asking each owner's daemon whether it is still alive and
   * using the device. {@link foreignOwnerPid} answers from each device's latest refresh.
   */
  refresh(deviceIds: readonly string[]): Promise<void>;
  /**
   * PID of another live process that owned `deviceId` at the latest refresh, or undefined when
   * no other process did (or the device was not refreshed).
   */
  foreignOwnerPid(deviceId: string): number | undefined;
  /**
   * Publish this daemon's allocation claim on a device it just assigned, so other daemons see it
   * before any CtrlProxy forward exists. False when another live daemon's claim on the device is
   * still in use: the caller must give the device back.
   */
  claim(deviceId: string): Promise<boolean>;
}

/** The owner a lock file names: its PID and token, as written. */
type LockOwner = Pick<LockContent, "pid" | "token">;

export interface DeviceOwnershipFileSource {
  /** This process's CtrlProxy forwarding lease file for the device (#10485). */
  leasePath(deviceId: string): string;
  /** The allocation claim file for the device; creating its directory is left to `tryAcquire`. */
  claimPath(deviceId: string): string;
  read(path: string): LockContent | undefined;
  isProcessRunning(pid: number): boolean;
  tryAcquire(path: string, owner: { pid: number; ownerToken: string; metadata?: string }): boolean;
  takeOver(
    path: string,
    observed: LockOwner,
    owner: { pid: number; ownerToken: string; metadata?: string },
  ): boolean;
}

/** Shared (agent-invariant) directory of multi-device allocation claims, one lock per device. */
export const DEVICE_ALLOCATION_CLAIM_SUBDIR = "device-allocations";

const defaultDeviceOwnershipFileSource: DeviceOwnershipFileSource = {
  // Read-only: resolving a path does not create the shared directory.
  leasePath: (deviceId) =>
    join(
      getSharedAutoMobileDir(CTRL_PROXY_FORWARD_LEASE_SUBDIR),
      ctrlProxyForwardLeaseFileName(deviceId),
    ),
  claimPath: (deviceId) =>
    join(
      getSharedAutoMobileDir(DEVICE_ALLOCATION_CLAIM_SUBDIR),
      ctrlProxyForwardLeaseFileName(deviceId),
    ),
  read: (path) => readExclusiveLockContent(path),
  isProcessRunning: (pid) => isProcessRunning(pid),
  tryAcquire: (path, owner) => {
    ensureSecureSharedAutoMobileDirSync(DEVICE_ALLOCATION_CLAIM_SUBDIR);
    return tryAcquireExclusiveLock(path, owner);
  },
  takeOver: (path, observed, owner) => takeOverExclusiveLock(path, observed, owner),
};

/**
 * Reads two per-device lock files in the shared coordination directory: the CtrlProxy forwarding
 * lease (#10485) a daemon takes when it first talks to a device's CtrlProxy, and the allocation
 * claim a daemon takes when multi-device allocation assigns it the device. Both use the
 * forwarding lease's lock format, including the owner's control socket.
 *
 * A live PID alone is not trusted: after a crash or reboot the PID can name an unrelated process.
 * An owner that recorded its control socket is asked over it, the same way the CtrlProxy path
 * detects an orphaned lease (#10497): an unreachable socket, or one now served by a different
 * PID, means the owner is gone. A claim also lapses once its owner reports no session and no
 * running tool call on the device. An owner that records no socket (an older build) keeps the
 * live-PID check.
 */
export class ForwardLeaseForeignDeviceOwnership implements ForeignDeviceOwnership {
  private readonly owners = new Map<string, number>();
  private readonly ownerToken = defaultIdGenerator.next();

  constructor(
    private readonly selfPid: number = process.pid,
    private readonly source: DeviceOwnershipFileSource = defaultDeviceOwnershipFileSource,
    private readonly probe: ForwardLeaseOwnerProbe = new DaemonDeviceLeaseOwnerProbe(),
    private readonly ownerSocketPath: () =>
      | string
      | undefined = getCtrlProxyForwardLeaseOwnerSocketPath,
    private readonly timer: Timer = defaultTimer,
  ) {}

  async refresh(deviceIds: readonly string[]): Promise<void> {
    const entries = await Promise.all(
      deviceIds.map(async (deviceId) => [deviceId, await this.readForeignOwner(deviceId)] as const),
    );
    for (const [deviceId, pid] of entries) {
      if (pid === undefined) {
        this.owners.delete(deviceId);
      } else {
        this.owners.set(deviceId, pid);
      }
    }
  }

  foreignOwnerPid(deviceId: string): number | undefined {
    return this.owners.get(deviceId);
  }

  async claim(deviceId: string): Promise<boolean> {
    const path = this.resolvePath(() => this.source.claimPath(deviceId), deviceId);
    if (path === undefined) {
      // No claim can be published; allocation proceeds as it did before claims existed.
      return true;
    }
    const owner = this.claimOwner();
    if (this.source.tryAcquire(path, owner)) {
      return true;
    }
    const observed = this.source.read(path);
    if (!observed || Number.isNaN(observed.pid) || observed.pid === this.selfPid) {
      // Ours already, or mid-write by a racing claimant that the next pass sees.
      return observed?.pid === this.selfPid;
    }
    if ((await this.evaluateOwner(path, deviceId, "claim")) !== undefined) {
      return false;
    }
    // The previous claimant is gone or no longer uses the device.
    return this.source.takeOver(path, observed, owner);
  }

  private claimOwner(): { pid: number; ownerToken: string; metadata?: string } {
    const socketPath = this.ownerSocketPath();
    return {
      pid: this.selfPid,
      ownerToken: this.ownerToken,
      ...(socketPath === undefined
        ? {}
        : {
            metadata: encodeForwardLeaseOwnerMetadata({ socketPath, acquiredAt: this.timer.now() }),
          }),
    };
  }

  private async readForeignOwner(deviceId: string): Promise<number | undefined> {
    const leasePath = this.resolvePath(() => this.source.leasePath(deviceId), deviceId);
    const claimPath = this.resolvePath(() => this.source.claimPath(deviceId), deviceId);
    const [leaseOwner, claimOwner] = await Promise.all([
      leasePath === undefined ? undefined : this.evaluateOwner(leasePath, deviceId, "lease"),
      claimPath === undefined ? undefined : this.evaluateOwner(claimPath, deviceId, "claim"),
    ]);
    return leaseOwner ?? claimOwner;
  }

  private resolvePath(resolve: () => string, deviceId: string): string | undefined {
    try {
      return resolve();
    } catch (error) {
      logger.warn(
        `Cannot resolve the device ownership files for ${deviceId}: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  /** The PID of a live foreign owner of the lock at `path` that still uses `deviceId`. */
  private async evaluateOwner(
    path: string,
    deviceId: string,
    kind: "lease" | "claim",
  ): Promise<number | undefined> {
    const content = this.source.read(path);
    const pid = content?.pid;
    if (
      pid === undefined ||
      Number.isNaN(pid) ||
      pid === this.selfPid ||
      !this.source.isProcessRunning(pid)
    ) {
      return undefined;
    }
    const metadata = decodeForwardLeaseOwnerMetadata(content?.metadata);
    if (!metadata) {
      // An older build records no control socket, so the live PID is the only evidence.
      return pid;
    }
    const report = await this.probe.query(metadata.socketPath, deviceId);
    return ownerStillHolds(report, pid, kind, deviceId) ? pid : undefined;
  }
}

/**
 * Whether the owner `pid` recorded in a lock still holds it, judged from its control socket's
 * answer. An unreachable socket, or one now served by another PID, means the owner is gone and
 * its PID may name an unrelated process (#10497). A claim also lapses once the owner reports no
 * session and no running tool call on the device.
 */
function ownerStillHolds(
  report: ForwardLeaseOwnerReport,
  pid: number,
  kind: "lease" | "claim",
  deviceId: string,
): boolean {
  switch (report.kind) {
    case "unreachable":
      // Expected after the owner crashed or the host rebooted.
      logger.debug(
        `[DevicePool] ${kind} owner PID ${pid} of ${deviceId} is orphaned: ${report.detail}`,
      );
      return false;
    case "no-response":
    case "unsupported":
      // A busy or older owner cannot report its use; keep treating the device as its own.
      return true;
    case "status":
      if (report.status.pid !== pid) {
        logger.debug(
          `[DevicePool] ${kind} owner PID ${pid} of ${deviceId} is orphaned: its socket is served by PID ${report.status.pid}`,
        );
        return false;
      }
      return (
        kind === "lease" || report.status.sessionId !== null || report.status.activeExecutions > 0
      );
  }
}
