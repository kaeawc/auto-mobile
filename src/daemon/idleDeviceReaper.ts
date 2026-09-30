import { logger } from "../utils/logger";
import { didSourceSucceedForDevice } from "../utils/discoverySource";
import { isIosPhysicalUdid } from "../utils/ios-cmdline-tools/iosDeviceType";
import type { PlatformDeviceManager } from "../devices/deviceUtils";
import type { PooledDevice } from "./devicePool";

/**
 * One iOS liveness sweep, carrying completeness per source (#5683).
 *
 * `discoverySucceeded` is the simulator (`simctl`) half and keeps its original
 * meaning; `physicalDiscoverySucceeded` is the devicectl half.
 *
 * `bootedDeviceIds` holds only devices a source **freshly** observed this
 * sweep. That distinction is load-bearing: `DevicectlDeviceLister` replays its
 * last-good listing for up to 60s behind `complete: false`, so a returned
 * device is not by itself proof of liveness — only a returned device whose own
 * source completed is.
 */
export interface IosLivenessSnapshot {
  discoverySucceeded: boolean;
  physicalDiscoverySucceeded: boolean;
  bootedDeviceIds: Set<string>;
}

export type IdleDeviceLivenessStatus = "assignable" | "stale" | "unknown";

export interface IdleDeviceReaperPoolPort {
  getDevice(deviceId: string): PooledDevice | null;
  removeDevice(
    deviceId: string,
    awaitCacheCleanup: boolean,
    expectedDevice: PooledDevice,
  ): Promise<void>;
  withAssignmentLock<T>(operation: () => Promise<T>): Promise<T>;
}

/** Prunes stale idle iOS entries without applying an older sweep to a new incarnation. */
export class IdleDeviceReaper {
  constructor(
    private readonly pool: IdleDeviceReaperPoolPort,
    private readonly deviceManager: Pick<PlatformDeviceManager, "getBootedDevicesDetailed">,
  ) {}

  async pruneStaleIdleIosDevices(candidates: PooledDevice[]): Promise<number> {
    const iosCandidates = candidates.filter((candidate) => {
      const device = this.pool.getDevice(candidate.id);
      return device?.platform === "ios" && device.status === "idle" && !device.sessionId;
    });
    if (iosCandidates.length === 0) {
      return 0;
    }

    const iosLiveness = await this.getIosLivenessSnapshot();
    if (!iosLiveness.discoverySucceeded && !iosLiveness.physicalDiscoverySucceeded) {
      logger.warn(
        "[DevicePool] Retaining idle iOS devices: no iOS liveness source completed before allocation planning",
      );
      return 0;
    }

    let removedCount = 0;
    for (const candidate of iosCandidates) {
      const device = this.pool.getDevice(candidate.id);
      if (device !== candidate || device.status !== "idle" || device.sessionId) {
        continue;
      }
      if (this.getIdleDeviceLivenessStatus(device, iosLiveness) === "stale") {
        logger.warn(
          `[DevicePool] Removing idle iOS ${this.iosDeviceNoun(device.id)} ${device.id}: ` +
            "iOS discovery no longer reports it as booted",
        );
        // Discovery completed outside the lock. Recheck the captured entry
        // under assignmentMutex before applying its snapshot to the pool.
        const removed = await this.pool.withAssignmentLock(async () => {
          if (
            this.pool.getDevice(device.id) !== device ||
            device.status !== "idle" ||
            device.sessionId
          ) {
            return false;
          }
          await this.pool.removeDevice(device.id, false, device);
          return !this.pool.getDevice(device.id);
        });
        if (removed) {
          removedCount++;
        }
      }
    }
    return removedCount;
  }

  async getIosLivenessSnapshot(): Promise<IosLivenessSnapshot> {
    const discovery = await this.deviceManager.getBootedDevicesDetailed("ios");
    const sources = discovery.succeededSources;
    const platformSucceeded = discovery.succeededPlatforms.has("ios");
    // Presence alone does not prove liveness: a failed devicectl sweep replays
    // its retained last-good iPhones, and treating those as fresh would hand an
    // unplugged device to a session instead of raising the intended
    // unable-to-verify error. Freshness is decided per device rather than per
    // source, because devicectl also reports source-wide incompleteness for a
    // sweep in which a device WAS freshly parsed beside one unreadable record —
    // dropping that device would reject a connected iPhone.
    const fresh = discovery.freshDeviceIds;
    return {
      discoverySucceeded: sources ? sources.has("ios-simulator") : platformSucceeded,
      physicalDiscoverySucceeded: sources ? sources.has("ios-physical") : platformSucceeded,
      bootedDeviceIds: new Set(
        discovery.devices
          .map((booted) => booted.deviceId)
          .filter((deviceId) =>
            // Producers that do not report freshness fall back to the source
            // aggregate, which is what they meant before #5683.
            fresh ? fresh.has(deviceId) : didSourceSucceedForDevice(discovery, "ios", deviceId),
          ),
      ),
    };
  }

  /** "simulator" or "device", so a log about a physical iPhone reads truthfully. */
  iosDeviceNoun(deviceId: string): string {
    return isIosPhysicalUdid(deviceId) ? "device" : "simulator";
  }

  getIdleDeviceLivenessStatus(
    device: PooledDevice,
    iosLiveness: IosLivenessSnapshot | undefined,
  ): IdleDeviceLivenessStatus {
    if (device.platform !== "ios") {
      return "assignable";
    }

    if (!iosLiveness) {
      return "unknown";
    }

    // A fresh observation by either source outranks the other's failure: a
    // devicectl-confirmed iPhone stays assignable through a failed simctl
    // sweep, and an idle simulator through a failed devicectl sweep (#5683).
    // The snapshot has already dropped retained-but-unverified ids.
    if (iosLiveness.bootedDeviceIds.has(device.id)) {
      return "assignable";
    }

    // Only the source that would have listed this device can call it gone.
    const observingSourceSucceeded = isIosPhysicalUdid(device.id)
      ? iosLiveness.physicalDiscoverySucceeded
      : iosLiveness.discoverySucceeded;
    return observingSourceSucceeded ? "stale" : "unknown";
  }
}
