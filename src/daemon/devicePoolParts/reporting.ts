import { isErrored, holderOf, statusOf } from "../deviceBinding";
import { deviceHold, poolBucketOf, type PoolStatusBucket } from "../deviceHold";
import { logger } from "../../utils/logger";
import { Platform } from "../../models";
import { getInstalledAppsCacheWriteCoordinator } from "../../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../../db/dbWriteBarrier";
import type { PooledDevice } from "../devicePoolTypes";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface ReportingOperations {
  poolBucketFor(device: PooledDevice): PoolStatusBucket;
  /** The bucket {@link getStats} counts `deviceId` in, or null when the pool does not know it. */
  poolBucket(deviceId: string): PoolStatusBucket | null;
  getStatsForPlatform(
    platform?: Platform,
    live?: ReadonlySet<string>,
  ): {
    total: number;
    idle: number;
    assigned: number;
    error: number;
  };
  /**
   * Get pool statistics for monitoring
   */
  getStats(live?: ReadonlySet<string>): {
    total: number;
    idle: number;
    assigned: number;
    error: number;
    avgAssignments: number;
  };
  /**
   * Get detailed status report
   */
  getStatusReport(): string;
  setDeviceSessionTracking(deviceId: string, sessionStart: number): Promise<void>;
  clearDeviceSessionCache(deviceId: string): Promise<void>;
}
type ReportingState = Pick<
  DevicePoolState,
  "devices" | "installedAppsRepository" | "daemonSessionId"
>;
export type ReportingCallbacks = Pick<
  DevicePoolOperations,
  "holdFactsFor" | "getDevicesByPlatform" | "getAllDevices" | "getStatsForPlatform" | "getStats"
>;

/** Reporting responsibilities of DevicePool. */
export class DevicePoolReporting {
  constructor(
    private readonly state: ReportingState,
    private readonly callbacks: ReportingCallbacks,
  ) {}
  /** A device allocation cannot lend (#11387): held, reserved, or carrying a health marker. */
  poolBucketFor(device: PooledDevice): PoolStatusBucket {
    return poolBucketOf(deviceHold(this.callbacks.holdFactsFor(device, undefined, "bucket")));
  }

  /** The bucket {@link getStats} counts `deviceId` in, or null when the pool does not know it. */
  poolBucket(deviceId: string): PoolStatusBucket | null {
    const device = this.state.devices.get(deviceId);
    return device ? this.poolBucketFor(device) : null;
  }

  getStatsForPlatform(
    platform?: Platform,
    live?: ReadonlySet<string>,
  ): {
    total: number;
    idle: number;
    assigned: number;
    error: number;
  } {
    const devices = this.callbacks
      .getDevicesByPlatform(platform)
      .filter((device) => !live || live.has(device.id));
    // Same derivation as getStats (#11317, #11387): one bucket per device. `total` (capacity
    // gating) is the device count.
    const buckets = devices.map((device) => this.poolBucketFor(device));
    const idle = buckets.filter((bucket) => bucket === "idle").length;
    const assigned = buckets.filter((bucket) => bucket === "assigned").length;
    const error = buckets.filter((bucket) => bucket === "error").length;
    return {
      total: devices.length,
      idle,
      assigned,
      error,
    };
  }

  /**
   * Get pool statistics for monitoring
   */
  getStats(live?: ReadonlySet<string>): {
    total: number;
    idle: number;
    assigned: number;
    error: number;
    avgAssignments: number;
  } {
    const all = this.callbacks.getAllDevices().filter((device) => !live || live.has(device.id));
    const { idle, assigned, error } = this.callbacks.getStatsForPlatform(undefined, live);
    const avgAssignments =
      all.length > 0
        ? Math.round(all.reduce((sum, d) => sum + d.assignmentCount, 0) / all.length)
        : 0;
    return {
      total: all.length,
      idle,
      assigned,
      error,
      avgAssignments,
    };
  }

  /**
   * Get detailed status report
   */
  getStatusReport(): string {
    const stats = this.callbacks.getStats();
    const lines = [
      "\n=== Device Pool Status ===",
      `Total Devices: ${stats.total}`,
      `  Idle:       ${stats.idle}`,
      `  Assigned:   ${stats.assigned}`,
      `  Error:      ${stats.error}`,
      `Avg Assignments: ${stats.avgAssignments}`,
      "",
      "Device Details:",
    ];
    for (const device of this.callbacks.getAllDevices()) {
      const status = isErrored(device) ? "❌" : holderOf(device) ? "🔴" : "🟢";
      const session = holderOf(device) ? ` (${holderOf(device)})` : "";
      lines.push(
        `  ${status} ${device.id}: ${statusOf(device)}${session} (${device.assignmentCount} uses, ${device.errorCount} errors)`,
      );
    }
    lines.push("=== End Report ===\n");
    return lines.join("\n");
  }

  /**
   * Set session tracking for a device in the installed apps cache
   */
  async setDeviceSessionTracking(deviceId: string, sessionStart: number): Promise<void> {
    try {
      await this.state.installedAppsRepository.setSessionTracking(
        this.state.daemonSessionId,
        deviceId,
        sessionStart,
      );
    } catch (error) {
      logger.warn(`Failed to set session tracking for device ${deviceId}: ${error}`);
    }
  }

  /**
   * Clear installed apps cache for a device session
   */
  async clearDeviceSessionCache(deviceId: string): Promise<void> {
    try {
      await getInstalledAppsCacheWriteCoordinator().invalidate(deviceId, () =>
        getDbWriteBarrier()
          .track(() => this.state.installedAppsRepository.clearDeviceSession(deviceId))
          .then(() => undefined),
      );
      // The device has left the pool for good, so forget its per-device
      // cache-coherence bookkeeping now that the final invalidation above has
      // drained — otherwise the coordinator retains a generation entry for every
      // device id the daemon ever saw (#6704). releaseDevice is generation-safe:
      // a rebuild that predates it cannot commit, and a reused serial starts clean.
      await getInstalledAppsCacheWriteCoordinator().releaseDevice(deviceId);
      logger.info(`[DevicePool] Cleared installed apps cache for device ${deviceId}`);
    } catch (error) {
      logger.warn(`Failed to clear device session cache for ${deviceId}: ${error}`);
    }
  }
}

export function connectReporting(
  part: () => DevicePoolReporting,
  seams: Pick<
    DevicePoolOperations,
    | "poolBucket"
    | "getStatsForPlatform"
    | "getStats"
    | "getStatusReport"
    | "setDeviceSessionTracking"
    | "clearDeviceSessionCache"
  >,
): ReportingOperations {
  return {
    poolBucketFor: (...args) => part().poolBucketFor(...args),
    poolBucket: (...args) => seams.poolBucket(...args),
    getStatsForPlatform: (...args) => seams.getStatsForPlatform(...args),
    getStats: (...args) => seams.getStats(...args),
    getStatusReport: (...args) => seams.getStatusReport(...args),
    setDeviceSessionTracking: (...args) => seams.setDeviceSessionTracking(...args),
    clearDeviceSessionCache: (...args) => seams.clearDeviceSessionCache(...args),
  };
}
