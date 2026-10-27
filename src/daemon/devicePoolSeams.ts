import type { DevicePoolSeams } from "./devicePoolParts/createParts";

type PrivateSeams = Pick<
  DevicePoolSeams,
  | "replacePooledDeviceForRuntimeIdentity"
  | "completeEmulatorLossRecovery"
  | "tryPreserveSessionForMissingDevice"
  | "evictMissingPooledDevice"
  | "releaseDeviceClaim"
  | "cancelOldDeviceWorkForSystemUiAnr"
  | "notifyRehydrationReservationChanged"
  | "hasConnectedMcpSessionOwner"
  | "setDeviceSessionTracking"
  | "clearDeviceSessionCache"
>;

type PublicPool = Omit<DevicePoolSeams, keyof PrivateSeams>;

/** Forward public pool operations lazily so overrides remain visible to collaborators. */
export function createDevicePoolSeams(
  pool: PublicPool,
  privateSeams: PrivateSeams,
): DevicePoolSeams {
  return {
    ...privateSeams,
    setDeviceProcessStartedListener: (...args) => pool.setDeviceProcessStartedListener(...args),
    initializeWithDevices: (...args) => pool.initializeWithDevices(...args),
    refreshDevices: (...args) => pool.refreshDevices(...args),
    refreshDevicesWithOutcome: (...args) => pool.refreshDevicesWithOutcome(...args),
    getDeviceRemovalStampCountForTest: (...args) => pool.getDeviceRemovalStampCountForTest(...args),
    notifyDeviceReady: (...args) => pool.notifyDeviceReady(...args),
    addDevice: (...args) => pool.addDevice(...args),
    removeDevice: (...args) => pool.removeDevice(...args),
    clearAndroidRebootBudgetForDeletedAvd: (...args) =>
      pool.clearAndroidRebootBudgetForDeletedAvd(...args),
    removeDisconnectedDevice: (...args) => pool.removeDisconnectedDevice(...args),
    recordEmulatorLossIncident: (...args) => pool.recordEmulatorLossIncident(...args),
    waitForEmulatorLossIncident: (...args) => pool.waitForEmulatorLossIncident(...args),
    finishEmulatorLossIncident: (...args) => pool.finishEmulatorLossIncident(...args),
    isCurrentDisconnectedDevice: (...args) => pool.isCurrentDisconnectedDevice(...args),
    fenceUnpooledShutdown: (...args) => pool.fenceUnpooledShutdown(...args),
    markIntentionalShutdown: (...args) => pool.markIntentionalShutdown(...args),
    releaseDeviceRestartReservationForStop: (...args) =>
      pool.releaseDeviceRestartReservationForStop(...args),
    hasRestartHandoffReservation: (...args) => pool.hasRestartHandoffReservation(...args),
    restartStopConfirmedPooledIdentity: (...args) =>
      pool.restartStopConfirmedPooledIdentity(...args),
    hasUnconfirmedRestartStopReservation: (...args) =>
      pool.hasUnconfirmedRestartStopReservation(...args),
    restartReservationForStop: (...args) => pool.restartReservationForStop(...args),
    restartStopConnectionHasLiveSession: (...args) =>
      pool.restartStopConnectionHasLiveSession(...args),
    clearIntentionalShutdown: (...args) => pool.clearIntentionalShutdown(...args),
    noteLatePlatformShutdownSettled: (...args) => pool.noteLatePlatformShutdownSettled(...args),
    assignMultipleDevices: (...args) => pool.assignMultipleDevices(...args),
    assignMultipleDevicesByCriteria: (...args) => pool.assignMultipleDevicesByCriteria(...args),
    hasReusableSerial: (...args) => pool.hasReusableSerial(...args),
    prepareSessionPreservingRecovery: (...args) => pool.prepareSessionPreservingRecovery(...args),
    finishSessionPreservingRecoveryPreparation: (...args) =>
      pool.finishSessionPreservingRecoveryPreparation(...args),
    recoverSessionBoundAndroidDeviceAfterLoss: (...args) =>
      pool.recoverSessionBoundAndroidDeviceAfterLoss(...args),
    recoverSessionBoundDeviceAfterLoss: (...args) =>
      pool.recoverSessionBoundDeviceAfterLoss(...args),
    recoverSessionBoundIOSSimulatorAfterLoss: (...args) =>
      pool.recoverSessionBoundIOSSimulatorAfterLoss(...args),
    retryDueDeferredSessionRecoveries: (...args) => pool.retryDueDeferredSessionRecoveries(...args),
    waitForSessionPreservingRecovery: (...args) => pool.waitForSessionPreservingRecovery(...args),
    isSessionRecoveryInFlight: (...args) => pool.isSessionRecoveryInFlight(...args),
    recoverSessionBoundAndroidDeviceAfterAdbServerReset: (...args) =>
      pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(...args),
    detachAdbServerResetCohort: (...args) => pool.detachAdbServerResetCohort(...args),
    waitForAdbServerResetRecovery: (...args) => pool.waitForAdbServerResetRecovery(...args),
    getRecoveringAndroidTargets: (...args) => pool.getRecoveringAndroidTargets(...args),
    reserveAndroidStartupLease: (...args) => pool.reserveAndroidStartupLease(...args),
    waitForAdbServerResetRecoveryMatchingName: (...args) =>
      pool.waitForAdbServerResetRecoveryMatchingName(...args),
    releaseAdbServerResetCohortReservations: (...args) =>
      pool.releaseAdbServerResetCohortReservations(...args),
    isDeviceLeasedForAndroidStartup: (...args) => pool.isDeviceLeasedForAndroidStartup(...args),
    trackStartedDeviceProcess: (...args) => pool.trackStartedDeviceProcess(...args),
    hasStartedDeviceProcess: (...args) => pool.hasStartedDeviceProcess(...args),
    assignDeviceToSession: (...args) => pool.assignDeviceToSession(...args),
    assertNotClaimedByForeignDaemon: (...args) => pool.assertNotClaimedByForeignDaemon(...args),
    releaseDeviceClaimsForShutdown: (...args) => pool.releaseDeviceClaimsForShutdown(...args),
    refreshInventoryOwnership: (...args) => pool.refreshInventoryOwnership(...args),
    getRefreshedStats: (...args) => pool.getRefreshedStats(...args),
    getRefreshedInventory: (...args) => pool.getRefreshedInventory(...args),
    getDeviceHealthMarker: (...args) => pool.getDeviceHealthMarker(...args),
    assertDeviceCleanupComplete: (...args) => pool.assertDeviceCleanupComplete(...args),
    releaseDevice: (...args) => pool.releaseDevice(...args),
    retireDeviceForShutdown: (...args) => pool.retireDeviceForShutdown(...args),
    retireDeviceAfterSystemUiAnrRecoveryFailure: (...args) =>
      pool.retireDeviceAfterSystemUiAnrRecoveryFailure(...args),
    replaceDeviceForShutdown: (...args) => pool.replaceDeviceForShutdown(...args),
    replaceDeviceForSystemUiAnrRecovery: (...args) =>
      pool.replaceDeviceForSystemUiAnrRecovery(...args),
    reserveDeviceForReadiness: (...args) => pool.reserveDeviceForReadiness(...args),
    reserveRestartRecoveryReadiness: (...args) => pool.reserveRestartRecoveryReadiness(...args),
    reserveDeviceForShutdown: (...args) => pool.reserveDeviceForShutdown(...args),
    isUnderShutdownReservation: (...args) => pool.isUnderShutdownReservation(...args),
    isReservedForReadiness: (...args) => pool.isReservedForReadiness(...args),
    assertNotPreparedForOtherRequest: (...args) => pool.assertNotPreparedForOtherRequest(...args),
    waitForAssignmentTransition: (...args) => pool.waitForAssignmentTransition(...args),
    isSafeForObservationServiceStart: (...args) => pool.isSafeForObservationServiceStart(...args),
    reserveDevicesForRehydration: (...args) => pool.reserveDevicesForRehydration(...args),
    releaseRehydrationReservation: (...args) => pool.releaseRehydrationReservation(...args),
    restartReservationForStart: (...args) => pool.restartReservationForStart(...args),
    restartReservationExclusions: (...args) => pool.restartReservationExclusions(...args),
    isRestartReservationOwnedByOtherConnection: (...args) =>
      pool.isRestartReservationOwnedByOtherConnection(...args),
    bindOrReuseDeviceSession: (...args) => pool.bindOrReuseDeviceSession(...args),
    releaseUndeliveredAcquisition: (...args) => pool.releaseUndeliveredAcquisition(...args),
    holderReleaseRemainingMs: (...args) => pool.holderReleaseRemainingMs(...args),
    beginMcpBind: (...args) => pool.beginMcpBind(...args),
    beginMcpToolCall: (...args) => pool.beginMcpToolCall(...args),
    declareMcpSessionLivenessOwnerToken: (...args) =>
      pool.declareMcpSessionLivenessOwnerToken(...args),
    beginMcpSessionOwnerCall: (...args) => pool.beginMcpSessionOwnerCall(...args),
    settlePooledRuntimeIdentity: (...args) => pool.settlePooledRuntimeIdentity(...args),
    reconcileDiscoveryObservation: (...args) => pool.reconcileDiscoveryObservation(...args),
    getAndroidTransportRouting: (...args) => pool.getAndroidTransportRouting(...args),
    getAndroidTransportAliases: (...args) => pool.getAndroidTransportAliases(...args),
    getAndroidTransportAvdName: (...args) => pool.getAndroidTransportAvdName(...args),
    mapAndroidDiscovery: (...args) => pool.mapAndroidDiscovery(...args),
    mapAndroidReadinessDiscovery: (...args) => pool.mapAndroidReadinessDiscovery(...args),
    resolveAndroidCanonicalId: (...args) => pool.resolveAndroidCanonicalId(...args),
    isAndroidTransportAssignable: (...args) => pool.isAndroidTransportAssignable(...args),
    androidTransportMayAliasDevice: (...args) => pool.androidTransportMayAliasDevice(...args),
    androidBindingHold: (...args) => pool.androidBindingHold(...args),
    needsAndroidTransportNormalization: (...args) =>
      pool.needsAndroidTransportNormalization(...args),
    normalizeAndroidDiscovery: (...args) => pool.normalizeAndroidDiscovery(...args),
    describesPooledRuntime: (...args) => pool.describesPooledRuntime(...args),
    matchesRuntimeIdentity: (...args) => pool.matchesRuntimeIdentity(...args),
    isPooledIdentityUnresolved: (...args) => pool.isPooledIdentityUnresolved(...args),
    assertDeviceActionable: (...args) => pool.assertDeviceActionable(...args),
    ...createConnectionSessionSeams(pool),
    recordDeviceError: (...args) => pool.recordDeviceError(...args),
    clearDeviceError: (...args) => pool.clearDeviceError(...args),
    getDevice: (...args) => pool.getDevice(...args),
    getDeviceIncarnation: (...args) => pool.getDeviceIncarnation(...args),
    bumpDeviceIncarnation: (...args) => pool.bumpDeviceIncarnation(...args),
    getDeviceForSession: (...args) => pool.getDeviceForSession(...args),
    bindingOwnershipGate: (...args) => pool.bindingOwnershipGate(...args),
    assertSessionReadyForAutomation: (...args) => pool.assertSessionReadyForAutomation(...args),
    isShutdownReserved: (...args) => pool.isShutdownReserved(...args),
    isShutdownReservationHeld: (...args) => pool.isShutdownReservationHeld(...args),
    getIdleDevices: (...args) => pool.getIdleDevices(...args),
    getAssignedDevices: (...args) => pool.getAssignedDevices(...args),
    getErrorDevices: (...args) => pool.getErrorDevices(...args),
    getAvailableDeviceCount: (...args) => pool.getAvailableDeviceCount(...args),
    getTotalDeviceCount: (...args) => pool.getTotalDeviceCount(...args),
    getAllDevices: (...args) => pool.getAllDevices(...args),
    getRecoveryPolicy: (...args) => pool.getRecoveryPolicy(...args),
    getRecoveryEligibility: (...args) => pool.getRecoveryEligibility(...args),
    genericAvailability: (...args) => pool.genericAvailability(...args),
    bindingRefusalFor: (...args) => pool.bindingRefusalFor(...args),
    bindingSnapshotRetainedAfterFailedRead: (...args) =>
      pool.bindingSnapshotRetainedAfterFailedRead(...args),
    assertNotAssignedToBinding: (...args) => pool.assertNotAssignedToBinding(...args),
    bindingStableIds: (...args) => pool.bindingStableIds(...args),
    matchesRestartRecoveryTarget: (...args) => pool.matchesRestartRecoveryTarget(...args),
    poolBucket: (...args) => pool.poolBucket(...args),
    getStatsForPlatform: (...args) => pool.getStatsForPlatform(...args),
    getStats: (...args) => pool.getStats(...args),
    getStatusReport: (...args) => pool.getStatusReport(...args),
  };
}

/** Keep connection ownership and autolock forwarding together. */
function createConnectionSessionSeams(
  pool: PublicPool,
): Pick<
  DevicePoolSeams,
  | "autolockDevice"
  | "captureAutolockSessionForMcpSession"
  | "adoptResumedAutolockSession"
  | "resolveAutolockSessionForMcpSession"
  | "resolveOwnedDeviceSessionForMcpSession"
  | "restoreAutolockSessionsForMcpSession"
  | "attachExplicitSessionUuidCall"
  | "attachAutolockSessionToMcpSession"
  | "assertAutolockAccess"
  | "restoreOwnedDeviceSessionsForMcpSession"
  | "sessionExecutionsEnded"
  | "releaseMcpSessionBindings"
  | "isSessionOwnedByOtherConnection"
  | "isSessionOwnedByConnection"
> {
  return {
    autolockDevice: (...args) => pool.autolockDevice(...args),
    captureAutolockSessionForMcpSession: (...args) =>
      pool.captureAutolockSessionForMcpSession(...args),
    adoptResumedAutolockSession: (...args) => pool.adoptResumedAutolockSession(...args),
    resolveAutolockSessionForMcpSession: (...args) =>
      pool.resolveAutolockSessionForMcpSession(...args),
    resolveOwnedDeviceSessionForMcpSession: (...args) =>
      pool.resolveOwnedDeviceSessionForMcpSession(...args),
    restoreAutolockSessionsForMcpSession: (...args) =>
      pool.restoreAutolockSessionsForMcpSession(...args),
    attachExplicitSessionUuidCall: (...args) => pool.attachExplicitSessionUuidCall(...args),
    attachAutolockSessionToMcpSession: (...args) => pool.attachAutolockSessionToMcpSession(...args),
    assertAutolockAccess: (...args) => pool.assertAutolockAccess(...args),
    restoreOwnedDeviceSessionsForMcpSession: (...args) =>
      pool.restoreOwnedDeviceSessionsForMcpSession(...args),
    sessionExecutionsEnded: (...args) => pool.sessionExecutionsEnded(...args),
    releaseMcpSessionBindings: (...args) => pool.releaseMcpSessionBindings(...args),
    isSessionOwnedByOtherConnection: (...args) => pool.isSessionOwnedByOtherConnection(...args),
    isSessionOwnedByConnection: (...args) => pool.isSessionOwnedByConnection(...args),
  };
}
