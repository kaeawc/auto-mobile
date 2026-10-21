import { holderOf } from "../deviceBinding";
import type { SessionReleaseReason } from "../releaseReasons";
import { isSessionReleasing } from "../sessionReleaseState";
import { logger } from "../../utils/logger";
import { DEVICE_RESTART_RECOVERY_WINDOW_MS, type Session } from "../sessionManager";
import { isDeviceRestartReleaseReason } from "../../db/deviceSessionRepository";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import { type SessionPreservingRecovery } from "../deviceRecoveryCoordinator";
import { type AndroidRecoveryRecord } from "../androidRecoveryRecordLedger";
import type {
  SessionPreservingRecoveryResult,
  SessionRecoveryPreparation,
  PooledDevice,
} from "../devicePoolTypes";
import {
  AdbServerResetCohortDetachment,
  AndroidEmulatorRecoveryDevice,
  AndroidEmulatorContinuityDevice,
  SessionContinuityDevice,
} from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface SessionRecoveryOperations {
  prepareSessionPreservingRecovery(
    deviceId: string,
    expectedDevice?: PooledDevice,
  ): SessionRecoveryPreparation | undefined;
  finishSessionPreservingRecoveryPreparation(
    preparation: SessionRecoveryPreparation | undefined,
  ): void;
  recoverSessionBoundAndroidDeviceAfterLoss(
    deviceId: string,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<SessionPreservingRecoveryResult>;
  recoverSessionBoundDeviceAfterLoss(
    deviceId: string,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<SessionPreservingRecoveryResult>;
  recoverSessionBoundIOSSimulatorAfterLoss(
    deviceId: string,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<SessionPreservingRecoveryResult>;
  retryDueDeferredSessionRecoveries(mayRecover?: (deviceId: string) => boolean): Promise<void>;
  performSessionPreservingRecovery(
    device: SessionContinuityDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult>;
  joinSessionPreservingRecovery(
    recovery: SessionPreservingRecovery,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult>;
  waitForSessionPreservingRecovery(sessionId: string, incidentId?: string): Promise<boolean>;
  isSessionRecoveryInFlight(sessionId: string): boolean;
  getSessionPreservingRecoveryTarget(
    deviceId: string,
    expectedDevice: PooledDevice | undefined,
  ):
    | {
        device: SessionContinuityDevice;
        session: Session;
      }
    | undefined;
  getAndroidSessionPreservingRecoveryTarget(
    deviceId: string,
    expectedDevice: PooledDevice | undefined,
  ):
    | {
        device: AndroidEmulatorContinuityDevice;
        session: Session;
      }
    | undefined;
  isSessionPreservingBinding(device: PooledDevice, session: Session): boolean;
  isEligibleSessionPreservingRecoveryTarget(
    device: PooledDevice,
    session: Session,
  ): device is SessionContinuityDevice;
  isSessionContinuityRecoveryDevice(device: PooledDevice): device is SessionContinuityDevice;
  canRetryDeferredSessionRecovery(device: PooledDevice): boolean;
  isPreservedSessionCurrent(session: Session, deviceId: string): boolean;
  recoverSessionBoundAndroidDeviceAfterAdbServerReset(
    deviceId: string,
    expectedDevice?: PooledDevice,
  ): Promise<boolean>;
  startAdbResetSessionRecovery(
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
    entry: SessionPreservingRecovery,
  ): Promise<SessionPreservingRecoveryResult>;
  performAdbResetSessionRecovery(
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult>;
  finishAdbResetRecoveryAfterReboot(
    record: AndroidRecoveryRecord,
    recovered: boolean,
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<"recovered" | "released">;
  refreshEmulatorLossRecoverySettlement(
    incidentId: string | undefined,
    fallbackOutcome: "exhausted" | "not-attempted",
  ): Promise<void>;
  getAdbResetRecoveryDevice(
    deviceId: string,
    expectedDevice: PooledDevice | undefined,
  ): AndroidEmulatorRecoveryDevice | undefined;
  getAdbResetRecoverySession(device: PooledDevice): Session | undefined;
  detachAdbServerResetCohort(
    cohort: readonly PooledDevice[],
  ): Promise<AdbServerResetCohortDetachment>;
  waitForAdbServerResetRecovery(avdName: string, signal?: AbortSignal): Promise<void>;
  getRecoveringAndroidTargets(): {
    names: Set<string>;
    serials: Set<string>;
  };
  reserveAndroidStartupLease(
    name: string | undefined,
    exactName: boolean,
    signal?: AbortSignal,
    ownsOfflineRecovery?: boolean,
  ): Promise<() => Promise<void>>;
  waitForAdbServerResetRecoveryMatchingName(
    name: string | undefined,
    signal?: AbortSignal,
  ): Promise<void>;
  releaseAdbServerResetCohortReservations(cohort: readonly PooledDevice[]): Promise<void>;
  isDeviceLeasedForAndroidStartup(deviceId: string): boolean;
  releasePreservedAdbResetSessionIfDetached(
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
  ): Promise<void>;
  releaseDisconnectedRecoverySessionWithRetry(
    sessionId: string,
    deviceId: string,
    releaseReason: SessionReleaseReason,
    attempt?: () => Promise<void>,
  ): Promise<void>;
  retrySessionRelease<T>(
    sessionId: string,
    deviceId: string,
    attempt: () => Promise<T>,
  ): Promise<T>;
}
type SessionRecoveryState = Pick<
  DevicePoolState,
  | "recoveryCoordinator"
  | "sessionPreservingRecovery"
  | "devices"
  | "sessionManager"
  | "deviceSessionContinuityEnabled"
  | "androidRecoveryRecordLedger"
  | "timer"
  | "adbResetSessionRecovery"
  | "emulatorLossLedger"
  | "adbServerResetQuarantine"
  | "intentionallyCancelledRecoverySessions"
  | "rehydrationReservations"
  | "mcpSessionAcquiredDeviceSessions"
  | "releaseSessionForDisconnectedDevice"
  | "retryExecutor"
>;
export type SessionRecoveryCallbacks = Pick<
  DevicePoolOperations,
  | "isAndroidEmulatorSessionContinuityDevice"
  | "isIOSSimulatorContinuityDevice"
  | "getRecoveryPolicy"
  | "stableDeviceIdFor"
  | "recordEmulatorLossIncident"
  | "reserveRehydrationDevices"
  | "hasAcquiredDeviceSession"
  | "restartReservationOwnerToken"
  | "scheduleDeviceRestartReservationExpiry"
  | "releaseDeviceRestartReservation"
  | "releaseDevice"
>;

/** Session Recovery responsibilities of DevicePool. */
export class DevicePoolSessionRecovery {
  constructor(
    private readonly state: SessionRecoveryState,
    private readonly callbacks: SessionRecoveryCallbacks,
  ) {}
  prepareSessionPreservingRecovery(
    deviceId: string,
    expectedDevice?: PooledDevice,
  ): SessionRecoveryPreparation | undefined {
    return this.state.recoveryCoordinator.prepareSessionPreservingRecovery(
      deviceId,
      expectedDevice,
    );
  }

  finishSessionPreservingRecoveryPreparation(
    preparation: SessionRecoveryPreparation | undefined,
  ): void {
    this.state.recoveryCoordinator.finishSessionPreservingRecoveryPreparation(preparation);
  }

  async recoverSessionBoundAndroidDeviceAfterLoss(
    deviceId: string,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<SessionPreservingRecoveryResult> {
    return this.state.recoveryCoordinator.recoverSessionBoundAndroidDeviceAfterLoss(
      deviceId,
      incidentId,
      expectedDevice,
    );
  }

  async recoverSessionBoundDeviceAfterLoss(
    deviceId: string,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<SessionPreservingRecoveryResult> {
    return this.state.recoveryCoordinator.recoverSessionBoundDeviceAfterLoss(
      deviceId,
      incidentId,
      expectedDevice,
    );
  }

  async recoverSessionBoundIOSSimulatorAfterLoss(
    deviceId: string,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<SessionPreservingRecoveryResult> {
    return this.state.recoveryCoordinator.recoverSessionBoundIOSSimulatorAfterLoss(
      deviceId,
      incidentId,
      expectedDevice,
    );
  }

  async retryDueDeferredSessionRecoveries(
    mayRecover?: (deviceId: string) => boolean,
  ): Promise<void> {
    return this.state.recoveryCoordinator.retryDueDeferredSessionRecoveries(mayRecover);
  }

  async performSessionPreservingRecovery(
    device: SessionContinuityDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult> {
    return this.state.sessionPreservingRecovery.performSessionPreservingRecovery(
      device,
      session,
      incidentId,
    );
  }

  async joinSessionPreservingRecovery(
    recovery: SessionPreservingRecovery,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult> {
    return this.state.recoveryCoordinator.joinSessionPreservingRecovery(recovery, incidentId);
  }

  async waitForSessionPreservingRecovery(sessionId: string, incidentId?: string): Promise<boolean> {
    return this.state.recoveryCoordinator.waitForSessionPreservingRecovery(sessionId, incidentId);
  }

  isSessionRecoveryInFlight(sessionId: string): boolean {
    return this.state.recoveryCoordinator.isSessionRecoveryInFlight(sessionId);
  }

  getSessionPreservingRecoveryTarget(
    deviceId: string,
    expectedDevice: PooledDevice | undefined,
  ):
    | {
        device: SessionContinuityDevice;
        session: Session;
      }
    | undefined {
    const device = this.state.devices.get(deviceId);
    if (!device) {
      return undefined;
    }
    if (expectedDevice !== undefined && device !== expectedDevice) {
      return undefined;
    }
    const sessionId = holderOf(device) ?? this.state.sessionManager.getSessionForDevice(device.id);
    if (!sessionId) {
      return undefined;
    }
    const session = this.state.sessionManager.getSession(sessionId);
    if (
      !session ||
      isSessionReleasing(this.state.sessionManager, sessionId, session) ||
      !this.isEligibleSessionPreservingRecoveryTarget(device, session)
    ) {
      return undefined;
    }
    return { device, session };
  }

  getAndroidSessionPreservingRecoveryTarget(
    deviceId: string,
    expectedDevice: PooledDevice | undefined,
  ):
    | {
        device: AndroidEmulatorContinuityDevice;
        session: Session;
      }
    | undefined {
    const target = this.getSessionPreservingRecoveryTarget(deviceId, expectedDevice);
    return target && this.callbacks.isAndroidEmulatorSessionContinuityDevice(target.device)
      ? { device: target.device, session: target.session }
      : undefined;
  }

  isSessionPreservingBinding(device: PooledDevice, session: Session): boolean {
    return holderOf(device) === session.sessionId || session.ownership === "awaiting-owner";
  }

  isEligibleSessionPreservingRecoveryTarget(
    device: PooledDevice,
    session: Session,
  ): device is SessionContinuityDevice {
    return (
      this.isSessionPreservingBinding(device, session) &&
      session.assignedDevice === device.id &&
      session.platform === device.platform &&
      this.isSessionContinuityRecoveryDevice(device)
    );
  }

  /**
   * Passive continuity's entry gate for Android is deliberately looser than
   * active relaunch's: any session-bound emulator with a resolved, non-placeholder
   * AVD identity qualifies, regardless of whether it was acquired through
   * getAndroid/startDevice image enrichment, pool idle allocation, or an
   * enrichment failure that adopted the device without its configured image.
   * Recording the image is what `isAndroidEmulatorActiveRelaunchEligible` gates,
   * separately, before an actual reboot is attempted (#7546).
   */
  isSessionContinuityRecoveryDevice(device: PooledDevice): device is SessionContinuityDevice {
    if (device.platform !== "android") {
      return (
        this.state.deviceSessionContinuityEnabled &&
        this.callbacks.isIOSSimulatorContinuityDevice(device)
      );
    }
    if (
      !(this.state.deviceSessionContinuityEnabled || this.callbacks.getRecoveryPolicy().onLoss) ||
      !this.callbacks.isAndroidEmulatorSessionContinuityDevice(device)
    ) {
      return false;
    }
    if (this.canRetryDeferredSessionRecovery(device)) {
      return true;
    }
    const stableDeviceId = this.callbacks.stableDeviceIdFor(device);
    return (
      stableDeviceId !== undefined &&
      !this.state.recoveryCoordinator.recoveringAndroidImages.has(stableDeviceId)
    );
  }

  canRetryDeferredSessionRecovery(device: PooledDevice): boolean {
    const deferredUntil = this.state.androidRecoveryRecordLedger.recoveringSessionLosses.get(
      holderOf(device) ?? "",
    )?.deferredUntil;
    return deferredUntil !== undefined && this.state.timer.now() >= deferredUntil;
  }

  // rebindSameAvdReplacementSession and the recovery ports may have already
  // detached the entry: their session fence does not require pooled-entry identity.
  isPreservedSessionCurrent(session: Session, deviceId: string): boolean {
    return (
      this.state.sessionManager.isCurrentSession(session) && session.assignedDevice === deviceId
    );
  }

  /**
   * A process-wide ADB reset can make every emulator disappear at once. Only a
   * session already bound to an AutoMobile-started AVD can retain its ownership:
   * the replacement is selected by that recorded AVD name, never by a reused
   * emulator port or serial.
   */
  async recoverSessionBoundAndroidDeviceAfterAdbServerReset(
    deviceId: string,
    expectedDevice?: PooledDevice,
  ): Promise<boolean> {
    const device = this.getAdbResetRecoveryDevice(deviceId, expectedDevice);
    if (!device) {
      return false;
    }
    const session = this.getAdbResetRecoverySession(device);
    if (!session) {
      return false;
    }
    const inFlight = this.state.recoveryCoordinator.sessionPreservingRecoveries.get(
      session.sessionId,
    );
    if (inFlight) {
      return (await this.joinSessionPreservingRecovery(inFlight, undefined)) === "recovered";
    }
    const entry = {} as SessionPreservingRecovery;
    const recovery = this.startAdbResetSessionRecovery(device, session, entry);
    entry.promise = recovery;
    this.state.recoveryCoordinator.registerSessionPreservingRecovery(session.sessionId, entry);
    try {
      return (await recovery) === "recovered";
    } finally {
      this.state.recoveryCoordinator.clearSessionPreservingRecoveryIfCurrent(
        session.sessionId,
        entry,
      );
    }
  }

  async startAdbResetSessionRecovery(
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
    entry: SessionPreservingRecovery,
  ): Promise<SessionPreservingRecoveryResult> {
    const incidentId =
      device.adbServerResetIncidentId ??
      (await this.callbacks.recordEmulatorLossIncident(
        device.id,
        "adb-server-reset",
        undefined,
        "absent",
      ));
    if (incidentId) {
      entry.incidentId = incidentId;
    }
    return await this.performAdbResetSessionRecovery(device, session, incidentId);
  }

  async performAdbResetSessionRecovery(
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult> {
    return await this.state.adbResetSessionRecovery.performAdbResetSessionRecovery(
      device,
      session,
      incidentId,
    );
  }

  async finishAdbResetRecoveryAfterReboot(
    record: AndroidRecoveryRecord,
    recovered: boolean,
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
    incidentId: string | undefined,
  ): Promise<"recovered" | "released"> {
    return await this.state.adbResetSessionRecovery.finishAdbResetRecoveryAfterReboot(
      record,
      recovered,
      device,
      session,
      incidentId,
    );
  }

  async refreshEmulatorLossRecoverySettlement(
    incidentId: string | undefined,
    fallbackOutcome: "exhausted" | "not-attempted",
  ): Promise<void> {
    return this.state.emulatorLossLedger.refreshEmulatorLossRecoverySettlement(
      incidentId,
      fallbackOutcome,
    );
  }

  getAdbResetRecoveryDevice(
    deviceId: string,
    expectedDevice: PooledDevice | undefined,
  ): AndroidEmulatorRecoveryDevice | undefined {
    return this.state.adbServerResetQuarantine.getAdbResetRecoveryDevice(deviceId, expectedDevice);
  }

  getAdbResetRecoverySession(device: PooledDevice): Session | undefined {
    return this.state.adbServerResetQuarantine.getAdbResetRecoverySession(device);
  }

  /**
   * Remove every captured reset-cohort connection before any AVD is restarted.
   * The session manager intentionally retains each old serial until recovery
   * rebinds it, so a replacement can safely reuse another cohort member's port.
   */
  async detachAdbServerResetCohort(
    cohort: readonly PooledDevice[],
  ): Promise<AdbServerResetCohortDetachment> {
    return await this.state.adbServerResetQuarantine.detachAdbServerResetCohort(cohort);
  }

  async waitForAdbServerResetRecovery(avdName: string, signal?: AbortSignal): Promise<void> {
    await this.state.adbServerResetQuarantine.waitForAdbServerResetRecovery(avdName, signal);
  }

  getRecoveringAndroidTargets(): {
    names: Set<string>;
    serials: Set<string>;
  } {
    return this.state.adbServerResetQuarantine.getRecoveringAndroidTargets();
  }

  async reserveAndroidStartupLease(
    name: string | undefined,
    exactName: boolean,
    signal?: AbortSignal,
    ownsOfflineRecovery = false,
  ): Promise<() => Promise<void>> {
    return await this.state.adbServerResetQuarantine.reserveAndroidStartupLease(
      name,
      exactName,
      signal,
      ownsOfflineRecovery,
    );
  }

  async waitForAdbServerResetRecoveryMatchingName(
    name: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.state.adbServerResetQuarantine.waitForAdbServerResetRecoveryMatchingName(
      name,
      signal,
    );
  }

  async releaseAdbServerResetCohortReservations(cohort: readonly PooledDevice[]): Promise<void> {
    await this.state.adbServerResetQuarantine.releaseAdbServerResetCohortReservations(cohort);
  }

  isDeviceLeasedForAndroidStartup(deviceId: string): boolean {
    return this.state.adbServerResetQuarantine.isDeviceLeasedForAndroidStartup(deviceId);
  }

  async releasePreservedAdbResetSessionIfDetached(
    device: AndroidEmulatorRecoveryDevice,
    session: Session,
  ): Promise<void> {
    return await this.state.adbResetSessionRecovery.releasePreservedAdbResetSessionIfDetached(
      device,
      session,
    );
  }

  async releaseDisconnectedRecoverySessionWithRetry(
    sessionId: string,
    deviceId: string,
    releaseReason: SessionReleaseReason,
    attempt?: () => Promise<void>,
  ): Promise<void> {
    let session = isDeviceRestartReleaseReason(releaseReason)
      ? this.state.sessionManager.getSession(sessionId)
      : null;
    if (session && this.state.intentionallyCancelledRecoverySessions.has(session)) {
      releaseReason = "explicit-release";
      session = null;
    }
    if (session) {
      const platform = session.platform;
      await this.callbacks.reserveRehydrationDevices(
        [
          {
            sessionId,
            target: {
              platform,
              stableDeviceId: releaseReason.slice("device-restart:".length),
              deviceId,
              ...(platform === "android"
                ? { androidEmulator: isAndroidEmulatorSerial(deviceId) }
                : {}),
            },
          },
        ],
        () => this.state.sessionManager.isCurrentSession(session),
        true,
      );
      const target = this.state.rehydrationReservations.get(sessionId);
      if (target?.restartHandoff) {
        // Release forgets live connection ownership; the hold must still recognize that client.
        target.ownerMcpSessionIds = new Set(
          [...this.state.mcpSessionAcquiredDeviceSessions.keys()].filter((connection) =>
            this.callbacks.hasAcquiredDeviceSession(connection, sessionId),
          ),
        );
        target.ownerLivenessToken = this.callbacks.restartReservationOwnerToken(session);
        target.sessionTimeoutMs = session.sessionTimeoutMs;
        target.idleDeadlineMs = session.expiresAt;
        target.recoveryWindowEndMs =
          this.state.sessionManager.sessionNow() + DEVICE_RESTART_RECOVERY_WINDOW_MS;
        // The idle timer waits for the release callback's persistence signal.
        this.callbacks.scheduleDeviceRestartReservationExpiry(
          sessionId,
          target.recoveryWindowEndMs,
        );
      }
    }
    try {
      await this.retrySessionRelease(
        sessionId,
        deviceId,
        attempt ??
          (async () =>
            await this.state.releaseSessionForDisconnectedDevice(
              sessionId,
              deviceId,
              releaseReason,
            )),
      );
    } finally {
      // A failed release that left its live owner holding the device needs no recovery hold.
      if (session && this.state.sessionManager.isCurrentSession(session)) {
        this.callbacks.releaseDeviceRestartReservation(sessionId);
      }
    }
  }

  async retrySessionRelease<T>(
    sessionId: string,
    deviceId: string,
    attempt: () => Promise<T>,
  ): Promise<T> {
    const device = this.state.devices.get(deviceId);
    const assignmentCount = device?.assignmentCount;
    try {
      return await this.state.retryExecutor.executeOrThrow(attempt, {
        onRetry: (error, attemptNumber, delay) => {
          logger.warn(
            `[DevicePool] Retrying recovery release for session ${sessionId} after attempt ${attemptNumber} failed; delay=${delay}ms: ${error}`,
            error,
          );
        },
      });
    } catch (releaseError) {
      // Retain ownership throughout backoff. Only the exhausted release may
      // free a removed session's device, and never a newer assignment.
      if (
        !this.state.sessionManager.hasSession(sessionId) &&
        device &&
        this.state.devices.get(deviceId) === device &&
        device.assignmentCount === assignmentCount &&
        holderOf(device) === sessionId
      ) {
        try {
          await this.callbacks.releaseDevice(deviceId, sessionId);
        } catch (poolError) {
          logger.warn(
            `Failed to free device ${deviceId} after session ${sessionId} release retries`,
            poolError,
          );
        }
      }
      throw releaseError;
    }
  }
}

export function connectSessionRecovery(
  part: () => DevicePoolSessionRecovery,
  seams: Pick<
    DevicePoolOperations,
    | "prepareSessionPreservingRecovery"
    | "finishSessionPreservingRecoveryPreparation"
    | "recoverSessionBoundAndroidDeviceAfterLoss"
    | "recoverSessionBoundDeviceAfterLoss"
    | "recoverSessionBoundIOSSimulatorAfterLoss"
    | "retryDueDeferredSessionRecoveries"
    | "waitForSessionPreservingRecovery"
    | "isSessionRecoveryInFlight"
    | "recoverSessionBoundAndroidDeviceAfterAdbServerReset"
    | "detachAdbServerResetCohort"
    | "waitForAdbServerResetRecovery"
    | "getRecoveringAndroidTargets"
    | "reserveAndroidStartupLease"
    | "waitForAdbServerResetRecoveryMatchingName"
    | "releaseAdbServerResetCohortReservations"
    | "isDeviceLeasedForAndroidStartup"
  >,
): SessionRecoveryOperations {
  return {
    prepareSessionPreservingRecovery: (...args) => seams.prepareSessionPreservingRecovery(...args),
    finishSessionPreservingRecoveryPreparation: (...args) =>
      seams.finishSessionPreservingRecoveryPreparation(...args),
    recoverSessionBoundAndroidDeviceAfterLoss: (...args) =>
      seams.recoverSessionBoundAndroidDeviceAfterLoss(...args),
    recoverSessionBoundDeviceAfterLoss: (...args) =>
      seams.recoverSessionBoundDeviceAfterLoss(...args),
    recoverSessionBoundIOSSimulatorAfterLoss: (...args) =>
      seams.recoverSessionBoundIOSSimulatorAfterLoss(...args),
    retryDueDeferredSessionRecoveries: (...args) =>
      seams.retryDueDeferredSessionRecoveries(...args),
    performSessionPreservingRecovery: (...args) => part().performSessionPreservingRecovery(...args),
    joinSessionPreservingRecovery: (...args) => part().joinSessionPreservingRecovery(...args),
    waitForSessionPreservingRecovery: (...args) => seams.waitForSessionPreservingRecovery(...args),
    isSessionRecoveryInFlight: (...args) => seams.isSessionRecoveryInFlight(...args),
    getSessionPreservingRecoveryTarget: (...args) =>
      part().getSessionPreservingRecoveryTarget(...args),
    getAndroidSessionPreservingRecoveryTarget: (...args) =>
      part().getAndroidSessionPreservingRecoveryTarget(...args),
    isSessionPreservingBinding: (...args) => part().isSessionPreservingBinding(...args),
    isEligibleSessionPreservingRecoveryTarget(
      device: PooledDevice,
      session: Session,
    ): device is SessionContinuityDevice {
      return part().isEligibleSessionPreservingRecoveryTarget(device, session);
    },
    isSessionContinuityRecoveryDevice(device: PooledDevice): device is SessionContinuityDevice {
      return part().isSessionContinuityRecoveryDevice(device);
    },
    canRetryDeferredSessionRecovery: (...args) => part().canRetryDeferredSessionRecovery(...args),
    isPreservedSessionCurrent: (...args) => part().isPreservedSessionCurrent(...args),
    recoverSessionBoundAndroidDeviceAfterAdbServerReset: (...args) =>
      seams.recoverSessionBoundAndroidDeviceAfterAdbServerReset(...args),
    startAdbResetSessionRecovery: (...args) => part().startAdbResetSessionRecovery(...args),
    performAdbResetSessionRecovery: (...args) => part().performAdbResetSessionRecovery(...args),
    finishAdbResetRecoveryAfterReboot: (...args) =>
      part().finishAdbResetRecoveryAfterReboot(...args),
    refreshEmulatorLossRecoverySettlement: (...args) =>
      part().refreshEmulatorLossRecoverySettlement(...args),
    getAdbResetRecoveryDevice: (...args) => part().getAdbResetRecoveryDevice(...args),
    getAdbResetRecoverySession: (...args) => part().getAdbResetRecoverySession(...args),
    detachAdbServerResetCohort: (...args) => seams.detachAdbServerResetCohort(...args),
    waitForAdbServerResetRecovery: (...args) => seams.waitForAdbServerResetRecovery(...args),
    getRecoveringAndroidTargets: (...args) => seams.getRecoveringAndroidTargets(...args),
    reserveAndroidStartupLease: (...args) => seams.reserveAndroidStartupLease(...args),
    waitForAdbServerResetRecoveryMatchingName: (...args) =>
      seams.waitForAdbServerResetRecoveryMatchingName(...args),
    releaseAdbServerResetCohortReservations: (...args) =>
      seams.releaseAdbServerResetCohortReservations(...args),
    isDeviceLeasedForAndroidStartup: (...args) => seams.isDeviceLeasedForAndroidStartup(...args),
    releasePreservedAdbResetSessionIfDetached: (...args) =>
      part().releasePreservedAdbResetSessionIfDetached(...args),
    releaseDisconnectedRecoverySessionWithRetry: (...args) =>
      part().releaseDisconnectedRecoverySessionWithRetry(...args),
    retrySessionRelease<T>(
      sessionId: string,
      deviceId: string,
      attempt: () => Promise<T>,
    ): Promise<T> {
      return part().retrySessionRelease(sessionId, deviceId, attempt);
    },
  };
}
