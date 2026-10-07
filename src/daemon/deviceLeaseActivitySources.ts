import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
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
