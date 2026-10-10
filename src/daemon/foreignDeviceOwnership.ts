import { closeSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  readExclusiveLockContent,
  releaseExclusiveLock,
  formatLockContent,
  parseLockContent,
  takeOverExclusiveLock,
  type LockContent,
} from "../utils/fileLock";
import { defaultIdGenerator } from "../utils/IdGenerator";
import { isProcessRunning } from "../utils/processLiveness";
import {
  ensureSecureDirectorySync,
  getAdbServerScopedAutoMobileDir,
  getSharedAutoMobileDir,
} from "../utils/tempDir";
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
   * Whether a claim file for `deviceId` exists but names no readable PID at the latest refresh.
   * Such a device is NOT free: whoever wrote it is unknown, so it is refused (retryably) with no
   * owner PID rather than treated as unclaimed yet unclaimable.
   */
  foreignClaimUnreadable?(deviceId: string): boolean;
  /**
   * Publish this daemon's allocation claim on a device it just assigned, so other daemons see it
   * before any CtrlProxy forward exists. False when another live daemon's claim on the device is
   * still in use: the caller must give the device back.
   */
  claim(deviceId: string): Promise<boolean>;
  /**
   * Withdraw this daemon's allocation claim on a device it no longer assigns to a session. A
   * claim another daemon took over is left alone.
   */
  release(deviceId: string): void;
}

/** The owner a lock file names: its PID and token, as written. */
type LockOwner = Pick<LockContent, "pid" | "token">;

export interface DeviceOwnershipFileSource {
  /**
   * This process's CtrlProxy forwarding lease file for the device (#10485); undefined for a
   * platform without one (iOS).
   */
  leasePath(deviceId: string): string | undefined;
  /** The allocation claim file for the device; creating its directory is left to `tryAcquire`. */
  claimPath(deviceId: string): string;
  /**
   * The coordination-directory claim file 0.0.84 daemons write (#10707). Read-only: a newer
   * daemon still honours it so it does not take a device an older daemon claimed (#10708).
   * Undefined for a platform 0.0.84 never claimed (iOS).
   */
  legacyClaimPath(deviceId: string): string | undefined;
  read(path: string): LockContent | undefined;
  /** Whether a lock file exists at `path` but is empty or names no readable PID. */
  isUnreadable?(path: string): boolean;
  isProcessRunning(pid: number): boolean;
  tryAcquire(path: string, owner: { pid: number; ownerToken: string; metadata?: string }): boolean;
  takeOver(
    path: string,
    observed: LockOwner,
    owner: { pid: number; ownerToken: string; metadata?: string },
  ): boolean;
  /** Remove the lock at `path` only while `owner` still holds it. */
  release(path: string, owner: { pid: number; ownerToken: string }): void;
}

/**
 * How long after publishing a claim its live owner may still be unreachable on its control socket
 * without the claim lapsing (#11158). A restarting daemon republishes the claims of the sessions
 * it rehydrates before it binds that socket (rehydration alone may take
 * `SESSION_REHYDRATION_DEADLINE_MS`), so "unreachable" then means "still starting", not "gone".
 * A crashed owner's PID is normally dead, which lapses its claim regardless of this window.
 */
export const DEVICE_CLAIM_OWNER_STARTUP_GRACE_MS = 60_000;

/** Directory of device allocation claims, one lock per device, under each ADB server's scope. */
export const DEVICE_ALLOCATION_CLAIM_SUBDIR = "device-allocations";

const DEFAULT_ADB_SERVER_HOST = "localhost";
const DEFAULT_ADB_SERVER_PORT = "5037";
const LOOPBACK_ADB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** A file-name-safe key for one ADB server endpoint; loopback spellings share one key. */
function tcpServerScope(host: string, port: string): string {
  const canonicalHost = LOOPBACK_ADB_HOSTS.has(host.toLowerCase())
    ? DEFAULT_ADB_SERVER_HOST
    : host.toLowerCase();
  return `tcp-${canonicalHost}-${port}`.replace(/[^A-Za-z0-9.-]/g, "_");
}

/**
 * Identifies the ADB server this process's `adb` talks to, from the variables adb itself reads:
 * `ADB_SERVER_SOCKET` (`tcp:<port>`, `tcp:<host>:<port>`, or another socket spec), else
 * `ANDROID_ADB_SERVER_ADDRESS` and `ANDROID_ADB_SERVER_PORT` (default `localhost:5037`).
 * Daemons sharing a server see the same devices, so they must share its claims (#10708).
 */
export function adbServerScope(env: NodeJS.ProcessEnv = process.env): string {
  const socket = env.ADB_SERVER_SOCKET?.trim();
  if (socket) {
    if (socket.startsWith("tcp:")) {
      const endpoint = socket.slice("tcp:".length);
      const separator = endpoint.lastIndexOf(":");
      return separator < 0
        ? tcpServerScope(DEFAULT_ADB_SERVER_HOST, endpoint)
        : tcpServerScope(endpoint.slice(0, separator), endpoint.slice(separator + 1));
    }
    return `socket-${Buffer.from(socket).toString("base64url")}`;
  }
  return tcpServerScope(
    env.ANDROID_ADB_SERVER_ADDRESS?.trim() || DEFAULT_ADB_SERVER_HOST,
    env.ANDROID_ADB_SERVER_PORT?.trim() || DEFAULT_ADB_SERVER_PORT,
  );
}

/**
 * Where a device's allocation claim lives. It is keyed by the ADB server, not by
 * `AUTOMOBILE_COORDINATION_DIR`, so two daemons that share an adb server but use different
 * coordination directories still contend for the same claim on the same device (#10708).
 */
export function deviceAllocationClaimPath(
  deviceId: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string {
  return join(
    getAdbServerScopedAutoMobileDir(
      adbServerScope(env),
      DEVICE_ALLOCATION_CLAIM_SUBDIR,
      env,
      homeDir,
    ),
    ctrlProxyForwardLeaseFileName(deviceId),
  );
}

/** Whether the lock file at `path` exists but is empty or names no readable PID. */
export function lockFileIsUnreadable(path: string): boolean {
  let content: string;
  try {
    content = readFileSync(path, "utf-8").trim();
  } catch (error) {
    // Missing (no claim) or unreadable for another reason; neither is a torn claim we can name.
    logger.debug(`claim file ${path} not readable: ${errorMessage(error)}`);
    return false;
  }
  return content.length === 0 || Number.isNaN(parseLockContent(content).pid);
}

let claimTempCounter = 0;

/**
 * Create the claim file at `path` already complete, or fail because it exists.
 *
 * The body is written to a private temp file in the same directory and `link()`ed into place.
 * `link` is atomic and fails with EEXIST when `path` exists, so the claim path is only ever
 * absent or complete: a writer that is suspended or crashes mid-write leaves a temp file, never a
 * torn claim. That removes the need to reclaim unreadable claims by age, which cannot be made
 * safe (a writer stalled between create and write would lose its lock without knowing, and a
 * reclaimer's "restore" is not atomic). At most one `link` to a given path can succeed, so at
 * most one claimant sees `true` per claim generation. A stale (dead-owner) claim is still taken
 * over by `takeOver`, the existing rename-then-verify protocol.
 */
export function createCompleteLockFile(
  path: string,
  owner: { pid: number; ownerToken: string; metadata?: string },
): boolean {
  const temp = `${path}.${owner.pid}.${++claimTempCounter}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, formatLockContent(owner.pid, owner.ownerToken, owner.metadata));
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Expected contention: another claimant (or a stale claim) holds the path.
      return false;
    }
    throw error;
  } finally {
    try {
      unlinkSync(temp);
    } catch (error) {
      // The temp name is private to this call; a failed cleanup only leaves an unreferenced file.
      logger.debug(`claim temp ${temp} cleanup failed: ${errorMessage(error)}`);
    }
  }
}

const defaultDeviceOwnershipFileSource: DeviceOwnershipFileSource = {
  // Read-only: resolving a path does not create the shared directory.
  leasePath: (deviceId) =>
    join(
      getSharedAutoMobileDir(CTRL_PROXY_FORWARD_LEASE_SUBDIR),
      ctrlProxyForwardLeaseFileName(deviceId),
    ),
  claimPath: (deviceId) => deviceAllocationClaimPath(deviceId),
  legacyClaimPath: (deviceId) =>
    join(
      getSharedAutoMobileDir(DEVICE_ALLOCATION_CLAIM_SUBDIR),
      ctrlProxyForwardLeaseFileName(deviceId),
    ),
  read: (path) => readExclusiveLockContent(path),
  isUnreadable: (path) => lockFileIsUnreadable(path),
  isProcessRunning: (pid) => isProcessRunning(pid),
  tryAcquire: (path, owner) => {
    ensureSecureDirectorySync(dirname(path));
    return createCompleteLockFile(path, owner);
  },
  takeOver: (path, observed, owner) => takeOverExclusiveLock(path, observed, owner),
  release: (path, owner) => releaseExclusiveLock(path, owner.pid, owner.ownerToken),
};

/**
 * The scope iOS simulator claims live under (#10980). A simulator set belongs to the user's
 * CoreSimulator, not to an adb server or a coordination directory, so every daemon on the host
 * contends for one claim per UDID.
 */
export const IOS_SIMULATOR_CLAIM_SCOPE = "ios-simulators";

/** Where an iOS simulator's allocation claim lives, keyed by its UDID (#10980). */
export function iosDeviceAllocationClaimPath(
  udid: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string {
  return join(
    getAdbServerScopedAutoMobileDir(
      IOS_SIMULATOR_CLAIM_SCOPE,
      DEVICE_ALLOCATION_CLAIM_SUBDIR,
      env,
      homeDir,
    ),
    ctrlProxyForwardLeaseFileName(udid),
  );
}

/**
 * The iOS file source (#10980): only the allocation claim. iOS has no CtrlProxy forwarding lease
 * file and no 0.0.84-format claim to honour.
 */
export const iosDeviceOwnershipFileSource: DeviceOwnershipFileSource = {
  ...defaultDeviceOwnershipFileSource,
  leasePath: () => undefined,
  claimPath: (udid) => iosDeviceAllocationClaimPath(udid),
  legacyClaimPath: () => undefined,
};

/**
 * Reads two per-device lock files: the CtrlProxy forwarding lease (#10485) a daemon takes in its
 * coordination directory when it first talks to a device's CtrlProxy, and the allocation claim a
 * daemon takes while a session holds the device (#10709). The claim lives in a directory
 * scoped to the ADB server rather than to the coordination directory, so daemons with different
 * `AUTOMOBILE_COORDINATION_DIR` values on one adb server still see each other's claims (#10708).
 * A 0.0.84 daemon's claim in the coordination directory (#10707) is still read, never written.
 * All use the forwarding lease's lock format, including the owner's control socket, whose
 * absolute path any daemon on the host can probe.
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
  private readonly unreadable = new Set<string>();
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
      // Not free while a claim file exists that names nobody (a known live PID is better).
      if (pid === undefined && this.hasUnreadableClaim(deviceId)) {
        this.unreadable.add(deviceId);
      } else {
        this.unreadable.delete(deviceId);
      }
    }
  }

  foreignClaimUnreadable(deviceId: string): boolean {
    return this.unreadable.has(deviceId);
  }

  /** A claim file (ours or a 0.0.84 daemon's) exists but names no PID: its writer is unknown. */
  private hasUnreadableClaim(deviceId: string): boolean {
    const paths = [
      this.resolvePath(() => this.source.claimPath(deviceId), deviceId),
      this.resolvePath(() => this.source.legacyClaimPath(deviceId), deviceId),
    ];
    return paths.some((path) => path !== undefined && this.source.isUnreadable?.(path) === true);
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
    if ((await this.legacyClaimOwner(deviceId)) !== undefined) {
      // A 0.0.84 daemon claimed the device in its coordination directory and still uses it.
      return false;
    }
    const owner = this.claimOwner();
    let acquired: boolean;
    try {
      acquired = this.source.tryAcquire(path, owner);
    } catch (error) {
      logger.warn(
        `Cannot publish the allocation claim for ${deviceId} at ${path}: ${errorMessage(error)}`,
        error,
      );
      // Without a writable claim directory, allocation proceeds as it did before claims existed.
      return true;
    }
    if (acquired) {
      return true;
    }
    const observed = this.source.read(path);
    if (!observed || Number.isNaN(observed.pid) || observed.pid === this.selfPid) {
      // Ours already. Anything else (a claim being taken over, or an unreadable claim file) is
      // refused here, and refresh reports the same device as not free, so the two agree.
      return observed?.pid === this.selfPid;
    }
    if ((await this.evaluateOwner(path, deviceId, "claim")) !== undefined) {
      return false;
    }
    // The previous claimant is gone or no longer uses the device.
    return this.source.takeOver(path, observed, owner);
  }

  release(deviceId: string): void {
    const path = this.resolvePath(() => this.source.claimPath(deviceId), deviceId);
    if (path === undefined) {
      return;
    }
    try {
      this.source.release(path, { pid: this.selfPid, ownerToken: this.ownerToken });
    } catch (error) {
      // The claim lapses anyway once this daemon reports no session on the device.
      logger.warn(
        `Cannot release the allocation claim on ${deviceId}: ${errorMessage(error)}`,
        error,
      );
    }
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
    const [leaseOwner, claimOwner, legacyOwner] = await Promise.all([
      leasePath === undefined ? undefined : this.evaluateOwner(leasePath, deviceId, "lease"),
      claimPath === undefined ? undefined : this.evaluateOwner(claimPath, deviceId, "claim"),
      this.legacyClaimOwner(deviceId),
    ]);
    return leaseOwner ?? claimOwner ?? legacyOwner;
  }

  /** The live foreign owner of a 0.0.84-format claim in the coordination directory, if any. */
  private async legacyClaimOwner(deviceId: string): Promise<number | undefined> {
    const path = this.resolvePath(() => this.source.legacyClaimPath(deviceId), deviceId);
    return path === undefined ? undefined : this.evaluateOwner(path, deviceId, "claim");
  }

  private resolvePath(resolve: () => string | undefined, deviceId: string): string | undefined {
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
    const startingUp =
      kind === "claim" &&
      this.timer.now() - metadata.acquiredAt < DEVICE_CLAIM_OWNER_STARTUP_GRACE_MS;
    return ownerStillHolds(report, pid, kind, deviceId, startingUp) ? pid : undefined;
  }
}

/**
 * Whether the owner `pid` recorded in a lock still holds it, judged from its control socket's
 * answer. An unreachable socket, or one now served by another PID, means the owner is gone and
 * its PID may name an unrelated process (#10497). A claim also lapses once the owner reports no
 * session and no running tool call on the device. A live owner that published its claim within
 * {@link DEVICE_CLAIM_OWNER_STARTUP_GRACE_MS} may not have bound its socket yet (`startingUp`), so
 * an unreachable socket does not lapse that claim (#11158).
 */
function ownerStillHolds(
  report: ForwardLeaseOwnerReport,
  pid: number,
  kind: "lease" | "claim",
  deviceId: string,
  startingUp: boolean,
): boolean {
  switch (report.kind) {
    case "unreachable":
      if (startingUp) {
        logger.debug(
          `[DevicePool] ${kind} owner PID ${pid} of ${deviceId} is live but not yet reachable; treating its fresh claim as held`,
        );
        return true;
      }
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
