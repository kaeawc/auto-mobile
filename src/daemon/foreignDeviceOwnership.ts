import type { DeviceClaimMirror } from "./deviceClaims";
import { raceWithDeadline } from "../utils/raceWithDeadline";
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
import type { ForeignCtrlProxyForwardEvidence } from "../features/observe/android/foreignCtrlProxyForwardEvidence";
import {
  decodeForwardLeaseOwnerMetadata,
  encodeForwardLeaseOwnerMetadata,
  getCtrlProxyForwardLeaseOwnerSocketPath,
  type ForwardLeaseOwnerMetadata,
  type ForwardLeaseOwnerProbe,
  type ForwardLeaseOwnerReport,
  type ForwardLeaseRelinquishProbe,
} from "../features/observe/shared/ctrlProxyForwardLeaseOwnership";
import {
  DaemonDeviceLeaseOwnerProbe,
  DEVICE_LEASE_OWNER_QUERY_TIMEOUT_MS,
} from "./deviceLeaseOwnerQuery";
import { AMBIENT_ENV, readEnvRaw } from "../config/env";

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
  refresh(deviceIds: readonly string[], signal?: AbortSignal): Promise<void>;
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
   * When the only foreign ownership of `deviceId` at the latest refresh was a CtrlProxy forwarding
   * lease whose holder reported no session and no running tool call, ask that holder once to give
   * the lease up, then re-read ownership (#11349). The holder decides; {@link foreignOwnerPid}
   * still names it when it kept the lease. Does nothing for any other kind of ownership.
   */
  relinquishIdleLease?(deviceId: string): Promise<void>;
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
  /**
   * Mirror this daemon's claims into the host-wide `device_claims` table (#11811 step b). The claim
   * files stay authoritative; the mirror never changes a claim's outcome.
   */
  attachClaimMirror?(mirror: DeviceClaimMirror): void;
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

/**
 * How long a live owner may keep accepting connections on its control socket without answering
 * before its claims and leases lapse (#11349, owner decision 2026-10-10). One unanswered request
 * means a busy owner; an unbroken run of them this long means a wedged one, which would otherwise
 * hold its devices for as long as its process lives.
 */
export const DEVICE_OWNER_UNANSWERED_LAPSE_MS = 5 * 60_000;

/**
 * The longest gap between two unanswered requests that still counts as one run. Ownership is only
 * probed on demand, so two timeouts far apart say nothing about the time between them: a live
 * owner that happened to be busy twice must keep its devices. Fifteen probe timeouts, so a prober
 * that retries every few seconds (allocation waits, readiness retries) stays within it while
 * unrelated calls minutes apart do not.
 */
export const DEVICE_OWNER_UNANSWERED_MAX_SAMPLE_GAP_MS = 15 * DEVICE_LEASE_OWNER_QUERY_TIMEOUT_MS;

/**
 * The fewest distinct unanswered samples a lapse needs: what it takes to span
 * {@link DEVICE_OWNER_UNANSWERED_LAPSE_MS} at the widest allowed gap. The gap rule already implies
 * it on a steady clock; stating it keeps a clock anomaly from lapsing a claim on a few samples.
 */
export const DEVICE_OWNER_UNANSWERED_MIN_SAMPLES =
  Math.ceil(DEVICE_OWNER_UNANSWERED_LAPSE_MS / DEVICE_OWNER_UNANSWERED_MAX_SAMPLE_GAP_MS) + 1;

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
  const socket = readEnvRaw(AMBIENT_ENV.ADB_SERVER_SOCKET, env)?.trim();
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
    readEnvRaw(AMBIENT_ENV.ANDROID_ADB_SERVER_ADDRESS, env)?.trim() || DEFAULT_ADB_SERVER_HOST,
    readEnvRaw(AMBIENT_ENV.ANDROID_ADB_SERVER_PORT, env)?.trim() || DEFAULT_ADB_SERVER_PORT,
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
 * live-PID check. An owner whose socket accepts but never answers keeps its devices while that
 * could be a busy moment, and loses them after {@link DEVICE_OWNER_UNANSWERED_LAPSE_MS} of it.
 */
export class ForwardLeaseForeignDeviceOwnership implements ForeignDeviceOwnership {
  private readonly owners = new Map<string, number>();
  private readonly unreadable = new Set<string>();
  /** Device -> control socket of an idle holder whose lease was its only foreign ownership. */
  private readonly idleLeaseHolders = new Map<string, string>();
  /** Owner PID -> its current run of unanswered status requests, cleared by any answer. */
  private readonly unanswered = new Map<number, UnansweredRun>();
  private readonly ownerToken = defaultIdGenerator.next();
  private claimMirror: DeviceClaimMirror | undefined;

  constructor(
    private readonly selfPid: number = process.pid,
    private readonly source: DeviceOwnershipFileSource = defaultDeviceOwnershipFileSource,
    private readonly probe: ForwardLeaseOwnerProbe &
      Partial<ForwardLeaseRelinquishProbe> = new DaemonDeviceLeaseOwnerProbe(),
    private readonly ownerSocketPath: () =>
      | string
      | undefined = getCtrlProxyForwardLeaseOwnerSocketPath,
    private readonly timer: Timer = defaultTimer,
    private readonly forwardEvidence?: ForeignCtrlProxyForwardEvidence,
  ) {}

  async refresh(deviceIds: readonly string[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const entries = await raceWithDeadline(
      Promise.all(
        deviceIds.map(
          async (deviceId) =>
            [deviceId, await this.readOwnerWithForwardEvidence(deviceId, signal)] as const,
        ),
      ),
      { timer: this.timer, signal, label: "Foreign ownership refresh" },
    );
    signal?.throwIfAborted();
    for (const [deviceId, { pid, forwardUnreadable }] of entries) {
      if (pid === undefined) {
        this.owners.delete(deviceId);
      } else {
        this.owners.set(deviceId, pid);
      }
      // Not free while a claim file exists that names nobody (a known live PID is better).
      if (pid === undefined && (forwardUnreadable || this.hasUnreadableClaim(deviceId))) {
        this.unreadable.add(deviceId);
      } else {
        this.unreadable.delete(deviceId);
      }
    }
  }

  private async readOwnerWithForwardEvidence(
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<{ pid: number | undefined; forwardUnreadable: boolean }> {
    const fileOwnerPid = await raceWithDeadline(this.readForeignOwner(deviceId), {
      timer: this.timer,
      signal,
      label: "Foreign ownership files",
    });
    signal?.throwIfAborted();
    // A verified file owner decides this refresh; avoid a host forward probe when known (#12220).
    if (fileOwnerPid !== undefined) {
      return { pid: fileOwnerPid, forwardUnreadable: false };
    }
    return this.readForwardEvidence(deviceId, signal);
  }

  private async readForwardEvidence(
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<{ pid: number | undefined; forwardUnreadable: boolean }> {
    const forward = await this.forwardEvidence?.read(deviceId, signal);
    if (!forward || forward.kind === "none") {
      return { pid: undefined, forwardUnreadable: false };
    }
    if (forward.ports.length === 0) {
      if (forward.kind === "unknown") {
        logger.warn(
          `[DevicePool] Cannot inspect CtrlProxy forwards for ${deviceId}: ${forward.message}`,
        );
      }
      return { pid: undefined, forwardUnreadable: false };
    }
    // A peer's live forwarding client cannot be made safe by relinquishing this daemon's
    // separate idle lease. Keep the evidence until the next fresh read (#12220).
    this.idleLeaseHolders.delete(deviceId);
    if (forward.kind === "foreign") {
      return { pid: forward.clientPids[0], forwardUnreadable: false };
    }
    return { pid: undefined, forwardUnreadable: true };
  }

  foreignClaimUnreadable(deviceId: string): boolean {
    return this.unreadable.has(deviceId);
  }

  attachClaimMirror(mirror: DeviceClaimMirror): void {
    this.claimMirror = mirror;
  }

  async relinquishIdleLease(deviceId: string): Promise<void> {
    const socketPath = this.idleLeaseHolders.get(deviceId);
    if (socketPath === undefined || !this.probe.requestRelinquish) {
      return;
    }
    // One bounded request; whatever the holder answers, the re-read below is the verdict.
    const report = await this.probe.requestRelinquish(socketPath, deviceId);
    logger.info(
      `[DevicePool] Asked the idle forwarding-lease holder of ${deviceId} to relinquish it: ` +
        (report.kind === "relinquish"
          ? `${report.result.released ? "released" : "kept"} (${report.result.reason})`
          : `${report.kind} (${report.detail})`),
    );
    await this.refresh([deviceId]);
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
    const owner = this.claimOwner();
    const outcome = await this.claimFile(deviceId, owner);
    if (outcome === "claimed") {
      this.claimMirror?.claimed(deviceId, owner, () => this.claimFileIsOurs(deviceId, owner));
    }
    return outcome !== "refused";
  }

  /** Whether the claim file for `deviceId` still names this owner. */
  private claimFileIsOurs(deviceId: string, owner: { pid: number; ownerToken: string }): boolean {
    const path = this.resolvePath(() => this.source.claimPath(deviceId), deviceId);
    if (path === undefined) {
      return false;
    }
    const held = this.source.read(path);
    return held?.pid === owner.pid && held.token === owner.ownerToken;
  }

  /** Take the claim file: "unpublished" when no claim could be written and allocation proceeds. */
  private async claimFile(
    deviceId: string,
    owner: { pid: number; ownerToken: string; metadata?: string },
  ): Promise<"claimed" | "unpublished" | "refused"> {
    const path = this.resolvePath(() => this.source.claimPath(deviceId), deviceId);
    if (path === undefined) {
      // No claim can be published; allocation proceeds as it did before claims existed.
      return "unpublished";
    }
    if ((await this.legacyClaimOwner(deviceId)) !== undefined) {
      // A 0.0.84 daemon claimed the device in its coordination directory and still uses it.
      return "refused";
    }
    let acquired: boolean;
    try {
      acquired = this.source.tryAcquire(path, owner);
    } catch (error) {
      logger.warn(
        `Cannot publish the allocation claim for ${deviceId} at ${path}: ${errorMessage(error)}`,
        error,
      );
      // Without a writable claim directory, allocation proceeds as it did before claims existed.
      return "unpublished";
    }
    if (acquired) {
      return this.unlessHeldInTable(deviceId, path, owner);
    }
    const observed = this.source.read(path);
    if (!observed || Number.isNaN(observed.pid) || observed.pid === this.selfPid) {
      // Ours already. Anything else (a claim being taken over, or an unreadable claim file) is
      // refused here, and refresh reports the same device as not free, so the two agree.
      return observed?.pid === this.selfPid ? "claimed" : "refused";
    }
    if ((await this.evaluateOwner(path, deviceId, "claim")) !== undefined) {
      return "refused";
    }
    // The previous claimant is gone or no longer uses the device.
    return this.source.takeOver(path, observed, owner)
      ? this.unlessHeldInTable(deviceId, path, owner)
      : "refused";
  }

  /**
   * A claim file just taken is given back when another live daemon holds the device in the
   * host-wide table, whatever claim directory it used (#11811 step c). A claim that was already
   * ours is never questioned: the table row is then merely behind.
   */
  private async unlessHeldInTable(
    deviceId: string,
    path: string,
    owner: { pid: number; ownerToken: string },
  ): Promise<"claimed" | "refused"> {
    if ((await this.tableClaimOwner(deviceId)) === undefined) {
      return "claimed";
    }
    try {
      this.source.release(path, owner);
    } catch (error) {
      logger.warn(
        `Cannot give back the claim on ${deviceId} another daemon holds in the host-wide table: ${errorMessage(error)}`,
        error,
      );
    }
    return "refused";
  }

  release(deviceId: string): void {
    const path = this.resolvePath(() => this.source.claimPath(deviceId), deviceId);
    if (path === undefined) {
      return;
    }
    try {
      this.source.release(path, { pid: this.selfPid, ownerToken: this.ownerToken });
      this.claimMirror?.released(deviceId, { pid: this.selfPid, ownerToken: this.ownerToken });
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
    const [lease, claimOwner, legacyOwner] = await Promise.all([
      leasePath === undefined ? undefined : this.evaluateLock(leasePath, deviceId, "lease"),
      claimPath === undefined ? undefined : this.evaluateOwner(claimPath, deviceId, "claim"),
      this.legacyClaimOwner(deviceId),
    ]);
    const tableOwner = await this.tableOwnerUnlessAFileDecides(
      deviceId,
      lease,
      claimOwner ?? legacyOwner,
    );
    if (
      lease?.idleSocketPath !== undefined &&
      (claimOwner ?? legacyOwner ?? tableOwner) === undefined
    ) {
      this.idleLeaseHolders.set(deviceId, lease.idleSocketPath);
    } else {
      this.idleLeaseHolders.delete(deviceId);
    }
    return lease?.pid ?? claimOwner ?? legacyOwner ?? tableOwner;
  }

  /**
   * An owner a file names decides, so the table is not read (nor its owner asked) for it. A lease
   * whose holder is idle does not: the table may still name a busy owner of the device.
   */
  private async tableOwnerUnlessAFileDecides(
    deviceId: string,
    lease: { pid: number; idleSocketPath?: string } | undefined,
    claimOrLegacyOwner: number | undefined,
  ): Promise<number | undefined> {
    const busyLeasePid = lease?.idleSocketPath === undefined ? lease?.pid : undefined;
    return (claimOrLegacyOwner ?? busyLeasePid) === undefined
      ? this.tableClaimOwner(deviceId)
      : undefined;
  }

  /**
   * The live foreign owner the host-wide claims table names, judged like a claim file's owner
   * (#11811 step c). Any owner a file names wins, and a table that cannot be read changes nothing:
   * the files decide alone, as before the table existed.
   */
  private async tableClaimOwner(deviceId: string): Promise<number | undefined> {
    if (!this.claimMirror?.read) {
      return undefined;
    }
    try {
      const row = await this.claimMirror.read(deviceId);
      if (!row) {
        return undefined;
      }
      return (
        await this.evaluateContent({ pid: row.pid, metadata: row.metadata }, deviceId, "claim")
      )?.pid;
    } catch (error) {
      logger.warn(
        `Cannot read the host-wide claim on ${deviceId}; the claim files decide: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
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
    return (await this.evaluateLock(path, deviceId, kind))?.pid;
  }

  /**
   * The live foreign owner of the lock at `path` that still uses `deviceId`, and its control
   * socket when it answered that it has no session and no running tool call on the device.
   */
  private async evaluateLock(
    path: string,
    deviceId: string,
    kind: "lease" | "claim",
  ): Promise<{ pid: number; idleSocketPath?: string } | undefined> {
    return this.evaluateContent(this.source.read(path), deviceId, kind);
  }

  /** {@link evaluateLock} for an owner record already read, from a claim file or the table. */
  private async evaluateContent(
    content: Pick<LockContent, "pid" | "metadata"> | undefined,
    deviceId: string,
    kind: "lease" | "claim",
  ): Promise<{ pid: number; idleSocketPath?: string } | undefined> {
    const lock = this.liveForeignLock(content);
    if (!lock) {
      return undefined;
    }
    const { pid, metadata } = lock;
    if (!metadata) {
      // An older build records no control socket, so the live PID is the only evidence.
      return { pid };
    }
    const report = await this.probe.query(metadata.socketPath, deviceId);
    if (this.wedgedOwnerLapsed(report, pid, deviceId, kind)) {
      return undefined;
    }
    const startingUp =
      kind === "claim" &&
      this.timer.now() - metadata.acquiredAt < DEVICE_CLAIM_OWNER_STARTUP_GRACE_MS;
    if (!ownerStillHolds(report, pid, kind, deviceId, startingUp)) {
      return undefined;
    }
    return ownerReportsNoUse(report) ? { pid, idleSocketPath: metadata.socketPath } : { pid };
  }

  /** The lock at `path` when a live process other than this one holds it. */
  private liveForeignLock(
    content: Pick<LockContent, "pid" | "metadata"> | undefined,
  ): { pid: number; metadata: ForwardLeaseOwnerMetadata | undefined } | undefined {
    const pid = content?.pid;
    if (pid === undefined || Number.isNaN(pid) || pid === this.selfPid) {
      return undefined;
    }
    if (!this.source.isProcessRunning(pid)) {
      this.unanswered.delete(pid);
      return undefined;
    }
    return { pid, metadata: decodeForwardLeaseOwnerMetadata(content?.metadata) };
  }

  /**
   * Whether owner `pid` has now gone unanswered for {@link DEVICE_OWNER_UNANSWERED_LAPSE_MS}: it
   * is alive but wedged, and its hold on `deviceId` has lapsed (#11349). Any answer ends the run,
   * and so does a gap in sampling: the run must be densely observed for the whole window.
   * Warns once per device until the owner answers again.
   */
  private wedgedOwnerLapsed(
    report: ForwardLeaseOwnerReport,
    pid: number,
    deviceId: string,
    kind: "lease" | "claim",
  ): boolean {
    if (report.kind !== "no-response") {
      this.unanswered.delete(pid);
      return false;
    }
    // Monotonic where available: a wall-clock step or a host suspend is not unanswered time.
    const now = this.timer.monotonicNow?.() ?? this.timer.now();
    const streak = this.unansweredRun(pid, now);
    const unansweredForMs = now - streak.since;
    if (
      unansweredForMs < DEVICE_OWNER_UNANSWERED_LAPSE_MS ||
      streak.samples < DEVICE_OWNER_UNANSWERED_MIN_SAMPLES
    ) {
      return false;
    }
    if (!streak.warnedDevices.has(deviceId)) {
      streak.warnedDevices.add(deviceId);
      logger.warn(
        `[DevicePool] ${kind} owner PID ${pid} of ${deviceId} is alive but has not answered on its ` +
          `control socket for ${Math.round(unansweredForMs / 1000)}s; treating its hold on the ` +
          "device as lapsed",
      );
    }
    return true;
  }

  /**
   * Owner `pid`'s run of unanswered requests with this one counted. A sample that follows the
   * previous one by more than {@link DEVICE_OWNER_UNANSWERED_MAX_SAMPLE_GAP_MS} starts a new run:
   * nothing was observed in between, so the owner may have answered anyone throughout.
   */
  private unansweredRun(pid: number, now: number): UnansweredRun {
    const previous = this.unanswered.get(pid);
    if (!previous || now - previous.lastAt > DEVICE_OWNER_UNANSWERED_MAX_SAMPLE_GAP_MS) {
      const started = { since: now, lastAt: now, samples: 1, warnedDevices: new Set<string>() };
      this.unanswered.set(pid, started);
      return started;
    }
    if (now > previous.lastAt) {
      // Requests answered (or not) at the same instant are one observation, not several.
      previous.samples += 1;
      previous.lastAt = now;
    }
    return previous;
  }
}

/** One owner's unbroken, densely sampled run of unanswered status requests. */
interface UnansweredRun {
  since: number;
  lastAt: number;
  samples: number;
  warnedDevices: Set<string>;
}

/** Whether an owner answered that it has no session and no running tool call on the device. */
function ownerReportsNoUse(report: ForwardLeaseOwnerReport): boolean {
  return (
    report.kind === "status" &&
    report.status.sessionId === null &&
    report.status.activeExecutions === 0
  );
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
      // A busy or older owner cannot report its use; keep treating the device as its own. An
      // owner unanswered for DEVICE_OWNER_UNANSWERED_LAPSE_MS never reaches here.
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
