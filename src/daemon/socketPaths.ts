import { SOCKET_PATH } from "./constants";
import { getAppearanceSocketPath } from "./appearanceSocketServer";
import { getDeviceDataStreamSocketPath } from "./deviceDataStreamSocketServer";
import { getDeviceSnapshotSocketPath } from "./deviceSnapshotSocketServer";
import { getFailuresPushSocketPath } from "./failuresPushSocketServer";
import { getFailuresStreamSocketPath } from "./failuresStreamSocketServer";
import { getPerformancePushSocketPath } from "./performancePushSocketServer";
import { getPerformanceStreamSocketPath } from "./performanceStreamSocketServer";
import { getTelemetryPushSocketPath } from "./telemetryPushSocketServer";
import { getTestRecordingSocketPath } from "./testRecordingSocketServer";
import { getVideoRecordingSocketPath } from "./videoRecordingSocketServer";
import { getVideoStreamSocketPath } from "./videoStreamSocketServer";
import { getWebRtcStreamSocketPath } from "./webrtcStreamSocketServer";
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
    "test-recording": getTestRecordingSocketPath(),
    "video-recording": getVideoRecordingSocketPath(),
    "video-stream": getVideoStreamSocketPath(),
    "webrtc-stream": getWebRtcStreamSocketPath(),
  };
}
