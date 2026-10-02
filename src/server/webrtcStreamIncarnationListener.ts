import type { EndWebRtcStreamsForDeviceOptions } from "./webrtcStreamManager";
import {
  registerDeviceIncarnationListener,
  type DeviceIncarnationListener,
} from "../utils/deviceIncarnation";

export interface WebRtcStreamIncarnationDependencies {
  stopStreamsForDevice(options: EndWebRtcStreamsForDeviceOptions): Promise<void>;
}

// The manager registers itself only when loaded. Boot and restore on a daemon
// that has never streamed must not import the werift stack just to stop nothing.
let loadedManager: WebRtcStreamIncarnationDependencies | undefined;

export function registerWebRtcStreamIncarnationCleanup(
  dependencies: WebRtcStreamIncarnationDependencies,
): void {
  loadedManager = dependencies;
}

export function createWebRtcStreamDeviceIncarnationListener(
  dependencies?: WebRtcStreamIncarnationDependencies,
): DeviceIncarnationListener {
  const stop = (deviceId: string): Promise<void> =>
    (dependencies ?? loadedManager)?.stopStreamsForDevice({
      deviceId,
      reason: "device_removed",
      cause: "incarnation change",
    }) ?? Promise.resolve();
  return {
    name: "webrtc-streams",
    prepareForIncarnationChange: (deviceId) => stop(deviceId),
    onDeviceIncarnationChanged: (deviceId) => stop(deviceId),
  };
}

registerDeviceIncarnationListener(createWebRtcStreamDeviceIncarnationListener());
