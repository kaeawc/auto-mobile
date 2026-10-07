import { join } from "node:path";
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
