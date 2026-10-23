import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";
import { DevicePoolInitialization, connectInitialization } from "./initialization";
import { DevicePoolAllocationWiring, connectAllocationWiring } from "./allocationWiring";
import { DevicePoolLifecycleWiring, connectLifecycleWiring } from "./lifecycleWiring";
import { DevicePoolRecoveryWiring, connectRecoveryWiring } from "./recoveryWiring";
import { DevicePoolMembership, connectMembership } from "./membership";
import { DevicePoolRestartStops, connectRestartStops } from "./restartStops";
import { DevicePoolMultiAllocation, connectMultiAllocation } from "./multiAllocation";
import { DevicePoolStartup, connectStartup } from "./startup";
import { DevicePoolPresence, connectPresence } from "./presence";
import { DevicePoolSessionRecovery, connectSessionRecovery } from "./sessionRecovery";
import { DevicePoolAndroidRecovery, connectAndroidRecovery } from "./androidRecovery";
import { DevicePoolEmulatorLifecycle, connectEmulatorLifecycle } from "./emulatorLifecycle";
import { DevicePoolAssignment, connectAssignment } from "./assignment";
import { DevicePoolAllocationHealth, connectAllocationHealth } from "./allocationHealth";
import { DevicePoolRelease, connectRelease } from "./release";
import { DevicePoolReplacement, connectReplacement } from "./replacement";
import { DevicePoolReservations, connectReservations } from "./reservations";
import { DevicePoolAvailability, connectAvailability } from "./availability";
import { DevicePoolTargetDiscovery, connectTargetDiscovery } from "./targetDiscovery";
import { DevicePoolConnectionClaims, connectConnectionClaims } from "./connectionClaims";
import { DevicePoolDiscovery, connectDiscovery } from "./discovery";
import { DevicePoolConnectionSessions, connectConnectionSessions } from "./connectionSessions";
import { DevicePoolStatus, connectStatus } from "./status";
import { DevicePoolBinding, connectBinding } from "./binding";
import { DevicePoolRecoveryEvidence, connectRecoveryEvidence } from "./recoveryEvidence";
import { DevicePoolReporting, connectReporting } from "./reporting";
import { DevicePoolTesting } from "./testing";

export type DevicePoolSeams = Pick<
  DevicePoolOperations,
  | "setDeviceProcessStartedListener"
  | "initializeWithDevices"
  | "refreshDevices"
  | "refreshDevicesWithOutcome"
  | "getDeviceRemovalStampCountForTest"
  | "notifyDeviceReady"
  | "addDevice"
  | "removeDevice"
  | "clearAndroidRebootBudgetForDeletedAvd"
  | "removeDisconnectedDevice"
  | "recordEmulatorLossIncident"
  | "waitForEmulatorLossIncident"
  | "finishEmulatorLossIncident"
  | "isCurrentDisconnectedDevice"
  | "markIntentionalShutdown"
  | "fenceUnpooledShutdown"
  | "releaseDeviceRestartReservationForStop"
  | "hasRestartHandoffReservation"
  | "restartStopConfirmedPooledIdentity"
  | "hasUnconfirmedRestartStopReservation"
  | "restartReservationForStop"
  | "restartStopConnectionHasLiveSession"
  | "clearIntentionalShutdown"
  | "noteLatePlatformShutdownSettled"
  | "assignMultipleDevices"
  | "assignMultipleDevicesByCriteria"
  | "hasReusableSerial"
  | "evictMissingPooledDevice"
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
  | "trackStartedDeviceProcess"
  | "hasStartedDeviceProcess"
  | "assignDeviceToSession"
  | "assertNotClaimedByForeignDaemon"
  | "releaseDeviceClaimsForShutdown"
  | "refreshInventoryOwnership"
  | "getRefreshedStats"
  | "getRefreshedInventory"
  | "getDeviceHealthMarker"
  | "assertDeviceCleanupComplete"
  | "releaseDevice"
  | "retireDeviceForShutdown"
  | "retireDeviceAfterSystemUiAnrRecoveryFailure"
  | "replaceDeviceForShutdown"
  | "replaceDeviceForSystemUiAnrRecovery"
  | "reserveDeviceForReadiness"
  | "reserveRestartRecoveryReadiness"
  | "reserveDeviceForShutdown"
  | "isUnderShutdownReservation"
  | "isReservedForReadiness"
  | "assertNotPreparedForOtherRequest"
  | "isSafeForObservationServiceStart"
  | "reserveDevicesForRehydration"
  | "releaseRehydrationReservation"
  | "restartReservationForStart"
  | "restartReservationExclusions"
  | "isRestartReservationOwnedByOtherConnection"
  | "bindOrReuseDeviceSession"
  | "releaseUndeliveredAcquisition"
  | "holderReleaseRemainingMs"
  | "beginMcpBind"
  | "beginMcpToolCall"
  | "declareMcpSessionLivenessOwnerToken"
  | "beginMcpSessionOwnerCall"
  | "settlePooledRuntimeIdentity"
  | "reconcileDiscoveryObservation"
  | "getAndroidTransportRouting"
  | "getAndroidTransportAliases"
  | "getAndroidTransportAvdName"
  | "mapAndroidDiscovery"
  | "mapAndroidReadinessDiscovery"
  | "resolveAndroidCanonicalId"
  | "isAndroidTransportAssignable"
  | "androidTransportMayAliasDevice"
  | "androidBindingHold"
  | "needsAndroidTransportNormalization"
  | "normalizeAndroidDiscovery"
  | "describesPooledRuntime"
  | "matchesRuntimeIdentity"
  | "isPooledIdentityUnresolved"
  | "assertDeviceActionable"
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
  | "hasConnectedMcpSessionOwner"
  | "recordDeviceError"
  | "clearDeviceError"
  | "getDevice"
  | "getDeviceIncarnation"
  | "bumpDeviceIncarnation"
  | "getDeviceForSession"
  | "bindingOwnershipGate"
  | "assertSessionReadyForAutomation"
  | "isShutdownReserved"
  | "isShutdownReservationHeld"
  | "getIdleDevices"
  | "getAssignedDevices"
  | "getErrorDevices"
  | "getAvailableDeviceCount"
  | "getTotalDeviceCount"
  | "getAllDevices"
  | "getRecoveryPolicy"
  | "getRecoveryEligibility"
  | "genericAvailability"
  | "bindingRefusalFor"
  | "bindingSnapshotRetainedAfterFailedRead"
  | "assertNotAssignedToBinding"
  | "bindingStableIds"
  | "matchesRestartRecoveryTarget"
  | "poolBucket"
  | "getStatsForPlatform"
  | "getStats"
  | "getStatusReport"
  | "cancelOldDeviceWorkForSystemUiAnr"
  | "notifyRehydrationReservationChanged"
  | "completeEmulatorLossRecovery"
  | "clearDeviceSessionCache"
  | "replacePooledDeviceForRuntimeIdentity"
  | "setDeviceSessionTracking"
  | "releaseDeviceClaim"
  | "tryPreserveSessionForMissingDevice"
>;
export type DevicePoolOverrides = {
  [
    K in
      | "cancelOldDeviceWorkForSystemUiAnr"
      | "notifyRehydrationReservationChanged"
      | "completeEmulatorLossRecovery"
      | "clearDeviceSessionCache"
      | "replacePooledDeviceForRuntimeIdentity"
      | "setDeviceSessionTracking"
      | "releaseDeviceClaim"
      | "tryPreserveSessionForMissingDevice"
      | "trackStartedDeviceProcess"
      | "addDevice"
      | "evictMissingPooledDevice"
  ]: { current(): DevicePoolOperations[K]; install(replacement: DevicePoolOperations[K]): void };
};
export function createDevicePoolParts(
  state: DevicePoolState,
  seams: DevicePoolSeams,
  overrides: DevicePoolOverrides,
) {
  const callbacks: DevicePoolOperations = {
    ...connectInitialization(() => initialization, seams),
    ...connectAllocationWiring(() => allocationWiring, seams),
    ...connectLifecycleWiring(() => lifecycleWiring, seams),
    ...connectRecoveryWiring(() => recoveryWiring, seams),
    ...connectMembership(() => membership, seams),
    ...connectRestartStops(() => restartStops, seams),
    ...connectMultiAllocation(() => multiAllocation, seams),
    ...connectStartup(() => startup, seams),
    ...connectPresence(() => presence, seams),
    ...connectSessionRecovery(() => sessionRecovery, seams),
    ...connectAndroidRecovery(() => androidRecovery, seams),
    ...connectEmulatorLifecycle(() => emulatorLifecycle, seams),
    ...connectAssignment(() => assignment, seams),
    ...connectAllocationHealth(() => allocationHealth, seams),
    ...connectRelease(() => release, seams),
    ...connectReplacement(() => replacement, seams),
    ...connectReservations(() => reservations, seams),
    ...connectAvailability(() => availability, seams),
    ...connectTargetDiscovery(() => targetDiscovery, seams),
    ...connectConnectionClaims(() => connectionClaims, seams),
    ...connectDiscovery(() => discovery, seams),
    ...connectConnectionSessions(() => connectionSessions, seams),
    ...connectStatus(() => status, seams),
    ...connectBinding(() => binding, seams),
    ...connectRecoveryEvidence(() => recoveryEvidence, seams),
    ...connectReporting(() => reporting, seams),
  };
  const initialization = new DevicePoolInitialization(state, callbacks);
  const allocationWiring = new DevicePoolAllocationWiring(state, callbacks);
  const lifecycleWiring = new DevicePoolLifecycleWiring(state, callbacks);
  const recoveryWiring = new DevicePoolRecoveryWiring(state, callbacks);
  const membership = new DevicePoolMembership(state, callbacks);
  const restartStops = new DevicePoolRestartStops(state, callbacks);
  const multiAllocation = new DevicePoolMultiAllocation(state, callbacks);
  const startup = new DevicePoolStartup(state, callbacks);
  const presence = new DevicePoolPresence(state, callbacks);
  const sessionRecovery = new DevicePoolSessionRecovery(state, callbacks);
  const androidRecovery = new DevicePoolAndroidRecovery(state, callbacks);
  const emulatorLifecycle = new DevicePoolEmulatorLifecycle(state, callbacks);
  const assignment = new DevicePoolAssignment(state, callbacks);
  const allocationHealth = new DevicePoolAllocationHealth(state, callbacks);
  const release = new DevicePoolRelease(state, callbacks);
  const replacement = new DevicePoolReplacement(state, callbacks);
  const reservations = new DevicePoolReservations(state, callbacks);
  const availability = new DevicePoolAvailability(state, callbacks);
  const targetDiscovery = new DevicePoolTargetDiscovery(state, callbacks);
  const connectionClaims = new DevicePoolConnectionClaims(state, callbacks);
  const discovery = new DevicePoolDiscovery(state, callbacks);
  const connectionSessions = new DevicePoolConnectionSessions(state, callbacks);
  const status = new DevicePoolStatus(state, callbacks);
  const binding = new DevicePoolBinding(state, callbacks);
  const recoveryEvidence = new DevicePoolRecoveryEvidence(state, callbacks);
  const reporting = new DevicePoolReporting(state, callbacks);
  const testing = new DevicePoolTesting(state, callbacks, overrides);
  return {
    initialization,
    allocationWiring,
    lifecycleWiring,
    recoveryWiring,
    membership,
    restartStops,
    multiAllocation,
    startup,
    presence,
    sessionRecovery,
    androidRecovery,
    emulatorLifecycle,
    assignment,
    allocationHealth,
    release,
    replacement,
    reservations,
    availability,
    targetDiscovery,
    connectionClaims,
    discovery,
    connectionSessions,
    status,
    binding,
    recoveryEvidence,
    reporting,
    testing,
  };
}
