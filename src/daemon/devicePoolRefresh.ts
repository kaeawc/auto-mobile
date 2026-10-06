import { truncateBodyText } from "../utils/truncateBodyText";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { Mutex } from "async-mutex";
import type { BootedDevice, Platform } from "../models";
import type { BootedDeviceDiscovery, PlatformDeviceManager } from "../devices/deviceUtils";
import type { Timer } from "../utils/SystemTimer";
import { createGlobalPerformanceTracker } from "../utils/PerformanceTracker";
import {
  didSourceSucceedForDevice,
  type DiscoveryCompleteness,
  type DiscoverySource,
} from "../utils/discoverySource";
import type { DeviceCriteriaMatcher } from "./DeviceCriteriaMatcher";
import type { PooledDevice } from "./devicePool";
import type { IdentityEvidence } from "../devices/deviceIdentityEvidence";

export interface DevicePoolRefreshResult {
  addedCount: number;
  completeness?: DiscoveryCompleteness;
  failure?: string;
}

/** Preserve partial discovery and report Android failures through the refresh outcome. */
export function discoveryRefreshOutcome(
  discovery: BootedDeviceDiscovery,
  addedCount: number,
): DevicePoolRefreshResult {
  const androidError = discovery.discoveryErrors?.android;
  return {
    addedCount,
    ...(androidError && androidError.code !== "unavailable"
      ? { failure: androidError.message }
      : {}),
  };
}

/** Client-facing form of the existing refresh failure, bounded independently of logs. */
export function deviceListRefreshFailureMessage(failure: string): string {
  return `Could not refresh device list: ${truncateBodyText(failure.split(/[\r\n\u2028\u2029]/, 1)[0], 256)}. Resolve the cause and retry.`;
}

/** Live pool state is read at each use, including after awaits. */
export interface DevicePoolRefreshPort {
  getTimer(): Timer;
  getDeviceManager(): PlatformDeviceManager;
  getDevices(): Map<string, PooledDevice>;
  getAssignmentMutex(): Mutex;
  getCriteriaMatcher(): DeviceCriteriaMatcher;
  identityEvidenceForBootedDevice(device: BootedDevice): IdentityEvidence;
  identityEvidenceFields(
    evidence: IdentityEvidence,
  ): Pick<PooledDevice, "identityObservedAt" | "identityUnresolved">;
  getDeviceSessionStarts(): Map<string, number>;
  getRefreshMissingDeviceMisses(): Map<string, number>;
  getSettledLateShutdowns(): Map<string, { incarnation: number; refreshGeneration: number }>;
  getIntentionalShutdowns(): Map<string, number>;
  seedLastUsedAt(now: number): number;
  nextDeviceIncarnation(): number;
  setDeviceSessionTracking(deviceId: string, now: number): Promise<void>;
  clearAutoStartSuppressionForBootedDevice(device: BootedDevice): void;
  foldObservationIntoPooledEntry(
    pooledDevice: PooledDevice,
    device: BootedDevice,
    source: "refresh",
  ): Promise<boolean | undefined>;
  removeMissingDevicesForRefresh(
    assignmentLockHeld: boolean,
    refreshGeneration: number,
    bootedDeviceIds: Set<string>,
    bootedPlatforms: Set<Platform>,
    succeededPlatforms: Set<Platform>,
    succeededSources?: Set<DiscoverySource>,
  ): Promise<number | undefined>;
  notifyDeviceReady(deviceId: string): void;
  /** Lift recovery reservations a fresh observation of this generation decides. */
  liftUnconfirmedRecoveringAndroidImages(
    discovery: BootedDeviceDiscovery,
    refreshGeneration: number,
  ): void;
}

/** Owns discovery scheduling, fresh observations, and generation fences. */
export class DevicePoolRefresh {
  private refreshGeneration = 0;
  private deviceRemovalGeneration = 0;
  private readonly deviceRemovalStamps = new Map<string, number>();
  private readonly targetDiscoveryFloors = new Map<symbol, number>();
  private readonly inFlightRefreshFloors = new Map<number, number>();

  constructor(private readonly pool: DevicePoolRefreshPort) {}

  getRefreshGeneration(): number {
    return this.refreshGeneration;
  }

  recordDeviceRemoval(deviceId: string): void {
    this.deviceRemovalStamps.set(deviceId, ++this.deviceRemovalGeneration);
  }

  /** Retain removal stamps until this unlocked target observation is consumed. */
  captureDeviceRemovalFence(deviceId: string): { wasRemoved: () => boolean; release: () => void } {
    const token = Symbol(deviceId);
    const floor = this.deviceRemovalGeneration;
    this.targetDiscoveryFloors.set(token, floor);
    return {
      wasRemoved: () => (this.deviceRemovalStamps.get(deviceId) ?? 0) > floor,
      release: () => {
        this.targetDiscoveryFloors.delete(token);
        this.pruneDeviceRemovalStamps();
      },
    };
  }

  getDeviceRemovalStampCountForTest(): number {
    return this.deviceRemovalStamps.size;
  }

  async refreshDevices(): Promise<number> {
    return (await this.refreshDevicesInternal(false)).addedCount;
  }

  async refreshDevicesInternal(assignmentLockHeld: boolean): Promise<DevicePoolRefreshResult> {
    const startTime = this.pool.getTimer().now();
    const perf = createGlobalPerformanceTracker();
    const refreshGeneration = ++this.refreshGeneration;
    const removalGenerationAtDiscoveryStart = this.deviceRemovalGeneration;
    this.inFlightRefreshFloors.set(refreshGeneration, removalGenerationAtDiscoveryStart);
    try {
      logger.info("Refreshing device pool - discovering connected devices...");

      // Log environment for debugging CI issues
      const androidHome = process.env.ANDROID_HOME || "(not set)";
      const androidSdkRoot = process.env.ANDROID_SDK_ROOT || "(not set)";
      logger.info(`Environment: ANDROID_HOME=${androidHome}, ANDROID_SDK_ROOT=${androidSdkRoot}`);

      perf.startOperation("deviceDiscovery");
      const discovery = await this.pool.getDeviceManager().getBootedDevicesDetailed("either", {
        bypassAndroidDeviceListCache: true,
        bypassIosDeviceListCache: true,
      });
      perf.endOperation("deviceDiscovery");
      const bootedDevices = discovery.devices;
      const discoveryTime = this.pool.getTimer().now() - startTime;
      logger.info(
        `Device discovery completed in ${discoveryTime}ms, found ${bootedDevices.length} devices`,
      );

      const now = this.pool.seedLastUsedAt(this.pool.getTimer().now());
      let addedCount = 0;
      let removedCount = 0;
      const bootedDeviceIds = new Set(bootedDevices.map((device) => device.deviceId));
      const bootedPlatforms = new Set(bootedDevices.map((device) => device.platform));

      perf.startOperation("poolUpdate");
      const removed = await this.pool.removeMissingDevicesForRefresh(
        assignmentLockHeld,
        refreshGeneration,
        bootedDeviceIds,
        bootedPlatforms,
        discovery.succeededPlatforms,
        discovery.succeededSources,
      );
      if (removed === undefined) {
        logger.info("Discarding an out-of-date device discovery snapshot");
        return { addedCount: 0 };
      }
      removedCount = removed;

      for (const device of bootedDevices) {
        const updatePooledDevice = async () => {
          if (
            this.shouldSkipRefreshedDevice(
              device.deviceId,
              refreshGeneration,
              removalGenerationAtDiscoveryStart,
            )
          ) {
            return undefined;
          }
          this.pool.clearAutoStartSuppressionForBootedDevice(device);
          const pooledDevice = this.pool.getDevices().get(device.deviceId);
          if (pooledDevice) {
            const updated = await this.pool.foldObservationIntoPooledEntry(
              pooledDevice,
              device,
              "refresh",
            );
            this.liftSettledShutdownAfterFreshObservation(
              device,
              pooledDevice,
              discovery,
              refreshGeneration,
            );
            return updated;
          }
          this.pool.getDevices().set(device.deviceId, {
            id: device.deviceId,
            name: device.name,
            platform: device.platform,
            sessionId: null,
            status: "idle",
            lastUsedAt: now,
            assignmentCount: 0,
            errorCount: 0,
            iosVersion: device.iosVersion,
            simulatorType: this.pool.getCriteriaMatcher().getBootedDeviceSimulatorType(device),
            ...(device.observedAt !== undefined ? { nameObservedAt: device.observedAt } : {}),
            ...this.pool.identityEvidenceFields(this.pool.identityEvidenceForBootedDevice(device)),
            incarnation: this.pool.nextDeviceIncarnation(),
          });
          this.pool.getDeviceSessionStarts().set(device.deviceId, now);
          this.pool.getRefreshMissingDeviceMisses().delete(device.deviceId);
          await this.pool.setDeviceSessionTracking(device.deviceId, now);
          logger.info(`Added device ${device.deviceId} to pool during refresh`);
          return true;
        };
        const added = assignmentLockHeld
          ? await updatePooledDevice()
          : await this.pool.getAssignmentMutex().runExclusive(updatePooledDevice);
        if (added) {
          addedCount++;
        }
        this.notifyRefreshedDeviceReady(device.deviceId, added);
      }
      perf.endOperation("poolUpdate");
      // After the pool update, so a still-running AVD is already pooled when its
      // unconfirmed recovery reservation lifts.
      this.pool.liftUnconfirmedRecoveringAndroidImages(discovery, refreshGeneration);

      if (addedCount > 0 || removedCount > 0) {
        logger.info(
          `Device pool refreshed: added ${addedCount}, removed ${removedCount} ` +
            `(total: ${this.pool.getDevices().size})`,
        );
      } else if (bootedDevices.length === 0) {
        logger.warn("No devices found during pool refresh. Is an emulator running?");
        logger.warn(
          "Ensure 'adb devices' returns connected devices in the daemon process environment.",
        );
      } else {
        logger.debug(`Device pool refresh: all ${bootedDevices.length} devices already in pool`);
      }

      return {
        ...discoveryRefreshOutcome(discovery, addedCount),
        completeness: this.currentRefreshCompleteness(discovery, refreshGeneration),
      };
    } catch (error) {
      const elapsed = this.pool.getTimer().now() - startTime;
      const failure = errorMessage(error) || "Unknown refresh failure";
      logger.warn(`Failed to refresh device pool after ${elapsed}ms: ${failure}`, error);
      return { addedCount: 0, failure };
    } finally {
      this.inFlightRefreshFloors.delete(refreshGeneration);
      this.pruneDeviceRemovalStamps();
    }
  }

  private currentRefreshCompleteness(
    discovery: BootedDeviceDiscovery,
    refreshGeneration: number,
  ): DiscoveryCompleteness | undefined {
    // A newer generation may have started between individual pool updates.
    // Partial/superseded updates never provide authoritative absence evidence.
    return refreshGeneration === this.refreshGeneration
      ? {
          succeededPlatforms: discovery.succeededPlatforms,
          succeededSources: discovery.succeededSources,
        }
      : undefined;
  }

  private pruneDeviceRemovalStamps(): void {
    const floor = Math.min(
      this.deviceRemovalGeneration,
      ...this.inFlightRefreshFloors.values(),
      ...this.targetDiscoveryFloors.values(),
    );
    for (const [deviceId, stamp] of this.deviceRemovalStamps) {
      if (stamp <= floor) {
        this.deviceRemovalStamps.delete(deviceId);
      }
    }
  }

  private shouldSkipRefreshedDevice(
    deviceId: string,
    refreshGeneration: number,
    removalGenerationAtDiscoveryStart: number,
  ): boolean {
    return (
      refreshGeneration !== this.refreshGeneration ||
      (this.deviceRemovalStamps.get(deviceId) ?? 0) > removalGenerationAtDiscoveryStart
    );
  }

  private notifyRefreshedDeviceReady(deviceId: string, added: boolean | undefined): void {
    if (added !== undefined) {
      this.pool.notifyDeviceReady(deviceId);
    }
  }

  private liftSettledShutdownAfterFreshObservation(
    device: BootedDevice,
    pooledDevice: PooledDevice,
    discovery: BootedDeviceDiscovery,
    refreshGeneration: number,
  ): void {
    const settled = this.pool.getSettledLateShutdowns().get(device.deviceId);
    if (
      settled?.incarnation === pooledDevice.incarnation &&
      refreshGeneration > settled.refreshGeneration &&
      this.pool.getDevices().get(device.deviceId) === pooledDevice &&
      !pooledDevice.identityUnresolved &&
      (discovery.freshDeviceIds
        ? discovery.freshDeviceIds.has(device.deviceId)
        : didSourceSucceedForDevice(discovery, device.platform, device.deviceId))
    ) {
      this.pool.getIntentionalShutdowns().delete(device.deviceId);
      this.pool.getSettledLateShutdowns().delete(device.deviceId);
    }
  }
}
