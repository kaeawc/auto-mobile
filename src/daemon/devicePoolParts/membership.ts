import { getIosLockStateCache } from "../../features/observe/ios/IosLockStateCacheRegistry";
import { clearDeviceError, isErrored, holderOf } from "../deviceBinding";
import { notifyDeviceIdentityReplaced } from "../../utils/deviceIncarnation";
import { logger } from "../../utils/logger";
import { displayTransitions } from "../../features/observe/DisplayTransition";
import { getObserveCacheStore } from "../../features/observe/cache/ObserveCacheRegistry";
import { ActionableError, BootedDevice, DeviceInfo, Platform } from "../../models";
import { PlatformDeviceManager } from "../../devices/deviceUtils";
import { Timer } from "../../utils/SystemTimer";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { type DevicePoolRefreshResult } from "../devicePoolRefresh";
import {
  getDeviceRecoveryPolicy,
  type DeviceRecoveryPolicy,
  isDeviceSessionContinuityEnabled,
} from "../poolConfig";
import {
  compareIdentityEvidence,
  type IdentityEvidence,
} from "../../devices/deviceIdentityEvidence";
import {
  type EmulatorLossDetectionPath,
  type EmulatorLossIncident,
  type EmulatorLossIncidentStore,
  type EmulatorLossRecoverySettlement,
} from "../emulatorLossIncident";
import { type CurrentDisconnectStatus } from "../deviceDisconnectHandler";
import {
  type AndroidRecoveryRecord,
  type AndroidRecoveryReservationKind,
} from "../androidRecoveryRecordLedger";
import type { RemoveDeviceOptions, PooledDevice } from "../devicePoolTypes";
import { neutralIdentityEvidence, identityEvidenceFields } from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface MembershipOperations {
  resolveRecoveryPolicy(recoveryPolicy?: DeviceRecoveryPolicy): DeviceRecoveryPolicy;
  resolveDeviceSessionContinuity(override: boolean | undefined): boolean;
  startAndroidRecoveryRecord(
    sessionId: string,
    details: Omit<
      Partial<AndroidRecoveryRecord>,
      "sessionId" | "generation" | "state" | "reservations"
    >,
    reservations: readonly AndroidRecoveryReservationKind[],
    replace?: boolean,
  ): AndroidRecoveryRecord;
  clearAdbResetRecoveryReservation(record: AndroidRecoveryRecord): void;
  initializeWithDevices(devices: BootedDevice[]): Promise<void>;
  /**
   * Refresh device pool by discovering connected devices
   *
   * Automatically called when pool is empty and a session requests a device.
   * This handles race conditions during daemon startup where device discovery
   * may not have completed before tests begin.
   *
   * Adds newly booted devices and prunes unassigned devices that are no longer
   * booted. Assigned devices are kept so active sessions can be cancelled and
   * released by the disconnect monitor.
   */
  refreshDevices(): Promise<number>;
  refreshDevicesWithOutcome(): Promise<DevicePoolRefreshResult>;
  /** @internal Test support for checking removal-stamp retention. */
  getDeviceRemovalStampCountForTest(): number;
  refreshDevicesInternal(assignmentLockHeld: boolean): Promise<DevicePoolRefreshResult>;
  /** Notify consumers that a device has reached a boot-ready connection boundary. */
  notifyDeviceReady(deviceId: string): void;
  notifyDeviceStateChanged(device: Pick<PooledDevice, "id" | "platform">): void;
  notifyDeviceFramesInvalidated(deviceId: string): void;
  notifyDeviceRemoved(deviceId: string, platform: Platform): void;
  addDevice(
    device: BootedDevice,
    sourceImage?: DeviceInfo,
    awaitSessionTracking?: boolean,
    identityEvidence?: IdentityEvidence,
  ): Promise<void>;
  recordSourceAndroidAvd(deviceId: string, sourceImage?: DeviceInfo): void;
  replacePooledDeviceForRuntimeIdentity(
    pooledDevice: PooledDevice,
    bootedDevice: BootedDevice,
  ): Promise<boolean>;
  dropTrackedProcessOnRemoval(deviceId: string, options?: RemoveDeviceOptions): void;
  releaseDeviceClaimOnRemoval(deviceId: string, options?: RemoveDeviceOptions): void;
  removeDevice(
    deviceId: string,
    awaitCacheCleanup?: boolean,
    expectedDevice?: PooledDevice,
    options?: RemoveDeviceOptions,
  ): Promise<void>;
  /**
   * A verified AVD deletion retires the name's crash-loop history. Ordinary
   * pool removal and re-add keep it, because they can refer to the same AVD.
   */
  clearAndroidRebootBudgetForDeletedAvd(target: Pick<DeviceInfo, "platform" | "name">): void;
  removeDisconnectedDevice(
    deviceId: string,
    mayBeStaleSignal?: boolean,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<void>;
  recordEmulatorLossIncident(
    deviceId: string,
    detectionPath: EmulatorLossDetectionPath,
    processExit?: {
      code: number | null;
      signal: NodeJS.Signals | null;
    },
    lastAdbState?: string,
  ): Promise<string | undefined>;
  getDeviceManager(): PlatformDeviceManager;
  getTimer(): Timer;
  recordEmulatorLossRecoveryAttempt(
    incidentId: string | undefined,
    attempt: {
      attempt: number;
      outcome: "failed" | "succeeded";
    },
  ): Promise<void>;
  completeEmulatorLossRecovery(
    incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
    releasedSessionState?: "awaiting-device",
  ): Promise<void>;
  buildEmulatorLossRecoverySettlement(
    incident: EmulatorLossIncident | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
    releasedSessionState?: "awaiting-device",
  ): EmulatorLossRecoverySettlement;
  waitForEmulatorLossIncident(
    incidentId: string,
    timeoutMs?: number,
  ): Promise<Awaited<ReturnType<EmulatorLossIncidentStore["get"]>>>;
  settleEmulatorLossIncident(incidentId: string | undefined): void;
  finishEmulatorLossIncident(
    incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
  ): Promise<void>;
  isCurrentDisconnectedDevice(device: PooledDevice): Promise<CurrentDisconnectStatus>;
  notifyDeviceIncarnationAssigned(deviceId: string): void;
  nextDeviceIncarnation(): number;
}
type MembershipState = Pick<
  DevicePoolState,
  | "recoveryCoordinator"
  | "adbServerResetQuarantine"
  | "timer"
  | "androidTransportAliases"
  | "devices"
  | "criteriaMatcher"
  | "deviceSessionStarts"
  | "refreshCoordinator"
  | "onDeviceReady"
  | "onDeviceStateChanged"
  | "onDeviceFramesInvalidated"
  | "onDeviceRemoved"
  | "intentionalShutdowns"
  | "refreshMissingDeviceMisses"
  | "runtimeIdentity"
  | "startedDeviceProcesses"
  | "emulatorProcessLifecycle"
  | "startedDeviceProcessOutput"
  | "sessionManager"
  | "androidAliasRetirement"
  | "deviceHealthMarkers"
  | "settledLateShutdowns"
  | "deferredDeviceReleases"
  | "releasedDeviceCaptures"
  | "lastReleasedDeviceId"
  | "androidDeviceReboot"
  | "disconnectHandler"
  | "emulatorLossLedger"
  | "deviceManager"
  | "onDeviceIncarnationAssigned"
>;
export type MembershipCallbacks = Pick<
  DevicePoolOperations,
  | "needsAndroidTransportNormalization"
  | "mapAndroidDiscovery"
  | "seedLastUsedAt"
  | "clearAutoStartSuppressionForBootedDevice"
  | "setDeviceSessionTracking"
  | "notifyDeviceReady"
  | "isPooledEntryCurrent"
  | "evictMissingPooledDevice"
  | "addDevice"
  | "releaseDeviceClaim"
  | "clearDeviceSessionCache"
>;

/** Membership responsibilities of DevicePool. */
export class DevicePoolMembership {
  constructor(
    private readonly state: MembershipState,
    private readonly callbacks: MembershipCallbacks,
  ) {}
  /**
   * Resolve the effective recovery policy once at construction. Extracted from the
   * constructor body so the injected-primitive parameters (timer, idGenerator, …)
   * do not push the constructor over the complexity gate.
   */
  resolveRecoveryPolicy(recoveryPolicy?: DeviceRecoveryPolicy): DeviceRecoveryPolicy {
    return { ...(recoveryPolicy ?? getDeviceRecoveryPolicy()) };
  }

  resolveDeviceSessionContinuity(override: boolean | undefined): boolean {
    if (override !== undefined) {
      return override;
    }
    return isDeviceSessionContinuityEnabled();
  }

  startAndroidRecoveryRecord(
    sessionId: string,
    details: Omit<
      Partial<AndroidRecoveryRecord>,
      "sessionId" | "generation" | "state" | "reservations"
    >,
    reservations: readonly AndroidRecoveryReservationKind[],
    replace = false,
  ): AndroidRecoveryRecord {
    return this.state.recoveryCoordinator.startAndroidRecoveryRecord(
      sessionId,
      details,
      reservations,
      replace,
    );
  }

  clearAdbResetRecoveryReservation(record: AndroidRecoveryRecord): void {
    this.state.adbServerResetQuarantine.clearAdbResetRecoveryReservation(record);
  }

  /**
   * Initialize pool with available devices
   *
   * Call this once after daemon starts to populate the device list.
   * Typically gets devices from --device-list or by querying emulator status.
   */
  async initializeWithDevices(devices: BootedDevice[]): Promise<void> {
    if (this.callbacks.needsAndroidTransportNormalization(devices)) {
      devices = this.callbacks.mapAndroidDiscovery(devices);
    }
    const now = this.callbacks.seedLastUsedAt(this.state.timer.now());
    const perf = createGlobalPerformanceTracker();
    perf.startOperation("populatePool");
    for (const device of devices) {
      if (!this.state.androidTransportAliases.isAssignable(device)) {
        continue;
      }
      this.callbacks.clearAutoStartSuppressionForBootedDevice(device);
      // Full: init/reinit replaces the pooled entry and allocates a new incarnation.
      this.notifyDeviceFramesInvalidated(device.deviceId);
      this.state.devices.set(device.deviceId, {
        id: device.deviceId,
        name: device.name,
        platform: device.platform,
        sessionId: null,
        status: "idle",
        health: "ok",
        lastUsedAt: now,
        assignmentCount: 0,
        errorCount: 0,
        iosVersion: device.iosVersion,
        simulatorType: this.state.criteriaMatcher.getBootedDeviceSimulatorType(device),
        ...(device.observedAt !== undefined ? { nameObservedAt: device.observedAt } : {}),
        incarnation: this.nextDeviceIncarnation(),
      });
      this.notifyDeviceIncarnationAssigned(device.deviceId);
      this.state.deviceSessionStarts.set(device.deviceId, now);
      await this.callbacks.setDeviceSessionTracking(device.deviceId, now);
    }
    perf.endOperation("populatePool");
    logger.info(`Device pool initialized with ${devices.length} devices`);
  }

  /**
   * Refresh device pool by discovering connected devices
   *
   * Automatically called when pool is empty and a session requests a device.
   * This handles race conditions during daemon startup where device discovery
   * may not have completed before tests begin.
   *
   * Adds newly booted devices and prunes unassigned devices that are no longer
   * booted. Assigned devices are kept so active sessions can be cancelled and
   * released by the disconnect monitor.
   */
  refreshDevices(): Promise<number> {
    return this.state.refreshCoordinator.refreshDevices();
  }

  refreshDevicesWithOutcome(): Promise<DevicePoolRefreshResult> {
    return this.refreshDevicesInternal(false);
  }

  /** @internal Test support for checking removal-stamp retention. */
  getDeviceRemovalStampCountForTest(): number {
    return this.state.refreshCoordinator.getDeviceRemovalStampCountForTest();
  }

  refreshDevicesInternal(assignmentLockHeld: boolean): Promise<DevicePoolRefreshResult> {
    return this.state.refreshCoordinator.refreshDevicesInternal(assignmentLockHeld);
  }

  /** Notify consumers that a device has reached a boot-ready connection boundary. */
  notifyDeviceReady(deviceId: string): void {
    try {
      this.state.onDeviceReady?.(deviceId);
    } catch (error) {
      logger.warn(`[DevicePool] Device-ready listener failed for ${deviceId}: ${error}`);
    }
  }

  /** Tell observers a device's status or holder changed; call only after the change committed. */
  notifyDeviceStateChanged(device: Pick<PooledDevice, "id" | "platform">): void {
    try {
      this.state.onDeviceStateChanged?.(device.id, device.platform);
    } catch (error) {
      // Observers cannot roll back a committed state change; never fail the pool operation.
      logger.warn(`[DevicePool] Device-state listener failed for ${device.id}: ${error}`);
    }
  }

  notifyDeviceFramesInvalidated(deviceId: string): void {
    try {
      this.state.onDeviceFramesInvalidated?.(deviceId);
    } catch (error) {
      logger.warn(
        `[DevicePool] Frame invalidation listener failed for ${deviceId}: ${error}`,
        error,
      );
    }
  }

  /** Notify consumers that a device has been removed from the pool. */
  notifyDeviceRemoved(deviceId: string, platform: Platform): void {
    try {
      this.state.onDeviceRemoved?.(deviceId, platform);
    } catch (error) {
      // Mirror the ready-listener contract: observers cannot roll back a removal
      // after the pool has deleted the device, so keep mandatory cleanup running.
      logger.warn(`[DevicePool] Device-removed listener failed for ${deviceId}: ${error}`);
    }
  }

  /**
   * Add a new device to the pool
   */
  async addDevice(
    device: BootedDevice,
    sourceImage?: DeviceInfo,
    awaitSessionTracking: boolean = true,
    identityEvidence: IdentityEvidence = neutralIdentityEvidence(device),
  ): Promise<void> {
    device = this.callbacks.mapAndroidDiscovery([device])[0];
    if (!this.state.androidTransportAliases.isAssignable(device)) {
      throw new ActionableError(
        `Android transport '${device.deviceId}' has no proven identity. Refresh devices after reconnecting it.`,
      );
    }
    this.callbacks.clearAutoStartSuppressionForBootedDevice(device, sourceImage);
    if (sourceImage) {
      this.state.intentionalShutdowns.delete(device.deviceId);
    }
    const existing = this.state.devices.get(device.deviceId);
    if (existing) {
      this.recordSourceAndroidAvd(device.deviceId, sourceImage);
      // A successful (re)boot of an errored, idle device clears its failure state so
      // criteria autoboot can hand it out instead of failing with "no devices match".
      if (isErrored(existing) && !holderOf(existing)) {
        clearDeviceError(existing);
        existing.errorCount = 0;
        existing.iosVersion = device.iosVersion ?? existing.iosVersion;
        existing.simulatorType =
          this.state.criteriaMatcher.getBootedDeviceSimulatorType(device) ?? existing.simulatorType;
        existing.lastUsedAt = this.callbacks.seedLastUsedAt(this.state.timer.now());
        logger.info(`Recovered errored device ${device.deviceId} after successful boot`);
        this.notifyDeviceStateChanged(existing);
      } else {
        logger.warn(`Device ${device.deviceId} already in pool`);
      }
    } else {
      const now = this.callbacks.seedLastUsedAt(this.state.timer.now());
      this.state.devices.set(device.deviceId, {
        id: device.deviceId,
        name: device.name,
        platform: device.platform,
        sessionId: null,
        status: "idle",
        health: "ok",
        lastUsedAt: now,
        assignmentCount: 0,
        errorCount: 0,
        iosVersion: device.iosVersion,
        simulatorType: this.state.criteriaMatcher.getBootedDeviceSimulatorType(device),
        ...(device.observedAt !== undefined ? { nameObservedAt: device.observedAt } : {}),
        ...identityEvidenceFields(identityEvidence),
        incarnation: this.nextDeviceIncarnation(),
      });
      this.notifyDeviceIncarnationAssigned(device.deviceId);
      this.recordSourceAndroidAvd(device.deviceId, sourceImage);
      this.state.deviceSessionStarts.set(device.deviceId, now);
      this.state.refreshMissingDeviceMisses.reset(device.deviceId);
      const sessionTracking = this.callbacks.setDeviceSessionTracking(device.deviceId, now);
      if (awaitSessionTracking) {
        await sessionTracking;
      } else {
        // Shutdown replacement already owns assignmentMutex. Persisting cache
        // metadata is best-effort and must not make allocators wait forever.
        void sessionTracking;
      }
      logger.info(`Added device ${device.deviceId} to pool`);
    }
    this.callbacks.notifyDeviceReady(device.deviceId);
  }

  recordSourceAndroidAvd(deviceId: string, sourceImage?: DeviceInfo): void {
    const device = this.state.devices.get(deviceId);
    if (device?.platform === "android" && sourceImage?.platform === "android") {
      device.avdName = sourceImage.name;
      device.androidImage = sourceImage;
    }
  }

  /**
   * Replace a pooled connection whose stable serial now identifies a different
   * runtime.
   *
   * Callers reach here when {@link matchesRuntimeIdentity} rejects discovery.
   * An unverified pooled placeholder can also cause that rejection, so clearing
   * serial-scoped guest state additionally requires resolved identity evidence
   * after the captured entry has been retired.
   */
  async replacePooledDeviceForRuntimeIdentity(
    pooledDevice: PooledDevice,
    bootedDevice: BootedDevice,
  ): Promise<boolean> {
    const capturedEntryStillPooled = this.callbacks.isPooledEntryCurrent(pooledDevice);
    this.state.runtimeIdentity.beginPendingReplacement(bootedDevice);
    try {
      await this.callbacks.evictMissingPooledDevice(
        pooledDevice,
        `runtime identity changed to ${bootedDevice.platform}:${bootedDevice.name}`,
        { identityObservation: bootedDevice },
      );
      const replacement = this.state.runtimeIdentity.getPendingReplacement(bootedDevice.deviceId);
      if (!replacement || this.state.devices.has(replacement.deviceId)) {
        return false;
      }
      const replacementEvidence =
        this.state.runtimeIdentity.identityEvidenceForBootedDevice(replacement);
      const pendingUnresolvedEvidence = this.state.runtimeIdentity.getPendingUnresolvedEvidence(
        replacement.deviceId,
      );
      const identityEvidence =
        pendingUnresolvedEvidence &&
        ["newer", "unresolved-newer"].includes(
          compareIdentityEvidence(replacementEvidence, pendingUnresolvedEvidence),
        )
          ? pendingUnresolvedEvidence
          : replacementEvidence;
      // Eviction must have retired the captured entry, with no successor already
      // published. Placeholder names assert no identity unless the pool knows its AVD.
      if (
        capturedEntryStillPooled &&
        pooledDevice.id === replacement.deviceId &&
        !identityEvidence.unresolved &&
        !this.state.runtimeIdentity.matchesRuntimeIdentity(pooledDevice, replacement) &&
        this.state.runtimeIdentity.comparePooledIdentityEvidence(pooledDevice, replacement) !==
          "stale" &&
        !this.state.runtimeIdentity.hasUnresolvedEmulatorName({
          deviceId: pooledDevice.id,
          platform: pooledDevice.platform,
          name: pooledDevice.avdName ?? pooledDevice.name,
        })
      ) {
        notifyDeviceIdentityReplaced(pooledDevice.id);
      }
      await this.callbacks.addDevice(replacement, undefined, true, identityEvidence);
      return true;
    } finally {
      this.state.runtimeIdentity.clearPendingReplacement(bootedDevice.deviceId);
    }
  }

  /**
   * Retirement forgets the tracked emulator process. A liveness-miss removal
   * (adb dropped the serial but the child may be alive) keeps it so its exit is
   * still watched and killDevice can stop it (#11123).
   */
  dropTrackedProcessOnRemoval(deviceId: string, options?: RemoveDeviceOptions): void {
    const tracked = this.state.startedDeviceProcesses.get(deviceId);
    if (options?.keepTrackedProcess && tracked) {
      return;
    }
    if (tracked && !this.state.emulatorProcessLifecycle.getCompletedProcessExit(tracked)) {
      logger.warn(`[DevicePool] Dropping tracking of live emulator process for ${deviceId}`);
    }
    this.state.startedDeviceProcesses.delete(deviceId);
    this.state.startedDeviceProcessOutput.delete(deviceId);
  }

  releaseDeviceClaimOnRemoval(deviceId: string, options?: RemoveDeviceOptions): void {
    if (!options?.keepDeviceClaim) {
      this.callbacks.releaseDeviceClaim(deviceId);
    }
  }

  /**
   * Remove device from pool
   */
  async removeDevice(
    deviceId: string,
    awaitCacheCleanup: boolean = true,
    expectedDevice?: PooledDevice,
    options?: RemoveDeviceOptions,
  ): Promise<void> {
    const device = this.state.devices.get(deviceId);
    if (!device) {
      return;
    }
    if (expectedDevice && device !== expectedDevice) {
      logger.debug(`Ignoring stale removal for replacement device ${deviceId}`);
      return;
    }
    this.state.sessionManager.flushDeferredRebindCleanups({ deviceId });
    if (holderOf(device)) {
      logger.warn(`Cannot remove device ${deviceId}: assigned to session ${holderOf(device)}`);
      return;
    }
    this.state.devices.delete(deviceId);
    this.releaseDeviceClaimOnRemoval(deviceId, options);
    if (device.platform === "android" && this.state.androidTransportAliases.retire(deviceId)) {
      this.state.androidAliasRetirement++;
    }
    this.state.deviceHealthMarkers.clear(deviceId);
    // Full: removal retires this runtime; onDeviceRemoved prunes stream state after registry retirement.
    this.notifyDeviceFramesInvalidated(deviceId);
    this.state.sessionManager.retireRestorations(deviceId, "removal");
    displayTransitions.reset(deviceId);
    getObserveCacheStore().clear(deviceId);
    getIosLockStateCache().invalidate(deviceId);
    this.state.refreshCoordinator.recordDeviceRemoval(deviceId);
    this.state.settledLateShutdowns.delete(deviceId);
    this.state.deferredDeviceReleases.delete(deviceId);
    this.notifyDeviceRemoved(deviceId, device.platform);
    this.state.deviceSessionStarts.delete(deviceId);
    this.state.refreshMissingDeviceMisses.reset(deviceId);
    this.dropTrackedProcessOnRemoval(deviceId, options);
    for (const [capturedSessionId, capture] of this.state.releasedDeviceCaptures) {
      if (capture.deviceId === deviceId) {
        this.state.releasedDeviceCaptures.delete(capturedSessionId);
      }
    }
    if (this.state.lastReleasedDeviceId === deviceId) {
      this.state.lastReleasedDeviceId = null;
    }
    const cacheCleanup = this.callbacks.clearDeviceSessionCache(deviceId);
    if (awaitCacheCleanup) {
      await cacheCleanup;
    } else {
      void cacheCleanup.catch((error) => {
        logger.warn(`[DevicePool] Deferred cache cleanup failed for ${deviceId}: ${error}`, error);
      });
    }
    logger.info(`Removed device ${deviceId} from pool and cleared cached data`);
  }

  /**
   * A verified AVD deletion retires the name's crash-loop history. Ordinary
   * pool removal and re-add keep it, because they can refer to the same AVD.
   */
  clearAndroidRebootBudgetForDeletedAvd(target: Pick<DeviceInfo, "platform" | "name">): void {
    if (target.platform === "android") {
      this.state.androidDeviceReboot.clear(target);
    }
  }

  removeDisconnectedDevice(
    deviceId: string,
    mayBeStaleSignal: boolean = true,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<void> {
    return this.state.disconnectHandler.removeDisconnectedDevice(
      deviceId,
      mayBeStaleSignal,
      incidentId,
      expectedDevice,
    );
  }

  /**
   * Opens a durable postmortem record without allowing diagnostics persistence
   * failure to block the critical device-loss cleanup path.
   */
  async recordEmulatorLossIncident(
    deviceId: string,
    detectionPath: EmulatorLossDetectionPath,
    processExit?: {
      code: number | null;
      signal: NodeJS.Signals | null;
    },
    lastAdbState?: string,
  ): Promise<string | undefined> {
    return this.state.emulatorLossLedger.recordEmulatorLossIncident(
      deviceId,
      detectionPath,
      processExit,
      lastAdbState,
    );
  }

  getDeviceManager(): PlatformDeviceManager {
    return this.state.deviceManager;
  }

  getTimer(): Timer {
    return this.state.timer;
  }

  async recordEmulatorLossRecoveryAttempt(
    incidentId: string | undefined,
    attempt: {
      attempt: number;
      outcome: "failed" | "succeeded";
    },
  ): Promise<void> {
    return this.state.emulatorLossLedger.recordEmulatorLossRecoveryAttempt(incidentId, attempt);
  }

  async completeEmulatorLossRecovery(
    incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
    releasedSessionState?: "awaiting-device",
  ): Promise<void> {
    return this.state.emulatorLossLedger.completeEmulatorLossRecovery(
      incidentId,
      outcome,
      releasedSessionState,
    );
  }

  buildEmulatorLossRecoverySettlement(
    incident: EmulatorLossIncident | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
    releasedSessionState?: "awaiting-device",
  ): EmulatorLossRecoverySettlement {
    return this.state.emulatorLossLedger.buildEmulatorLossRecoverySettlement(
      incident,
      outcome,
      releasedSessionState,
    );
  }

  async waitForEmulatorLossIncident(
    incidentId: string,
    timeoutMs?: number,
  ): Promise<Awaited<ReturnType<EmulatorLossIncidentStore["get"]>>> {
    return this.state.emulatorLossLedger.waitForEmulatorLossIncident(incidentId, timeoutMs);
  }

  settleEmulatorLossIncident(incidentId: string | undefined): void {
    this.state.emulatorLossLedger.settleEmulatorLossIncident(incidentId);
  }

  async finishEmulatorLossIncident(
    incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
  ): Promise<void> {
    return this.state.emulatorLossLedger.finishEmulatorLossIncident(incidentId, outcome);
  }

  isCurrentDisconnectedDevice(device: PooledDevice): Promise<CurrentDisconnectStatus> {
    return this.state.disconnectHandler.isCurrentDisconnectedDevice(device);
  }

  /** Notify only after the new entry is synchronously visible to allocators. */
  notifyDeviceIncarnationAssigned(deviceId: string): void {
    const incarnation = this.state.devices.get(deviceId)!.incarnation;
    try {
      this.state.onDeviceIncarnationAssigned?.(deviceId, incarnation);
    } catch (error) {
      logger.warn(`Device incarnation listener failed on ${deviceId}`, error);
    }
  }

  /** Assign the next monotonic incarnation id for a newly pooled connection. */
  nextDeviceIncarnation(): number {
    return this.state.devices.nextIncarnation();
  }
}

export function connectMembership(
  part: () => DevicePoolMembership,
  seams: Pick<
    DevicePoolOperations,
    | "initializeWithDevices"
    | "refreshDevices"
    | "refreshDevicesWithOutcome"
    | "getDeviceRemovalStampCountForTest"
    | "notifyDeviceReady"
    | "addDevice"
    | "replacePooledDeviceForRuntimeIdentity"
    | "removeDevice"
    | "clearAndroidRebootBudgetForDeletedAvd"
    | "removeDisconnectedDevice"
    | "recordEmulatorLossIncident"
    | "completeEmulatorLossRecovery"
    | "waitForEmulatorLossIncident"
    | "finishEmulatorLossIncident"
    | "isCurrentDisconnectedDevice"
  >,
): MembershipOperations {
  return {
    resolveRecoveryPolicy: (...args) => part().resolveRecoveryPolicy(...args),
    resolveDeviceSessionContinuity: (...args) => part().resolveDeviceSessionContinuity(...args),
    startAndroidRecoveryRecord: (...args) => part().startAndroidRecoveryRecord(...args),
    clearAdbResetRecoveryReservation: (...args) => part().clearAdbResetRecoveryReservation(...args),
    initializeWithDevices: (...args) => seams.initializeWithDevices(...args),
    refreshDevices: (...args) => seams.refreshDevices(...args),
    refreshDevicesWithOutcome: (...args) => seams.refreshDevicesWithOutcome(...args),
    getDeviceRemovalStampCountForTest: (...args) =>
      seams.getDeviceRemovalStampCountForTest(...args),
    refreshDevicesInternal: (...args) => part().refreshDevicesInternal(...args),
    notifyDeviceReady: (...args) => seams.notifyDeviceReady(...args),
    notifyDeviceStateChanged: (...args) => part().notifyDeviceStateChanged(...args),
    notifyDeviceFramesInvalidated: (...args) => part().notifyDeviceFramesInvalidated(...args),
    notifyDeviceRemoved: (...args) => part().notifyDeviceRemoved(...args),
    addDevice: (...args) => seams.addDevice(...args),
    recordSourceAndroidAvd: (...args) => part().recordSourceAndroidAvd(...args),
    replacePooledDeviceForRuntimeIdentity: (...args) =>
      seams.replacePooledDeviceForRuntimeIdentity(...args),
    dropTrackedProcessOnRemoval: (...args) => part().dropTrackedProcessOnRemoval(...args),
    releaseDeviceClaimOnRemoval: (...args) => part().releaseDeviceClaimOnRemoval(...args),
    removeDevice: (...args) => seams.removeDevice(...args),
    clearAndroidRebootBudgetForDeletedAvd: (...args) =>
      seams.clearAndroidRebootBudgetForDeletedAvd(...args),
    removeDisconnectedDevice: (...args) => seams.removeDisconnectedDevice(...args),
    recordEmulatorLossIncident: (...args) => seams.recordEmulatorLossIncident(...args),
    getDeviceManager: (...args) => part().getDeviceManager(...args),
    getTimer: (...args) => part().getTimer(...args),
    recordEmulatorLossRecoveryAttempt: (...args) =>
      part().recordEmulatorLossRecoveryAttempt(...args),
    completeEmulatorLossRecovery: (...args) => seams.completeEmulatorLossRecovery(...args),
    buildEmulatorLossRecoverySettlement: (...args) =>
      part().buildEmulatorLossRecoverySettlement(...args),
    waitForEmulatorLossIncident: (...args) => seams.waitForEmulatorLossIncident(...args),
    settleEmulatorLossIncident: (...args) => part().settleEmulatorLossIncident(...args),
    finishEmulatorLossIncident: (...args) => seams.finishEmulatorLossIncident(...args),
    isCurrentDisconnectedDevice: (...args) => seams.isCurrentDisconnectedDevice(...args),
    notifyDeviceIncarnationAssigned: (...args) => part().notifyDeviceIncarnationAssigned(...args),
    nextDeviceIncarnation: (...args) => part().nextDeviceIncarnation(...args),
  };
}
