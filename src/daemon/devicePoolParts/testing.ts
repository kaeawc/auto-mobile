import { type ForeignDeviceOwnership } from "../foreignDeviceOwnership";
import { PlatformDeviceManager } from "../../devices/deviceUtils";
/**
 * Pooled Device Status
 */
import { interceptableMethod } from "../interceptableMethod";
import type { PooledDevice } from "../devicePoolTypes";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";
import type { DevicePoolOverrides } from "./createParts";

type TestingState = Pick<
  DevicePoolState,
  | "assignmentMutex"
  | "missingDeviceLiveness"
  | "runtimeIdentity"
  | "idleDeviceReaper"
  | "startedDeviceProcesses"
  | "startedDeviceProcessOutput"
  | "rehydrationReservations"
  | "intentionalShutdowns"
  | "shutdownReservationCoordinator"
  | "deviceReservations"
  | "foreignDeviceOwnership"
  | "timer"
  | "installedAppsRepository"
  | "deviceManager"
  | "retryExecutor"
  | "criteriaMatcher"
  | "onDeviceReady"
  | "deferredDeviceReleases"
  | "deviceHealthMarkers"
  | "mcpSessionRecoveryDevices"
  | "releasedDeviceCaptures"
  | "adbServerResetQuarantinedSessions"
  | "adbServerResetRecoveryReservations"
  | "recoveryCoordinator"
  | "androidRecoveryRecordLedger"
  | "emulatorLossLedger"
  | "afterAndroidStartupRecoverySnapshot"
  | "iosForeignDeviceOwnership"
  | "watchForeignDeviceOwnership"
  | "releaseSessionForDisconnectedDevice"
  | "ownerDisconnectRelease"
  | "DEVICE_WAIT_TIMEOUT_MS"
  | "devices"
  | "pooledSessionIdentities"
  | "autolockManager"
  | "mcpSessionAcquiredDeviceSessions"
  | "mcpSessionLivenessOwnerTokens"
  | "mcpSessionUndeliveredMints"
  | "mcpBindsInFlight"
>;
export type TestingCallbacks = Pick<
  DevicePoolOperations,
  | "releaseDeviceRestartReservation"
  | "getAssignedDevices"
  | "isReservedForShutdown"
  | "reserveShutdownSessionIdentity"
  | "refreshForeignOwnership"
  | "cancelOldDeviceWorkForSystemUiAnr"
  | "tryAssignDevice"
  | "getStartableDeviceImageCandidates"
  | "getSessionPreservingRecoveryTarget"
  | "retrySessionRelease"
  | "foldObservationIntoPooledEntry"
  | "releaseDisconnectedRecoverySessionWithRetry"
  | "notifyRehydrationReservationChanged"
  | "captureReleasedDevice"
  | "runCoordinatedDeviceStart"
  | "startAndroidRecoveryRecord"
  | "joinSessionPreservingRecovery"
  | "completeEmulatorLossRecovery"
  | "createIdleDeviceReaper"
  | "pruneStaleIdleIosDevices"
  | "selectAssignableIdleDevice"
  | "startAdditionalDevices"
  | "startAdditionalDeviceMatchingCriteria"
  | "trackStartedDeviceProcess"
  | "addDevice"
  | "clearDeviceSessionCache"
  | "evictMissingPooledDevice"
  | "replacePooledDeviceForRuntimeIdentity"
  | "setDeviceSessionTracking"
  | "snapshotSessionAssignment"
  | "restoreSessionAssignment"
  | "detachSessionForAndroidRecovery"
  | "releaseCapturedDevice"
  | "isPreservedSessionCurrent"
  | "isCurrentIdleDeviceAssignable"
  | "isSessionAssignmentCurrent"
  | "isCapturedReleaseCurrent"
  | "restoreSystemUiAnrRecoverySession"
  | "completeShutdownSessionIdentity"
  | "releaseDeviceClaim"
  | "tryPreserveSessionForMissingDevice"
  | "recoveryAssignmentError"
  | "discardReleasedCapture"
  | "releaseSessionForEvictedDevice"
  | "rollbackAssignments"
>;

/** Testing responsibilities of DevicePool. */
export class DevicePoolTesting {
  constructor(
    private readonly state: TestingState,
    private readonly callbacks: TestingCallbacks,
    private readonly overrides: DevicePoolOverrides,
  ) {}
  /** @internal Typed view of private state for unit tests; not part of the public API. */
  private coreHooks() {
    return {
      assignmentMutex: this.state.assignmentMutex,
      missingDeviceLiveness: this.state.missingDeviceLiveness,
      runtimeIdentity: this.state.runtimeIdentity,
      idleDeviceReaper: this.state.idleDeviceReaper,
      startedDeviceProcesses: this.state.startedDeviceProcesses,
      startedDeviceProcessOutput: this.state.startedDeviceProcessOutput,
      releaseDeviceRestartReservation: this.callbacks.releaseDeviceRestartReservation.bind(
        this.callbacks,
      ),
      rehydrationReservations: this.state.rehydrationReservations,
      intentionalShutdowns: this.state.intentionalShutdowns,
      shutdownReservationCoordinator: this.state.shutdownReservationCoordinator,
      isReservedForShutdown: (device: PooledDevice) => this.callbacks.isReservedForShutdown(device),
      reserveShutdownSessionIdentity: (deviceId: string) =>
        this.callbacks.reserveShutdownSessionIdentity(deviceId),
      restartReadiness: this.state.deviceReservations.restartReadiness,
      foreignDeviceOwnership: this.state.foreignDeviceOwnership,
      watchForeignDeviceOwnership: this.state.watchForeignDeviceOwnership,
      refreshForeignOwnership: this.callbacks.refreshForeignOwnership.bind(this.callbacks),
      cancelOldDeviceWorkForSystemUiAnr: interceptableMethod(
        () => this.overrides.cancelOldDeviceWorkForSystemUiAnr.current(),
        (replacement) => {
          this.overrides.cancelOldDeviceWorkForSystemUiAnr.install(replacement);
        },
      ),
      tryAssignDevice: this.callbacks.tryAssignDevice.bind(this.callbacks),
      getStartableDeviceImageCandidates: this.callbacks.getStartableDeviceImageCandidates.bind(
        this.callbacks,
      ),
      getSessionPreservingRecoveryTarget: this.callbacks.getSessionPreservingRecoveryTarget.bind(
        this.callbacks,
      ),
      retrySessionRelease: this.callbacks.retrySessionRelease.bind(this.callbacks),
      foldObservationIntoPooledEntry: this.callbacks.foldObservationIntoPooledEntry.bind(
        this.callbacks,
      ),
      releaseDisconnectedRecoverySessionWithRetry:
        this.callbacks.releaseDisconnectedRecoverySessionWithRetry.bind(this.callbacks),
      notifyRehydrationReservationChanged: interceptableMethod(
        () => this.overrides.notifyRehydrationReservationChanged.current(),
        (replacement) => {
          this.overrides.notifyRehydrationReservationChanged.install(replacement);
        },
      ),
      collaborators: {
        timer: this.state.timer,
        installedAppsRepository: this.state.installedAppsRepository,
        deviceManager: this.state.deviceManager,
        retryExecutor: this.state.retryExecutor,
        criteriaMatcher: this.state.criteriaMatcher,
        onDeviceReady: this.state.onDeviceReady,
      },
      deferredDeviceReleases: this.state.deferredDeviceReleases,
      deviceHealthMarkers: this.state.deviceHealthMarkers,
      mcpSessionRecoveryDevices: this.state.mcpSessionRecoveryDevices,
      releasedDeviceCaptures: this.state.releasedDeviceCaptures,
      captureReleasedDevice: this.callbacks.captureReleasedDevice.bind(this.callbacks),
      runCoordinatedDeviceStart: this.callbacks.runCoordinatedDeviceStart.bind(this.callbacks),
      adbServerResetQuarantinedSessions: this.state.adbServerResetQuarantinedSessions,
      adbServerResetRecoveryReservations: this.state.adbServerResetRecoveryReservations,
      recoveryCoordinator: this.state.recoveryCoordinator,
      androidRecoveryRecordLedger: this.state.androidRecoveryRecordLedger,
      emulatorLossLedger: this.state.emulatorLossLedger,
      startAndroidRecoveryRecord: this.callbacks.startAndroidRecoveryRecord.bind(this.callbacks),
      joinSessionPreservingRecovery: this.callbacks.joinSessionPreservingRecovery.bind(
        this.callbacks,
      ),
      setAfterAndroidStartupRecoverySnapshot: (hook: (() => void) | undefined): void => {
        this.state.afterAndroidStartupRecoverySnapshot = hook;
      },
      completeEmulatorLossRecovery: interceptableMethod(
        () => this.overrides.completeEmulatorLossRecovery.current(),
        (replacement) => {
          this.overrides.completeEmulatorLossRecovery.install(replacement);
        },
      ),
      /** Swaps the host-facing collaborators a daemon-built pool captured at construction. */
      installHostCollaborators: (collaborators: {
        deviceManager: PlatformDeviceManager;
        foreignDeviceOwnership: ForeignDeviceOwnership | undefined;
        iosForeignDeviceOwnership: ForeignDeviceOwnership | undefined;
        watchForeignDeviceOwnership?: ForeignDeviceOwnership;
      }): void => {
        this.state.deviceManager = collaborators.deviceManager;
        this.state.foreignDeviceOwnership = collaborators.foreignDeviceOwnership;
        this.state.iosForeignDeviceOwnership = collaborators.iosForeignDeviceOwnership;
        this.state.watchForeignDeviceOwnership = collaborators.watchForeignDeviceOwnership;
        // The reaper captured the previous device manager when the pool was built.
        this.state.idleDeviceReaper = this.callbacks.createIdleDeviceReaper();
      },
      setDeviceManager: (manager: PlatformDeviceManager): void => {
        this.state.deviceManager = manager;
      },
      pruneStaleIdleIosDevices: (candidates: PooledDevice[]) =>
        this.callbacks.pruneStaleIdleIosDevices(candidates),
      selectAssignableIdleDevice: this.callbacks.selectAssignableIdleDevice.bind(this.callbacks),
      startAdditionalDevices: this.callbacks.startAdditionalDevices.bind(this.callbacks),
      startAdditionalDeviceMatchingCriteria:
        this.callbacks.startAdditionalDeviceMatchingCriteria.bind(this.callbacks),
      trackStartedDeviceProcess: interceptableMethod(
        () => this.overrides.trackStartedDeviceProcess.current(),
        (replacement) => {
          this.overrides.trackStartedDeviceProcess.install(replacement);
        },
      ),
      addDevice: interceptableMethod(
        () => this.overrides.addDevice.current(),
        (replacement) => {
          this.overrides.addDevice.install(replacement);
        },
      ),
      clearDeviceSessionCache: interceptableMethod(
        () => this.overrides.clearDeviceSessionCache.current(),
        (replacement) => {
          this.overrides.clearDeviceSessionCache.install(replacement);
        },
      ),
      evictMissingPooledDevice: interceptableMethod(
        () => this.overrides.evictMissingPooledDevice.current(),
        (replacement) => {
          this.overrides.evictMissingPooledDevice.install(replacement);
        },
      ),
      replacePooledDeviceForRuntimeIdentity: interceptableMethod(
        () => this.overrides.replacePooledDeviceForRuntimeIdentity.current(),
        (replacement) => {
          this.overrides.replacePooledDeviceForRuntimeIdentity.install(replacement);
        },
      ),
      setDeviceSessionTracking: interceptableMethod(
        () => this.overrides.setDeviceSessionTracking.current(),
        (replacement) => {
          this.overrides.setDeviceSessionTracking.install(replacement);
        },
      ),
      releaseSessionForDisconnectedDevice: interceptableMethod(
        () => this.state.releaseSessionForDisconnectedDevice,
        (replacement) => {
          this.state.releaseSessionForDisconnectedDevice = replacement;
        },
      ),
      ...this.migratedHooks(),
    } as const;
  }

  private migratedHooks() {
    const state = this.state;
    const callbacks = this.callbacks;
    return {
      ownerDisconnectRelease: state.ownerDisconnectRelease,
      snapshotSessionAssignment: callbacks.snapshotSessionAssignment.bind(callbacks),
      restoreSessionAssignment: callbacks.restoreSessionAssignment.bind(callbacks),
      detachSessionForAndroidRecovery: callbacks.detachSessionForAndroidRecovery.bind(callbacks),
      releaseCapturedDevice: callbacks.releaseCapturedDevice.bind(callbacks),
      devices: state.devices,
      isPreservedSessionCurrent: callbacks.isPreservedSessionCurrent.bind(callbacks),
      isCurrentIdleDeviceAssignable: callbacks.isCurrentIdleDeviceAssignable.bind(callbacks),
      isSessionAssignmentCurrent: callbacks.isSessionAssignmentCurrent.bind(callbacks),
      isCapturedReleaseCurrent: callbacks.isCapturedReleaseCurrent.bind(callbacks),
      pooledSessionIdentities: state.pooledSessionIdentities,
      restoreSystemUiAnrRecoverySession:
        callbacks.restoreSystemUiAnrRecoverySession.bind(callbacks),
      autolockManager: state.autolockManager,
      completeShutdownSessionIdentity: callbacks.completeShutdownSessionIdentity.bind(callbacks),
      recoveryAssignmentError: callbacks.recoveryAssignmentError.bind(callbacks),
      discardReleasedCapture: callbacks.discardReleasedCapture.bind(callbacks),
      releaseSessionForEvictedDevice: callbacks.releaseSessionForEvictedDevice.bind(callbacks),
      rollbackAssignments: callbacks.rollbackAssignments.bind(callbacks),
      mcpSessionAcquiredDeviceSessions: state.mcpSessionAcquiredDeviceSessions,
      mcpSessionLivenessOwnerTokens: state.mcpSessionLivenessOwnerTokens,
      mcpSessionUndeliveredMints: state.mcpSessionUndeliveredMints,
      mcpBindsInFlight: state.mcpBindsInFlight,
    };
  }

  get testHooks() {
    const state = this.state;
    const overrides = this.overrides;
    return {
      ...this.coreHooks(),
      ...this.migratedHooks(),
      get deviceManager() {
        return state.deviceManager;
      },
      set deviceManager(value: DevicePoolState["deviceManager"]) {
        state.deviceManager = value;
      },
      get DEVICE_WAIT_TIMEOUT_MS() {
        return state.DEVICE_WAIT_TIMEOUT_MS;
      },
      set DEVICE_WAIT_TIMEOUT_MS(value: DevicePoolState["DEVICE_WAIT_TIMEOUT_MS"]) {
        state.DEVICE_WAIT_TIMEOUT_MS = value;
      },
      get releaseDeviceClaim() {
        return overrides.releaseDeviceClaim.current();
      },
      set releaseDeviceClaim(value: DevicePoolOperations["releaseDeviceClaim"]) {
        overrides.releaseDeviceClaim.install(value);
      },
      get tryPreserveSessionForMissingDevice() {
        return overrides.tryPreserveSessionForMissingDevice.current();
      },
      set tryPreserveSessionForMissingDevice(
        value: DevicePoolOperations["tryPreserveSessionForMissingDevice"],
      ) {
        overrides.tryPreserveSessionForMissingDevice.install(value);
      },
    };
  }
}
