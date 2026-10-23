import type { Environment } from "../poolConfig";
import { releaseSessionAndDevice } from "../releaseSessionAndDevice";
import type { AmbientExecutionIdReader } from "../../utils/interfaces/AmbientExecutionIdReader";
import { type DevicePoolRefreshPort } from "../devicePoolRefresh";
import { IdleDeviceReaper } from "../idleDeviceReaper";
import { DeviceAutolockManager } from "../deviceAutolockManager";
import { type EmulatorProcessLifecyclePoolPort } from "../emulatorProcessLifecycle";
import { type MissingDeviceLivenessPoolPort } from "../missingDeviceLiveness";
import { type DeviceRuntimeIdentityPoolPort } from "../deviceRuntimeIdentity";
import { type DeviceShutdownReservationsPoolPort } from "../deviceShutdownReservations";
import { DeviceDisconnectHandler } from "../deviceDisconnectHandler";
import { identityEvidenceFields } from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface LifecycleWiringOperations {
  createIdleDeviceReaper(): IdleDeviceReaper;
  createRuntimeIdentityPort(
    ambientExecutionIdReader: AmbientExecutionIdReader | undefined,
  ): DeviceRuntimeIdentityPoolPort;
  createDisconnectHandler(): DeviceDisconnectHandler;
  registerSessionReleaseHandlers(): void;
  createShutdownReservationsPort(): DeviceShutdownReservationsPoolPort;
  createMissingDevicePort(): MissingDeviceLivenessPoolPort;
  createRefreshPort(): DevicePoolRefreshPort;
  createEmulatorProcessPort(): EmulatorProcessLifecyclePoolPort;
  createAutolockManager(env: Environment | undefined): DeviceAutolockManager;
}
type LifecycleWiringState = Pick<
  DevicePoolState,
  | "assignmentMutex"
  | "deviceManager"
  | "devices"
  | "retryExecutor"
  | "timer"
  | "refreshCoordinator"
  | "cancelDeviceSessionExecutions"
  | "intentionalShutdowns"
  | "criteriaMatcher"
  | "sessionManager"
  | "recoveryCoordinator"
  | "deviceReservations"
  | "autolockManager"
  | "runtimeIdentity"
  | "refreshMissingDeviceMisses"
  | "androidTransportAliases"
  | "deviceSessionStarts"
  | "settledLateShutdowns"
  | "missingDeviceLiveness"
  | "startedDeviceProcesses"
  | "startedDeviceProcessOutput"
  | "daemonSessionId"
  | "pooledSessionIdentities"
  | "mcpSessionRecoveryDevices"
  | "adbServerResetQuarantinedSessions"
  | "bindingExclusion"
  | "deviceSessionRepository"
  | "idGenerator"
>;
export type LifecycleWiringCallbacks = Pick<
  DevicePoolOperations,
  | "getDevice"
  | "removeDevice"
  | "notifyDeviceFramesInvalidated"
  | "hasReusableSerial"
  | "isReservedForShutdown"
  | "finishEmulatorLossIncident"
  | "recordEmulatorLossIncident"
  | "shouldRebootDisconnectedAndroidDevice"
  | "rebootDisconnectedAndroidDevice"
  | "settleEmulatorLossIncident"
  | "suppressAutoStartForDevice"
  | "completeEmulatorLossRecovery"
  | "refreshEmulatorLossRecoverySettlement"
  | "getRecoveryPolicy"
  | "isAndroidEmulatorActiveRelaunchEligible"
  | "releaseDevice"
  | "clearMcpSessionOwnership"
  | "releaseExpiredSessionDevice"
  | "captureReleasedDevice"
  | "assertReadinessReservationOwner"
  | "assertAndroidRecoveryExclusionForReadinessReservation"
  | "reserveShutdownSessionIdentity"
  | "completeShutdownSessionIdentity"
  | "reserveMcpSessionRecoveryLease"
  | "releaseMcpSessionRecoveryLease"
  | "notifyDeviceStateChanged"
  | "needsAndroidTransportNormalization"
  | "replacePooledDeviceForRuntimeIdentity"
  | "finishSessionPreservingRecoveryPreparation"
  | "tryPreserveSessionForMissingDevice"
  | "releaseSessionForEvictedDevice"
  | "removeDisconnectedDevice"
  | "normalizeAndroidDiscovery"
  | "seedLastUsedAt"
  | "nextDeviceIncarnation"
  | "notifyDeviceIncarnationAssigned"
  | "setDeviceSessionTracking"
  | "clearAutoStartSuppressionForBootedDevice"
  | "foldObservationIntoPooledEntry"
  | "notifyDeviceReady"
  | "prepareSessionPreservingRecovery"
  | "evictMissingPooledDevice"
  | "withTargetDeviceDiscovery"
  | "assertNotReservedForShutdown"
  | "assertNotReservedForOtherRehydration"
  | "recordSourceAndroidAvd"
  | "notifyTargetDeviceReady"
  | "trackStartedDeviceProcess"
  | "assertIdleDeviceAssignable"
  | "validateOrReloadIdlePooledDevice"
  | "assertDeviceCleanupComplete"
  | "snapshotSessionAssignment"
  | "nextLastUsedAt"
  | "createSessionOrRestore"
  | "stableDeviceIdFor"
  | "recordMintedSessionOwnership"
  | "recordBindOwnership"
  | "restoreSessionAssignment"
  | "isSessionAssignmentCurrent"
  | "assertNotClaimedByForeignDaemon"
  | "assertNotAssignedToBinding"
  | "foreignOwnershipFor"
  | "claimExplicitlyBoundDevice"
>;

/** Lifecycle Wiring responsibilities of DevicePool. */
export class DevicePoolLifecycleWiring {
  constructor(
    private readonly state: LifecycleWiringState,
    private readonly callbacks: LifecycleWiringCallbacks,
  ) {}
  createIdleDeviceReaper(): IdleDeviceReaper {
    return new IdleDeviceReaper(
      {
        getDevice: (deviceId) => this.callbacks.getDevice(deviceId),
        removeDevice: (deviceId, awaitCacheCleanup, expectedDevice) =>
          this.callbacks.removeDevice(deviceId, awaitCacheCleanup, expectedDevice),
        withAssignmentLock: (operation) => this.state.assignmentMutex.runExclusive(operation),
      },
      this.state.deviceManager,
    );
  }

  createRuntimeIdentityPort(
    ambientExecutionIdReader: AmbientExecutionIdReader | undefined,
  ): DeviceRuntimeIdentityPoolPort {
    return {
      getAmbientExecutionId: () => ambientExecutionIdReader?.getExecutionId(),
      notifyDeviceFramesInvalidated: (deviceId) =>
        this.callbacks.notifyDeviceFramesInvalidated(deviceId),
      getDevices: () => this.state.devices.backingMap(),
      getDeviceManager: () => this.state.deviceManager,
      getRetryExecutor: () => this.state.retryExecutor,
      getTimer: () => this.state.timer,
      getRefreshGeneration: () => this.state.refreshCoordinator.getRefreshGeneration(),
      hasReusableSerial: (device) => this.callbacks.hasReusableSerial(device),
      isReservedForShutdown: (device) => this.callbacks.isReservedForShutdown(device),
      cancelDeviceExecutions: (deviceId, reason, options) =>
        this.state.cancelDeviceSessionExecutions.cancelDeviceExecutions?.(
          deviceId,
          reason,
          options,
        ) ?? Promise.resolve(0),
      cancelDeviceSessionExecutions: (sessionId, reason, options) =>
        this.state.cancelDeviceSessionExecutions(sessionId, reason, options),
    };
  }

  createDisconnectHandler(): DeviceDisconnectHandler {
    return new DeviceDisconnectHandler({
      getPooledDevice: (deviceId) => this.state.devices.get(deviceId),
      getIntentionalShutdownMarker: (deviceId) => this.state.intentionalShutdowns.get(deviceId),
      deleteIntentionalShutdownMarker: (deviceId) => {
        this.state.intentionalShutdowns.delete(deviceId);
      },
      isReservedForShutdown: (device) => this.callbacks.isReservedForShutdown(device),
      removeDevice: (deviceId, awaitCacheCleanup, expectedDevice, options) =>
        this.callbacks.removeDevice(deviceId, awaitCacheCleanup, expectedDevice, options),
      finishEmulatorLossIncident: (incidentId, outcome) =>
        this.callbacks.finishEmulatorLossIncident(incidentId, outcome),
      recordEmulatorLossIncident: (deviceId, path, processExit, lastAdbState) =>
        this.callbacks.recordEmulatorLossIncident(deviceId, path, processExit, lastAdbState),
      shouldRebootDisconnectedAndroidDevice: (device) =>
        this.callbacks.shouldRebootDisconnectedAndroidDevice(device),
      rebootDisconnectedAndroidDevice: (device, incidentId) =>
        this.callbacks.rebootDisconnectedAndroidDevice(device, incidentId),
      settleEmulatorLossIncident: (incidentId) =>
        this.callbacks.settleEmulatorLossIncident(incidentId),
      suppressAutoStartForDevice: (device) => this.callbacks.suppressAutoStartForDevice(device),
      completeEmulatorLossRecovery: (incidentId, outcome) =>
        this.callbacks.completeEmulatorLossRecovery(incidentId, outcome),
      refreshEmulatorLossRecoverySettlement: (incidentId, outcome) =>
        this.callbacks.refreshEmulatorLossRecoverySettlement(incidentId, outcome),
      getRecoveryPolicy: () => this.callbacks.getRecoveryPolicy(),
      isAndroidEmulatorActiveRelaunchEligible: (device) =>
        this.callbacks.isAndroidEmulatorActiveRelaunchEligible(device),
      getDeviceManager: () => this.state.deviceManager,
      androidRediscoveryMatches: (candidate, deviceId, avdName) =>
        this.state.criteriaMatcher.androidRediscoveryMatches(candidate, deviceId, avdName),
    });
  }

  registerSessionReleaseHandlers(): void {
    this.state.sessionManager.cleanupReceipts.setGeneration(this.state.daemonSessionId);
    this.state.sessionManager.setRecoveryExpiryReleaseHandler({
      release: (sessionId, reason, attempt, options) => {
        const recoveryRelease = this.state.recoveryCoordinator.releaseFailedRecoveryOnExpiry(
          sessionId,
          reason,
          attempt,
          options,
        );
        if (recoveryRelease) {
          options.deviceReleaseManaged = true;
          return recoveryRelease;
        }
        const terminalRelease = this.state.sessionManager.getTerminalReleaseSnapshot(sessionId);
        if (!terminalRelease || !this.state.sessionManager.hasSession(sessionId)) {
          return undefined;
        }
        // This handler returns the device after the attempt, including when a
        // retained terminal fence upgrades the expiry's diagnostic reason.
        options.deviceReleaseManaged = true;
        let releasedDeviceId: string | null = null;
        return releaseSessionAndDevice(
          this.state.sessionManager,
          this.callbacks,
          terminalRelease.deviceId,
          sessionId,
          reason,
          {
            release: async () => {
              releasedDeviceId = await attempt();
              return releasedDeviceId;
            },
          },
        ).then(() => releasedDeviceId);
      },
    });
    // Expiry has no caller available to return the device to the pool. Explicit
    // release callers retain their ordered cleanup and release flow, while
    // connection ownership and autolock metadata are removed when their session
    // ends.
    this.state.sessionManager.onRestartRecoveryActivity((sessionId, atMs) => {
      this.state.deviceReservations.handleRestartRecoveryActivity(sessionId, atMs);
    });
    this.state.sessionManager.onSessionCreated((session) => {
      this.state.deviceReservations.handleSessionCreated(session);
    });
    this.state.sessionManager.onSessionRelease((sessionId, deviceId, reason, snapshot, options) => {
      this.state.deviceReservations.handleSessionRelease(sessionId, reason, snapshot, options);
      this.callbacks.clearMcpSessionOwnership(sessionId);
      // An expiry handler that owns the ordered release consumes its capture after the attempt.
      if (options.expiryOrigin && !options.deviceReleaseManaged) {
        this.callbacks.releaseExpiredSessionDevice(sessionId, deviceId);
      } else {
        this.callbacks.captureReleasedDevice(sessionId, deviceId);
        this.state.autolockManager.clearReleasedAutolockState(sessionId, deviceId);
      }
      this.state.recoveryCoordinator.finalizeReleasedRecoverySession(sessionId);
    });
  }

  createShutdownReservationsPort(): DeviceShutdownReservationsPoolPort {
    return {
      getDevices: () => this.state.devices.backingMap(),
      withAssignmentLock: (operation) => this.state.assignmentMutex.runExclusive(operation),
      getIntentionalShutdowns: () => this.state.intentionalShutdowns,
      assertReadinessReservationOwner: (device, client) =>
        this.callbacks.assertReadinessReservationOwner(device, client),
      assertRuntimeIdentity: (device, identity) =>
        this.state.runtimeIdentity.assertRuntimeIdentity(device, identity),
      assertAndroidRecoveryExclusionForReadinessReservation: (device, identity, name, enforce) =>
        this.callbacks.assertAndroidRecoveryExclusionForReadinessReservation(
          device,
          identity,
          name,
          enforce,
        ),
      reserveShutdownSessionIdentity: (deviceId) =>
        this.callbacks.reserveShutdownSessionIdentity(deviceId),
      completeShutdownSessionIdentity: (deviceId, device, identity) =>
        this.callbacks.completeShutdownSessionIdentity(deviceId, device, identity),
      reserveMcpSessionRecoveryLease: (sessionId, device, token) =>
        this.callbacks.reserveMcpSessionRecoveryLease(sessionId, device, token),
      releaseMcpSessionRecoveryLease: (sessionId, token) =>
        this.callbacks.releaseMcpSessionRecoveryLease(sessionId, token),
      getOwnedAutolockSession: (device, client) =>
        this.state.autolockManager.getOwnedAutolockSession(device, client),
    };
  }

  createMissingDevicePort(): MissingDeviceLivenessPoolPort {
    return {
      noteDeviceStateChanged: (device) => this.callbacks.notifyDeviceStateChanged(device),
      getDevices: () => this.state.devices.backingMap(),
      getRefreshMissingDeviceMisses: () => this.state.refreshMissingDeviceMisses,
      withAssignmentLock: (operation) => this.state.assignmentMutex.runExclusive(operation),
      getDeviceManager: () => this.state.deviceManager,
      getRefreshGeneration: () => this.state.refreshCoordinator.getRefreshGeneration(),
      shouldRebootDisconnectedAndroidDevice: (device) =>
        this.callbacks.shouldRebootDisconnectedAndroidDevice(device),
      mapAndroidDiscovery: (devices) =>
        this.state.androidTransportAliases.mapDiscovery(devices, true),
      needsAndroidTransportNormalization: (devices) =>
        devices.some((device) => device.platform === "android") &&
        this.callbacks.needsAndroidTransportNormalization(devices),
      isTransportEmulator: (deviceId) =>
        this.state.androidTransportAliases.avdName(deviceId) !== undefined,
      matchesRuntimeIdentity: (device, booted) =>
        this.state.runtimeIdentity.matchesRuntimeIdentity(device, booted),
      reconcilePooledIdentityResolution: (device, booted) =>
        this.state.runtimeIdentity.reconcilePooledIdentityResolution(device, booted),
      comparePooledIdentityEvidence: (device, observed) =>
        this.state.runtimeIdentity.comparePooledIdentityEvidence(device, observed),
      replacePooledDeviceForRuntimeIdentity: (device, booted) =>
        this.callbacks.replacePooledDeviceForRuntimeIdentity(device, booted),
      finishSessionPreservingRecoveryPreparation: (preparation) =>
        this.callbacks.finishSessionPreservingRecoveryPreparation(preparation),
      tryPreserveSessionForMissingDevice: (device, attempt, incidentId) =>
        this.callbacks.tryPreserveSessionForMissingDevice(device, attempt, incidentId),
      releaseSessionForEvictedDevice: (device, incidentId, observation) =>
        this.callbacks.releaseSessionForEvictedDevice(device, incidentId, observation),
      finishEmulatorLossIncident: (incidentId, outcome) =>
        this.callbacks.finishEmulatorLossIncident(incidentId, outcome),
      removeDisconnectedDevice: (deviceId, mayBeStaleSignal, incidentId) =>
        this.callbacks.removeDisconnectedDevice(deviceId, mayBeStaleSignal, incidentId),
      completeEmulatorLossRecovery: (incidentId, outcome) =>
        this.callbacks.completeEmulatorLossRecovery(incidentId, outcome),
      settleEmulatorLossIncident: (incidentId) =>
        this.callbacks.settleEmulatorLossIncident(incidentId),
      removeDevice: (deviceId, awaitCacheCleanup, expectedDevice, options) =>
        this.callbacks.removeDevice(deviceId, awaitCacheCleanup, expectedDevice, options),
      isReservedForShutdown: (device) => this.callbacks.isReservedForShutdown(device),
      recordEmulatorLossIncident: (deviceId, path, exit, state) =>
        this.callbacks.recordEmulatorLossIncident(deviceId, path, exit, state),
    };
  }

  createRefreshPort(): DevicePoolRefreshPort {
    return {
      normalizeAndroidDiscovery: (devices, held, current, complete) =>
        this.callbacks.normalizeAndroidDiscovery(devices, held, current, complete),
      isAndroidTransportAssignable: (device) =>
        this.state.androidTransportAliases.isAssignable(device),
      needsAndroidTransportNormalization: (devices) =>
        this.callbacks.needsAndroidTransportNormalization(devices),
      getTimer: () => this.state.timer,
      getDeviceManager: () => this.state.deviceManager,
      getDevices: () => this.state.devices.backingMap(),
      addPooledDevice: (device) => this.state.devices.set(device.id, device),
      withAssignmentLock: (operation) => this.state.assignmentMutex.runExclusive(operation),
      getCriteriaMatcher: () => this.state.criteriaMatcher,
      identityEvidenceForBootedDevice: (device) =>
        this.state.runtimeIdentity.identityEvidenceForBootedDevice(device),
      identityEvidenceFields: (evidence) => identityEvidenceFields(evidence),
      getDeviceSessionStarts: () => this.state.deviceSessionStarts,
      getRefreshMissingDeviceMisses: () => this.state.refreshMissingDeviceMisses,
      getSettledLateShutdowns: () => this.state.settledLateShutdowns,
      getIntentionalShutdowns: () => this.state.intentionalShutdowns,
      seedLastUsedAt: (now) => this.callbacks.seedLastUsedAt(now),
      nextDeviceIncarnation: () => this.callbacks.nextDeviceIncarnation(),
      notifyDeviceIncarnationAssigned: (id) => this.callbacks.notifyDeviceIncarnationAssigned(id),
      setDeviceSessionTracking: (id, now) => this.callbacks.setDeviceSessionTracking(id, now),
      clearAutoStartSuppressionForBootedDevice: (device) =>
        this.callbacks.clearAutoStartSuppressionForBootedDevice(device),
      foldObservationIntoPooledEntry: (pooled, device, source) =>
        this.callbacks.foldObservationIntoPooledEntry(pooled, device, source),
      removeMissingDevicesForRefresh: (held, generation, ids, platforms, succeeded, sources) =>
        this.state.missingDeviceLiveness.removeMissingDevicesForRefresh(
          held,
          generation,
          ids,
          platforms,
          succeeded,
          sources,
        ),
      notifyDeviceReady: (id) => this.callbacks.notifyDeviceReady(id),
      liftUnconfirmedRecoveringAndroidImages: (discovery, generation) =>
        this.state.recoveryCoordinator.liftUnconfirmedRecoveringAndroidImages(
          discovery,
          generation,
        ),
    };
  }

  createEmulatorProcessPort(): EmulatorProcessLifecyclePoolPort {
    return {
      getTimer: () => this.state.timer,
      getStartedDeviceProcesses: () => this.state.startedDeviceProcesses,
      getStartedDeviceProcessOutput: () => this.state.startedDeviceProcessOutput,
      getDevices: () => this.state.devices.backingMap(),
      getSessionManager: () => this.state.sessionManager,
      isReservedForShutdown: (device) => this.callbacks.isReservedForShutdown(device),
      prepareSessionPreservingRecovery: (id, device) =>
        this.callbacks.prepareSessionPreservingRecovery(id, device),
      finishSessionPreservingRecoveryPreparation: (preparation) =>
        this.callbacks.finishSessionPreservingRecoveryPreparation(preparation),
      recordEmulatorLossIncident: (id, path, exit) =>
        this.callbacks.recordEmulatorLossIncident(id, path, exit),
      finishEmulatorLossIncident: (id, outcome) =>
        this.callbacks.finishEmulatorLossIncident(id, outcome),
      evictMissingPooledDevice: (device, reason, attempt, incidentId, captured, preparation) =>
        this.callbacks.evictMissingPooledDevice(device, reason, {
          attemptDeviceLossRecovery: attempt,
          incidentId,
          incidentCaptureComplete: captured,
          recoveryPreparation: preparation,
        }),
    };
  }

  createAutolockManager(env: Environment | undefined): DeviceAutolockManager {
    return new DeviceAutolockManager(
      {
        getSessionManager: () => this.state.sessionManager,
        getDaemonSessionId: () => this.state.daemonSessionId,
        noteDeviceStateChanged: (device) => this.callbacks.notifyDeviceStateChanged(device),
        getDevice: (id) => this.state.devices.get(id),
        withAssignmentLock: (operation) => this.state.assignmentMutex.runExclusive(operation),
        withTargetDeviceDiscovery: (options) => this.callbacks.withTargetDeviceDiscovery(options),
        assertRuntimeIdentity: (device, identity) =>
          this.state.runtimeIdentity.assertRuntimeIdentity(device, identity),
        assertNotReservedForShutdown: (device, message) =>
          this.callbacks.assertNotReservedForShutdown(device, message),
        assertNotReservedForOtherRehydration: (device) =>
          this.callbacks.assertNotReservedForOtherRehydration(device, undefined),
        recordSourceAndroidAvd: (id, image) => this.callbacks.recordSourceAndroidAvd(id, image),
        notifyTargetDeviceReady: (options) => this.callbacks.notifyTargetDeviceReady(options),
        trackStartedDeviceProcess: (device, process) =>
          this.callbacks.trackStartedDeviceProcess(device, process),
        assertIdleDeviceAssignable: (options) => this.callbacks.assertIdleDeviceAssignable(options),
        validateOrReloadIdlePooledDevice: (options) =>
          this.callbacks.validateOrReloadIdlePooledDevice(options),
        assertDeviceCleanupComplete: (id) => this.callbacks.assertDeviceCleanupComplete(id),
        snapshotSessionAssignment: (device) => this.callbacks.snapshotSessionAssignment(device),
        nextLastUsedAt: () => this.callbacks.nextLastUsedAt(),
        createSessionOrRestore: (device, snapshot, create) =>
          this.callbacks.createSessionOrRestore(device, snapshot, create),
        stableDeviceIdFor: (device) => this.callbacks.stableDeviceIdFor(device),
        recordBindOwnership: (client, session, minted) =>
          minted
            ? this.callbacks.recordMintedSessionOwnership(client, session, false)
            : this.callbacks.recordBindOwnership(client, session),
        restoreSessionAssignment: (device, snapshot) =>
          this.callbacks.restoreSessionAssignment(device, snapshot),
        isSessionAssignmentCurrent: (device, session) =>
          this.callbacks.isSessionAssignmentCurrent(device, session),
        getPooledSessionIdentity: (device) => this.state.pooledSessionIdentities.get(device),
        getMcpSessionRecoveryDevice: (client) =>
          this.state.mcpSessionRecoveryDevices.get(client)?.device,
        isAdbServerResetQuarantined: (id) => this.state.adbServerResetQuarantinedSessions.has(id),
        assertNotClaimedByForeignDaemon: (deviceId, platform) =>
          this.callbacks.assertNotClaimedByForeignDaemon(deviceId, platform),
        assertNotAssignedToBinding: this.state.bindingExclusion
          ? (deviceId, platform, sourceImage) =>
              this.callbacks.assertNotAssignedToBinding({
                action: "acquire",
                deviceId,
                platform,
                stableIds: [platform === "android" ? sourceImage?.name : undefined],
              })
          : undefined,
        claimAcquiredDevice: async (sessionId, deviceId, heldBefore, platform, createdSession) => {
          if (this.callbacks.foreignOwnershipFor(platform)) {
            await this.callbacks.claimExplicitlyBoundDevice(
              sessionId,
              deviceId,
              heldBefore,
              createdSession,
            );
          }
        },
      },
      this.state.deviceSessionRepository,
      this.state.idGenerator,
      env,
    );
  }
}

export function connectLifecycleWiring(
  part: () => DevicePoolLifecycleWiring,
  seams: Pick<DevicePoolOperations, never>,
): LifecycleWiringOperations {
  return {
    createIdleDeviceReaper: (...args) => part().createIdleDeviceReaper(...args),
    createRuntimeIdentityPort: (...args) => part().createRuntimeIdentityPort(...args),
    createDisconnectHandler: (...args) => part().createDisconnectHandler(...args),
    registerSessionReleaseHandlers: (...args) => part().registerSessionReleaseHandlers(...args),
    createShutdownReservationsPort: (...args) => part().createShutdownReservationsPort(...args),
    createMissingDevicePort: (...args) => part().createMissingDevicePort(...args),
    createRefreshPort: (...args) => part().createRefreshPort(...args),
    createEmulatorProcessPort: (...args) => part().createEmulatorProcessPort(...args),
    createAutolockManager: (...args) => part().createAutolockManager(...args),
  };
}
