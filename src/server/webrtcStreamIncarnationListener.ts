import {
  registerDeviceIncarnationListener,
  type DeviceIncarnationListener,
} from "../utils/deviceIncarnation";

export interface WebRtcStreamIncarnationDependencies {
  stopStreamsForDevice(deviceId: string, reason: string): Promise<void>;
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
  const stop = (deviceId: string, reason: string): Promise<void> =>
    (dependencies ?? loadedManager)?.stopStreamsForDevice(deviceId, reason) ?? Promise.resolve();
  return {
    name: "webrtc-streams",
    prepareForIncarnationChange: (deviceId) => stop(deviceId, "preparing incarnation change"),
    onDeviceIncarnationChanged: (deviceId) => stop(deviceId, "incarnation changed"),
  };
}

registerDeviceIncarnationListener(createWebRtcStreamDeviceIncarnationListener());
