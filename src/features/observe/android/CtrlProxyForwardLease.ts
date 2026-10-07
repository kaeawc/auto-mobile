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
  resolveCtrlProxyForwardLeaseIdleMs,
  type ForwardLeaseOwnerProbe,
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
   * owner whether it still uses the device and take the lease when it does not
   * (issue #10497).
   */
  tryReclaimFromStaleOwner?(): Promise<ForwardLeaseReclaimResult>;
  /** Whether this process currently holds the lease. */
  isHeld?(): boolean;
}

export interface FileCtrlProxyForwardLeaseDeps {
  lockDir?: () => string;
  ownerProbe?: ForwardLeaseOwnerProbe;
  ownerSocketPath?: () => string | undefined;
  idleMs?: number;
  timer?: Timer;
  pid?: number;
}

export class FileCtrlProxyForwardLease implements CtrlProxyForwardLease {
  private lockPath: string | null = null;
  private readonly ownerToken = defaultIdGenerator.next();
  private holders = 0;
  private acquired = false;
  private lastOwnerPid: number | undefined;
  private readonly lockDir: () => string;
  private readonly ownerProbe: ForwardLeaseOwnerProbe;
  private readonly ownerSocketPath: () => string | undefined;
  private readonly idleMs: number;
  private readonly timer: Timer;
  private readonly pid: number;

  public constructor(
    private readonly deviceId: string,
    deps: FileCtrlProxyForwardLeaseDeps = {},
  ) {
    this.lockDir = deps.lockDir ?? ctrlProxyForwardLeaseDir;
    this.ownerProbe = deps.ownerProbe ?? new DaemonDeviceLeaseOwnerProbe();
    this.ownerSocketPath = deps.ownerSocketPath ?? getCtrlProxyForwardLeaseOwnerSocketPath;
    this.idleMs = deps.idleMs ?? resolveCtrlProxyForwardLeaseIdleMs();
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
    this.lastOwnerPid = acquired ? undefined : readLockOwnerPid(this.resolveLockPath());
    return acquired;
  }

  public async tryReclaimFromStaleOwner(): Promise<ForwardLeaseReclaimResult> {
    const lockPath = this.resolveLockPath();
    const observed = readExclusiveLockContent(lockPath);
    if (!observed || Number.isNaN(observed.pid) || observed.pid === this.pid) {
      // Same-process holders wait for the in-process release instead (#6260).
      return { acquired: false, ownerPid: this.lastOwnerPid, reason: "no foreign owner to check" };
    }
    const metadata = decodeForwardLeaseOwnerMetadata(observed.metadata);
    const report = metadata
      ? await this.ownerProbe.query(metadata.socketPath, this.deviceId)
      : undefined;
    const decision = decideForwardLeaseReclaim({
      ownerPid: observed.pid,
      metadata,
      report,
      idleMs: this.idleMs,
    });
    this.lastOwnerPid = observed.pid;
    const owner = { ownerPid: observed.pid, ownerSocketPath: metadata?.socketPath };
    if (decision.action === "refuse" || this.isHeld()) {
      return { acquired: false, ...owner, reason: decision.reason };
    }
    const tookOver = takeOverExclusiveLock(lockPath, observed, {
      pid: this.pid,
      ownerToken: this.ownerToken,
      metadata: this.ownerMetadata(),
    });
    if (!tookOver) {
      return { acquired: false, ...owner, reason: "another process claimed the lease first" };
    }
    logger.warn(
      `[CTRL_PROXY] Took over CtrlProxy forwarding lease for ${this.deviceId} from PID ` +
        `${observed.pid}: ${decision.reason}`,
    );
    this.holders = 1;
    this.acquired = true;
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
