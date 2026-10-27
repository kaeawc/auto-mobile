import { DeviceAllocation } from "../deviceAllocation";
import { ExplicitDeviceBind } from "../explicitDeviceBind";
import { DeviceReplacement } from "../deviceReplacement";
import { MultiDeviceAllocationQueue } from "../multiDeviceAllocation";
import { ForeignClaims } from "../foreignClaims";
import { ConnectionOwnership } from "../connectionOwnership";
import { DeviceAutoStart } from "../deviceAutoStart";
import { DeviceReservations } from "../deviceReservations";
import { waitForDeviceReadyOrCancel } from "../../devices/deviceUtils";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { getAbortSignal } from "../../utils/AbortContext";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface AllocationWiringOperations {
  createMultiDeviceAllocationQueue(): MultiDeviceAllocationQueue;
  createForeignClaims(): ForeignClaims;
  createConnectionOwnership(): ConnectionOwnership;
  createDeviceAllocation(): DeviceAllocation;
  createExplicitDeviceBind(): ExplicitDeviceBind;
  createDeviceReplacement(): DeviceReplacement;
  createDeviceReservations(): DeviceReservations;
  createDeviceAutoStart(): DeviceAutoStart;
}
type AllocationWiringState = Pick<
  DevicePoolState,
  | "timer"
  | "DEVICE_WAIT_INTERVAL_MS"
  | "criteriaMatcher"
  | "foreignDeviceOwnership"
  | "iosForeignDeviceOwnership"
  | "devices"
  | "DEVICE_WAIT_TIMEOUT_MS"
  | "RECOVERY_RESPONSE_MARGIN_MS"
  | "retryExecutor"
  | "emulatorLossLedger"
  | "bindingExclusion"
  | "idleDeviceReaper"
  | "assignmentMutex"
  | "allocationRefresh"
  | "recoveryRetryRefresh"
  | "runtimeIdentity"
  | "sessionManager"
  | "lastReleasedDeviceId"
  | "cancelDeviceSessionExecutions"
  | "ambientExecutionIdReader"
  | "autolockManager"
  | "intentionalShutdowns"
  | "pooledSessionIdentities"
  | "connectionOwnership"
  | "rehydrationReservations"
  | "mcpSessionRecoveryDevices"
  | "shutdownReservationCoordinator"
  | "recoveryCoordinator"
  | "deviceManager"
  | "lifecycleCoordinator"
  | "adbServerResetRecoveryReservations"
>;
export type AllocationWiringCallbacks = Pick<
  DevicePoolOperations,
  | "deviceHeldByExistingSession"
  | "heldDeviceDisqualification"
  | "getDevicesMatchingCriteria"
  | "hasPendingAndroidRecoveryMatching"
  | "potentialSupplyFor"
  | "getDevicesByPlatform"
  | "foreignOwnershipFor"
  | "recoveryNow"
  | "recoveryAssignmentError"
  | "getStatsForPlatform"
  | "recoveryFailure"
  | "releaseRehydrationReservation"
  | "getDevicesMatchingRecoveryTarget"
  | "tracksForeignOwnership"
  | "getGenericallyAllocatableDevices"
  | "hasPendingAndroidRecovery"
  | "isDrivenByForeignDaemon"
  | "publishDeviceClaim"
  | "rollbackAssignments"
  | "refreshForeignOwnership"
  | "countForeignDrivenDevices"
  | "getUnownedDevicesMatchingCriteria"
  | "shouldValidatePooledDevicePresence"
  | "takeFreshPresenceDiscovery"
  | "assertHealthyAllocationPossible"
  | "countBusyDevices"
  | "shouldWaitForDevice"
  | "refreshDevicesInternal"
  | "isPooledEntryCurrent"
  | "isReservedForAssignment"
  | "ensurePooledDevicePresentForUse"
  | "getDeviceHealthMarker"
  | "unhealthyDevicesError"
  | "snapshotSessionAssignment"
  | "nextLastUsedAt"
  | "createSessionOrRestore"
  | "stableDeviceIdFor"
  | "restoreSessionAssignment"
  | "notifyDeviceStateChanged"
  | "isPotentialAllocationSupply"
  | "beginMcpBind"
  | "assertNotClaimedByForeignDaemon"
  | "assertNotAssignedToBinding"
  | "assertDeviceCleanupComplete"
  | "matchesRestartRecoveryTarget"
  | "assertNotPreparedForOtherRequest"
  | "releaseDevice"
  | "holderReleaseRemainingMs"
  | "withTargetDeviceDiscovery"
  | "recordSourceAndroidAvd"
  | "notifyTargetDeviceReady"
  | "trackStartedDeviceProcess"
  | "assertIdleDeviceAssignable"
  | "validateOrReloadIdlePooledDevice"
  | "recordBindOwnership"
  | "assertCallerOwnsDeviceSession"
  | "assertNotReservedForShutdown"
  | "assertNotReservedForOtherRehydration"
  | "ownershipSessionId"
  | "hasConnectedMcpSessionOwner"
  | "recordMintedSessionOwnership"
  | "releaseCapturedDeviceForShutdown"
  | "removeDevice"
  | "addDevice"
  | "sourceImageForSameAndroidReplacement"
  | "assertSystemUiAnrReplacement"
  | "systemUiAnrRecoverySession"
  | "cancelOldDeviceWorkForSystemUiAnr"
  | "rollbackSystemUiAnrRecoveryReplacement"
  | "settleSystemUiAnrOriginalClaim"
  | "transferMcpSessionRecoveryLeases"
  | "validateSystemUiAnrRecoverySession"
  | "releaseDeviceClaim"
  | "retrySessionRelease"
  | "reserveDeviceForReadiness"
  | "notifyReservationChanged"
  | "notifyRehydrationReservationChanged"
  | "getRecoveringAndroidTargets"
  | "isReservedForShutdown"
  | "isBindingDevice"
  | "isPooledAndroidEmulator"
  | "restartReservationsForStop"
  | "restartStopNamesForeignConnection"
  | "refreshDevicesWithOutcome"
  | "refreshDevices"
  | "stopEmulatorProcess"
>;

/** Allocation Wiring responsibilities of DevicePool. */
export class DevicePoolAllocationWiring {
  constructor(
    private readonly state: AllocationWiringState,
    private readonly callbacks: AllocationWiringCallbacks,
  ) {}
  createMultiDeviceAllocationQueue(): MultiDeviceAllocationQueue {
    // Field initialization precedes dependency setup; defer reads until queue use.
    const pool = this.state;
    return new MultiDeviceAllocationQueue({
      get timer() {
        return pool.timer;
      },
      getAbortSignal,
      raceWithDeadline,
      get DEVICE_WAIT_INTERVAL_MS() {
        return pool.DEVICE_WAIT_INTERVAL_MS;
      },
      deviceHeldByExistingSession: (sessionId) =>
        this.callbacks.deviceHeldByExistingSession(sessionId),
      heldDeviceDisqualification: (request, device) =>
        this.callbacks.heldDeviceDisqualification(request, device),
      getDevicesMatchingCriteria: (criteria) => this.callbacks.getDevicesMatchingCriteria(criteria),
      hasPendingAndroidRecoveryMatching: (criteria) =>
        this.callbacks.hasPendingAndroidRecoveryMatching(criteria),
      potentialSupplyFor: (request) => this.callbacks.potentialSupplyFor(request),
      criteriaMatcher: {
        formatCriteriaSummary: (criteria) =>
          this.state.criteriaMatcher.formatCriteriaSummary(criteria),
      },
    });
  }

  createForeignClaims(): ForeignClaims {
    // Field initialization precedes dependency setup; defer reads until claims use.
    const pool = this.state;
    return new ForeignClaims({
      get foreignDeviceOwnership() {
        return pool.foreignDeviceOwnership;
      },
      get iosForeignDeviceOwnership() {
        return pool.iosForeignDeviceOwnership;
      },
      get timer() {
        return pool.timer;
      },
      getDevice: (deviceId) => this.state.devices.get(deviceId),
      getDevicesByPlatform: (platform) => this.callbacks.getDevicesByPlatform(platform),
    });
  }

  createConnectionOwnership(): ConnectionOwnership {
    // Field initialization precedes dependency setup; defer reads until claims use.
    return new ConnectionOwnership({
      foreignOwnershipFor: (platform) => this.callbacks.foreignOwnershipFor(platform),
      getDevice: (deviceId) => this.state.devices.get(deviceId),
    });
  }

  createDeviceAllocation(): DeviceAllocation {
    // Field initialization precedes dependency setup; defer reads until allocation use.
    const pool = this.state;
    return new DeviceAllocation({
      get DEVICE_WAIT_TIMEOUT_MS() {
        return pool.DEVICE_WAIT_TIMEOUT_MS;
      },
      get DEVICE_WAIT_INTERVAL_MS() {
        return pool.DEVICE_WAIT_INTERVAL_MS;
      },
      get RECOVERY_RESPONSE_MARGIN_MS() {
        return pool.RECOVERY_RESPONSE_MARGIN_MS;
      },
      get retryExecutor() {
        return pool.retryExecutor;
      },
      get emulatorLossIncidentStore() {
        return pool.emulatorLossLedger.emulatorLossIncidentStore;
      },
      get emulatorLossLedger() {
        return pool.emulatorLossLedger;
      },
      get bindingExclusion() {
        return pool.bindingExclusion;
      },
      get devices() {
        return pool.devices;
      },
      get idleDeviceReaper() {
        return pool.idleDeviceReaper;
      },
      get timer() {
        return pool.timer;
      },
      get assignmentMutex() {
        return pool.assignmentMutex;
      },
      get allocationRefresh() {
        return pool.allocationRefresh;
      },
      get recoveryRetryRefresh() {
        return pool.recoveryRetryRefresh;
      },
      get runtimeIdentity() {
        return pool.runtimeIdentity;
      },
      get sessionManager() {
        return pool.sessionManager;
      },
      get lastReleasedDeviceId() {
        return pool.lastReleasedDeviceId;
      },
      recoveryNow: () => this.callbacks.recoveryNow(),
      recoveryAssignmentError: (sessionId, target, incident) =>
        this.callbacks.recoveryAssignmentError(sessionId, target, incident),
      getStatsForPlatform: (platform, live) => this.callbacks.getStatsForPlatform(platform, live),
      recoveryFailure: (sessionId, target, refreshCompleteness) =>
        this.callbacks.recoveryFailure(sessionId, target, refreshCompleteness),
      releaseRehydrationReservation: (sessionId, terminal) =>
        this.callbacks.releaseRehydrationReservation(sessionId, terminal),
      getDevicesMatchingRecoveryTarget: (target) =>
        this.callbacks.getDevicesMatchingRecoveryTarget(target),
      tracksForeignOwnership: (platform) => this.callbacks.tracksForeignOwnership(platform),
      getGenericallyAllocatableDevices: (platform) =>
        this.callbacks.getGenericallyAllocatableDevices(platform),
      hasPendingAndroidRecovery: (platform) => this.callbacks.hasPendingAndroidRecovery(platform),
      foreignOwnershipFor: (platform) => this.callbacks.foreignOwnershipFor(platform),
      isDrivenByForeignDaemon: (device) => this.callbacks.isDrivenByForeignDaemon(device),
      publishDeviceClaim: (deviceId) => this.callbacks.publishDeviceClaim(deviceId),
      rollbackAssignments: (assignments, releaseReason) =>
        this.callbacks.rollbackAssignments(assignments, releaseReason),
      refreshForeignOwnership: (requireCurrent) =>
        this.callbacks.refreshForeignOwnership(requireCurrent),
      countForeignDrivenDevices: (platform) => this.callbacks.countForeignDrivenDevices(platform),
      getUnownedDevicesMatchingCriteria: (criteria) =>
        this.callbacks.getUnownedDevicesMatchingCriteria(criteria),
      hasPendingAndroidRecoveryMatching: (criteria) =>
        this.callbacks.hasPendingAndroidRecoveryMatching(criteria),
      shouldValidatePooledDevicePresence: (device) =>
        this.callbacks.shouldValidatePooledDevicePresence(device),
      takeFreshPresenceDiscovery: (platform) => this.callbacks.takeFreshPresenceDiscovery(platform),
      assertHealthyAllocationPossible: (candidates, selected) =>
        this.callbacks.assertHealthyAllocationPossible(candidates, selected),
      countBusyDevices: (candidates) => this.callbacks.countBusyDevices(candidates),
      shouldWaitForDevice: (busyDevices, pendingRecovery) =>
        this.callbacks.shouldWaitForDevice(busyDevices, pendingRecovery),
      refreshDevicesInternal: (assignmentLockHeld) =>
        this.callbacks.refreshDevicesInternal(assignmentLockHeld),
      isPooledEntryCurrent: (device) => this.callbacks.isPooledEntryCurrent(device),
      isReservedForAssignment: (device, forSessionId) =>
        this.callbacks.isReservedForAssignment(device, forSessionId),
      ensurePooledDevicePresentForUse: (device, options) =>
        this.callbacks.ensurePooledDevicePresentForUse(device, options),
      getDeviceHealthMarker: (deviceId) => this.callbacks.getDeviceHealthMarker(deviceId),
      unhealthyDevicesError: (devices) => this.callbacks.unhealthyDevicesError(devices),
      snapshotSessionAssignment: (device) => this.callbacks.snapshotSessionAssignment(device),
      nextLastUsedAt: () => this.callbacks.nextLastUsedAt(),
      createSessionOrRestore: (device, snapshot, createSession) =>
        this.callbacks.createSessionOrRestore(device, snapshot, createSession),
      stableDeviceIdFor: (device) => this.callbacks.stableDeviceIdFor(device),
      restoreSessionAssignment: (device, snapshot) =>
        this.callbacks.restoreSessionAssignment(device, snapshot),
      notifyDeviceStateChanged: (device) => this.callbacks.notifyDeviceStateChanged(device),
      isPotentialAllocationSupply: (device) => this.callbacks.isPotentialAllocationSupply(device),
    });
  }

  createExplicitDeviceBind(): ExplicitDeviceBind {
    // Field initialization precedes dependency setup; defer reads until explicit bind use.
    const pool = this.state;
    return new ExplicitDeviceBind({
      get devices() {
        return pool.devices;
      },
      get sessionManager() {
        return pool.sessionManager;
      },
      get runtimeIdentity() {
        return pool.runtimeIdentity;
      },
      get bindingExclusion() {
        return pool.bindingExclusion;
      },
      get cancelDeviceSessionExecutions() {
        return pool.cancelDeviceSessionExecutions;
      },
      get ambientExecutionIdReader() {
        return pool.ambientExecutionIdReader;
      },
      get autolockManager() {
        return pool.autolockManager;
      },
      get timer() {
        return pool.timer;
      },
      beginMcpBind: (mcpSessionId) => this.callbacks.beginMcpBind(mcpSessionId),
      assertNotClaimedByForeignDaemon: (deviceId, platform, remedy, maxAgeMs) =>
        this.callbacks.assertNotClaimedByForeignDaemon(deviceId, platform, remedy, maxAgeMs),
      assertNotAssignedToBinding: (input) => this.callbacks.assertNotAssignedToBinding(input),
      assertDeviceCleanupComplete: (deviceId) =>
        this.callbacks.assertDeviceCleanupComplete(deviceId),
      matchesRestartRecoveryTarget: (device, target) =>
        this.callbacks.matchesRestartRecoveryTarget(device, target),
      assertNotPreparedForOtherRequest: (deviceId, ownReservations) =>
        this.callbacks.assertNotPreparedForOtherRequest(deviceId, ownReservations),
      releaseDevice: (deviceId, expectedSessionId) =>
        this.callbacks.releaseDevice(deviceId, expectedSessionId),
      holderReleaseRemainingMs: (holderSessionId) =>
        this.callbacks.holderReleaseRemainingMs(holderSessionId),
      withTargetDeviceDiscovery: (options) => this.callbacks.withTargetDeviceDiscovery(options),
      recordSourceAndroidAvd: (deviceId, sourceImage) =>
        this.callbacks.recordSourceAndroidAvd(deviceId, sourceImage),
      notifyTargetDeviceReady: (options) => this.callbacks.notifyTargetDeviceReady(options),
      trackStartedDeviceProcess: (device, childProcess) =>
        this.callbacks.trackStartedDeviceProcess(device, childProcess),
      assertIdleDeviceAssignable: (options) => this.callbacks.assertIdleDeviceAssignable(options),
      validateOrReloadIdlePooledDevice: (options) =>
        this.callbacks.validateOrReloadIdlePooledDevice(options),
      notifyDeviceStateChanged: (device) => this.callbacks.notifyDeviceStateChanged(device),
      foreignOwnershipFor: (platform) => this.callbacks.foreignOwnershipFor(platform),
      recordBindOwnership: (mcpSessionId, sessionId) =>
        this.callbacks.recordBindOwnership(mcpSessionId, sessionId),
      assertCallerOwnsDeviceSession: (caller, session, device, spawnedDevice) =>
        this.callbacks.assertCallerOwnsDeviceSession(caller, session, device, spawnedDevice),
      assertNotReservedForShutdown: (device, detail) =>
        this.callbacks.assertNotReservedForShutdown(device, detail),
      assertNotReservedForOtherRehydration: (device, sessionId) =>
        this.callbacks.assertNotReservedForOtherRehydration(device, sessionId),
      recoveryNow: () => this.callbacks.recoveryNow(),
      recoveryAssignmentError: (sessionId, target) =>
        this.callbacks.recoveryAssignmentError(sessionId, target),
      ownershipSessionId: (sessionId) => this.callbacks.ownershipSessionId(sessionId),
      hasConnectedMcpSessionOwner: (namedSessionId, exceptMcpSessionId) =>
        this.callbacks.hasConnectedMcpSessionOwner(namedSessionId, exceptMcpSessionId),
      snapshotSessionAssignment: (device) => this.callbacks.snapshotSessionAssignment(device),
      nextLastUsedAt: () => this.callbacks.nextLastUsedAt(),
      createSessionOrRestore: (device, snapshot, createSession) =>
        this.callbacks.createSessionOrRestore(device, snapshot, createSession),
      stableDeviceIdFor: (device) => this.callbacks.stableDeviceIdFor(device),
      recordMintedSessionOwnership: (mcpSessionId, sessionId, oneShotCli, clientSuppliedId) =>
        this.callbacks.recordMintedSessionOwnership(
          mcpSessionId,
          sessionId,
          oneShotCli,
          clientSuppliedId,
        ),
      publishDeviceClaim: (deviceId) => this.callbacks.publishDeviceClaim(deviceId),
      rollbackAssignments: (assignments, releaseReason) =>
        this.callbacks.rollbackAssignments(assignments, releaseReason),
    });
  }

  createDeviceReplacement(): DeviceReplacement {
    // Field initialization precedes dependency setup; defer reads until replacement use.
    const pool = this.state;
    return new DeviceReplacement({
      get assignmentMutex() {
        return pool.assignmentMutex;
      },
      isPooledEntryCurrent: (device) => this.callbacks.isPooledEntryCurrent(device),
      get runtimeIdentity() {
        return pool.runtimeIdentity;
      },
      releaseCapturedDeviceForShutdown: (device) =>
        this.callbacks.releaseCapturedDeviceForShutdown(device),
      removeDevice: (deviceId, awaitCacheCleanup, expectedDevice, options) =>
        this.callbacks.removeDevice(deviceId, awaitCacheCleanup, expectedDevice, options),
      get devices() {
        return pool.devices;
      },
      get intentionalShutdowns() {
        return pool.intentionalShutdowns;
      },
      addDevice: (device, sourceImage, awaitSessionTracking, identityEvidence) =>
        this.callbacks.addDevice(device, sourceImage, awaitSessionTracking, identityEvidence),
      sourceImageForSameAndroidReplacement: (expectedDevice, replacement) =>
        this.callbacks.sourceImageForSameAndroidReplacement(expectedDevice, replacement),
      assertSystemUiAnrReplacement: (expectedDevice, replacement, sourceImage) =>
        this.callbacks.assertSystemUiAnrReplacement(expectedDevice, replacement, sourceImage),
      systemUiAnrRecoverySession: (expectedDevice) =>
        this.callbacks.systemUiAnrRecoverySession(expectedDevice),
      trackStartedDeviceProcess: (device, childProcess) =>
        this.callbacks.trackStartedDeviceProcess(device, childProcess),
      cancelOldDeviceWorkForSystemUiAnr: (deviceId, excludeExecutionId) =>
        this.callbacks.cancelOldDeviceWorkForSystemUiAnr(deviceId, excludeExecutionId),
      recordSourceAndroidAvd: (deviceId, sourceImage) =>
        this.callbacks.recordSourceAndroidAvd(deviceId, sourceImage),
      get pooledSessionIdentities() {
        return pool.pooledSessionIdentities;
      },
      nextLastUsedAt: () => this.callbacks.nextLastUsedAt(),
      rollbackSystemUiAnrRecoveryReplacement: (replacementDevice, preservedSession) =>
        this.callbacks.rollbackSystemUiAnrRecoveryReplacement(replacementDevice, preservedSession),
      settleSystemUiAnrOriginalClaim: (originalDeviceId) =>
        this.callbacks.settleSystemUiAnrOriginalClaim(originalDeviceId),
      transferMcpSessionRecoveryLeases: (previous, replacement) =>
        this.callbacks.transferMcpSessionRecoveryLeases(previous, replacement),
      validateSystemUiAnrRecoverySession: (preservedSession, replacementDevice) =>
        this.callbacks.validateSystemUiAnrRecoverySession(preservedSession, replacementDevice),
      releaseDeviceClaim: (deviceId) => this.callbacks.releaseDeviceClaim(deviceId),
      get sessionManager() {
        return pool.sessionManager;
      },
      retrySessionRelease: (sessionId, deviceId, attempt) =>
        this.callbacks.retrySessionRelease(sessionId, deviceId, attempt),
      get cancelDeviceSessionExecutions() {
        return pool.cancelDeviceSessionExecutions;
      },
      foreignOwnershipFor: (platform) => this.callbacks.foreignOwnershipFor(platform),
      get connectionOwnership() {
        return pool.connectionOwnership;
      },
      get criteriaMatcher() {
        return pool.criteriaMatcher;
      },
      get lastReleasedDeviceId() {
        return pool.lastReleasedDeviceId;
      },
      set lastReleasedDeviceId(value) {
        pool.lastReleasedDeviceId = value;
      },
      notifyDeviceStateChanged: (device) => this.callbacks.notifyDeviceStateChanged(device),
    });
  }

  createDeviceReservations(): DeviceReservations {
    // Field initialization precedes dependency setup; defer reads until reservations use.
    const pool = this.state;
    return new DeviceReservations({
      get devices() {
        return pool.devices;
      },
      get rehydrationReservations() {
        return pool.rehydrationReservations;
      },
      get mcpSessionRecoveryDevices() {
        return pool.mcpSessionRecoveryDevices;
      },
      get pooledSessionIdentities() {
        return pool.pooledSessionIdentities;
      },
      get sessionManager() {
        return pool.sessionManager;
      },
      get shutdownReservationCoordinator() {
        return pool.shutdownReservationCoordinator;
      },
      get recoveryCoordinator() {
        return pool.recoveryCoordinator;
      },
      get autolockManager() {
        return pool.autolockManager;
      },
      get runtimeIdentity() {
        return pool.runtimeIdentity;
      },
      get bindingExclusion() {
        return pool.bindingExclusion;
      },
      get timer() {
        return pool.timer;
      },
      reserveDeviceForReadiness: (...args) => this.callbacks.reserveDeviceForReadiness(...args),
      assertCallerOwnsDeviceSession: (client, session, device) =>
        this.callbacks.assertCallerOwnsDeviceSession(client, session, device),
      notifyReservationChanged: (deviceId, platform) =>
        this.callbacks.notifyReservationChanged(deviceId, platform),
      notifyRehydrationReservationChanged: (target) =>
        this.callbacks.notifyRehydrationReservationChanged(target),
      notifyDeviceStateChanged: (device) => this.callbacks.notifyDeviceStateChanged(device),
      getDevicesByPlatform: (platform) => this.callbacks.getDevicesByPlatform(platform),
      getRecoveringAndroidTargets: () => this.callbacks.getRecoveringAndroidTargets(),
      isReservedForShutdown: (device) => this.callbacks.isReservedForShutdown(device),
      isBindingDevice: (device) => this.callbacks.isBindingDevice(device),
      isPooledAndroidEmulator: (deviceId) => this.callbacks.isPooledAndroidEmulator(deviceId),
      stableDeviceIdFor: (device) => this.callbacks.stableDeviceIdFor(device),
      restartReservationsForStop: (deviceId, identity, ownerRequester) =>
        this.callbacks.restartReservationsForStop(deviceId, identity, ownerRequester),
      restartStopNamesForeignConnection: (sessionId, target, requester) =>
        this.callbacks.restartStopNamesForeignConnection(sessionId, target, requester),
    });
  }

  createDeviceAutoStart(): DeviceAutoStart {
    // Field initialization precedes dependency setup; defer reads until auto-start use.
    const pool = this.state;
    return new DeviceAutoStart({
      get criteriaMatcher() {
        return pool.criteriaMatcher;
      },
      get deviceManager() {
        return pool.deviceManager;
      },
      get timer() {
        return pool.timer;
      },
      get foreignDeviceOwnership() {
        return pool.foreignDeviceOwnership;
      },
      get bindingExclusion() {
        return pool.bindingExclusion;
      },
      get runtimeIdentity() {
        return pool.runtimeIdentity;
      },
      get lifecycleCoordinator() {
        return pool.lifecycleCoordinator;
      },
      get recoveringAndroidImages() {
        return pool.recoveryCoordinator.recoveringAndroidImages;
      },
      get assignmentMutex() {
        return pool.assignmentMutex;
      },
      get adbServerResetRecoveryReservations() {
        return pool.adbServerResetRecoveryReservations;
      },
      refreshDevicesWithOutcome: () => this.callbacks.refreshDevicesWithOutcome(),
      refreshDevices: () => this.callbacks.refreshDevices(),
      refreshForeignOwnership: () => this.callbacks.refreshForeignOwnership(),
      trackStartedDeviceProcess: (device, childProcess) =>
        this.callbacks.trackStartedDeviceProcess(device, childProcess),
      stopEmulatorProcess: (childProcess, retainLeaseUntil) =>
        this.callbacks.stopEmulatorProcess(childProcess, retainLeaseUntil),
      getUnownedDevicesMatchingCriteria: (criteria) =>
        this.callbacks.getUnownedDevicesMatchingCriteria(criteria),
      getDevicesByPlatform: (platform) => this.callbacks.getDevicesByPlatform(platform),
      getDevice: (deviceId) => this.state.devices.get(deviceId),
      deviceHeldByExistingSession: (sessionId) =>
        this.callbacks.deviceHeldByExistingSession(sessionId),
      addDevice: (device, sourceImage, awaitSessionTracking, identityEvidence) =>
        this.callbacks.addDevice(device, sourceImage, awaitSessionTracking, identityEvidence),
      waitForDeviceReadyOrCancel: (
        device,
        childProcess,
        timeoutMs,
        signal,
        timer,
        cancelOwnedBoot,
      ) =>
        waitForDeviceReadyOrCancel(this.state.deviceManager, device, childProcess, {
          timeoutMs,
          signal,
          timer,
          cancelOwnedBoot,
        }),
    });
  }
}

export function connectAllocationWiring(
  part: () => DevicePoolAllocationWiring,
  seams: Pick<DevicePoolOperations, never>,
): AllocationWiringOperations {
  return {
    createMultiDeviceAllocationQueue: (...args) => part().createMultiDeviceAllocationQueue(...args),
    createForeignClaims: (...args) => part().createForeignClaims(...args),
    createConnectionOwnership: (...args) => part().createConnectionOwnership(...args),
    createDeviceAllocation: (...args) => part().createDeviceAllocation(...args),
    createExplicitDeviceBind: (...args) => part().createExplicitDeviceBind(...args),
    createDeviceReplacement: (...args) => part().createDeviceReplacement(...args),
    createDeviceReservations: (...args) => part().createDeviceReservations(...args),
    createDeviceAutoStart: (...args) => part().createDeviceAutoStart(...args),
  };
}
