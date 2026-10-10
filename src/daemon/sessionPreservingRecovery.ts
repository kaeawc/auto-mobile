import type { SessionReleaseReason } from "./releaseReasons";
import type {
  PooledDevice,
  SessionContinuityDevice,
  SessionPreservingRecoveryResult,
} from "./devicePool";
import type { Session } from "./sessionManager";
import type {
  AndroidRecoveryRecord,
  AndroidRecoveryRecordLedger,
} from "./androidRecoveryRecordLedger";
import type { DeviceRecoveryCoordinator } from "./deviceRecoveryCoordinator";
import type { DeviceRecoveryPolicy } from "./poolConfig";
import type { EmulatorLossIncident, EmulatorRecoveryOutcome } from "./emulatorLossIncident";
import { deviceLossCancellationReason } from "./emulatorLossIncident";
import {
  UnconfirmedRecoveryShutdownError,
  type AndroidEmulatorRecoveryOptions,
} from "./androidRebootCoordinator";
import {
  deviceRestartReleaseReason,
  isDeviceRestartReleaseReason,
} from "../db/deviceSessionRepository";
import { logger } from "../utils/logger";

// Shared with the ADB-reset recovery path in DevicePool.
export const UNCONFIRMED_RECOVERY_SHUTDOWN_COOLDOWN_MS = 30_000;
export const MAX_DEFERRED_RECOVERY_SHUTDOWNS = 1;

type AndroidEmulatorRecoveryDevice = PooledDevice & {
  avdName: string;
  androidImage: NonNullable<PooledDevice["androidImage"]>;
};

export interface SessionPreservingRecoveryPoolPort {
  getRecoveringSessionLoss(sessionId: string): AndroidRecoveryRecord | undefined;
  startAndroidRecoveryRecord: AndroidRecoveryRecordLedger["startAndroidRecoveryRecord"];
  isAndroidEmulatorActiveRelaunchEligible(
    device: PooledDevice,
  ): device is AndroidEmulatorRecoveryDevice;
  rebootDisconnectedAndroidDevice(
    device: PooledDevice,
    incidentId: string | undefined,
    options: AndroidEmulatorRecoveryOptions,
  ): Promise<boolean>;
  getRecoveryPolicy(): Pick<DeviceRecoveryPolicy, "onLoss">;
  deviceSessionContinuityEnabled(): boolean;
  cancelDeviceSessionExecutions(sessionId: string, reason: string): Promise<number>;
  refreshReleasedRecoverySettlementAfterAwait: DeviceRecoveryCoordinator["refreshReleasedRecoverySettlementAfterAwait"];
  finalizeReleasedRecoveryAfterAwait: DeviceRecoveryCoordinator["finalizeReleasedRecoveryAfterAwait"];
  finalizeRecoveryRecord: DeviceRecoveryCoordinator["finalizeRecoveryRecord"];
  finalizeReleasedRecoveryAfterCleanupFailure: DeviceRecoveryCoordinator["finalizeReleasedRecoveryAfterCleanupFailure"];
  markAndroidRecoveryReleaseFailure(record: AndroidRecoveryRecord): void;
  completeEmulatorLossRecovery(
    incidentId: string | undefined,
    outcome: EmulatorRecoveryOutcome,
    state?: "awaiting-device",
  ): Promise<void>;
  settleEmulatorLossIncident(incidentId: string | undefined): void;
  isPreservedSessionCurrent(session: Session, deviceId: string): boolean;
  releaseDisconnectedRecoverySessionWithRetry(
    sessionId: string,
    deviceId: string,
    releaseReason: SessionReleaseReason,
  ): Promise<void>;
  stableDeviceIdFor(device: PooledDevice): string | undefined;
  getPooledDevice(deviceId: string): PooledDevice | undefined;
  removeDevice(
    deviceId: string,
    awaitCacheCleanup: boolean,
    expectedDevice: PooledDevice,
  ): Promise<void>;
  suppressAutoStartForDevice(device: PooledDevice): void;
  getEmulatorLossIncident(incidentId: string): Promise<EmulatorLossIncident | undefined>;
  getFinalizedReleaseReason(session: Session): string | undefined;
  now(): number;
}

/** Runs session continuity recovery while the pool retains session and device ownership. */
export class SessionPreservingRecoveryRunner {
  constructor(private readonly pool: SessionPreservingRecoveryPoolPort) {}
  private async attemptSessionPreservingRuntimeRecovery(
    device: SessionContinuityDevice,
    session: Session,
    incidentId: string | undefined,
    deferredShutdowns: number,
  ): Promise<boolean> {
    if (!this.pool.isAndroidEmulatorActiveRelaunchEligible(device)) {
      // iOS continuity is passive: falling through to the shared durable-release
      // tail preserves the session without invoking any simulator lifecycle API.
      return false;
    }
    return await this.pool.rebootDisconnectedAndroidDevice(device, incidentId, {
      preserveSessionId: session.sessionId,
      preserveSession: session,
      bypassRecoveryPolicy: this.pool.deviceSessionContinuityEnabled(),
      // Continuity admits passive reattachment; only onLoss opts into relaunching.
      allowActiveRelaunch: this.pool.getRecoveryPolicy().onLoss,
      allowExistingRecoveryReservation: deferredShutdowns > 0,
    });
  }
  private startSessionContinuityRecoveryRecord(
    device: SessionContinuityDevice,
    sessionId: string,
    incidentId: string | undefined,
    deferredShutdowns: number,
  ): AndroidRecoveryRecord {
    return this.pool.startAndroidRecoveryRecord(
      sessionId,
      {
        deviceId: device.id,
        incidentId,
        ...(this.pool.isAndroidEmulatorActiveRelaunchEligible(device)
          ? { avdName: device.avdName }
          : {}),
        deferredShutdowns,
      },
      ["quarantine", "loss"],
    );
  }
  private captureAndroidSessionRecoveryMetadata(
    device: SessionContinuityDevice,
    sessionId: string,
  ): void {
    if (!this.pool.isAndroidEmulatorActiveRelaunchEligible(device)) {
      return;
    }
    device.adbServerResetSessionId = sessionId;
    device.adbServerResetAutolockSessionId = device.autolockSessionId;
  }
  async performSessionPreservingRecovery(
    device: SessionContinuityDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult> {
    const sessionId = session.sessionId;
    const deferredShutdowns = this.pool.getRecoveringSessionLoss(sessionId)?.deferredShutdowns ?? 0;
    const record = this.startSessionContinuityRecoveryRecord(
      device,
      sessionId,
      incidentId,
      deferredShutdowns,
    );
    this.captureAndroidSessionRecoveryMetadata(device, sessionId);
    let complete = false;
    try {
      await this.pool.cancelDeviceSessionExecutions(
        sessionId,
        deviceLossCancellationReason(device.id, incidentId),
      );
      await this.pool.refreshReleasedRecoverySettlementAfterAwait(record, incidentId);
      if (await this.pool.finalizeReleasedRecoveryAfterAwait(record, incidentId)) {
        return "released";
      }
      if (!this.pool.isPreservedSessionCurrent(session, device.id)) {
        await this.pool.completeEmulatorLossRecovery(incidentId, "exhausted");
        complete = true;
        return "released";
      }
      const recovered = await this.attemptSessionPreservingRuntimeRecovery(
        device,
        session,
        incidentId,
        deferredShutdowns,
      );
      await this.pool.refreshReleasedRecoverySettlementAfterAwait(record, incidentId);
      if (await this.pool.finalizeReleasedRecoveryAfterAwait(record, incidentId)) {
        return "released";
      }
      if (recovered) {
        complete = true;
        return "recovered";
      }
      await this.releasePreservedSessionAfterRecoveryFailure(device, session, incidentId);
      complete = true;
      return "released";
    } catch (error) {
      if (
        error instanceof UnconfirmedRecoveryShutdownError &&
        deferredShutdowns < MAX_DEFERRED_RECOVERY_SHUTDOWNS
      ) {
        const result = await this.handleUnconfirmedSessionRecoveryShutdown(
          sessionId,
          device,
          incidentId,
          deferredShutdowns,
        );
        complete = result === "released";
        return result;
      }
      if (
        await this.releasePreservedSessionAfterRecoveryError(record, device, session, incidentId)
      ) {
        return "released";
      }
      complete = true;
      logger.warn(
        `[DevicePool] Session-preserving recovery failed for ${device.id}: ${error}`,
        error,
      );
      return "released";
    } finally {
      if (complete) {
        this.pool.finalizeRecoveryRecord(sessionId, record);
        this.pool.settleEmulatorLossIncident(incidentId);
      }
    }
  }

  /**
   * Releases the preserved session after a recovery error. Returns true when
   * the record was already finalized because an explicit release landed
   * mid-recovery; otherwise the caller finalizes it. A genuine release failure
   * fences the record behind `failed-release` and rethrows.
   */
  private async releasePreservedSessionAfterRecoveryError(
    record: AndroidRecoveryRecord,
    device: SessionContinuityDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<boolean> {
    try {
      await this.releasePreservedSessionAfterRecoveryFailure(device, session, incidentId);
      return false;
    } catch (releaseError) {
      if (
        await this.pool.finalizeReleasedRecoveryAfterCleanupFailure(
          record,
          incidentId,
          releaseError,
        )
      ) {
        return true;
      }
      this.pool.markAndroidRecoveryReleaseFailure(record);
      await this.pool.completeEmulatorLossRecovery(incidentId, "exhausted");
      this.pool.settleEmulatorLossIncident(incidentId);
      logger.warn(
        `[DevicePool] Failed to release session ${session.sessionId} after recovery error: ${releaseError}`,
        releaseError,
      );
      throw releaseError;
    }
  }
  private async releasePreservedSessionAfterRecoveryFailure(
    device: SessionContinuityDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<void> {
    const sessionId = session.sessionId;
    const assignmentCount = device.assignmentCount;
    const releasedForDeviceRestart = this.pool.isPreservedSessionCurrent(session, device.id);
    if (releasedForDeviceRestart) {
      await this.pool.releaseDisconnectedRecoverySessionWithRetry(
        sessionId,
        device.id,
        // `avdName` is not guaranteed here: passive continuity admits an Android
        // emulator whose identity resolved only via discovery's device name
        // (no image-enrichment pass ever ran). stableDeviceIdFor falls back to
        // that resolved name, matching how a later resume looks the device up.
        deviceRestartReleaseReason(this.pool.stableDeviceIdFor(device) ?? device.id),
      );
    }
    if (this.canRemoveReleasedDevice(device, sessionId, assignmentCount)) {
      device.sessionId = null;
      device.status = "idle";
      this.pool.suppressAutoStartForDevice(device);
      await this.pool.removeDevice(device.id, true, device);
    }
    if (incidentId) {
      const incident = await this.pool.getEmulatorLossIncident(incidentId);
      await this.pool.completeEmulatorLossRecovery(
        incidentId,
        incident?.recovery.outcome ??
          (incident?.recovery.policy.onLoss ? "exhausted" : "not-attempted"),
        isDeviceRestartReleaseReason(this.pool.getFinalizedReleaseReason(session) ?? "")
          ? "awaiting-device"
          : undefined,
      );
    }
  }
  private canRemoveReleasedDevice(
    device: SessionContinuityDevice,
    sessionId: string,
    assignmentCount: number,
  ): boolean {
    return (
      this.pool.getPooledDevice(device.id) === device &&
      device.assignmentCount === assignmentCount &&
      (device.sessionId === sessionId || device.sessionId === null)
    );
  }

  private async handleUnconfirmedSessionRecoveryShutdown(
    sessionId: string,
    device: PooledDevice,
    incidentId: string | undefined,
    deferredShutdowns: number,
  ): Promise<"deferred" | "released"> {
    const record = this.pool.getRecoveringSessionLoss(sessionId);
    if (record?.state === "released") {
      await this.pool.completeEmulatorLossRecovery(incidentId, "exhausted");
      await this.pool.finalizeReleasedRecoveryAfterAwait(record, incidentId);
      return "released";
    }
    const deferredRecord = this.pool.startAndroidRecoveryRecord(
      sessionId,
      {
        deviceId: device.id,
        incidentId,
        avdName: device.avdName,
        deferredUntil: this.pool.now() + UNCONFIRMED_RECOVERY_SHUTDOWN_COOLDOWN_MS,
        deferredShutdowns: deferredShutdowns + 1,
      },
      ["quarantine", "loss"],
    );
    deferredRecord.state = "deferred";
    return "deferred";
  }
}
