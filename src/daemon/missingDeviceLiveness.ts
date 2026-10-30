import { clearDeviceError, markDeviceError, holderOf, isIdle } from "./deviceBinding";
import { logger } from "../utils/logger";
import type { BootedDevice, Platform } from "../models";
import type {
  BootedDeviceDiscovery,
  BootedDeviceDiscoveryOptions,
  PlatformDeviceManager,
} from "../devices/deviceUtils";
import {
  resetBootedDevicesResourceCache,
  resetAndroidDeviceImageResourceCache,
} from "./deviceResourceInvalidation";
import { consolePortFromSerial } from "../utils/android-cmdline-tools/EmulatorConsoleClient";
import { didSourceSucceedForDevice, type DiscoverySource } from "../utils/discoverySource";
import type { PooledDevice, RemoveDeviceOptions, SessionRecoveryPreparation } from "./devicePool";
import type { IdentityComparison } from "../devices/deviceIdentityEvidence";
import {
  MISSING_DEVICE_MISS_THRESHOLD,
  type DeviceLossMissPort,
  type MissingDeviceObservation,
} from "./deviceLossMisses";

export function classifyMissingDeviceObservation(
  sourceSucceeded: boolean,
  devicePresent: boolean,
): MissingDeviceObservation {
  return !sourceSucceeded ? "source-unavailable" : devicePresent ? "present" : "missing";
}

/** adb lost the serial but the emulator child may be alive: keep watching it (#11123). */
const LIVENESS_MISS_REMOVAL: RemoveDeviceOptions = { keepTrackedProcess: true };

type IdentityObservation = Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">;

export interface MissingDeviceEvictionOptions {
  attemptDeviceLossRecovery?: boolean;
  incidentId?: string;
  incidentCaptureComplete?: boolean;
  recoveryPreparation?: SessionRecoveryPreparation;
  identityObservation?: IdentityObservation;
  lockPoolRemoval?: boolean;
}

/** The pool's mutable state is read when used, including after every await. */
export interface MissingDeviceLivenessPoolPort {
  /** Tell resource subscribers a status or holder write committed (#11413). */
  noteDeviceStateChanged?(device: Pick<PooledDevice, "id" | "platform">): void;
  needsAndroidTransportNormalization?(devices: readonly BootedDevice[]): boolean;
  mapAndroidDiscovery?(devices: readonly BootedDevice[]): BootedDevice[];
  isTransportEmulator?(deviceId: string): boolean;
  getDevices(): ReadonlyMap<string, PooledDevice>;
  getRefreshMissingDeviceMisses(): DeviceLossMissPort;
  withAssignmentLock<T>(operation: () => Promise<T> | T): Promise<T>;
  getDeviceManager(): PlatformDeviceManager;
  getRefreshGeneration(): number;
  shouldRebootDisconnectedAndroidDevice(device: PooledDevice): boolean;
  matchesRuntimeIdentity(device: PooledDevice, booted: BootedDevice): boolean;
  reconcilePooledIdentityResolution(device: PooledDevice, booted: BootedDevice): Promise<void>;
  comparePooledIdentityEvidence(
    device: PooledDevice,
    observed: IdentityObservation,
  ): IdentityComparison;
  replacePooledDeviceForRuntimeIdentity(
    device: PooledDevice,
    booted: BootedDevice,
  ): Promise<boolean>;
  finishSessionPreservingRecoveryPreparation(
    preparation: SessionRecoveryPreparation | undefined,
  ): void;
  tryPreserveSessionForMissingDevice(
    device: PooledDevice,
    attempt: boolean,
    incidentId: string | undefined,
  ): Promise<boolean>;
  releaseSessionForEvictedDevice(
    device: PooledDevice,
    incidentId: string | undefined,
    observation?: IdentityObservation,
  ): Promise<boolean>;
  finishEmulatorLossIncident(
    incidentId: string | undefined,
    outcome: "not-attempted",
  ): Promise<void>;
  removeDisconnectedDevice(
    deviceId: string,
    mayBeStaleSignal: boolean,
    incidentId?: string,
  ): Promise<void>;
  completeEmulatorLossRecovery(
    incidentId: string | undefined,
    outcome: "not-attempted" | "exhausted",
  ): Promise<void>;
  settleEmulatorLossIncident(incidentId: string | undefined): void;
  removeDevice(
    deviceId: string,
    awaitCacheCleanup: boolean,
    expectedDevice: PooledDevice,
    options?: RemoveDeviceOptions,
  ): Promise<void>;
  isReservedForShutdown(device: PooledDevice): boolean;
  recordEmulatorLossIncident(
    deviceId: string,
    path: "device-discovery-miss",
    exit: undefined,
    state: "absent",
  ): Promise<string | undefined>;
}

/** Owns missing-device discovery decisions and eviction ordering. */
export class MissingDeviceLiveness {
  constructor(private readonly pool: MissingDeviceLivenessPoolPort) {}

  private noteStateChanged(device: PooledDevice): void {
    this.pool.noteDeviceStateChanged?.(device);
  }

  private async removeDevicesMissingFrom(
    bootedDeviceIds: Set<string>,
    bootedPlatforms: Set<Platform>,
    succeededPlatforms: Set<Platform>,
    succeededSources?: Set<DiscoverySource>,
  ): Promise<number> {
    let removedCount = 0;

    for (const device of Array.from(this.pool.getDevices().values())) {
      if (bootedDeviceIds.has(device.id)) {
        this.pool.getRefreshMissingDeviceMisses().observe(device.id, "present");
        continue;
      }
      if (holderOf(device)) {
        logger.warn(
          `Device ${device.id} is no longer booted but is assigned to session ${holderOf(device)}; keeping until session cleanup`,
        );
        continue;
      }
      // The source that would have listed this device failed or was unavailable
      // this refresh, so we cannot confirm the device is gone. Retain it rather
      // than pruning a device that may still be running (e.g. simctl failed
      // while devicectl and Android discovery succeeded). Asking per source
      // rather than per platform keeps one failing iOS half from either
      // freezing the other half's pruning or pruning its own devices (#5683).
      if (
        !didSourceSucceedForDevice(
          { succeededPlatforms, succeededSources },
          device.platform,
          device.id,
        )
      ) {
        this.pool.getRefreshMissingDeviceMisses().observe(device.id, "source-unavailable");
        logger.warn(
          `Device ${device.id} retained: ${device.platform} discovery did not succeed this refresh`,
        );
        continue;
      }
      const { misses, confirmedGone } = this.pool
        .getRefreshMissingDeviceMisses()
        .observe(device.id, "missing");
      logger.warn(
        `Device ${device.id} missing from ${device.platform} refresh discovery ` +
          `(miss ${misses}/${MISSING_DEVICE_MISS_THRESHOLD}, platform empty=${!bootedPlatforms.has(device.platform)})`,
      );
      if (!confirmedGone) {
        continue;
      }

      if (this.pool.shouldRebootDisconnectedAndroidDevice(device)) {
        // This prune runs inside assignmentMutex; the recovery reboot must not (#6391).
        this.startDetachedRecoveringEviction(device, "not present in refresh discovery");
      } else {
        await this.evictMissingPooledDevice(device, "not present in refresh discovery", {
          attemptDeviceLossRecovery: true,
        });
      }
      removedCount++;
    }

    return removedCount;
  }

  async removeMissingDevicesForRefresh(
    assignmentLockHeld: boolean,
    refreshGeneration: number,
    bootedDeviceIds: Set<string>,
    bootedPlatforms: Set<Platform>,
    {
      succeededPlatforms,
      succeededSources,
    }: Pick<BootedDeviceDiscovery, "succeededPlatforms" | "succeededSources">,
  ): Promise<number | undefined> {
    const removeMissingDevices = async () => {
      if (refreshGeneration !== this.pool.getRefreshGeneration()) {
        return undefined;
      }
      return await this.removeDevicesMissingFrom(
        bootedDeviceIds,
        bootedPlatforms,
        succeededPlatforms,
        succeededSources,
      );
    };
    return assignmentLockHeld
      ? await removeMissingDevices()
      : await this.pool.withAssignmentLock(removeMissingDevices);
  }

  /**
   * Whether a pooled entry must be re-proved PRESENT before it is handed out.
   *
   * Every Android entry must: a handset unplugged after the last refresh is
   * gone from `adb devices` but still sitting in the pool, and assigning it
   * hands a session a device that cannot answer (#6863 review).
   */
  shouldValidatePooledDevicePresence(device: PooledDevice): boolean {
    return device.platform === "android";
  }

  /**
   * Whether a pooled entry's serial can be REASSIGNED to a different runtime.
   *
   * Emulator console ports are the reused identifiers: `emulator-5554` is handed
   * to whichever AVD boots into that console slot next, so a serial that is
   * present still has to prove it is the same runtime. Transport aliases of an
   * emulator need the same reconciliation. A hardware handset serial's name
   * (`ro.product.model`) is not identity, so running it
   * through identity reconciliation could only produce false replacements.
   */
  hasReusableSerial(device: PooledDevice): boolean {
    return (
      device.platform === "android" &&
      (consolePortFromSerial(device.id) !== null ||
        this.pool.isTransportEmulator?.(device.id) === true)
    );
  }

  /** Confirm a pooled device is present, reconciling a reused serial when needed. */
  async ensurePooledDevicePresent(
    device: PooledDevice,
    deferRecovery: boolean,
    assignmentLockHeld: boolean,
    idleEviction: boolean,
    snapshot?: BootedDeviceDiscovery,
  ): Promise<boolean> {
    if (!this.shouldValidatePooledDevicePresence(device)) {
      return true;
    }

    const discovery = snapshot ?? (await this.takeFreshPresenceDiscovery(device.platform));
    const bootedDevice = discovery.devices.find((booted) => booted.deviceId === device.id);
    const observation = classifyMissingDeviceObservation(
      didSourceSucceedForDevice(discovery, device.platform, device.id),
      bootedDevice !== undefined,
    );
    if (observation === "source-unavailable") {
      this.pool.getRefreshMissingDeviceMisses().observe(device.id, "source-unavailable");
      logger.warn(
        `Retaining ${device.id}: ${device.platform} discovery did not succeed during assignment liveness check`,
      );
      return true;
    }

    if (observation === "present" && bootedDevice) {
      return this.hasReusableSerial(device)
        ? await this.reconcileDiscoveredPooledDevice(device, bootedDevice, assignmentLockHeld)
        : this.confirmLivePooledDevice(device);
    }

    // Assignment must reject an absent target now: handing it to a session
    // would fail immediately. The issue explicitly permits this single-shot
    // confirmation while background refresh and monitor sweeps are debounced.
    if (deferRecovery && this.pool.shouldRebootDisconnectedAndroidDevice(device)) {
      this.startDetachedRecoveringEviction(device, "not present in adb devices");
      return false;
    }
    if (idleEviction) {
      const claimed = await this.pool.withAssignmentLock(() => {
        // The discovery ran without the lock. A newer bind or incarnation wins
        // over its absent snapshot; claim before any other bind can select it.
        if (
          this.pool.getDevices().get(device.id) !== device ||
          !isIdle(device) ||
          holderOf(device) !== null
        ) {
          return false;
        }
        markDeviceError(device);
        return true;
      });
      if (!claimed) {
        return true;
      }
      // Notify after the mutex section, never inside it.
      this.noteStateChanged(device);
      const deferEviction = this.pool.shouldRebootDisconnectedAndroidDevice(device);
      const eviction = this.evictMissingPooledDevice(device, "not present in adb devices", {
        attemptDeviceLossRecovery: true,
        lockPoolRemoval: true,
      });
      if (deferEviction) {
        void eviction.catch((error) => {
          logger.warn(`[DevicePool] Deferred eviction failed for ${device.id}: ${error}`, error);
        });
        return false;
      }
      await eviction;
      return false;
    }
    await this.evictMissingPooledDevice(device, "not present in adb devices", {
      attemptDeviceLossRecovery: true,
    });
    return false;
  }

  /**
   * One fresh discovery sweep for presence checks. Bypass the platform's device-list
   * cache for this read without invalidating other callers' cached snapshot. iOS needs
   * it too: a mapped simulator listing taken before a fast boot stays cached for 5 s and
   * still shows the just-booted clone Shutdown, so the bind that follows the boot was
   * refused as "not available in the device pool" (#15295).
   */
  async takeFreshPresenceDiscovery(platform: Platform): Promise<BootedDeviceDiscovery> {
    resetBootedDevicesResourceCache();
    resetAndroidDeviceImageResourceCache();
    const discovery = await this.pool
      .getDeviceManager()
      .getBootedDevicesDetailed(platform, freshPresenceOptions(platform));
    return this.pool.mapAndroidDiscovery &&
      this.pool.needsAndroidTransportNormalization?.(discovery.devices)
      ? { ...discovery, devices: this.pool.mapAndroidDiscovery(discovery.devices) }
      : discovery;
  }

  /**
   * Settle a liveness check for a serial discovery still reports as booted:
   * either the pooled entry is the runtime that answered, or a different one
   * has taken the serial and the entry must be replaced.
   */
  async reconcileDiscoveredPooledDevice(
    device: PooledDevice,
    bootedDevice: BootedDevice,
    assignmentLockHeld: boolean,
  ): Promise<boolean> {
    if (this.pool.matchesRuntimeIdentity(device, bootedDevice)) {
      await this.pool.reconcilePooledIdentityResolution(device, bootedDevice);
      return this.confirmLivePooledDevice(device);
    }
    if (this.pool.comparePooledIdentityEvidence(device, bootedDevice) === "stale") {
      return this.confirmLivePooledDevice(device);
    }
    const replaced = await this.replaceIdlePooledDeviceForLivenessCheck(
      device,
      bootedDevice,
      assignmentLockHeld,
    );
    return !replaced && this.pool.getDevices().get(device.id) === device;
  }

  /**
   * Accept a pooled entry discovery just confirmed is present.
   *
   * Guarded on entry identity: a concurrent re-add can have replaced this entry
   * while discovery was in flight, and serial, platform and name cannot tell the
   * incarnations apart — only the pool's own entry object can — so the captured
   * object would be a previous incarnation and must not be handed out.
   */
  private confirmLivePooledDevice(device: PooledDevice): boolean {
    if (this.pool.getDevices().get(device.id) !== device) {
      logger.debug(`Rejecting superseded pooled incarnation of ${device.id} after liveness check`);
      return false;
    }
    this.pool.getRefreshMissingDeviceMisses().reset(device.id);
    return true;
  }

  private async replaceIdlePooledDeviceForLivenessCheck(
    device: PooledDevice,
    bootedDevice: BootedDevice,
    assignmentLockHeld: boolean,
  ): Promise<boolean> {
    const replaceIfStillIdle = async () => {
      if (
        this.pool.getDevices().get(device.id) !== device ||
        !isIdle(device) ||
        holderOf(device) !== null
      ) {
        return false;
      }
      if (this.pool.comparePooledIdentityEvidence(device, bootedDevice) === "stale") {
        return false;
      }
      return await this.pool.replacePooledDeviceForRuntimeIdentity(device, bootedDevice);
    };
    return assignmentLockHeld
      ? await replaceIfStillIdle()
      : await this.pool.withAssignmentLock(replaceIfStillIdle);
  }

  /**
   * Start a recovering eviction without awaiting it, marking the entry
   * unassignable meanwhile. The Android recovery it runs stops and cold-boots an
   * emulator for minutes, so no assignmentMutex critical section may await it
   * (#6391): the lifecycle lease serializes the boot instead, and the eviction
   * re-validates pool identity after each await.
   */
  private startDetachedRecoveringEviction(device: PooledDevice, reason: string): void {
    const eviction = this.evictMissingPooledDevice(device, reason, {
      attemptDeviceLossRecovery: true,
    });
    if (this.pool.getDevices().get(device.id) === device) {
      markDeviceError(device);
      this.noteStateChanged(device);
    }
    void eviction.catch((error) => {
      logger.warn(`[DevicePool] Deferred eviction failed for ${device.id}: ${error}`, error);
    });
  }

  async evictMissingPooledDevice(
    device: PooledDevice,
    reason: string,
    options: MissingDeviceEvictionOptions = {},
  ): Promise<void> {
    const {
      attemptDeviceLossRecovery = false,
      incidentId,
      incidentCaptureComplete = false,
      recoveryPreparation,
      identityObservation,
      lockPoolRemoval,
    } = options;
    const abortReason = this.shouldAbortEvictionUpfront(device, reason, identityObservation);
    if (abortReason) {
      if (incidentId) {
        await this.pool.finishEmulatorLossIncident(incidentId, "not-attempted");
      }
      return;
    }
    logger.warn(`Evicting device ${device.id} from pool: ${reason}`);
    const correlatedIncidentId = await this.resolveMissingDeviceIncident(
      device,
      attemptDeviceLossRecovery,
      incidentId,
      incidentCaptureComplete,
    );
    this.pool.finishSessionPreservingRecoveryPreparation(recoveryPreparation);
    if (
      await this.pool.tryPreserveSessionForMissingDevice(
        device,
        attemptDeviceLossRecovery,
        correlatedIncidentId,
      )
    ) {
      // SessionPreservingRecovery owns settlement, including its deferred recovery record.
      return;
    }
    if (
      holderOf(device) &&
      !(await this.releaseSessionForEviction(device, correlatedIncidentId, identityObservation))
    ) {
      return;
    }
    if (this.pool.getDevices().get(device.id) !== device) {
      await this.pool.finishEmulatorLossIncident(correlatedIncidentId, "not-attempted");
      return;
    }
    return this.dispatchEvictedDeviceRemoval(
      device,
      attemptDeviceLossRecovery,
      correlatedIncidentId,
      identityObservation,
      lockPoolRemoval,
    );
  }

  private async dispatchEvictedDeviceRemoval(
    device: PooledDevice,
    attemptDeviceLossRecovery: boolean,
    correlatedIncidentId: string | undefined,
    identityObservation: IdentityObservation | undefined,
    lockPoolRemoval: boolean | undefined,
  ): Promise<void> {
    this.prepareEvictedDeviceForRemoval(device, lockPoolRemoval);
    if (attemptDeviceLossRecovery && this.pool.shouldRebootDisconnectedAndroidDevice(device)) {
      if (this.shouldAbortEvictionForStaleIdentityObservation(device, identityObservation)) {
        await this.pool.finishEmulatorLossIncident(correlatedIncidentId, "not-attempted");
        return;
      }
      await this.pool.removeDisconnectedDevice(device.id, false, correlatedIncidentId);
      return;
    }
    await this.completeEvictionWithoutRecovery(
      device,
      correlatedIncidentId,
      identityObservation,
      lockPoolRemoval,
    );
  }

  private async releaseSessionForEviction(
    device: PooledDevice,
    incidentId: string | undefined,
    identityObservation?: IdentityObservation,
  ): Promise<boolean> {
    try {
      const released = await this.pool.releaseSessionForEvictedDevice(
        device,
        incidentId,
        identityObservation,
      );
      // The pool already finishes the incident when release sees a replacement.
      if (!released && this.pool.getDevices().get(device.id) === device) {
        await this.pool.finishEmulatorLossIncident(incidentId, "not-attempted");
      }
      return released;
    } catch (error) {
      await this.pool.completeEmulatorLossRecovery(incidentId, "exhausted");
      this.pool.settleEmulatorLossIncident(incidentId);
      logger.warn(`[DevicePool] Eviction session release failed for ${device.id}`, error);
      throw error;
    }
  }

  private async completeEvictionWithoutRecovery(
    device: PooledDevice,
    incidentId: string | undefined,
    identityObservation?: IdentityObservation,
    lockPoolRemoval?: boolean,
  ): Promise<void> {
    try {
      await this.pool.completeEmulatorLossRecovery(incidentId, "not-attempted");
      if (this.shouldAbortEvictionForStaleIdentityObservation(device, identityObservation)) {
        return;
      }
      await this.removeEvictedDevice(device, lockPoolRemoval);
    } catch (error) {
      // No coordinator ran here: cleanup failure replaces only our preliminary outcome.
      await this.pool.completeEmulatorLossRecovery(incidentId, "exhausted");
      logger.warn(`[DevicePool] Eviction cleanup failed for ${device.id}`, error);
      throw error;
    } finally {
      this.pool.settleEmulatorLossIncident(incidentId);
    }
  }

  private async removeEvictedDevice(
    device: PooledDevice,
    lockPoolRemoval?: boolean,
  ): Promise<void> {
    if (!lockPoolRemoval) {
      await this.pool.removeDevice(device.id, true, device, LIVENESS_MISS_REMOVAL);
      return;
    }
    // Incident and recovery I/O completed before assignmentMutex. Only the
    // compare-and-delete runs under the lock, after any lifecycle lease settles.
    await this.pool.withAssignmentLock(() =>
      this.pool.removeDevice(device.id, false, device, LIVENESS_MISS_REMOVAL),
    );
  }

  private prepareEvictedDeviceForRemoval(device: PooledDevice, lockPoolRemoval?: boolean): void {
    // An idle preallocation eviction already claimed this entry as error under
    // assignmentMutex; keep it unavailable until its guarded removal completes.
    if (!lockPoolRemoval) {
      clearDeviceError(device);
      this.noteStateChanged(device);
    }
  }

  private shouldAbortEvictionUpfront(
    device: PooledDevice,
    reason: string,
    identityObservation?: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
  ): "stale" | "shutdown-reserved" | undefined {
    if (this.shouldAbortEvictionForStaleIdentityObservation(device, identityObservation)) {
      return "stale";
    }
    if (this.pool.isReservedForShutdown(device)) {
      // killDevice alone owns a shutdown-reserved incarnation until it either
      // retires it or atomically hands off a same-ID replacement. Discovery
      // pruning must not remove it in the middle of that handoff.
      logger.debug(`Deferring eviction of shutdown-reserved device ${device.id}: ${reason}`);
      return "shutdown-reserved";
    }
    return undefined;
  }

  private shouldAbortEvictionForStaleIdentityObservation(
    device: PooledDevice,
    identityObservation?: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
  ): boolean {
    if (
      !identityObservation ||
      this.pool.comparePooledIdentityEvidence(device, identityObservation) !== "stale"
    ) {
      return false;
    }
    logger.debug(
      `[DevicePool] Aborting eviction of ${device.id}: a newer identity observation confirmed it during eviction`,
    );
    return true;
  }

  async resolveMissingDeviceIncident(
    device: PooledDevice,
    attemptDeviceLossRecovery: boolean,
    incidentId: string | undefined,
    incidentCaptureComplete: boolean,
  ): Promise<string | undefined> {
    if (incidentId || !attemptDeviceLossRecovery || incidentCaptureComplete) {
      return incidentId;
    }
    return await this.pool.recordEmulatorLossIncident(
      device.id,
      "device-discovery-miss",
      undefined,
      "absent",
    );
  }
}

/** Each platform's cache bypass; the watch listing has no cache, so it reads fresh as is (#14908). */
function freshPresenceOptions(platform: Platform): BootedDeviceDiscoveryOptions {
  switch (platform) {
    case "android":
      return { bypassAndroidDeviceListCache: true };
    case "ios":
      return { bypassIosDeviceListCache: true };
    case "watchos":
      return {};
  }
}
