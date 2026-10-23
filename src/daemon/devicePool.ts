import { createDevicePoolSeams } from "./devicePoolSeams";
import { createDevicePoolParts } from "./devicePoolParts/createParts";
import { DevicePoolState } from "./devicePoolParts/state";
import type { DevicePoolOperations as PoolOps } from "./devicePoolParts/operations";
import type { DevicePoolDependencies } from "./devicePoolParts/contracts";
import {
  ForwardLeaseForeignDeviceOwnership,
  iosDeviceOwnershipFileSource,
} from "./foreignDeviceOwnership";
export * from "./devicePoolParts/contracts";
export { classifyPoolStatus, type GenericAvailability, type PoolStatusBucket } from "./deviceHold";
export { McpSessionRecoveryInProgressError } from "./McpSessionRecoveryInProgressError";
export type { DeviceRecoveryPolicy } from "./poolConfig";
export type {
  RefusedOwnedSessionRestore,
  DeviceStatus,
  SessionPreservingRecoveryResult,
  SessionRecoveryPreparation,
  DeviceRecoveryEligibility,
  RemoveDeviceOptions,
  PooledDevice,
} from "./devicePoolTypes";

export class DevicePool {
  private readonly state = new DevicePoolState();
  private readonly parts = createDevicePoolParts(
    this.state,
    createDevicePoolSeams(this, {
      evictMissingPooledDevice: (...args) => this.evictMissingPooledDevice(...args),
      hasConnectedMcpSessionOwner: (...args) => this.hasConnectedMcpSessionOwner(...args),
      cancelOldDeviceWorkForSystemUiAnr: (...args) =>
        this.cancelOldDeviceWorkForSystemUiAnr(...args),
      notifyRehydrationReservationChanged: (...args) =>
        this.notifyRehydrationReservationChanged(...args),
      completeEmulatorLossRecovery: (...args) => this.completeEmulatorLossRecovery(...args),
      clearDeviceSessionCache: (...args) => this.clearDeviceSessionCache(...args),
      replacePooledDeviceForRuntimeIdentity: (...args) =>
        this.replacePooledDeviceForRuntimeIdentity(...args),
      setDeviceSessionTracking: (...args) => this.setDeviceSessionTracking(...args),
      releaseDeviceClaim: (...args) => this.releaseDeviceClaim(...args),
      tryPreserveSessionForMissingDevice: (...args) =>
        this.tryPreserveSessionForMissingDevice(...args),
    }),
    {
      cancelOldDeviceWorkForSystemUiAnr: {
        current: () => this.cancelOldDeviceWorkForSystemUiAnr.bind(this),
        install: (replacement) => {
          this.cancelOldDeviceWorkForSystemUiAnr = replacement;
        },
      },
      notifyRehydrationReservationChanged: {
        current: () => this.notifyRehydrationReservationChanged.bind(this),
        install: (replacement) => {
          this.notifyRehydrationReservationChanged = replacement;
        },
      },
      completeEmulatorLossRecovery: {
        current: () => this.completeEmulatorLossRecovery.bind(this),
        install: (replacement) => {
          this.completeEmulatorLossRecovery = replacement;
        },
      },
      clearDeviceSessionCache: {
        current: () => this.clearDeviceSessionCache.bind(this),
        install: (replacement) => {
          this.clearDeviceSessionCache = replacement;
        },
      },
      replacePooledDeviceForRuntimeIdentity: {
        current: () => this.replacePooledDeviceForRuntimeIdentity.bind(this),
        install: (replacement) => {
          this.replacePooledDeviceForRuntimeIdentity = replacement;
        },
      },
      setDeviceSessionTracking: {
        current: () => this.setDeviceSessionTracking.bind(this),
        install: (replacement) => {
          this.setDeviceSessionTracking = replacement;
        },
      },
      releaseDeviceClaim: {
        current: () => this.releaseDeviceClaim.bind(this),
        install: (replacement) => {
          this.releaseDeviceClaim = replacement;
        },
      },
      tryPreserveSessionForMissingDevice: {
        current: () => this.tryPreserveSessionForMissingDevice.bind(this),
        install: (replacement) => {
          this.tryPreserveSessionForMissingDevice = replacement;
        },
      },
      trackStartedDeviceProcess: {
        current: () => this.trackStartedDeviceProcess.bind(this),
        install: (replacement) => {
          this.trackStartedDeviceProcess = replacement;
        },
      },
      addDevice: {
        current: () => this.addDevice.bind(this),
        install: (replacement) => {
          this.addDevice = replacement;
        },
      },
      evictMissingPooledDevice: {
        current: () => this.evictMissingPooledDevice.bind(this),
        install: (replacement) => {
          this.evictMissingPooledDevice = replacement;
        },
      },
    },
  );
  static create(deps: DevicePoolDependencies): DevicePool {
    return new DevicePool({
      foreignDeviceOwnership: new ForwardLeaseForeignDeviceOwnership(),
      iosForeignDeviceOwnership: new ForwardLeaseForeignDeviceOwnership(
        process.pid,
        iosDeviceOwnershipFileSource,
      ),
      ...deps,
    });
  }
  constructor(deps: DevicePoolDependencies) {
    this.parts.initialization.initialize(deps);
  }
  foreignSerials(serials: readonly string[], signal?: AbortSignal): Promise<ReadonlySet<string>> {
    return this.state.foreignClaims.foreignSerials(serials, signal);
  }

  protected get assignmentMutex() {
    return this.state.assignmentMutex;
  }
  protected set assignmentMutex(value: DevicePoolState["assignmentMutex"]) {
    this.state.assignmentMutex = value;
  }
  protected get rehydrationReservations() {
    return this.state.rehydrationReservations;
  }
  setDeviceProcessStartedListener(
    ...args: Parameters<PoolOps["setDeviceProcessStartedListener"]>
  ): ReturnType<PoolOps["setDeviceProcessStartedListener"]> {
    return this.parts.initialization.setDeviceProcessStartedListener(...args);
  }

  initializeWithDevices(
    ...args: Parameters<PoolOps["initializeWithDevices"]>
  ): ReturnType<PoolOps["initializeWithDevices"]> {
    return this.parts.membership.initializeWithDevices(...args);
  }

  refreshDevices(
    ...args: Parameters<PoolOps["refreshDevices"]>
  ): ReturnType<PoolOps["refreshDevices"]> {
    return this.parts.membership.refreshDevices(...args);
  }

  refreshDevicesWithOutcome(
    ...args: Parameters<PoolOps["refreshDevicesWithOutcome"]>
  ): ReturnType<PoolOps["refreshDevicesWithOutcome"]> {
    return this.parts.membership.refreshDevicesWithOutcome(...args);
  }

  getDeviceRemovalStampCountForTest(
    ...args: Parameters<PoolOps["getDeviceRemovalStampCountForTest"]>
  ): ReturnType<PoolOps["getDeviceRemovalStampCountForTest"]> {
    return this.parts.membership.getDeviceRemovalStampCountForTest(...args);
  }

  notifyDeviceReady(
    ...args: Parameters<PoolOps["notifyDeviceReady"]>
  ): ReturnType<PoolOps["notifyDeviceReady"]> {
    return this.parts.membership.notifyDeviceReady(...args);
  }

  pickUpRunningDevice(
    ...args: Parameters<PoolOps["pickUpRunningDevice"]>
  ): ReturnType<PoolOps["pickUpRunningDevice"]> {
    return this.parts.targetDiscovery.pickUpRunningDevice(...args);
  }

  addDevice(...args: Parameters<PoolOps["addDevice"]>): ReturnType<PoolOps["addDevice"]> {
    return this.parts.membership.addDevice(...args);
  }

  private replacePooledDeviceForRuntimeIdentity(
    ...args: Parameters<PoolOps["replacePooledDeviceForRuntimeIdentity"]>
  ): ReturnType<PoolOps["replacePooledDeviceForRuntimeIdentity"]> {
    return this.parts.membership.replacePooledDeviceForRuntimeIdentity(...args);
  }

  removeDevice(...args: Parameters<PoolOps["removeDevice"]>): ReturnType<PoolOps["removeDevice"]> {
    return this.parts.membership.removeDevice(...args);
  }

  clearAndroidRebootBudgetForDeletedAvd(
    ...args: Parameters<PoolOps["clearAndroidRebootBudgetForDeletedAvd"]>
  ): ReturnType<PoolOps["clearAndroidRebootBudgetForDeletedAvd"]> {
    return this.parts.membership.clearAndroidRebootBudgetForDeletedAvd(...args);
  }

  removeDisconnectedDevice(
    ...args: Parameters<PoolOps["removeDisconnectedDevice"]>
  ): ReturnType<PoolOps["removeDisconnectedDevice"]> {
    return this.parts.membership.removeDisconnectedDevice(...args);
  }

  recordEmulatorLossIncident(
    ...args: Parameters<PoolOps["recordEmulatorLossIncident"]>
  ): ReturnType<PoolOps["recordEmulatorLossIncident"]> {
    return this.parts.membership.recordEmulatorLossIncident(...args);
  }

  private completeEmulatorLossRecovery(
    ...args: Parameters<PoolOps["completeEmulatorLossRecovery"]>
  ): ReturnType<PoolOps["completeEmulatorLossRecovery"]> {
    return this.parts.membership.completeEmulatorLossRecovery(...args);
  }

  waitForEmulatorLossIncident(
    ...args: Parameters<PoolOps["waitForEmulatorLossIncident"]>
  ): ReturnType<PoolOps["waitForEmulatorLossIncident"]> {
    return this.parts.membership.waitForEmulatorLossIncident(...args);
  }

  finishEmulatorLossIncident(
    ...args: Parameters<PoolOps["finishEmulatorLossIncident"]>
  ): ReturnType<PoolOps["finishEmulatorLossIncident"]> {
    return this.parts.membership.finishEmulatorLossIncident(...args);
  }

  isCurrentDisconnectedDevice(
    ...args: Parameters<PoolOps["isCurrentDisconnectedDevice"]>
  ): ReturnType<PoolOps["isCurrentDisconnectedDevice"]> {
    return this.parts.membership.isCurrentDisconnectedDevice(...args);
  }

  markIntentionalShutdown(
    ...args: Parameters<PoolOps["markIntentionalShutdown"]>
  ): ReturnType<PoolOps["markIntentionalShutdown"]> {
    return this.parts.restartStops.markIntentionalShutdown(...args);
  }

  releaseDeviceRestartReservationForStop(
    ...args: Parameters<PoolOps["releaseDeviceRestartReservationForStop"]>
  ): ReturnType<PoolOps["releaseDeviceRestartReservationForStop"]> {
    return this.parts.restartStops.releaseDeviceRestartReservationForStop(...args);
  }

  hasRestartHandoffReservation(
    ...args: Parameters<PoolOps["hasRestartHandoffReservation"]>
  ): ReturnType<PoolOps["hasRestartHandoffReservation"]> {
    return this.parts.restartStops.hasRestartHandoffReservation(...args);
  }

  restartStopConfirmedPooledIdentity(
    ...args: Parameters<PoolOps["restartStopConfirmedPooledIdentity"]>
  ): ReturnType<PoolOps["restartStopConfirmedPooledIdentity"]> {
    return this.parts.restartStops.restartStopConfirmedPooledIdentity(...args);
  }

  hasUnconfirmedRestartStopReservation(
    ...args: Parameters<PoolOps["hasUnconfirmedRestartStopReservation"]>
  ): ReturnType<PoolOps["hasUnconfirmedRestartStopReservation"]> {
    return this.parts.restartStops.hasUnconfirmedRestartStopReservation(...args);
  }

  restartReservationForStop(
    ...args: Parameters<PoolOps["restartReservationForStop"]>
  ): ReturnType<PoolOps["restartReservationForStop"]> {
    return this.parts.restartStops.restartReservationForStop(...args);
  }

  restartStopConnectionHasLiveSession(
    ...args: Parameters<PoolOps["restartStopConnectionHasLiveSession"]>
  ): ReturnType<PoolOps["restartStopConnectionHasLiveSession"]> {
    return this.parts.restartStops.restartStopConnectionHasLiveSession(...args);
  }

  clearIntentionalShutdown(
    ...args: Parameters<PoolOps["clearIntentionalShutdown"]>
  ): ReturnType<PoolOps["clearIntentionalShutdown"]> {
    return this.parts.restartStops.clearIntentionalShutdown(...args);
  }

  noteLatePlatformShutdownSettled(
    ...args: Parameters<PoolOps["noteLatePlatformShutdownSettled"]>
  ): ReturnType<PoolOps["noteLatePlatformShutdownSettled"]> {
    return this.parts.restartStops.noteLatePlatformShutdownSettled(...args);
  }

  assignMultipleDevices(
    ...args: Parameters<PoolOps["assignMultipleDevices"]>
  ): ReturnType<PoolOps["assignMultipleDevices"]> {
    return this.parts.multiAllocation.assignMultipleDevices(...args);
  }

  assignMultipleDevicesByCriteria(
    ...args: Parameters<PoolOps["assignMultipleDevicesByCriteria"]>
  ): ReturnType<PoolOps["assignMultipleDevicesByCriteria"]> {
    return this.parts.multiAllocation.assignMultipleDevicesByCriteria(...args);
  }

  private tryPreserveSessionForMissingDevice(
    ...args: Parameters<PoolOps["tryPreserveSessionForMissingDevice"]>
  ): ReturnType<PoolOps["tryPreserveSessionForMissingDevice"]> {
    return this.parts.presence.tryPreserveSessionForMissingDevice(...args);
  }

  hasReusableSerial(
    ...args: Parameters<PoolOps["hasReusableSerial"]>
  ): ReturnType<PoolOps["hasReusableSerial"]> {
    return this.parts.presence.hasReusableSerial(...args);
  }

  protected evictMissingPooledDevice(
    ...args: Parameters<PoolOps["evictMissingPooledDevice"]>
  ): ReturnType<PoolOps["evictMissingPooledDevice"]> {
    return this.parts.presence.evictMissingPooledDevice(...args);
  }

  prepareSessionPreservingRecovery(
    ...args: Parameters<PoolOps["prepareSessionPreservingRecovery"]>
  ): ReturnType<PoolOps["prepareSessionPreservingRecovery"]> {
    return this.parts.sessionRecovery.prepareSessionPreservingRecovery(...args);
  }

  finishSessionPreservingRecoveryPreparation(
    ...args: Parameters<PoolOps["finishSessionPreservingRecoveryPreparation"]>
  ): ReturnType<PoolOps["finishSessionPreservingRecoveryPreparation"]> {
    return this.parts.sessionRecovery.finishSessionPreservingRecoveryPreparation(...args);
  }

  recoverSessionBoundAndroidDeviceAfterLoss(
    ...args: Parameters<PoolOps["recoverSessionBoundAndroidDeviceAfterLoss"]>
  ): ReturnType<PoolOps["recoverSessionBoundAndroidDeviceAfterLoss"]> {
    return this.parts.sessionRecovery.recoverSessionBoundAndroidDeviceAfterLoss(...args);
  }

  recoverSessionBoundDeviceAfterLoss(
    ...args: Parameters<PoolOps["recoverSessionBoundDeviceAfterLoss"]>
  ): ReturnType<PoolOps["recoverSessionBoundDeviceAfterLoss"]> {
    return this.parts.sessionRecovery.recoverSessionBoundDeviceAfterLoss(...args);
  }

  recoverSessionBoundIOSSimulatorAfterLoss(
    ...args: Parameters<PoolOps["recoverSessionBoundIOSSimulatorAfterLoss"]>
  ): ReturnType<PoolOps["recoverSessionBoundIOSSimulatorAfterLoss"]> {
    return this.parts.sessionRecovery.recoverSessionBoundIOSSimulatorAfterLoss(...args);
  }

  retryDueDeferredSessionRecoveries(
    ...args: Parameters<PoolOps["retryDueDeferredSessionRecoveries"]>
  ): ReturnType<PoolOps["retryDueDeferredSessionRecoveries"]> {
    return this.parts.sessionRecovery.retryDueDeferredSessionRecoveries(...args);
  }

  waitForSessionPreservingRecovery(
    ...args: Parameters<PoolOps["waitForSessionPreservingRecovery"]>
  ): ReturnType<PoolOps["waitForSessionPreservingRecovery"]> {
    return this.parts.sessionRecovery.waitForSessionPreservingRecovery(...args);
  }

  isSessionRecoveryInFlight(
    ...args: Parameters<PoolOps["isSessionRecoveryInFlight"]>
  ): ReturnType<PoolOps["isSessionRecoveryInFlight"]> {
    return this.parts.sessionRecovery.isSessionRecoveryInFlight(...args);
  }

  recoverSessionBoundAndroidDeviceAfterAdbServerReset(
    ...args: Parameters<PoolOps["recoverSessionBoundAndroidDeviceAfterAdbServerReset"]>
  ): ReturnType<PoolOps["recoverSessionBoundAndroidDeviceAfterAdbServerReset"]> {
    return this.parts.sessionRecovery.recoverSessionBoundAndroidDeviceAfterAdbServerReset(...args);
  }

  detachAdbServerResetCohort(
    ...args: Parameters<PoolOps["detachAdbServerResetCohort"]>
  ): ReturnType<PoolOps["detachAdbServerResetCohort"]> {
    return this.parts.sessionRecovery.detachAdbServerResetCohort(...args);
  }

  waitForAdbServerResetRecovery(
    ...args: Parameters<PoolOps["waitForAdbServerResetRecovery"]>
  ): ReturnType<PoolOps["waitForAdbServerResetRecovery"]> {
    return this.parts.sessionRecovery.waitForAdbServerResetRecovery(...args);
  }

  getRecoveringAndroidTargets(
    ...args: Parameters<PoolOps["getRecoveringAndroidTargets"]>
  ): ReturnType<PoolOps["getRecoveringAndroidTargets"]> {
    return this.parts.sessionRecovery.getRecoveringAndroidTargets(...args);
  }

  reserveAndroidStartupLease(
    ...args: Parameters<PoolOps["reserveAndroidStartupLease"]>
  ): ReturnType<PoolOps["reserveAndroidStartupLease"]> {
    return this.parts.sessionRecovery.reserveAndroidStartupLease(...args);
  }

  waitForAdbServerResetRecoveryMatchingName(
    ...args: Parameters<PoolOps["waitForAdbServerResetRecoveryMatchingName"]>
  ): ReturnType<PoolOps["waitForAdbServerResetRecoveryMatchingName"]> {
    return this.parts.sessionRecovery.waitForAdbServerResetRecoveryMatchingName(...args);
  }

  releaseAdbServerResetCohortReservations(
    ...args: Parameters<PoolOps["releaseAdbServerResetCohortReservations"]>
  ): ReturnType<PoolOps["releaseAdbServerResetCohortReservations"]> {
    return this.parts.sessionRecovery.releaseAdbServerResetCohortReservations(...args);
  }

  isDeviceLeasedForAndroidStartup(
    ...args: Parameters<PoolOps["isDeviceLeasedForAndroidStartup"]>
  ): ReturnType<PoolOps["isDeviceLeasedForAndroidStartup"]> {
    return this.parts.sessionRecovery.isDeviceLeasedForAndroidStartup(...args);
  }

  trackStartedDeviceProcess(
    ...args: Parameters<PoolOps["trackStartedDeviceProcess"]>
  ): ReturnType<PoolOps["trackStartedDeviceProcess"]> {
    return this.parts.emulatorLifecycle.trackStartedDeviceProcess(...args);
  }

  hasStartedDeviceProcess(
    ...args: Parameters<PoolOps["hasStartedDeviceProcess"]>
  ): ReturnType<PoolOps["hasStartedDeviceProcess"]> {
    return this.parts.emulatorLifecycle.hasStartedDeviceProcess(...args);
  }

  assignDeviceToSession(
    ...args: Parameters<PoolOps["assignDeviceToSession"]>
  ): ReturnType<PoolOps["assignDeviceToSession"]> {
    return this.parts.assignment.assignDeviceToSession(...args);
  }

  private releaseDeviceClaim(
    ...args: Parameters<PoolOps["releaseDeviceClaim"]>
  ): ReturnType<PoolOps["releaseDeviceClaim"]> {
    return this.parts.assignment.releaseDeviceClaim(...args);
  }

  assertNotClaimedByForeignDaemon(
    ...args: Parameters<PoolOps["assertNotClaimedByForeignDaemon"]>
  ): ReturnType<PoolOps["assertNotClaimedByForeignDaemon"]> {
    return this.parts.assignment.assertNotClaimedByForeignDaemon(...args);
  }

  releaseDeviceClaimsForShutdown(
    ...args: Parameters<PoolOps["releaseDeviceClaimsForShutdown"]>
  ): ReturnType<PoolOps["releaseDeviceClaimsForShutdown"]> {
    return this.parts.assignment.releaseDeviceClaimsForShutdown(...args);
  }

  refreshInventoryOwnership(
    ...args: Parameters<PoolOps["refreshInventoryOwnership"]>
  ): ReturnType<PoolOps["refreshInventoryOwnership"]> {
    return this.parts.assignment.refreshInventoryOwnership(...args);
  }

  getRefreshedStats(
    ...args: Parameters<PoolOps["getRefreshedStats"]>
  ): ReturnType<PoolOps["getRefreshedStats"]> {
    return this.parts.assignment.getRefreshedStats(...args);
  }

  getRefreshedInventory(
    ...args: Parameters<PoolOps["getRefreshedInventory"]>
  ): ReturnType<PoolOps["getRefreshedInventory"]> {
    return this.parts.assignment.getRefreshedInventory(...args);
  }

  getDeviceHealthMarker(
    ...args: Parameters<PoolOps["getDeviceHealthMarker"]>
  ): ReturnType<PoolOps["getDeviceHealthMarker"]> {
    return this.parts.allocationHealth.getDeviceHealthMarker(...args);
  }

  assertDeviceCleanupComplete(
    ...args: Parameters<PoolOps["assertDeviceCleanupComplete"]>
  ): ReturnType<PoolOps["assertDeviceCleanupComplete"]> {
    return this.parts.allocationHealth.assertDeviceCleanupComplete(...args);
  }

  releaseDevice(
    ...args: Parameters<PoolOps["releaseDevice"]>
  ): ReturnType<PoolOps["releaseDevice"]> {
    return this.parts.release.releaseDevice(...args);
  }

  retireDeviceForShutdown(
    ...args: Parameters<PoolOps["retireDeviceForShutdown"]>
  ): ReturnType<PoolOps["retireDeviceForShutdown"]> {
    return this.parts.replacement.retireDeviceForShutdown(...args);
  }

  retireDeviceAfterSystemUiAnrRecoveryFailure(
    ...args: Parameters<PoolOps["retireDeviceAfterSystemUiAnrRecoveryFailure"]>
  ): ReturnType<PoolOps["retireDeviceAfterSystemUiAnrRecoveryFailure"]> {
    return this.parts.replacement.retireDeviceAfterSystemUiAnrRecoveryFailure(...args);
  }

  replaceDeviceForShutdown(
    ...args: Parameters<PoolOps["replaceDeviceForShutdown"]>
  ): ReturnType<PoolOps["replaceDeviceForShutdown"]> {
    return this.parts.replacement.replaceDeviceForShutdown(...args);
  }

  replaceDeviceForSystemUiAnrRecovery(
    ...args: Parameters<PoolOps["replaceDeviceForSystemUiAnrRecovery"]>
  ): ReturnType<PoolOps["replaceDeviceForSystemUiAnrRecovery"]> {
    return this.parts.replacement.replaceDeviceForSystemUiAnrRecovery(...args);
  }

  private cancelOldDeviceWorkForSystemUiAnr(
    ...args: Parameters<PoolOps["cancelOldDeviceWorkForSystemUiAnr"]>
  ): ReturnType<PoolOps["cancelOldDeviceWorkForSystemUiAnr"]> {
    return this.parts.replacement.cancelOldDeviceWorkForSystemUiAnr(...args);
  }

  reserveDeviceForReadiness(
    ...args: Parameters<PoolOps["reserveDeviceForReadiness"]>
  ): ReturnType<PoolOps["reserveDeviceForReadiness"]> {
    return this.parts.reservations.reserveDeviceForReadiness(...args);
  }

  reserveRestartRecoveryReadiness(
    ...args: Parameters<PoolOps["reserveRestartRecoveryReadiness"]>
  ): ReturnType<PoolOps["reserveRestartRecoveryReadiness"]> {
    return this.parts.reservations.reserveRestartRecoveryReadiness(...args);
  }

  clearUnpooledShutdown(deviceId: string): void {
    this.parts.reservations.clearUnpooledShutdown(deviceId);
  }

  settleUnpooledShutdown(deviceId: string): void {
    this.parts.reservations.settleUnpooledShutdown(deviceId);
  }

  reserveDeviceForShutdown(
    ...args: Parameters<PoolOps["reserveDeviceForShutdown"]>
  ): ReturnType<PoolOps["reserveDeviceForShutdown"]> {
    return this.parts.reservations.reserveDeviceForShutdown(...args);
  }

  isUnderShutdownReservation(
    ...args: Parameters<PoolOps["isUnderShutdownReservation"]>
  ): ReturnType<PoolOps["isUnderShutdownReservation"]> {
    return this.parts.reservations.isUnderShutdownReservation(...args);
  }

  isReservedForReadiness(
    ...args: Parameters<PoolOps["isReservedForReadiness"]>
  ): ReturnType<PoolOps["isReservedForReadiness"]> {
    return this.parts.reservations.isReservedForReadiness(...args);
  }

  assertNotPreparedForOtherRequest(
    ...args: Parameters<PoolOps["assertNotPreparedForOtherRequest"]>
  ): ReturnType<PoolOps["assertNotPreparedForOtherRequest"]> {
    return this.parts.reservations.assertNotPreparedForOtherRequest(...args);
  }

  isSafeForObservationServiceStart(
    ...args: Parameters<PoolOps["isSafeForObservationServiceStart"]>
  ): ReturnType<PoolOps["isSafeForObservationServiceStart"]> {
    return this.parts.availability.isSafeForObservationServiceStart(...args);
  }

  reserveDevicesForRehydration(
    ...args: Parameters<PoolOps["reserveDevicesForRehydration"]>
  ): ReturnType<PoolOps["reserveDevicesForRehydration"]> {
    return this.parts.availability.reserveDevicesForRehydration(...args);
  }

  private notifyRehydrationReservationChanged(
    ...args: Parameters<PoolOps["notifyRehydrationReservationChanged"]>
  ): ReturnType<PoolOps["notifyRehydrationReservationChanged"]> {
    return this.parts.availability.notifyRehydrationReservationChanged(...args);
  }

  releaseRehydrationReservation(
    ...args: Parameters<PoolOps["releaseRehydrationReservation"]>
  ): ReturnType<PoolOps["releaseRehydrationReservation"]> {
    return this.parts.availability.releaseRehydrationReservation(...args);
  }

  restartReservationForStart(
    ...args: Parameters<PoolOps["restartReservationForStart"]>
  ): ReturnType<PoolOps["restartReservationForStart"]> {
    return this.parts.availability.restartReservationForStart(...args);
  }

  restartReservationExclusions(
    ...args: Parameters<PoolOps["restartReservationExclusions"]>
  ): ReturnType<PoolOps["restartReservationExclusions"]> {
    return this.parts.availability.restartReservationExclusions(...args);
  }

  isRestartReservationOwnedByOtherConnection(
    ...args: Parameters<PoolOps["isRestartReservationOwnedByOtherConnection"]>
  ): ReturnType<PoolOps["isRestartReservationOwnedByOtherConnection"]> {
    return this.parts.availability.isRestartReservationOwnedByOtherConnection(...args);
  }

  bindOrReuseDeviceSession(
    ...args: Parameters<PoolOps["bindOrReuseDeviceSession"]>
  ): ReturnType<PoolOps["bindOrReuseDeviceSession"]> {
    return this.parts.targetDiscovery.bindOrReuseDeviceSession(...args);
  }

  releaseUndeliveredAcquisition(
    ...args: Parameters<PoolOps["releaseUndeliveredAcquisition"]>
  ): ReturnType<PoolOps["releaseUndeliveredAcquisition"]> {
    return this.parts.targetDiscovery.releaseUndeliveredAcquisition(...args);
  }

  holderReleaseRemainingMs(
    ...args: Parameters<PoolOps["holderReleaseRemainingMs"]>
  ): ReturnType<PoolOps["holderReleaseRemainingMs"]> {
    return this.parts.targetDiscovery.holderReleaseRemainingMs(...args);
  }

  beginMcpBind(...args: Parameters<PoolOps["beginMcpBind"]>): ReturnType<PoolOps["beginMcpBind"]> {
    return this.parts.connectionClaims.beginMcpBind(...args);
  }

  beginMcpToolCall(
    ...args: Parameters<PoolOps["beginMcpToolCall"]>
  ): ReturnType<PoolOps["beginMcpToolCall"]> {
    return this.parts.connectionClaims.beginMcpToolCall(...args);
  }

  declareMcpSessionLivenessOwnerToken(
    ...args: Parameters<PoolOps["declareMcpSessionLivenessOwnerToken"]>
  ): ReturnType<PoolOps["declareMcpSessionLivenessOwnerToken"]> {
    return this.parts.connectionClaims.declareMcpSessionLivenessOwnerToken(...args);
  }

  beginMcpSessionOwnerCall(
    ...args: Parameters<PoolOps["beginMcpSessionOwnerCall"]>
  ): ReturnType<PoolOps["beginMcpSessionOwnerCall"]> {
    return this.parts.connectionClaims.beginMcpSessionOwnerCall(...args);
  }

  settlePooledRuntimeIdentity(
    ...args: Parameters<PoolOps["settlePooledRuntimeIdentity"]>
  ): ReturnType<PoolOps["settlePooledRuntimeIdentity"]> {
    return this.parts.discovery.settlePooledRuntimeIdentity(...args);
  }

  reconcileDiscoveryObservation(
    ...args: Parameters<PoolOps["reconcileDiscoveryObservation"]>
  ): ReturnType<PoolOps["reconcileDiscoveryObservation"]> {
    return this.parts.discovery.reconcileDiscoveryObservation(...args);
  }

  getAndroidTransportRouting(
    ...args: Parameters<PoolOps["getAndroidTransportRouting"]>
  ): ReturnType<PoolOps["getAndroidTransportRouting"]> {
    return this.parts.discovery.getAndroidTransportRouting(...args);
  }

  getAndroidTransportAliases(
    ...args: Parameters<PoolOps["getAndroidTransportAliases"]>
  ): ReturnType<PoolOps["getAndroidTransportAliases"]> {
    return this.parts.discovery.getAndroidTransportAliases(...args);
  }

  getAndroidTransportAvdName(
    ...args: Parameters<PoolOps["getAndroidTransportAvdName"]>
  ): ReturnType<PoolOps["getAndroidTransportAvdName"]> {
    return this.parts.discovery.getAndroidTransportAvdName(...args);
  }

  mapAndroidDiscovery(
    ...args: Parameters<PoolOps["mapAndroidDiscovery"]>
  ): ReturnType<PoolOps["mapAndroidDiscovery"]> {
    return this.parts.discovery.mapAndroidDiscovery(...args);
  }

  mapAndroidReadinessDiscovery(
    ...args: Parameters<PoolOps["mapAndroidReadinessDiscovery"]>
  ): ReturnType<PoolOps["mapAndroidReadinessDiscovery"]> {
    return this.parts.discovery.mapAndroidReadinessDiscovery(...args);
  }

  resolveAndroidCanonicalId(
    ...args: Parameters<PoolOps["resolveAndroidCanonicalId"]>
  ): ReturnType<PoolOps["resolveAndroidCanonicalId"]> {
    return this.parts.discovery.resolveAndroidCanonicalId(...args);
  }

  isAndroidTransportAssignable(
    ...args: Parameters<PoolOps["isAndroidTransportAssignable"]>
  ): ReturnType<PoolOps["isAndroidTransportAssignable"]> {
    return this.parts.discovery.isAndroidTransportAssignable(...args);
  }

  androidTransportMayAliasDevice(
    ...args: Parameters<PoolOps["androidTransportMayAliasDevice"]>
  ): ReturnType<PoolOps["androidTransportMayAliasDevice"]> {
    return this.parts.discovery.androidTransportMayAliasDevice(...args);
  }

  androidBindingHold(
    ...args: Parameters<PoolOps["androidBindingHold"]>
  ): ReturnType<PoolOps["androidBindingHold"]> {
    return this.parts.discovery.androidBindingHold(...args);
  }

  needsAndroidTransportNormalization(
    ...args: Parameters<PoolOps["needsAndroidTransportNormalization"]>
  ): ReturnType<PoolOps["needsAndroidTransportNormalization"]> {
    return this.parts.discovery.needsAndroidTransportNormalization(...args);
  }

  normalizeAndroidDiscovery(
    ...args: Parameters<PoolOps["normalizeAndroidDiscovery"]>
  ): ReturnType<PoolOps["normalizeAndroidDiscovery"]> {
    return this.parts.discovery.normalizeAndroidDiscovery(...args);
  }

  describesPooledRuntime(
    ...args: Parameters<PoolOps["describesPooledRuntime"]>
  ): ReturnType<PoolOps["describesPooledRuntime"]> {
    return this.parts.discovery.describesPooledRuntime(...args);
  }

  matchesRuntimeIdentity(
    ...args: Parameters<PoolOps["matchesRuntimeIdentity"]>
  ): ReturnType<PoolOps["matchesRuntimeIdentity"]> {
    return this.parts.discovery.matchesRuntimeIdentity(...args);
  }

  isPooledIdentityUnresolved(
    ...args: Parameters<PoolOps["isPooledIdentityUnresolved"]>
  ): ReturnType<PoolOps["isPooledIdentityUnresolved"]> {
    return this.parts.discovery.isPooledIdentityUnresolved(...args);
  }

  assertDeviceActionable(
    ...args: Parameters<PoolOps["assertDeviceActionable"]>
  ): ReturnType<PoolOps["assertDeviceActionable"]> {
    return this.parts.discovery.assertDeviceActionable(...args);
  }

  autolockDevice(
    ...args: Parameters<PoolOps["autolockDevice"]>
  ): ReturnType<PoolOps["autolockDevice"]> {
    return this.parts.connectionSessions.autolockDevice(...args);
  }

  captureAutolockSessionForMcpSession(
    ...args: Parameters<PoolOps["captureAutolockSessionForMcpSession"]>
  ): ReturnType<PoolOps["captureAutolockSessionForMcpSession"]> {
    return this.parts.connectionSessions.captureAutolockSessionForMcpSession(...args);
  }

  adoptResumedAutolockSession(
    ...args: Parameters<PoolOps["adoptResumedAutolockSession"]>
  ): ReturnType<PoolOps["adoptResumedAutolockSession"]> {
    return this.parts.connectionSessions.adoptResumedAutolockSession(...args);
  }

  resolveAutolockSessionForMcpSession(
    ...args: Parameters<PoolOps["resolveAutolockSessionForMcpSession"]>
  ): ReturnType<PoolOps["resolveAutolockSessionForMcpSession"]> {
    return this.parts.connectionSessions.resolveAutolockSessionForMcpSession(...args);
  }

  resolveOwnedDeviceSessionForMcpSession(
    ...args: Parameters<PoolOps["resolveOwnedDeviceSessionForMcpSession"]>
  ): ReturnType<PoolOps["resolveOwnedDeviceSessionForMcpSession"]> {
    return this.parts.connectionSessions.resolveOwnedDeviceSessionForMcpSession(...args);
  }

  restoreAutolockSessionsForMcpSession(
    ...args: Parameters<PoolOps["restoreAutolockSessionsForMcpSession"]>
  ): ReturnType<PoolOps["restoreAutolockSessionsForMcpSession"]> {
    return this.parts.connectionSessions.restoreAutolockSessionsForMcpSession(...args);
  }

  attachExplicitSessionUuidCall(
    ...args: Parameters<PoolOps["attachExplicitSessionUuidCall"]>
  ): ReturnType<PoolOps["attachExplicitSessionUuidCall"]> {
    return this.parts.connectionSessions.attachExplicitSessionUuidCall(...args);
  }

  attachAutolockSessionToMcpSession(
    ...args: Parameters<PoolOps["attachAutolockSessionToMcpSession"]>
  ): ReturnType<PoolOps["attachAutolockSessionToMcpSession"]> {
    return this.parts.connectionSessions.attachAutolockSessionToMcpSession(...args);
  }

  assertAutolockAccess(
    ...args: Parameters<PoolOps["assertAutolockAccess"]>
  ): ReturnType<PoolOps["assertAutolockAccess"]> {
    return this.parts.connectionSessions.assertAutolockAccess(...args);
  }

  restoreOwnedDeviceSessionsForMcpSession(
    ...args: Parameters<PoolOps["restoreOwnedDeviceSessionsForMcpSession"]>
  ): ReturnType<PoolOps["restoreOwnedDeviceSessionsForMcpSession"]> {
    return this.parts.connectionSessions.restoreOwnedDeviceSessionsForMcpSession(...args);
  }

  sessionExecutionsEnded(
    ...args: Parameters<PoolOps["sessionExecutionsEnded"]>
  ): ReturnType<PoolOps["sessionExecutionsEnded"]> {
    return this.parts.connectionSessions.sessionExecutionsEnded(...args);
  }

  releaseMcpSessionBindings(
    ...args: Parameters<PoolOps["releaseMcpSessionBindings"]>
  ): ReturnType<PoolOps["releaseMcpSessionBindings"]> {
    return this.parts.connectionSessions.releaseMcpSessionBindings(...args);
  }

  isSessionOwnedByOtherConnection(
    ...args: Parameters<PoolOps["isSessionOwnedByOtherConnection"]>
  ): ReturnType<PoolOps["isSessionOwnedByOtherConnection"]> {
    return this.parts.connectionSessions.isSessionOwnedByOtherConnection(...args);
  }

  isSessionOwnedByConnection(
    ...args: Parameters<PoolOps["isSessionOwnedByConnection"]>
  ): ReturnType<PoolOps["isSessionOwnedByConnection"]> {
    return this.parts.connectionSessions.isSessionOwnedByConnection(...args);
  }

  protected hasConnectedMcpSessionOwner(
    ...args: Parameters<PoolOps["hasConnectedMcpSessionOwner"]>
  ): ReturnType<PoolOps["hasConnectedMcpSessionOwner"]> {
    return this.parts.connectionSessions.hasConnectedMcpSessionOwner(...args);
  }

  recordDeviceError(
    ...args: Parameters<PoolOps["recordDeviceError"]>
  ): ReturnType<PoolOps["recordDeviceError"]> {
    return this.parts.status.recordDeviceError(...args);
  }

  clearDeviceError(
    ...args: Parameters<PoolOps["clearDeviceError"]>
  ): ReturnType<PoolOps["clearDeviceError"]> {
    return this.parts.status.clearDeviceError(...args);
  }

  getDevice(...args: Parameters<PoolOps["getDevice"]>): ReturnType<PoolOps["getDevice"]> {
    return this.parts.status.getDevice(...args);
  }

  getDeviceIncarnation(
    ...args: Parameters<PoolOps["getDeviceIncarnation"]>
  ): ReturnType<PoolOps["getDeviceIncarnation"]> {
    return this.parts.status.getDeviceIncarnation(...args);
  }

  bumpDeviceIncarnation(
    ...args: Parameters<PoolOps["bumpDeviceIncarnation"]>
  ): ReturnType<PoolOps["bumpDeviceIncarnation"]> {
    return this.parts.status.bumpDeviceIncarnation(...args);
  }

  getDeviceForSession(
    ...args: Parameters<PoolOps["getDeviceForSession"]>
  ): ReturnType<PoolOps["getDeviceForSession"]> {
    return this.parts.status.getDeviceForSession(...args);
  }

  bindingOwnershipGate(
    ...args: Parameters<PoolOps["bindingOwnershipGate"]>
  ): ReturnType<PoolOps["bindingOwnershipGate"]> {
    return this.parts.status.bindingOwnershipGate(...args);
  }

  assertSessionReadyForAutomation(
    ...args: Parameters<PoolOps["assertSessionReadyForAutomation"]>
  ): ReturnType<PoolOps["assertSessionReadyForAutomation"]> {
    return this.parts.status.assertSessionReadyForAutomation(...args);
  }

  isShutdownReserved(
    ...args: Parameters<PoolOps["isShutdownReserved"]>
  ): ReturnType<PoolOps["isShutdownReserved"]> {
    return this.parts.status.isShutdownReserved(...args);
  }

  isShutdownReservationHeld(
    ...args: Parameters<PoolOps["isShutdownReservationHeld"]>
  ): ReturnType<PoolOps["isShutdownReservationHeld"]> {
    return this.parts.status.isShutdownReservationHeld(...args);
  }

  getIdleDevices(
    ...args: Parameters<PoolOps["getIdleDevices"]>
  ): ReturnType<PoolOps["getIdleDevices"]> {
    return this.parts.status.getIdleDevices(...args);
  }

  getAssignedDevices(
    ...args: Parameters<PoolOps["getAssignedDevices"]>
  ): ReturnType<PoolOps["getAssignedDevices"]> {
    return this.parts.status.getAssignedDevices(...args);
  }

  getErrorDevices(
    ...args: Parameters<PoolOps["getErrorDevices"]>
  ): ReturnType<PoolOps["getErrorDevices"]> {
    return this.parts.status.getErrorDevices(...args);
  }

  getAvailableDeviceCount(
    ...args: Parameters<PoolOps["getAvailableDeviceCount"]>
  ): ReturnType<PoolOps["getAvailableDeviceCount"]> {
    return this.parts.status.getAvailableDeviceCount(...args);
  }

  getTotalDeviceCount(
    ...args: Parameters<PoolOps["getTotalDeviceCount"]>
  ): ReturnType<PoolOps["getTotalDeviceCount"]> {
    return this.parts.status.getTotalDeviceCount(...args);
  }

  getAllDevices(
    ...args: Parameters<PoolOps["getAllDevices"]>
  ): ReturnType<PoolOps["getAllDevices"]> {
    return this.parts.status.getAllDevices(...args);
  }

  getRecoveryPolicy(
    ...args: Parameters<PoolOps["getRecoveryPolicy"]>
  ): ReturnType<PoolOps["getRecoveryPolicy"]> {
    return this.parts.status.getRecoveryPolicy(...args);
  }

  getRecoveryEligibility(
    ...args: Parameters<PoolOps["getRecoveryEligibility"]>
  ): ReturnType<PoolOps["getRecoveryEligibility"]> {
    return this.parts.status.getRecoveryEligibility(...args);
  }

  genericAvailability(
    ...args: Parameters<PoolOps["genericAvailability"]>
  ): ReturnType<PoolOps["genericAvailability"]> {
    return this.parts.status.genericAvailability(...args);
  }

  bindingRefusalFor(
    ...args: Parameters<PoolOps["bindingRefusalFor"]>
  ): ReturnType<PoolOps["bindingRefusalFor"]> {
    return this.parts.binding.bindingRefusalFor(...args);
  }

  bindingSnapshotRetainedAfterFailedRead(
    ...args: Parameters<PoolOps["bindingSnapshotRetainedAfterFailedRead"]>
  ): ReturnType<PoolOps["bindingSnapshotRetainedAfterFailedRead"]> {
    return this.parts.binding.bindingSnapshotRetainedAfterFailedRead(...args);
  }

  assertNotAssignedToBinding(
    ...args: Parameters<PoolOps["assertNotAssignedToBinding"]>
  ): ReturnType<PoolOps["assertNotAssignedToBinding"]> {
    return this.parts.binding.assertNotAssignedToBinding(...args);
  }

  bindingStableIds(
    ...args: Parameters<PoolOps["bindingStableIds"]>
  ): ReturnType<PoolOps["bindingStableIds"]> {
    return this.parts.binding.bindingStableIds(...args);
  }

  matchesRestartRecoveryTarget(
    ...args: Parameters<PoolOps["matchesRestartRecoveryTarget"]>
  ): ReturnType<PoolOps["matchesRestartRecoveryTarget"]> {
    return this.parts.recoveryEvidence.matchesRestartRecoveryTarget(...args);
  }

  poolBucket(...args: Parameters<PoolOps["poolBucket"]>): ReturnType<PoolOps["poolBucket"]> {
    return this.parts.reporting.poolBucket(...args);
  }

  getStatsForPlatform(
    ...args: Parameters<PoolOps["getStatsForPlatform"]>
  ): ReturnType<PoolOps["getStatsForPlatform"]> {
    return this.parts.reporting.getStatsForPlatform(...args);
  }

  getStats(...args: Parameters<PoolOps["getStats"]>): ReturnType<PoolOps["getStats"]> {
    return this.parts.reporting.getStats(...args);
  }

  getStatusReport(
    ...args: Parameters<PoolOps["getStatusReport"]>
  ): ReturnType<PoolOps["getStatusReport"]> {
    return this.parts.reporting.getStatusReport(...args);
  }

  private setDeviceSessionTracking(
    ...args: Parameters<PoolOps["setDeviceSessionTracking"]>
  ): ReturnType<PoolOps["setDeviceSessionTracking"]> {
    return this.parts.reporting.setDeviceSessionTracking(...args);
  }

  private clearDeviceSessionCache(
    ...args: Parameters<PoolOps["clearDeviceSessionCache"]>
  ): ReturnType<PoolOps["clearDeviceSessionCache"]> {
    return this.parts.reporting.clearDeviceSessionCache(...args);
  }
  get testHooks() {
    return this.parts.testing.testHooks;
  }
}
