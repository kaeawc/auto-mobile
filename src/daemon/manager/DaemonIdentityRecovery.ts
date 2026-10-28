import {
  isCompleteRecoveryRecord,
  recoveryOwnerSchema,
  republishResultSchema,
  type IdentityRecoveryIO,
} from "../identityRecovery";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { ActionableError } from "../../models";
import { DaemonStatus, DaemonOptions } from "../types";
import { type DaemonClientFactoryOptions, type DaemonClientLike } from "../client/client";
import {
  DAEMON_REPUBLISH_IDENTITY_METHOD,
  DaemonRestartDeferredError,
} from "../daemonRestartAdmission";
import { type DaemonRestartResult } from "../daemonRestart";
import { Timer } from "../../utils/SystemTimer";
import { type ProcessGenerationRecordFields } from "../processGenerationFields";
import type { DaemonStartResult } from "../manager";

/** Only the replaceable manager seams used by DaemonIdentityRecovery. */
export interface DaemonIdentityRecoveryHost {
  recordedStatus(): DaemonStatus;
  readonly identityRecoveryIO: IdentityRecoveryIO;
  recoverSocketIdentity(): Promise<DaemonStatus>;
  readonly socketPath: string;
  isRecordedDaemonRunning(
    record: {
      pid: number;
    } & ProcessGenerationRecordFields,
  ): boolean;
  status(recoverIdentity?: boolean): Promise<DaemonStatus>;
  isRecoveryOwner(owner: DaemonStatus): boolean;
  readonly pidFilePath: string;
  isProcessRunning(pid: number): boolean;
  markStartupLockRecovering(): void;
  authenticateSocketOwner(): Promise<DaemonStatus>;
  restart(options?: DaemonOptions, expectedDaemon?: DaemonStatus): Promise<DaemonRestartResult>;
  readonly timer: Timer;
  isSameDaemonGeneration(current: DaemonStatus, expected: DaemonStatus): boolean;
  hasPublishedRecoveryIdentity(owner: DaemonStatus): boolean;
  replaceRecoveryOwner(owner: DaemonStatus): Promise<DaemonStatus>;
  createClient(options?: DaemonClientFactoryOptions): DaemonClientLike;
}

/** Daemon Identity Recovery lifecycle operations. */
export class DaemonIdentityRecovery {
  recoveryOwner?: DaemonStatus;
  private identityRecoveryInFlight?: Promise<DaemonStatus>;
  constructor(private readonly host: DaemonIdentityRecoveryHost) {}
  /** Status never deletes files. Only the authenticated provider may repair metadata. */
  async status(recoverIdentity: boolean = true): Promise<DaemonStatus> {
    if (!recoverIdentity) {
      return this.host.recordedStatus();
    }
    if (this.identityRecoveryInFlight) {
      return this.identityRecoveryInFlight;
    }
    const recorded = this.host.recordedStatus();
    if (recorded.running || !this.host.identityRecoveryIO.socketExists()) {
      return recorded;
    }
    this.identityRecoveryInFlight = this.host.recoverSocketIdentity();
    try {
      return await this.identityRecoveryInFlight;
    } finally {
      this.identityRecoveryInFlight = undefined;
    }
  }

  recordedStatus(): DaemonStatus {
    const record = this.host.identityRecoveryIO.readRecord();
    return record &&
      record.socketPath === this.host.socketPath &&
      this.host.isRecordedDaemonRunning(record)
      ? { ...record, running: true }
      : { running: false };
  }

  /** Internal startup reads must not await the recovery that initiated this replacement. */
  lifecycleStatus(): Promise<DaemonStatus> {
    return this.recoveryOwner ? Promise.resolve(this.host.recordedStatus()) : this.host.status();
  }

  async authenticateSocketOwner(): Promise<DaemonStatus> {
    try {
      const owner = await this.host.identityRecoveryIO.probe();
      if (!this.host.isRecoveryOwner(owner)) {
        throw new ActionableError(
          "Socket owner did not provide a live, matching provider identity",
        );
      }
      return owner;
    } catch (error) {
      if (/ECONNREFUSED|ENOENT|Failed to connect to daemon/.test(errorMessage(error))) {
        // A stale socket with no listener is an expected post-crash state.
        logger.debug("No daemon listening on the recovery socket", error);
        return { running: false };
      }
      logger.warn("Daemon socket owner could not be authenticated", error);
      return {
        running: false,
        recovery: { state: "unauthenticated", reason: errorMessage(error) },
      };
    }
  }

  isRecoveryOwner(owner: DaemonStatus): boolean {
    return (
      recoveryOwnerSchema.safeParse(owner).success &&
      owner.reportedPidFilePath === this.host.pidFilePath &&
      owner.reportedSocketPath === this.host.socketPath &&
      this.host.isProcessRunning(owner.pid!)
    );
  }

  async recoverSocketIdentity(): Promise<DaemonStatus> {
    // Publish before the first incumbent RPC, not after deciding to replace it.
    // PID/token gating makes this inert for status callers without the lock.
    // Retain the marker until the enclosing lifecycle operation releases its lock,
    // including repair/unauthenticated outcomes: repaired records satisfy followers,
    // and release removes the marker so later starts cannot inherit stale recovery.
    this.host.markStartupLockRecovering();
    const owner = await this.host.authenticateSocketOwner();
    if (!owner.running) {
      return owner;
    }
    const result = await this.requestIdentityRepublish(owner);
    if (result.accepted) {
      return (
        (await this.tryVerifiedRepair(owner)) ?? {
          running: false,
          recovery: {
            state: "failed",
            reason: "Republish accepted without authoritative metadata",
          },
        }
      );
    }
    return {
      running: false,
      recovery: { state: "deferred", reason: result.reason, replacementOwner: owner },
    };
  }

  /** Only an explicit lifecycle operation may replace an authenticated incumbent. */
  async replaceRecoveryOwner(owner: DaemonStatus): Promise<DaemonStatus> {
    this.recoveryOwner = owner;
    try {
      this.host.markStartupLockRecovering();
      const result = await this.host.restart({}, owner);
      return await this.waitForRecoverySuccessor(
        owner,
        result === "joined" ? "joined" : "replaced",
      );
    } catch (error) {
      logger.warn("Explicit daemon identity replacement did not complete", error);
      return {
        running: false,
        recovery: {
          state: error instanceof DaemonRestartDeferredError ? "deferred" : "failed",
          reason: errorMessage(error),
        },
      };
    } finally {
      this.recoveryOwner = undefined;
    }
  }

  private async waitForRecoverySuccessor(
    owner: DaemonStatus,
    state: "joined" | "replaced",
  ): Promise<DaemonStatus> {
    const deadline = this.host.timer.now() + 5000;
    while (this.host.timer.now() < deadline) {
      const live = await this.host.authenticateSocketOwner();
      if (
        live.running &&
        (state === "joined" || !this.host.isSameDaemonGeneration(live, owner)) &&
        this.host.hasPublishedRecoveryIdentity(live)
      ) {
        return this.verifiedRecoveryStatus(state, live);
      }
      await this.host.timer.sleep(100);
    }
    return {
      running: false,
      recovery: {
        state: "failed",
        reason: "Successor did not publish complete identity within 5000ms",
      },
    };
  }

  async startIdentityRecovery(status: DaemonStatus): Promise<DaemonStartResult> {
    const owner = status.recovery?.replacementOwner;
    const result = owner ? await this.host.replaceRecoveryOwner(owner) : status;
    if (!result.running) {
      const reason = result.recovery?.reason ?? "Identity recovery could not be verified";
      if (result.recovery?.state === "deferred") {
        throw new DaemonRestartDeferredError(reason);
      }
      throw new ActionableError(reason);
    }
    return result.recovery?.state === "joined" ? "joined" : "replaced";
  }

  private async requestIdentityRepublish(
    owner: DaemonStatus,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const client = this.host.createClient({ clientIdentity: null });
    try {
      const result: unknown = await client.callDaemonMethod(DAEMON_REPUBLISH_IDENTITY_METHOD, {
        ...owner,
      });
      return republishResultSchema.parse(result);
    } catch (error) {
      logger.warn("In-place daemon identity publication unavailable", error);
      return { accepted: false, reason: "republish_unavailable" };
    } finally {
      await client.close();
    }
  }

  hasPublishedRecoveryIdentity(owner: DaemonStatus): boolean {
    const record = this.host.identityRecoveryIO.readRecord();
    return (
      isCompleteRecoveryRecord(record, owner.reportedSockets ?? {}) &&
      this.host.isProcessRunning(record.pid) &&
      record.socketPath === this.host.socketPath &&
      this.host.isSameDaemonGeneration({ ...record, running: true }, owner)
    );
  }

  private async tryVerifiedRepair(owner: DaemonStatus): Promise<DaemonStatus | undefined> {
    try {
      return await this.verifiedRecoveryStatus("repaired", owner);
    } catch (error) {
      logger.warn("Daemon acknowledged repair without authoritative metadata", error);
      return undefined;
    }
  }

  private async verifiedRecoveryStatus(
    state: "repaired" | "replaced" | "joined",
    expected?: DaemonStatus,
  ): Promise<DaemonStatus> {
    const record = this.host.identityRecoveryIO.readRecord();
    const live = expected ?? (await this.host.identityRecoveryIO.probe());
    if (
      !this.host.isRecoveryOwner(live) ||
      !isCompleteRecoveryRecord(record, live.reportedSockets ?? {}) ||
      !this.host.isProcessRunning(record.pid) ||
      !this.host.isSameDaemonGeneration({ ...record, running: true }, live) ||
      (expected && !this.host.isSameDaemonGeneration(live, expected)) ||
      record.socketPath !== this.host.socketPath
    ) {
      throw new ActionableError("Daemon recovery did not publish complete authoritative metadata");
    }
    return { ...record, running: true, recovery: { state } };
  }
}
