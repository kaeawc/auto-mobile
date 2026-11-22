import { SOCKET_PATH } from "./wire/constants";
import { getAppearanceSocketPath } from "./streams/appearanceSocketServer";
import { getDeviceDataStreamSocketPath } from "./streams/deviceDataStreamSocketServer";
import { getDeviceSnapshotSocketPath } from "./streams/deviceSnapshotSocketServer";
import { getFailuresPushSocketPath } from "./streams/failuresPushSocketServer";
import { getFailuresStreamSocketPath } from "./streams/failuresStreamSocketServer";
import { getPerformancePushSocketPath } from "./streams/performancePushSocketServer";
import { getPerformanceStreamSocketPath } from "./streams/performanceStreamSocketServer";
import { getTelemetryPushSocketPath } from "./streams/telemetryPushSocketServer";
import { getDeviceGestureRecordingSocketPath } from "./streams/deviceGestureRecordingSocketServer";
import { getVideoRecordingSocketPath } from "./streams/videoRecordingSocketServer";
import { getVideoStreamSocketPath } from "./streams/videoStreamSocketServer";
import { getWebRtcStreamSocketPath } from "./streams/webrtcStreamSocketServer";
import type { DaemonSocketPaths } from "./types";

/**
 * Live paths of every daemon socket, keyed by published name, for the daemon
 * status/pidfile payload.
 *
 * Distinct from `getDaemonSocketPathList()` in `daemonFiles.ts`, which returns
 * the default paths as a flat array for unlink-on-cleanup. Both are anchored to
 * `AuxiliaryDaemonSocketName`, so a new socket must appear in both (issue #4195).
 */
export function getDaemonSocketPathsByName(): DaemonSocketPaths {
  return {
    control: SOCKET_PATH,
    appearance: getAppearanceSocketPath(),
    "device-snapshot": getDeviceSnapshotSocketPath(),
    "failures-push": getFailuresPushSocketPath(),
    "failures-stream": getFailuresStreamSocketPath(),
    "observation-stream": getDeviceDataStreamSocketPath(),
    "performance-push": getPerformancePushSocketPath(),
    "performance-stream": getPerformanceStreamSocketPath(),
    "telemetry-push": getTelemetryPushSocketPath(),
    "device-gesture-recording": getDeviceGestureRecordingSocketPath(),
    "video-recording": getVideoRecordingSocketPath(),
    "video-stream": getVideoStreamSocketPath(),
    "webrtc-stream": getWebRtcStreamSocketPath(),
  };
}
