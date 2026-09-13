import type { BootedDevice } from "../models";
import { logger } from "../utils/logger";
import {
  advanceDeviceIncarnation,
  getDeviceIncarnationListeners,
  type DeviceIncarnationListener,
} from "../utils/deviceIncarnation";

// Loading these state owners installs their module-init listeners before the
// default invalidator snapshots the registry. Keep ownership local to each
// module; this funnel deliberately knows only the listener contract.
import "../features/action/TerminateApp";
import "../features/observe/android/AndroidCtrlProxyClient";
import "../features/performance/PerformanceMonitor";
import "../utils/CtrlProxyManager";
import "./appResources";

/** Invalidates host-side state that belongs to one physical device incarnation. */
export interface DeviceIncarnationInvalidator {
  invalidate(device: BootedDevice): Promise<void>;
}

export interface CtrlProxyClientLifecycle {
  closeAndRemove(deviceId: string): Promise<void>;
}

/**
 * The single VM-restore funnel. Each listener is independently best-effort:
 * the guest has already reverted, so a host-cache persistence failure must not
 * report the irreversible restore as failed to the caller.
 */
export class DefaultDeviceIncarnationInvalidator implements DeviceIncarnationInvalidator {
  constructor(private readonly listeners?: readonly DeviceIncarnationListener[]) {}

  async invalidate(device: BootedDevice): Promise<void> {
    if (device.platform !== "android") {
      return;
    }

    advanceDeviceIncarnation(device.deviceId);
    const listeners = this.listeners ?? getDeviceIncarnationListeners();
    const results = await Promise.allSettled(
      listeners.map(async (listener) => {
        await listener.onDeviceIncarnationChanged(device.deviceId);
        return listener.name;
      }),
    );
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === "rejected") {
        // Safe to continue: the VM restore already completed and each owner is independently fenced.
        logger.warn(
          `[DeviceIncarnationInvalidator] Failed to invalidate ${listeners[index].name}`,
          result.reason,
        );
      }
    }
  }
}
