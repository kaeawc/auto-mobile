import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { resolveCtrlProxyForwardLeaseIdleMs } from "../features/observe/shared/ctrlProxyForwardLeaseOwnership";
import { executionTracker } from "../server/executionTracker";
import { getDeviceDataStreamServer } from "./deviceDataStreamSocketServer";
import type { DeviceLeaseActivitySources } from "./deviceLeaseActivity";

/** Production sources: tool tracker, stream server and CtrlProxy clients. */
export function daemonDeviceLeaseActivitySources(
  sessionForDevice: (deviceId: string) => string | null,
): DeviceLeaseActivitySources {
  return {
    sessionForDevice,
    activeExecutionCount: (deviceId) => executionTracker.getActiveDeviceExecutionCount(deviceId),
    toolIdleForMs: (deviceId) => executionTracker.getDeviceIdleForMs(deviceId),
    hasStreamSubscriber: (deviceId) =>
      getDeviceDataStreamServer()?.hasSubscriberForDevice(deviceId) ?? false,
    clientActivity: (deviceId) => AndroidCtrlProxyClient.getForwardLeaseActivity(deviceId),
  };
}

/** The owner side of `daemon/relinquishDeviceLease`: its idle policy and release. */
export interface DeviceLeaseRelinquishPort {
  /** Use within this period keeps the lease (the owner's own idle-release setting). */
  idleMs: number;
  /**
   * Give the device's lease up. Must evict synchronously, before its first
   * await, so the caller's use check and the eviction are one atomic step.
   */
  release(deviceId: string): Promise<void>;
}

/** Production port: this daemon's idle setting and its singleton CtrlProxy client. */
export function daemonDeviceLeaseRelinquishPort(): DeviceLeaseRelinquishPort {
  return {
    idleMs: resolveCtrlProxyForwardLeaseIdleMs(),
    release: async (deviceId) => {
      // A daemon that does not hold the lease (e.g. one now serving an orphaned
      // owner's socket path) must not close its own client for the device.
      if (!AndroidCtrlProxyClient.getForwardLeaseHeldDeviceIds().includes(deviceId)) {
        return;
      }
      await AndroidCtrlProxyClient.releaseIdleForwardLease(deviceId);
    },
  };
}
