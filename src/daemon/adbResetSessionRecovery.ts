import type { SessionReleaseReason } from "./releaseReasons";
import { deviceRestartReleaseReason } from "../db/deviceSessionRepository";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import {
  UnconfirmedRecoveryShutdownError,
  type AndroidEmulatorRecoveryOptions,
} from "./androidRebootCoordinator";
import type { AndroidRecoveryRecord } from "./androidRecoveryRecordLedger";
import type { DeviceRecoveryCoordinator } from "./deviceRecoveryCoordinator";
import type {
  AndroidEmulatorRecoveryDevice,
  PooledDevice,
  SessionPreservingRecoveryResult,
} from "./devicePool";
import type { Session } from "./sessionManager";

export interface AdbResetSessionRecoveryPoolPort extends Pick<
  DeviceRecoveryCoordinator,
  | "startAndroidRecoveryRecord"
  | "finalizeReleasedRecoveryAfterAwait"
  | "finalizeReleasedRecoveryAfterCleanupFailure"
  | "markAndroidRecoveryReleaseFailure"
  | "finalizeRecoveryRecord"
> {
  readonly maxDeferredRecoveryShutdowns: number;
  readonly unconfirmedRecoveryShutdownCooldownMs: number;
  getRecoveryRecord(sessionId: string): AndroidRecoveryRecord | undefined;
  getPooledDevice(deviceId: string): PooledDevice | undefined;
  isPreservedSessionCurrent(session: Session, deviceId: string): boolean;
  rebootDisconnectedAndroidDevice(
    device: PooledDevice,
    incidentId: string | undefined,
    options: AndroidEmulatorRecoveryOptions,
  ): Promise<boolean>;
  releaseDisconnectedRecoverySessionWithRetry(
    sessionId: string,
    deviceId: string,
    releaseReason: SessionReleaseReason,
  ): Promise<void>;
  refreshEmulatorLossRecoverySettlement(
    incidentId: string | undefined,
    outcome: "exhausted",
  ): Promise<void>;
  completeEmulatorLossRecovery(incidentId: string | undefined, outcome: "exhausted"): Promise<void>;
  settleEmulatorLossIncident(incidentId: string | undefined): void;
}

/** Executes ADB-reset recovery while the pool retains shared session and recovery state. */
export class AdbResetSessionRecovery {
  constructor(
    private readonly pool: AdbResetSessionRecoveryPoolPort,
    private readonly timer: Timer,
  ) {}

  async performAdbResetSessionRecovery(
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult> {
    const deferredShutdowns =
      this.pool.getRecoveryRecord(session.sessionId)?.deferredShutdowns ?? 0;
    const record = this.pool.startAndroidRecoveryRecord(
      session.sessionId,
      {
        deviceId: device.id,
        expectedDevice: device,
        incidentId,
        avdName: device.avdName,
        deferredShutdowns,
      },
      ["quarantine", "loss"],
    );
    let complete = false;
    try {
      const recovered = await this.pool.rebootDisconnectedAndroidDevice(device, incidentId, {
        preserveSessionId: session.sessionId,
        preserveSession: session,
        bypassRecoveryPolicy: true,
        allowActiveRelaunch: true,
        allowExistingRecoveryReservation: true,
      });
      const result = await this.finishAdbResetRecoveryAfterReboot(
        record,
        recovered,
        device,
        session,
        incidentId,
      );
      complete = true;
      return result;
    } catch (error) {
      if (
        error instanceof UnconfirmedRecoveryShutdownError &&
        deferredShutdowns < this.pool.maxDeferredRecoveryShutdowns
      ) {
        record.deferredUntil = this.timer.now() + this.pool.unconfirmedRecoveryShutdownCooldownMs;
        record.deferredShutdowns = deferredShutdowns + 1;
        record.state = "deferred";
        return "deferred";
      }
      try {
        await this.releasePreservedAdbResetSessionIfDetached(device, session);
        await this.pool.refreshEmulatorLossRecoverySettlement(incidentId, "exhausted");
        if (await this.pool.finalizeReleasedRecoveryAfterAwait(record, incidentId)) {
          return "released";
        }
        complete = true;
      } catch (releaseError) {
        if (
          await this.pool.finalizeReleasedRecoveryAfterCleanupFailure(
            record,
            incidentId,
            releaseError,
          )
        ) {
          return "released";
        }
        this.pool.markAndroidRecoveryReleaseFailure(record);
        await this.pool.completeEmulatorLossRecovery(incidentId, "exhausted");
        logger.warn(
          `[DevicePool] Failed to release detached session ${session.sessionId}: ${releaseError}`,
          releaseError,
        );
        throw releaseError;
      }
      logger.warn(`[DevicePool] ADB-reset recovery failed for ${device.id}: ${error}`, error);
      return "released";
    } finally {
      if (complete) {
        this.pool.finalizeRecoveryRecord(session.sessionId, record);
        this.pool.settleEmulatorLossIncident(incidentId);
      }
    }
  }

  async finishAdbResetRecoveryAfterReboot(
    record: AndroidRecoveryRecord,
    recovered: boolean,
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<"recovered" | "released"> {
    if (await this.pool.finalizeReleasedRecoveryAfterAwait(record, incidentId)) {
      return "released";
    }
    if (recovered) {
      return "recovered";
    }
    await this.releasePreservedAdbResetSessionIfDetached(device, session);
    await this.pool.refreshEmulatorLossRecoverySettlement(incidentId, "exhausted");
    await this.pool.finalizeReleasedRecoveryAfterAwait(record, incidentId);
    return "released";
  }

  async releasePreservedAdbResetSessionIfDetached(
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
  ): Promise<void> {
    if (
      this.pool.getPooledDevice(device.id) === device ||
      !this.pool.isPreservedSessionCurrent(session, device.id)
    ) {
      return;
    }
    await this.pool.releaseDisconnectedRecoverySessionWithRetry(
      session.sessionId,
      device.id,
      deviceRestartReleaseReason(device.avdName),
    );
  }
}
