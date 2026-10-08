import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../../../utils/describeUnknownError";
import { defaultIdGenerator } from "../../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import {
  readExclusiveLockContent,
  readLockOwnerPid,
  releaseExclusiveLock,
  takeOverExclusiveLock,
  tryAcquireExclusiveLock,
} from "../../../utils/fileLock";
import { ensureSecureSharedAutoMobileDirSync } from "../../../utils/tempDir";
import { DaemonDeviceLeaseOwnerProbe } from "../../../daemon/deviceLeaseOwnerQuery";
import {
  decideForwardLeaseReclaim,
  decodeForwardLeaseOwnerMetadata,
  encodeForwardLeaseOwnerMetadata,
  getCtrlProxyForwardLeaseOwnerSocketPath,
  type ForwardLeaseRelinquishProbe,
} from "../shared/ctrlProxyForwardLeaseOwnership";

/** Shared (agent-invariant) directory holding one lease lock file per device. */
export const CTRL_PROXY_FORWARD_LEASE_SUBDIR = "ctrlproxy-forwards";

export function ctrlProxyForwardLeaseDir(): string {
  // Agent-specific data directories are intentionally isolated, but a default
  // ADB server is shared across agents for this OS user.
  return ensureSecureSharedAutoMobileDirSync(CTRL_PROXY_FORWARD_LEASE_SUBDIR);
}

/** base64url makes arbitrary Android serials safe as one path segment. */
export function ctrlProxyForwardLeaseFileName(deviceId: string): string {
  return `${Buffer.from(deviceId).toString("base64url")}.lock`;
}

export function deviceIdFromCtrlProxyForwardLeaseFileName(fileName: string): string | undefined {
  if (!fileName.endsWith(".lock")) {
    return undefined;
  }
  const decoded = Buffer.from(fileName.slice(0, -".lock".length), "base64url").toString("utf8");
  return decoded.length > 0 ? decoded : undefined;
}

/**
 * Marker recording that a process in this coordination directory created the
 * CtrlProxy forward on `localPort` for `deviceId` (issue #10690). The ".forward"
 * suffix keeps markers out of the ".lock" lease listing.
 */
export function ctrlProxyOwnedForwardFileName(deviceId: string, localPort: number): string {
  return `${Buffer.from(deviceId).toString("base64url")}.${localPort}.forward`;
}

/** One `.forward` marker: the host port and when its writer recorded it. */
export interface RecordedCtrlProxyForward {
  localPort: number;
  /** Writer's clock when recorded; 0 when the record cannot be read. */
  createdAt: number;
}

/** Parse the host port out of a marker file name written for `deviceId`. */
function localPortFromOwnedForwardFileName(deviceId: string, fileName: string): number | undefined {
  const prefix = `${Buffer.from(deviceId).toString("base64url")}.`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith(".forward")) {
    return undefined;
  }
  const port = Number(fileName.slice(prefix.length, -".forward".length));
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function recordCreatedAt(contents: string): number {
  try {
    const parsed: unknown = JSON.parse(contents);
    return typeof parsed === "object" &&
      parsed !== null &&
      "createdAt" in parsed &&
      typeof parsed.createdAt === "number"
      ? parsed.createdAt
      : 0;
  } catch (error) {
    // A torn or foreign-format record carries no time; 0 lets the sweep prune it.
    logger.debug(`[CTRL_PROXY] Unreadable CtrlProxy forward record: ${errorMessage(error)}`);
    return 0;
  }
}

/** Why an attempt to take a live owner's lease succeeded or was refused. */
export interface ForwardLeaseReclaimResult {
  acquired: boolean;
  ownerPid?: number;
  ownerSocketPath?: string;
  reason: string;
  /** A time-based refusal that may lift if retried shortly. */
  transient?: boolean;
}

/**
 * Process-held ownership claim for a device's CtrlProxy ADB forwards. The ADB
 * server is shared by AutoMobile processes, so its global forward listing alone
 * cannot identify which process owns a row.
 */
export interface CtrlProxyForwardLease {
  tryAcquire(): boolean;
  release(): void;
  fork?(): CtrlProxyForwardLease;
  /**
   * PID of the process currently holding the lease, when a preceding
   * {@link tryAcquire} call returned `false` (issue #6260). Lets the caller
   * name the orphan in its actionable error instead of a bare "another
   * process owns this" message the client cannot act on.
   */
  getLastOwnerPid(): number | undefined;
  /**
   * After {@link tryAcquire} failed against a live foreign owner, ask that
   * owner to give the lease up when it no longer uses the device, then take it
   * (issue #10497). An owner that cannot be asked (unreachable or orphaned
   * socket) is taken over directly.
   */
  tryReclaimFromStaleOwner?(): Promise<ForwardLeaseReclaimResult>;
  /** Whether this process currently holds the lease. */
  isHeld?(): boolean;
  /** When this process last took the lease, while it holds it. */
  getAcquiredAt?(): number | undefined;
  /**
   * Record that this process created the device's CtrlProxy forward on
   * `localPort` (issue #10690). Only a recorded forward may later be removed.
   */
  recordOwnedForward?(localPort: number): void;
  /** Drop the record once the forward on `localPort` is confirmed gone. */
  forgetOwnedForward?(localPort: number): void;
  /**
   * Whether this process, or an earlier AutoMobile process sharing its
   * coordination directory, created the forward on `localPort`. A forward
   * without a record belongs to a daemon this process cannot coordinate with,
   * so it must never be removed or replaced (issue #10690).
   */
  ownsForward?(localPort: number): boolean;
  /** The directory holding the lease and forward records, for diagnostics. */
  ownershipDirectory?(): string;
  /**
   * Every forward record for this device in the coordination directory, with
   * when it was written. The orphan sweep drops records whose forward is gone
   * (ADB restart, device reboot) so a stale record can never claim a port that
   * another daemon later forwards (issue #10690).
   */
  recordedForwards?(): RecordedCtrlProxyForward[];
}

export interface FileCtrlProxyForwardLeaseDeps {
  lockDir?: () => string;
  ownerProbe?: ForwardLeaseRelinquishProbe;
  ownerSocketPath?: () => string | undefined;
  timer?: Timer;
  pid?: number;
}

export class FileCtrlProxyForwardLease implements CtrlProxyForwardLease {
  private lockPath: string | null = null;
  private readonly ownerToken = defaultIdGenerator.next();
  private holders = 0;
  private acquired = false;
  private lastOwnerPid: number | undefined;
  private acquiredAt: number | undefined;
  private readonly lockDir: () => string;
  private readonly ownerProbe: ForwardLeaseRelinquishProbe;
  private readonly ownerSocketPath: () => string | undefined;
  private readonly timer: Timer;
  private readonly pid: number;
  /** Forwards this process created; shared with forked observer holders. */
  private readonly ownedForwardPorts = new Set<number>();

  public constructor(
    private readonly deviceId: string,
    deps: FileCtrlProxyForwardLeaseDeps = {},
  ) {
    this.lockDir = deps.lockDir ?? ctrlProxyForwardLeaseDir;
    this.ownerProbe = deps.ownerProbe ?? new DaemonDeviceLeaseOwnerProbe();
    this.ownerSocketPath = deps.ownerSocketPath ?? getCtrlProxyForwardLeaseOwnerSocketPath;
    this.timer = deps.timer ?? defaultTimer;
    this.pid = deps.pid ?? process.pid;
  }

  private resolveLockPath(): string {
    if (this.lockPath === null) {
      this.lockPath = join(this.lockDir(), ctrlProxyForwardLeaseFileName(this.deviceId));
    }
    return this.lockPath;
  }

  private ownerMetadata(): string | undefined {
    const socketPath = this.ownerSocketPath();
    return socketPath === undefined
      ? undefined
      : encodeForwardLeaseOwnerMetadata({ socketPath, acquiredAt: this.timer.now() });
  }

  public tryAcquire(): boolean {
    if (this.acquired) {
      if (this.lockStillOurs()) {
        return true;
      }
      // Another process took the lease over while this one was idle (#10497).
      // Forget the stale claim so this acquire competes for it honestly.
      logger.warn(
        `[CTRL_PROXY] Forwarding lease for ${this.deviceId} was taken over by another process`,
      );
      this.acquired = false;
      this.holders = 0;
    }
    this.acquired = this.acquireHolder();
    return this.acquired;
  }

  public getAcquiredAt(): number | undefined {
    return this.isHeld() ? this.acquiredAt : undefined;
  }

  public isHeld(): boolean {
    return this.acquired || this.holders > 0;
  }

  private lockStillOurs(): boolean {
    const content = readExclusiveLockContent(this.resolveLockPath());
    return content?.pid === this.pid && content.token === this.ownerToken;
  }

  private acquireHolder(): boolean {
    if (this.holders > 0) {
      this.holders++;
      return true;
    }
    // Shutdown recovery can evict a singleton while its setup remains in flight.
    // Another client in this process must wait for that live lease, not reclaim it.
    const acquired = tryAcquireExclusiveLock(this.resolveLockPath(), {
      pid: this.pid,
      ownerToken: this.ownerToken,
      metadata: this.ownerMetadata(),
    });
    this.holders = acquired ? 1 : 0;
    this.acquiredAt = acquired ? this.timer.now() : undefined;
    this.lastOwnerPid = acquired ? undefined : readLockOwnerPid(this.resolveLockPath());
    return acquired;
  }

  public async tryReclaimFromStaleOwner(): Promise<ForwardLeaseReclaimResult> {
    const result = await this.reclaimHolder();
    if (result.acquired) {
      this.acquired = true;
    }
    return result;
  }

  /**
   * Get the lease from a live foreign owner for one holder of this process
   * lease: the singleton itself or a forked observer (#10506 review). On
   * success the holder count is 1 and the caller records its own claim.
   */
  private async reclaimHolder(): Promise<ForwardLeaseReclaimResult> {
    const lockPath = this.resolveLockPath();
    const observed = readExclusiveLockContent(lockPath);
    if (!observed || Number.isNaN(observed.pid) || observed.pid === this.pid) {
      // Same-process holders wait for the in-process release instead (#6260).
      return { acquired: false, ownerPid: this.lastOwnerPid, reason: "no foreign owner to check" };
    }
    const metadata = decodeForwardLeaseOwnerMetadata(observed.metadata);
    // The owner checks its own use of the device and releases in one step, so
    // activity it starts while we wait is never taken from under it.
    const report = metadata
      ? await this.ownerProbe.requestRelinquish(metadata.socketPath, this.deviceId)
      : undefined;
    const decision = decideForwardLeaseReclaim({ ownerPid: observed.pid, metadata, report });
    this.lastOwnerPid = observed.pid;
    const owner = { ownerPid: observed.pid, ownerSocketPath: metadata?.socketPath };
    if (decision.action === "refuse") {
      return {
        acquired: false,
        ...owner,
        reason: decision.reason,
        ...(decision.transient ? { transient: true } : {}),
      };
    }
    if (this.isHeld()) {
      return { acquired: false, ...owner, reason: decision.reason };
    }
    const claim = { pid: this.pid, ownerToken: this.ownerToken, metadata: this.ownerMetadata() };
    const claimed =
      decision.action === "acquire"
        ? tryAcquireExclusiveLock(lockPath, claim)
        : takeOverExclusiveLock(lockPath, observed, claim);
    if (!claimed) {
      return {
        acquired: false,
        ...owner,
        reason: "another process claimed the lease first",
        transient: true,
      };
    }
    const how = decision.action === "acquire" ? "released by" : "taken over from";
    logger.warn(
      `[CTRL_PROXY] CtrlProxy forwarding lease for ${this.deviceId} ${how} PID ` +
        `${observed.pid}: ${decision.reason}`,
    );
    this.holders = 1;
    this.acquiredAt = this.timer.now();
    this.lastOwnerPid = undefined;
    return { acquired: true, ...owner, reason: decision.reason };
  }

  public release(): void {
    if (!this.acquired) {
      return;
    }
    this.acquired = false;
    this.releaseHolder();
  }

  private releaseHolder(): void {
    if (this.holders <= 0) {
      // The lease was taken over and reset; nothing of ours remains to release.
      return;
    }
    this.holders--;
    if (this.holders > 0) {
      return;
    }
    releaseExclusiveLock(this.resolveLockPath(), this.pid, this.ownerToken);
  }

  public getLastOwnerPid(): number | undefined {
    return this.lastOwnerPid;
  }

  private ownedForwardPath(localPort: number): string {
    return join(this.lockDir(), ctrlProxyOwnedForwardFileName(this.deviceId, localPort));
  }

  public recordOwnedForward(localPort: number): void {
    this.ownedForwardPorts.add(localPort);
    const record = {
      pid: this.pid,
      deviceId: this.deviceId,
      localPort,
      createdAt: this.timer.now(),
    };
    try {
      writeFileSync(this.ownedForwardPath(localPort), `${JSON.stringify(record)}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      // This process still owns the forward in memory; only crash recovery by
      // a later daemon loses the record, and it then leaves the forward alone.
      logger.warn(
        `[CTRL_PROXY] Failed to record CtrlProxy forward ownership for ${this.deviceId} ` +
          `tcp:${localPort}: ${errorMessage(error)}`,
        error,
      );
    }
  }

  public forgetOwnedForward(localPort: number): void {
    this.ownedForwardPorts.delete(localPort);
    try {
      rmSync(this.ownedForwardPath(localPort), { force: true });
    } catch (error) {
      // A leftover record only lets this coordination domain reclaim the port later.
      logger.warn(
        `[CTRL_PROXY] Failed to remove CtrlProxy forward record for ${this.deviceId} ` +
          `tcp:${localPort}: ${errorMessage(error)}`,
        error,
      );
    }
  }

  public ownsForward(localPort: number): boolean {
    return this.ownedForwardPorts.has(localPort) || existsSync(this.ownedForwardPath(localPort));
  }

  public ownershipDirectory(): string {
    return this.lockDir();
  }

  public recordedForwards(): RecordedCtrlProxyForward[] {
    let fileNames: string[];
    try {
      fileNames = readdirSync(this.lockDir());
    } catch (error) {
      // No readable directory means no records to prune; ownership checks still fail closed.
      logger.warn(
        `[CTRL_PROXY] Failed to list CtrlProxy forward records for ${this.deviceId}: ` +
          `${errorMessage(error)}`,
        error,
      );
      return [];
    }
    return fileNames.flatMap((fileName) => {
      const localPort = localPortFromOwnedForwardFileName(this.deviceId, fileName);
      if (localPort === undefined) {
        return [];
      }
      try {
        const contents = readFileSync(this.ownedForwardPath(localPort), "utf8");
        return [{ localPort, createdAt: recordCreatedAt(contents) }];
      } catch (error) {
        // Removed between listing and reading: nothing left to prune.
        logger.debug(
          `[CTRL_PROXY] CtrlProxy forward record ${fileName} vanished: ${errorMessage(error)}`,
        );
        return [];
      }
    });
  }

  /** A separate holder on the same process lease for one detached observer. */
  public fork(): CtrlProxyForwardLease {
    let acquired = false;
    return {
      tryAcquire: () => {
        if (!acquired) {
          acquired = this.acquireHolder();
        }
        return acquired;
      },
      release: () => {
        if (acquired) {
          acquired = false;
          this.releaseHolder();
        }
      },
      getLastOwnerPid: () => this.lastOwnerPid,
      recordOwnedForward: (localPort) => this.recordOwnedForward(localPort),
      forgetOwnedForward: (localPort) => this.forgetOwnedForward(localPort),
      ownsForward: (localPort) => this.ownsForward(localPort),
      ownershipDirectory: () => this.ownershipDirectory(),
      recordedForwards: () => this.recordedForwards(),
      // A fork can meet the same idle or orphaned foreign owner as the singleton.
      tryReclaimFromStaleOwner: async () => {
        const result = await this.reclaimHolder();
        if (result.acquired) {
          acquired = true;
        }
        return result;
      },
    };
  }
}

export class NoOpCtrlProxyForwardLease implements CtrlProxyForwardLease {
  public tryAcquire(): boolean {
    return true;
  }

  public release(): void {}

  public getLastOwnerPid(): undefined {
    return undefined;
  }
}
