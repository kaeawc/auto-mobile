import type { BootedDevice } from "../models";
import {
  DefaultDeviceWindowCacheInvalidator,
  type DeviceWindowCacheInvalidator,
} from "../features/action/TerminateApp";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import {
  getInstalledAppsCacheWriteCoordinator,
  type InstalledAppsCacheWriteCoordinator,
} from "../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier, type DbWriteBarrier } from "../db/dbWriteBarrier";
import { InstalledAppsRepository, type InstalledAppsStore } from "../db/installedAppsRepository";

/**
 * Invalidates host-side state that belongs to one physical incarnation of a
 * device serial. A VM snapshot restore reverts the whole Android guest while
 * retaining its serial, so callers must invoke this before reusing that state.
 */
export interface DeviceIncarnationInvalidator {
  invalidate(device: BootedDevice): Promise<void>;
}

/** Default Android VM-restore invalidation for CtrlProxy, observe, and apps caches. */
export class DefaultDeviceIncarnationInvalidator implements DeviceIncarnationInvalidator {
  constructor(
    private readonly windowCacheInvalidator: DeviceWindowCacheInvalidator = new DefaultDeviceWindowCacheInvalidator(),
    private readonly installedAppsRepository: InstalledAppsStore = new InstalledAppsRepository(),
    private readonly installedAppsCoordinator: InstalledAppsCacheWriteCoordinator = getInstalledAppsCacheWriteCoordinator(),
    private readonly dbWriteBarrier: DbWriteBarrier = getDbWriteBarrier(),
  ) {}

  async invalidate(device: BootedDevice): Promise<void> {
    if (device.platform !== "android") {
      return;
    }

    // First clear the hierarchy and observe caches through the established
    // invalidator, then evict the stronger per-serial singleton so its forward
    // and guest-side helper state cannot survive a whole-VM restore.
    this.windowCacheInvalidator.invalidate(device);
    AndroidCtrlProxyClient.removeInstance(device.deviceId);
    await this.installedAppsCoordinator.invalidate(device.deviceId, () =>
      this.dbWriteBarrier
        .track(() => this.installedAppsRepository.markDeviceStale(device.deviceId))
        .then(() => undefined),
    );
  }
}
