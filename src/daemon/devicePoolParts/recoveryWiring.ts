import { AdbResetSessionRecovery } from "../adbResetSessionRecovery";
import { DeviceRecoveryCoordinator } from "../deviceRecoveryCoordinator";
import {
  SessionPreservingRecoveryRunner,
  MAX_DEFERRED_RECOVERY_SHUTDOWNS,
  UNCONFIRMED_RECOVERY_SHUTDOWN_COOLDOWN_MS,
} from "../sessionPreservingRecovery";
import { AdbServerResetQuarantine } from "../adbServerResetQuarantine";
import {
  AndroidRebootCoordinator,
  type AndroidRebootCoordinatorPoolPort,
} from "../androidRebootCoordinator";
import {
  ANDROID_OFFLINE_PROBE_TIMEOUT_MS,
  AndroidEmulatorRecoveryDevice,
  DevicePoolDependencies,
  createAdbServerResetQuarantine,
} from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface RecoveryWiringOperations {
  createRecoveryCoordinator(): DeviceRecoveryCoordinator;
  createSessionPreservingRecovery(): SessionPreservingRecoveryRunner;
  createAdbResetSessionRecovery(): AdbResetSessionRecovery;
  createAndroidRebootCoordinator(): AndroidRebootCoordinator;
  createAdbResetQuarantine(
    factory: DevicePoolDependencies["adbServerResetQuarantineFactory"],
  ): AdbServerResetQuarantine;
}
type RecoveryWiringState = Pick<
  DevicePoolState,
  | "refreshCoordinator"
  | "deviceManager"
  | "androidRecoveryRecordLedger"
  | "devices"
  | "emulatorLossLedger"
  | "sessionManager"
  | "timer"
  | "adbServerResetQuarantinedSessions"
  | "releasedDeviceCaptures"
  | "deviceSessionContinuityEnabled"
  | "cancelDeviceSessionExecutions"
  | "recoveryCoordinator"
  | "runtimeIdentity"
  | "criteriaMatcher"
  | "androidDeviceReboot"
  | "assignmentMutex"
  | "startedDeviceProcesses"
  | "adbServerResetTrackedProcesses"
  | "adbServerResetRecoveryReservations"
  | "androidStartupLeases"
  | "afterAndroidStartupRecoverySnapshot"
>;
export type RecoveryWiringCallbacks = Pick<
  DevicePoolOperations,
  | "completeEmulatorLossRecovery"
  | "getAndroidSessionPreservingRecoveryTarget"
  | "getSessionPreservingRecoveryTarget"
  | "isIOSSimulatorContinuityDevice"
  | "performSessionPreservingRecovery"
  | "finishEmulatorLossIncident"
  | "recoverSessionBoundAndroidDeviceAfterAdbServerReset"
  | "releaseAdbServerResetCohortReservations"
  | "refreshEmulatorLossRecoverySettlement"
  | "settleEmulatorLossIncident"
  | "releaseDisconnectedRecoverySessionWithRetry"
  | "releaseDevice"
  | "notifyDeviceStateChanged"
  | "startAndroidRecoveryRecord"
  | "isAndroidEmulatorActiveRelaunchEligible"
  | "rebootDisconnectedAndroidDevice"
  | "getRecoveryPolicy"
  | "isPreservedSessionCurrent"
  | "stableDeviceIdFor"
  | "removeDevice"
  | "suppressAutoStartForDevice"
  | "getDeviceManager"
  | "getTimer"
  | "recordEmulatorLossRecoveryAttempt"
  | "stopAndroidEmulatorForRecovery"
  | "rebindSameAvdReplacementSession"
  | "detachSessionForAndroidRecovery"
  | "addDevice"
  | "bindRecoveredAndroidDeviceSession"
  | "stopEmulatorProcess"
  | "consumeAndroidRecoveryCancellation"
  | "getDevice"
  | "recordEmulatorLossIncident"
  | "stopTrackedEmulatorProcess"
>;

/** Recovery Wiring responsibilities of DevicePool. */
export class DevicePoolRecoveryWiring {
  constructor(
    private readonly state: RecoveryWiringState,
    private readonly callbacks: RecoveryWiringCallbacks,
  ) {}
  createRecoveryCoordinator(): DeviceRecoveryCoordinator {
    return new DeviceRecoveryCoordinator({
      getRefreshGeneration: () => this.state.refreshCoordinator.getRefreshGeneration(),
      getAndroidOfflineDeviceIds: async (deviceIds) =>
        (await this.state.deviceManager.getAndroidOfflineDeviceIds?.(deviceIds, {
          timeoutMs: ANDROID_OFFLINE_PROBE_TIMEOUT_MS,
        })) ?? new Set<string>(),
      getRecoveringSessionLosses: () =>
        this.state.androidRecoveryRecordLedger.recoveringSessionLosses,
      getPooledDevice: (id) => this.state.devices.get(id),
      getEmulatorLossIncident: (id) =>
        this.state.emulatorLossLedger.emulatorLossIncidentStore.get(id),
      completeJoinedEmulatorLossRecovery: (id, outcome, state) =>
        this.callbacks.completeEmulatorLossRecovery(id, outcome, state),
      getSessionForDevice: (id) => this.state.sessionManager.getSessionForDevice(id),
      waitForReleasingSession: (sessionId) =>
        this.state.sessionManager.getReleasingSession(sessionId)
          ? this.state.sessionManager.waitForSessionRelease(sessionId)
          : undefined,
      getAndroidSessionPreservingRecoveryTarget: (id, expected) =>
        this.callbacks.getAndroidSessionPreservingRecoveryTarget(id, expected),
      getSessionPreservingRecoveryTarget: (id, expected) =>
        this.callbacks.getSessionPreservingRecoveryTarget(id, expected),
      isIOSSimulatorContinuityDevice: (device) =>
        this.callbacks.isIOSSimulatorContinuityDevice(device),
      performSessionPreservingRecovery: (device, session, incident) =>
        this.callbacks.performSessionPreservingRecovery(device, session, incident),
      finishEmulatorLossIncident: (incident, outcome) =>
        this.callbacks.finishEmulatorLossIncident(incident, outcome),
      recoverSessionBoundAndroidDeviceAfterAdbServerReset: (id, expected) =>
        this.callbacks.recoverSessionBoundAndroidDeviceAfterAdbServerReset(id, expected),
      releaseAdbServerResetCohortReservations: (devices) =>
        this.callbacks.releaseAdbServerResetCohortReservations(devices),
      getTimer: () => this.state.timer,
      getAndroidRecoveryRecordLedger: () => this.state.androidRecoveryRecordLedger,
      getAdbServerResetQuarantinedSessions: () => this.state.adbServerResetQuarantinedSessions,
      getEmulatorLossRecoverySettlements: () =>
        this.state.emulatorLossLedger.emulatorLossRecoverySettlements,
      hasReleasedDeviceCapture: (sessionId) => this.state.releasedDeviceCaptures.has(sessionId),
      refreshEmulatorLossRecoverySettlement: (incidentId, outcome) =>
        this.callbacks.refreshEmulatorLossRecoverySettlement(incidentId, outcome),
      settleEmulatorLossIncident: (incidentId) =>
        this.callbacks.settleEmulatorLossIncident(incidentId),
      completeEmulatorLossRecovery: (incidentId, outcome) =>
        this.callbacks.completeEmulatorLossRecovery(incidentId, outcome),
      releaseDisconnectedRecoverySessionWithRetry: (sessionId, deviceId, reason, attempt) =>
        this.callbacks.releaseDisconnectedRecoverySessionWithRetry(
          sessionId,
          deviceId,
          reason,
          attempt,
        ),
      releaseDevice: (deviceId, sessionId) => this.callbacks.releaseDevice(deviceId, sessionId),
    });
  }

  createSessionPreservingRecovery(): SessionPreservingRecoveryRunner {
    return new SessionPreservingRecoveryRunner({
      getRecoveringSessionLoss: (id) =>
        this.state.androidRecoveryRecordLedger.recoveringSessionLosses.get(id),
      noteDeviceStateChanged: (device) => this.callbacks.notifyDeviceStateChanged(device),
      startAndroidRecoveryRecord: (id, details, reservations, replace) =>
        this.callbacks.startAndroidRecoveryRecord(id, details, reservations, replace),
      isAndroidEmulatorActiveRelaunchEligible: (device): device is AndroidEmulatorRecoveryDevice =>
        this.callbacks.isAndroidEmulatorActiveRelaunchEligible(device),
      rebootDisconnectedAndroidDevice: (device, incidentId, options) =>
        this.callbacks.rebootDisconnectedAndroidDevice(device, incidentId, options),
      getRecoveryPolicy: () => this.callbacks.getRecoveryPolicy(),
      deviceSessionContinuityEnabled: () => this.state.deviceSessionContinuityEnabled,
      cancelDeviceSessionExecutions: (id, reason) =>
        this.state.cancelDeviceSessionExecutions(id, reason),
      refreshReleasedRecoverySettlementAfterAwait: (record, incidentId) =>
        this.state.recoveryCoordinator.refreshReleasedRecoverySettlementAfterAwait(
          record,
          incidentId,
        ),
      finalizeReleasedRecoveryAfterAwait: (record, incidentId) =>
        this.state.recoveryCoordinator.finalizeReleasedRecoveryAfterAwait(record, incidentId),
      finalizeRecoveryRecord: (id, record) =>
        this.state.recoveryCoordinator.finalizeRecoveryRecord(id, record),
      finalizeReleasedRecoveryAfterCleanupFailure: (record, incidentId, error) =>
        this.state.recoveryCoordinator.finalizeReleasedRecoveryAfterCleanupFailure(
          record,
          incidentId,
          error,
        ),
      markAndroidRecoveryReleaseFailure: (record) =>
        this.state.recoveryCoordinator.markAndroidRecoveryReleaseFailure(record),
      completeEmulatorLossRecovery: (incidentId, outcome, state) =>
        this.callbacks.completeEmulatorLossRecovery(incidentId, outcome, state),
      settleEmulatorLossIncident: (incidentId) =>
        this.callbacks.settleEmulatorLossIncident(incidentId),
      isPreservedSessionCurrent: (session, id) =>
        this.callbacks.isPreservedSessionCurrent(session, id),
      releaseDisconnectedRecoverySessionWithRetry: (sessionId, deviceId, reason) =>
        this.callbacks.releaseDisconnectedRecoverySessionWithRetry(sessionId, deviceId, reason),
      stableDeviceIdFor: (device) => this.callbacks.stableDeviceIdFor(device),
      getPooledDevice: (id) => this.state.devices.get(id),
      removeDevice: (id, awaitCacheCleanup, device) =>
        this.callbacks.removeDevice(id, awaitCacheCleanup, device),
      suppressAutoStartForDevice: (device) => this.callbacks.suppressAutoStartForDevice(device),
      getEmulatorLossIncident: (id) =>
        this.state.emulatorLossLedger.emulatorLossIncidentStore.get(id),
      getFinalizedReleaseReason: (session) =>
        this.state.sessionManager.getFinalizedReleaseReason(session),
      now: () => this.state.timer.now(),
    });
  }

  createAdbResetSessionRecovery(): AdbResetSessionRecovery {
    return new AdbResetSessionRecovery(
      {
        maxDeferredRecoveryShutdowns: MAX_DEFERRED_RECOVERY_SHUTDOWNS,
        unconfirmedRecoveryShutdownCooldownMs: UNCONFIRMED_RECOVERY_SHUTDOWN_COOLDOWN_MS,
        getRecoveryRecord: (sessionId) =>
          this.state.androidRecoveryRecordLedger.recoveringSessionLosses.get(sessionId),
        getPooledDevice: (deviceId) => this.state.devices.get(deviceId),
        isPreservedSessionCurrent: (session, deviceId) =>
          this.callbacks.isPreservedSessionCurrent(session, deviceId),
        startAndroidRecoveryRecord: (sessionId, details, reservations, replace) =>
          this.callbacks.startAndroidRecoveryRecord(sessionId, details, reservations, replace),
        rebootDisconnectedAndroidDevice: (device, incidentId, options) =>
          this.callbacks.rebootDisconnectedAndroidDevice(device, incidentId, options),
        releaseDisconnectedRecoverySessionWithRetry: (sessionId, deviceId, reason) =>
          this.callbacks.releaseDisconnectedRecoverySessionWithRetry(sessionId, deviceId, reason),
        refreshEmulatorLossRecoverySettlement: (incidentId, outcome) =>
          this.callbacks.refreshEmulatorLossRecoverySettlement(incidentId, outcome),
        completeEmulatorLossRecovery: (incidentId, outcome) =>
          this.callbacks.completeEmulatorLossRecovery(incidentId, outcome),
        settleEmulatorLossIncident: (incidentId) =>
          this.callbacks.settleEmulatorLossIncident(incidentId),
        finalizeReleasedRecoveryAfterAwait: (record, incidentId) =>
          this.state.recoveryCoordinator.finalizeReleasedRecoveryAfterAwait(record, incidentId),
        finalizeReleasedRecoveryAfterCleanupFailure: (record, incidentId, error) =>
          this.state.recoveryCoordinator.finalizeReleasedRecoveryAfterCleanupFailure(
            record,
            incidentId,
            error,
          ),
        markAndroidRecoveryReleaseFailure: (record) =>
          this.state.recoveryCoordinator.markAndroidRecoveryReleaseFailure(record),
        finalizeRecoveryRecord: (sessionId, record) =>
          this.state.recoveryCoordinator.finalizeRecoveryRecord(sessionId, record),
      },
      this.state.timer,
    );
  }

  createAndroidRebootCoordinator(): AndroidRebootCoordinator {
    return new AndroidRebootCoordinator(
      {
        getDeviceManager: () => this.callbacks.getDeviceManager(),
        getTimer: () => this.callbacks.getTimer(),
        getRecoveryPolicy: () => this.callbacks.getRecoveryPolicy(),
        completeEmulatorLossRecovery: (incidentId, outcome, releasedSessionState) =>
          this.callbacks.completeEmulatorLossRecovery(incidentId, outcome, releasedSessionState),
        recordEmulatorLossRecoveryAttempt: (incidentId, attempt) =>
          this.callbacks.recordEmulatorLossRecoveryAttempt(incidentId, attempt),
        setRecoveringAndroidImage: (avdName, image) =>
          this.state.recoveryCoordinator.setRecoveringAndroidImage(avdName, image),
        addRecoveringAndroidDeviceId: (deviceId) =>
          this.state.recoveryCoordinator.addRecoveringAndroidDeviceId(deviceId),
        setAndroidRecoveryHandoffOwner: (deviceId, owner) =>
          this.state.recoveryCoordinator.setAndroidRecoveryHandoffOwner(deviceId, owner),
        clearAndroidRecoveryHandoffOwnerIfCurrent: (deviceId, owner) =>
          this.state.recoveryCoordinator.clearAndroidRecoveryHandoffOwnerIfCurrent(deviceId, owner),
        finishAndroidRecoveryAttempt: (avdName, deviceIds, retainImage, owner, lateShutdown) =>
          this.state.recoveryCoordinator.finishAndroidRecoveryAttempt(
            avdName,
            deviceIds,
            retainImage,
            owner,
            lateShutdown,
          ),
        stopAndroidEmulatorForRecovery: (
          ...[
            device,
            avdName,
            retainLeaseUntil,
            allowActiveStop,
            owner,
            sessionId,
            session,
          ]: Parameters<AndroidRebootCoordinatorPoolPort["stopAndroidEmulatorForRecovery"]>
        ) =>
          this.callbacks.stopAndroidEmulatorForRecovery({
            device,
            avdName,
            retainLeaseUntil,
            allowActiveStop,
            handoffOwner: owner,
            preservedSessionId: sessionId,
            preservedSession: session,
          }),
        rebindSameAvdReplacementSession: (
          ...[device, avdName, sessionId, session, autolockSessionId, image, owner]: Parameters<
            AndroidRebootCoordinatorPoolPort["rebindSameAvdReplacementSession"]
          >
        ) =>
          this.callbacks.rebindSameAvdReplacementSession({
            device,
            avdName,
            preservedSessionId: sessionId,
            preservedSession: session,
            preservedAutolockSessionId: autolockSessionId,
            recoveryImage: image,
            handoffOwner: owner,
          }),
        detachSessionForAndroidRecovery: (device, sessionId, session) =>
          this.callbacks.detachSessionForAndroidRecovery(device, sessionId, session),
        removeDevice: (deviceId, awaitCacheCleanup, expectedDevice) =>
          this.callbacks.removeDevice(deviceId, awaitCacheCleanup, expectedDevice),
        addDevice: (device, image, awaitSessionTracking, evidence) =>
          this.callbacks.addDevice(device, image, awaitSessionTracking, evidence),
        identityEvidenceForBootedDevice: (device) =>
          this.state.runtimeIdentity.identityEvidenceForBootedDevice(device),
        bindRecoveredAndroidDeviceSession: (
          ...[
            previousDeviceId,
            avdName,
            sessionId,
            session,
            ready,
            image,
            childProcess,
            autolockSessionId,
            owner,
          ]: Parameters<AndroidRebootCoordinatorPoolPort["bindRecoveredAndroidDeviceSession"]>
        ) =>
          this.callbacks.bindRecoveredAndroidDeviceSession({
            previousDeviceId,
            avdName,
            preservedSessionId: sessionId,
            preservedSession: session,
            ready,
            recoveryImage: image,
            childProcess,
            preservedAutolockSessionId: autolockSessionId,
            handoffOwner: owner,
          }),
        stopEmulatorProcess: (childProcess, retainLeaseUntil) =>
          this.callbacks.stopEmulatorProcess(childProcess, retainLeaseUntil),
        consumeAndroidRecoveryCancellation: (device, recoveryDeviceIds) =>
          this.callbacks.consumeAndroidRecoveryCancellation(device, recoveryDeviceIds),
      },
      this.state.androidRecoveryRecordLedger,
      this.state.criteriaMatcher,
      this.state.androidDeviceReboot,
    );
  }

  createAdbResetQuarantine(
    factory: DevicePoolDependencies["adbServerResetQuarantineFactory"],
  ): AdbServerResetQuarantine {
    return createAdbServerResetQuarantine(
      {
        noteDeviceStateChanged: (device) => this.callbacks.notifyDeviceStateChanged(device),
        withAssignmentLock: (operation) => this.state.assignmentMutex.runExclusive(operation),
        getDevices: () => this.state.devices.backingMap(),
        getSessionManager: () => this.state.sessionManager,
        getStartedDeviceProcesses: () => this.state.startedDeviceProcesses,
        getAdbServerResetTrackedProcesses: () => this.state.adbServerResetTrackedProcesses,
        getAdbServerResetRecoveryReservations: () => this.state.adbServerResetRecoveryReservations,
        getAndroidStartupLeases: () => this.state.androidStartupLeases,
        getRecoveringAndroidImages: () => this.state.recoveryCoordinator.recoveringAndroidImages,
        getRecoveringAndroidDeviceIds: () =>
          this.state.recoveryCoordinator.recoveringAndroidDeviceIds,
        getRecoveringSessionLosses: () =>
          this.state.androidRecoveryRecordLedger.recoveringSessionLosses,
        getFailedTerminalRecoveryReleases: () =>
          this.state.androidRecoveryRecordLedger.failedTerminalRecoveryReleases,
        getRecoveryCoordinator: () => this.state.recoveryCoordinator,
        getAfterAndroidStartupRecoverySnapshot: () =>
          this.state.afterAndroidStartupRecoverySnapshot,
        getDevice: (id) => this.callbacks.getDevice(id),
        isPreservedSessionCurrent: (session, deviceId) =>
          this.callbacks.isPreservedSessionCurrent(session, deviceId),
        isAndroidEmulatorActiveRelaunchEligible: (device) =>
          this.callbacks.isAndroidEmulatorActiveRelaunchEligible(device),
        removeDevice: (id, awaitCacheCleanup, expected) =>
          this.callbacks.removeDevice(id, awaitCacheCleanup, expected),
        startAndroidRecoveryRecord: (sessionId, details, reservations, replace) =>
          this.callbacks.startAndroidRecoveryRecord(sessionId, details, reservations, replace),
        recordEmulatorLossIncident: (id, path, exit, state) =>
          this.callbacks.recordEmulatorLossIncident(id, path, exit, state),
        cancelDeviceExecutions: (id, reason) =>
          this.state.cancelDeviceSessionExecutions.cancelDeviceExecutions?.(id, reason) ??
          Promise.resolve(0),
        cancelDeviceSessionExecutions: (id, reason) =>
          this.state.cancelDeviceSessionExecutions(id, reason),
        completeEmulatorLossRecovery: (id, outcome) =>
          this.callbacks.completeEmulatorLossRecovery(id, outcome),
        settleEmulatorLossIncident: (id) => this.callbacks.settleEmulatorLossIncident(id),
        finishEmulatorLossIncident: (id, outcome) =>
          this.callbacks.finishEmulatorLossIncident(id, outcome),
        stopTrackedEmulatorProcess: (id) => this.callbacks.stopTrackedEmulatorProcess(id),
      },
      factory,
    );
  }
}

export function connectRecoveryWiring(
  part: () => DevicePoolRecoveryWiring,
  seams: Pick<DevicePoolOperations, never>,
): RecoveryWiringOperations {
  return {
    createRecoveryCoordinator: (...args) => part().createRecoveryCoordinator(...args),
    createSessionPreservingRecovery: (...args) => part().createSessionPreservingRecovery(...args),
    createAdbResetSessionRecovery: (...args) => part().createAdbResetSessionRecovery(...args),
    createAndroidRebootCoordinator: (...args) => part().createAndroidRebootCoordinator(...args),
    createAdbResetQuarantine: (...args) => part().createAdbResetQuarantine(...args),
  };
}
