import { republishResultSchema, type IdentityRecoveryIO } from "../identityRecovery";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { DaemonStatus, DaemonOptions } from "../types";
import { type DaemonClientFactoryOptions, type DaemonClientLike } from "../client";
import {
  DAEMON_PREPARE_MAINTENANCE_METHOD,
  DAEMON_COMPLETE_MAINTENANCE_METHOD,
  DAEMON_PREPARE_RESTART_METHOD,
  DAEMON_RESTART_ADMITTED_METHOD,
  type AcceptanceSessionRestartScope,
  DaemonRestartDeferredError,
  type DaemonAdmittedRestart,
  type DaemonRestartPreparation,
} from "../daemonRestartAdmission";
import {
  restartAcceptanceSession as restartAcceptanceSessionDaemon,
  restartAdmitted as restartAdmittedDaemon,
  restartDaemon,
  type DaemonRestartHost,
  type DaemonRestartResult,
} from "../daemonRestart";
import { Timer } from "../../utils/SystemTimer";
import { cleanupDaemonFiles } from "../daemonFiles";
import {
  processGenerationRecordFields,
  recordedProcessGenerationToken,
} from "../processGenerationFields";
import { type DaemonProcessRecord, type DaemonProcessSignaler } from "../processTable";
import { stderrLog } from "./DaemonLaunch";
import type { WaitForStopResult } from "./DaemonShutdown";
import type { DaemonStartResult } from "../manager";
import type { TakeoverDeferralLedger } from "./TakeoverDeferralLedger";

/** Only the replaceable manager seams used by DaemonRestartCoordinator. */
export interface DaemonRestartCoordinatorHost {
  readonly timer: Timer;
  readonly takeoverDeferrals: TakeoverDeferralLedger;
  acquireLock(): boolean;
  releaseLock(): void;
  createClient(options?: DaemonClientFactoryOptions): DaemonClientLike;
  lifecycleStatus(): Promise<DaemonStatus>;
  recordedStatus(): DaemonStatus;
  readonly identityRecoveryIO: IdentityRecoveryIO;
  readonly recoveryOwner?: DaemonStatus;
  isRecoveryOwner(owner: DaemonStatus): boolean;
  hasPublishedRecoveryIdentity(owner: DaemonStatus): boolean;
  isSameDaemonGeneration(current: DaemonStatus, expected: DaemonStatus): boolean;
  isConfirmedDifferentDaemonGeneration(
    expected: DaemonProcessRecord,
    candidate: DaemonProcessRecord,
  ): boolean;
  daemonProcessRecordFromStatus(status: DaemonStatus): DaemonProcessRecord;
  isProcessRunning(pid: number): boolean;
  readonly processSignaler: DaemonProcessSignaler;
  stop(timeout?: number, expected?: DaemonStatus): Promise<void>;
  stopRunningDaemon(status: DaemonStatus, timeout?: number, signalFirst?: boolean): Promise<void>;
  stopNamespaceOrphansForExplicitRestart(recordedPid?: number): Promise<void>;
  awaitRestartCleanup(operations: ReadonlyArray<() => void | Promise<void>>): Promise<void>;
  waitForStop(
    pid: number,
    timeout: number,
    expectedGeneration?: DaemonProcessRecord,
  ): Promise<WaitForStopResult>;
  assertNoSurvivingDaemonBeforeRestart(
    options: DaemonOptions,
    recoveryDeadline?: number,
  ): Promise<void>;
  cleanupAcceptanceRestartFiles(
    status: DaemonStatus,
    replacedByOtherGeneration: boolean,
  ): Promise<void>;
  verifyDaemonGenerationBeforeSignal(
    expected: DaemonProcessRecord,
    recoveryDeadline: number | undefined,
    context?: string,
  ): Promise<boolean>;
  prepareDaemonForConditionalRestart(expected: DaemonStatus): Promise<DaemonRestartPreparation>;
  prepareIdentityRecoveryRestart(expected: DaemonStatus): Promise<DaemonRestartPreparation>;
  admitMaintenanceRestart(
    expected: DaemonStatus,
    maintenanceToken: string,
  ): Promise<DaemonAdmittedRestart>;
  start(options?: DaemonOptions): Promise<DaemonStartResult>;
  startWithRunningOptions(options: DaemonOptions): Promise<DaemonStartResult>;
  startUnlocked(
    options: DaemonOptions,
    recoverySignal?: AbortSignal,
    inheritExitRecord?: boolean,
  ): Promise<DaemonStartResult>;
  readonly pidFilePath: string;
  cleanupSocketPaths(primarySocketPath?: string): string[] | undefined;
}

/**
 * Bound on connecting to and asking an incumbent daemon for safe-restart admission (#13792). The
 * start path holds the startup lock across it against a 30 s start budget, and a stalled or too-old
 * incumbent otherwise made connect and call each wait the client's 120 s default; a timeout is a
 * deferral like any other admission failure. The incumbent answers synchronously, so a healthy one
 * never needs more.
 */
export const RESTART_ADMISSION_TIMEOUT_MS = 3_000;

/** Daemon Restart Coordinator lifecycle operations. */
export class DaemonRestartCoordinator {
  constructor(private readonly host: DaemonRestartCoordinatorHost) {}
  /**
   * Restart the daemon
   */
  async restart(
    options: DaemonOptions = {},
    expectedDaemon?: DaemonStatus,
  ): Promise<DaemonRestartResult> {
    return restartDaemon(this.restartHost(), options, expectedDaemon);
  }

  /**
   * Complete a host-maintenance restart only after the generation that minted
   * its opaque maintenance token accepts it. See {@link restartAdmitted}.
   */
  async restartAdmitted(
    options: DaemonOptions,
    maintenanceToken: string,
  ): Promise<DaemonRestartResult> {
    return restartAdmittedDaemon(this.restartHost(), options, maintenanceToken);
  }

  isSameDaemonGeneration(current: DaemonStatus, expected: DaemonStatus): boolean {
    if (!current.running || !expected.running || current.pid !== expected.pid) {
      return false;
    }
    const identityFields = [
      "startedAt",
      "processStartedAt",
      "processGenerationToken",
      "processGenerationTokenUtc",
      "version",
      "buildId",
      "entryScript",
    ] as const;
    return identityFields.every(
      (field) => expected[field] === undefined || current[field] === expected[field],
    );
  }

  /**
   * Crash and replace one verified live-acceptance daemon generation without a
   * graceful shutdown. See {@link restartAcceptanceSession}.
   */
  async restartAcceptanceSession(
    scope: AcceptanceSessionRestartScope,
  ): Promise<DaemonRestartResult> {
    return restartAcceptanceSessionDaemon(this.restartHost(), scope);
  }

  /** Adapter exposing the lifecycle primitives {@link daemonRestart} sequences. */
  private restartHost(): DaemonRestartHost {
    const host = this.host;
    return {
      get takeoverDeferrals() {
        return host.takeoverDeferrals;
      },
      now: () => this.host.timer.now(),
      log: (message) => stderrLog(message),
      sleep: (ms) => this.host.timer.sleep(ms),
      acquireLock: () => this.host.acquireLock(),
      releaseLock: () => this.host.releaseLock(),
      createClient: (options) => this.host.createClient(options),
      lifecycleStatus: () => this.host.lifecycleStatus(),
      recordedStatus: () => this.host.recordedStatus(),
      probeRecoveryOwner: () => this.host.identityRecoveryIO.probe(),
      isRecoveryOwnerReference: (expected) => expected === this.host.recoveryOwner,
      isRecoveryOwner: (owner) => this.host.isRecoveryOwner(owner),
      hasPublishedRecoveryIdentity: (owner) => this.host.hasPublishedRecoveryIdentity(owner),
      isSameDaemonGeneration: (current, expected) =>
        this.host.isSameDaemonGeneration(current, expected),
      isConfirmedDifferentDaemonGeneration: (expected, candidate) =>
        this.host.isConfirmedDifferentDaemonGeneration(expected, candidate),
      daemonProcessRecordFromStatus: (status) => this.host.daemonProcessRecordFromStatus(status),
      isProcessRunning: (pid) => this.host.isProcessRunning(pid),
      signalProcess: (pid, signal) => this.host.processSignaler.signal(pid, signal),
      stop: (timeout, expected) => this.host.stop(timeout, expected),
      stopRunningDaemon: (status, timeout, signalFirst) =>
        this.host.stopRunningDaemon(status, timeout, signalFirst),
      stopNamespaceOrphansForExplicitRestart: (recordedPid) =>
        this.host.stopNamespaceOrphansForExplicitRestart(recordedPid),
      awaitRestartCleanup: (operations) => this.host.awaitRestartCleanup(operations),
      waitForStop: (pid, timeout, expectedGeneration) =>
        this.host.waitForStop(pid, timeout, expectedGeneration),
      assertNoSurvivingDaemonBeforeRestart: (options) =>
        this.host.assertNoSurvivingDaemonBeforeRestart(options),
      cleanupAcceptanceRestartFiles: (status, replaced) =>
        this.host.cleanupAcceptanceRestartFiles(status, replaced),
      verifyDaemonGenerationBeforeSignal: (expected, deadline, context) =>
        this.host.verifyDaemonGenerationBeforeSignal(expected, deadline, context),
      prepareDaemonForConditionalRestart: (expected) =>
        this.host.prepareDaemonForConditionalRestart(expected),
      prepareIdentityRecoveryRestart: (expected) =>
        this.host.prepareIdentityRecoveryRestart(expected),
      admitMaintenanceRestart: (expected, token) =>
        this.host.admitMaintenanceRestart(expected, token),
      start: (options) => this.host.start(options),
      startWithRunningOptions: (options) => this.host.startWithRunningOptions(options),
      startUnlocked: (options, signal, inheritExitRecord) =>
        this.host.startUnlocked(options, signal, inheritExitRecord),
    };
  }

  async cleanupAcceptanceRestartFiles(
    status: DaemonStatus,
    replacedByOtherGeneration: boolean,
  ): Promise<void> {
    if (replacedByOtherGeneration) {
      return;
    }
    await cleanupDaemonFiles({
      pidFilePath: this.host.pidFilePath,
      socketPaths: this.host.cleanupSocketPaths(status.socketPath),
      expectedPid: status.pid!,
    });
  }

  /** Admit or refuse a conditional restart of the running daemon. Public so tests can stub admission. */
  async prepareDaemonForConditionalRestart(
    expected: DaemonStatus,
  ): Promise<DaemonRestartPreparation> {
    // The generation tuple below authorizes this lifecycle RPC. It must reach
    // an older daemon even when its normal client compatibility handshake would
    // reject the newer caller that is requesting the replacement.
    const client = this.host.createClient({ clientIdentity: null });
    try {
      // callDaemonMethod connects inside its own deadline, so one budget bounds connect and call.
      const result: unknown = await client.callDaemonMethod(
        DAEMON_PREPARE_RESTART_METHOD,
        {
          pid: expected.pid,
          startedAt: expected.startedAt,
          ...processGenerationRecordFields(recordedProcessGenerationToken(expected)),
          version: expected.version,
          buildId: expected.buildId,
          entryScript: expected.entryScript,
        },
        { timeoutMs: RESTART_ADMISSION_TIMEOUT_MS },
      );
      if (!result || typeof result !== "object") {
        throw new DaemonRestartDeferredError(
          "the daemon returned no safe-restart admission result",
        );
      }
      const preparation = result as Partial<DaemonRestartPreparation>;
      if (preparation.accepted === true) {
        return { accepted: true };
      }
      if (
        preparation.accepted === false &&
        (preparation.reason === "generation_changed" ||
          preparation.reason === "restart_pending" ||
          preparation.reason === "active_operations" ||
          preparation.reason === "shutdown_unavailable")
      ) {
        return { accepted: false, reason: preparation.reason };
      }
      throw new DaemonRestartDeferredError(
        "the daemon returned an unrecognized safe-restart admission result",
      );
    } catch (error) {
      if (error instanceof DaemonRestartDeferredError) {
        throw error;
      }
      // Older daemon generations do not implement atomic restart admission.
      // Fail closed: an explicit operator restart remains available.
      throw new DaemonRestartDeferredError(
        `safe-restart admission is unavailable for daemon pid ${expected.pid} (version ${expected.version ?? "unknown"}; ` +
          `daemons before 0.0.74 predate it): ${errorMessage(error)}`,
      );
    } finally {
      await client.close();
    }
  }

  async prepareIdentityRecoveryRestart(expected: DaemonStatus): Promise<DaemonRestartPreparation> {
    // Without a known DB path a replacement could silently open a different database.
    if (!expected.dbPath || !expected.options) {
      throw new DaemonRestartDeferredError(
        "incumbent database path or startup options unavailable",
      );
    }
    const client = this.host.createClient({ clientIdentity: null });
    let maintenanceToken: string | undefined;
    try {
      const raw: unknown = await client.callDaemonMethod(DAEMON_PREPARE_MAINTENANCE_METHOD, {
        ...expected,
      });
      const result = republishResultSchema.passthrough().parse(raw);
      if (!result.accepted || typeof result.maintenanceToken !== "string") {
        throw new DaemonRestartDeferredError(
          result.reason ?? "maintenance admission unavailable",
          result.reason,
        );
      }
      maintenanceToken = result.maintenanceToken;
      const admitted = await this.host.admitMaintenanceRestart(expected, maintenanceToken);
      if (!admitted.accepted) {
        throw new DaemonRestartDeferredError(
          admitted.reason ?? "maintenance admission refused",
          admitted.reason,
        );
      }
      return { accepted: true };
    } finally {
      if (maintenanceToken) {
        try {
          await client.callDaemonMethod(DAEMON_COMPLETE_MAINTENANCE_METHOD, {
            ...expected,
            maintenanceToken,
          });
        } catch (error) {
          // An admitted daemon may already have closed its control socket for shutdown.
          logger.debug("Maintenance release after identity recovery unavailable", error);
        }
      }
      await client.close();
    }
  }

  async admitMaintenanceRestart(
    expected: DaemonStatus,
    maintenanceToken: string,
  ): Promise<DaemonAdmittedRestart> {
    const client = this.host.createClient({ clientIdentity: null });
    try {
      await client.connect();
      const result: unknown = await client.callDaemonMethod(DAEMON_RESTART_ADMITTED_METHOD, {
        pid: expected.pid,
        startedAt: expected.startedAt,
        ...processGenerationRecordFields(recordedProcessGenerationToken(expected)),
        version: expected.version,
        buildId: expected.buildId,
        entryScript: expected.entryScript,
        maintenanceToken,
      });
      if (!result || typeof result !== "object") {
        return { accepted: false, reason: "maintenance_token_invalid" };
      }
      const admission = result as Partial<DaemonAdmittedRestart>;
      if (admission.accepted === true) {
        return { accepted: true };
      }
      if (admission.accepted === false && isDaemonAdmittedRestartReason(admission.reason)) {
        return { accepted: false, reason: admission.reason };
      }
      return { accepted: false, reason: "maintenance_token_invalid" };
    } catch (error) {
      throw new DaemonRestartDeferredError(
        `maintenance admission is unavailable: ${errorMessage(error)}`,
      );
    } finally {
      await client.close();
    }
  }
}

const DAEMON_ADMITTED_RESTART_REASONS: ReadonlySet<string> = new Set([
  "active_operations",
  "active_sessions",
  "generation_changed",
  "maintenance_token_invalid",
  "maintenance_token_consumed",
  "restart_pending",
  "shutdown_unavailable",
  "sessions_unavailable",
]);

function isDaemonAdmittedRestartReason(
  value: unknown,
): value is NonNullable<DaemonAdmittedRestart["reason"]> {
  return typeof value === "string" && DAEMON_ADMITTED_RESTART_REASONS.has(value);
}
