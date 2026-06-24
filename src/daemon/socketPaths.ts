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
import type { DaemonSocketPaths } from "./types";

export function getDaemonSocketPaths(): DaemonSocketPaths {
  return {
    "control": SOCKET_PATH,
    "appearance": getAppearanceSocketPath(),
    "device-snapshot": getDeviceSnapshotSocketPath(),
    "failures-push": getFailuresPushSocketPath(),
    "failures-stream": getFailuresStreamSocketPath(),
    "observation-stream": getDeviceDataStreamSocketPath(),
    "performance-push": getPerformancePushSocketPath(),
    "performance-stream": getPerformanceStreamSocketPath(),
    "telemetry-push": getTelemetryPushSocketPath(),
    "test-recording": getTestRecordingSocketPath(),
    "video-recording": getVideoRecordingSocketPath(),
  };
}
