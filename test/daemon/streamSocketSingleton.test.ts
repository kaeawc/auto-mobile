import { describe, test, expect, spyOn } from "bun:test";
import { logger } from "../../src/utils/logger";
import * as appearanceSocketServer from "../../src/daemon/appearanceSocketServer";
import * as deviceDataStreamSocketServer from "../../src/daemon/deviceDataStreamSocketServer";
import * as deviceSnapshotSocketServer from "../../src/daemon/deviceSnapshotSocketServer";
import * as failuresPushSocketServer from "../../src/daemon/failuresPushSocketServer";
import * as failuresStreamSocketServer from "../../src/daemon/failuresStreamSocketServer";
import * as performancePushSocketServer from "../../src/daemon/performancePushSocketServer";
import * as performanceStreamSocketServer from "../../src/daemon/performanceStreamSocketServer";
import * as telemetryPushSocketServer from "../../src/daemon/telemetryPushSocketServer";
import * as testRecordingSocketServer from "../../src/daemon/testRecordingSocketServer";
import * as videoRecordingSocketServer from "../../src/daemon/videoRecordingSocketServer";
import * as videoStreamSocketServer from "../../src/daemon/videoStreamSocketServer";
import * as webRtcStreamSocketServer from "../../src/daemon/webrtcStreamSocketServer";
const cases = [
  {
    name: "Appearance",
    Server: appearanceSocketServer.AppearanceSocketServer,
    start: appearanceSocketServer.startAppearanceSocketServer,
    stop: appearanceSocketServer.stopAppearanceSocketServer,
    path: appearanceSocketServer.getAppearanceSocketPath,
  },
  {
    name: "DeviceDataStream",
    Server: deviceDataStreamSocketServer.DeviceDataStreamSocketServer,
    start: deviceDataStreamSocketServer.startDeviceDataStreamSocketServer,
    stop: deviceDataStreamSocketServer.stopDeviceDataStreamSocketServer,
    path: deviceDataStreamSocketServer.getDeviceDataStreamSocketPath,
  },
  {
    name: "DeviceSnapshot",
    Server: deviceSnapshotSocketServer.DeviceSnapshotSocketServer,
    start: deviceSnapshotSocketServer.startDeviceSnapshotSocketServer,
    stop: deviceSnapshotSocketServer.stopDeviceSnapshotSocketServer,
    path: deviceSnapshotSocketServer.getDeviceSnapshotSocketPath,
  },
  {
    name: "FailuresPush",
    Server: failuresPushSocketServer.FailuresPushSocketServer,
    start: failuresPushSocketServer.startFailuresPushSocketServer,
    stop: failuresPushSocketServer.stopFailuresPushSocketServer,
    path: failuresPushSocketServer.getFailuresPushSocketPath,
  },
  {
    name: "FailuresStream",
    Server: failuresStreamSocketServer.FailuresStreamSocketServer,
    start: failuresStreamSocketServer.startFailuresStreamSocketServer,
    stop: failuresStreamSocketServer.stopFailuresStreamSocketServer,
    path: failuresStreamSocketServer.getFailuresStreamSocketPath,
  },
  {
    name: "PerformancePush",
    Server: performancePushSocketServer.PerformancePushSocketServer,
    start: performancePushSocketServer.startPerformancePushSocketServer,
    stop: performancePushSocketServer.stopPerformancePushSocketServer,
    path: performancePushSocketServer.getPerformancePushSocketPath,
  },
  {
    name: "PerformanceStream",
    Server: performanceStreamSocketServer.PerformanceStreamSocketServer,
    start: performanceStreamSocketServer.startPerformanceStreamSocketServer,
    stop: performanceStreamSocketServer.stopPerformanceStreamSocketServer,
    path: performanceStreamSocketServer.getPerformanceStreamSocketPath,
  },
  {
    name: "TelemetryPush",
    Server: telemetryPushSocketServer.TelemetryPushSocketServer,
    start: telemetryPushSocketServer.startTelemetryPushSocketServer,
    stop: telemetryPushSocketServer.stopTelemetryPushSocketServer,
    path: telemetryPushSocketServer.getTelemetryPushSocketPath,
  },
  {
    name: "TestRecording",
    Server: testRecordingSocketServer.TestRecordingSocketServer,
    start: testRecordingSocketServer.startTestRecordingSocketServer,
    stop: testRecordingSocketServer.stopTestRecordingSocketServer,
    path: testRecordingSocketServer.getTestRecordingSocketPath,
  },
  {
    name: "VideoRecording",
    Server: videoRecordingSocketServer.VideoRecordingSocketServer,
    start: videoRecordingSocketServer.startVideoRecordingSocketServer,
    stop: videoRecordingSocketServer.stopVideoRecordingSocketServer,
    path: videoRecordingSocketServer.getVideoRecordingSocketPath,
  },
  {
    name: "VideoStream",
    Server: videoStreamSocketServer.VideoStreamSocketServer,
    start: videoStreamSocketServer.startVideoStreamSocketServer,
    stop: videoStreamSocketServer.stopVideoStreamSocketServer,
    path: videoStreamSocketServer.getVideoStreamSocketPath,
  },
  {
    name: "WebRtcStream",
    Server: webRtcStreamSocketServer.WebRtcStreamSocketServer,
    start: webRtcStreamSocketServer.startWebRtcStreamSocketServer,
    stop: webRtcStreamSocketServer.stopWebRtcStreamSocketServer,
    path: webRtcStreamSocketServer.getWebRtcStreamSocketPath,
  },
];

describe("stream singleton characterization", () => {
  for (const row of cases) {
    test(`${row.name}: idempotence, ordering, failures and wrapper log silence`, async () => {
      let listening = false;
      let startError: Error | null = new Error("start failure");
      let closeError: Error | null = new Error("close failure");
      let finishClose: (() => void) | undefined;
      const instances: object[] = [];
      const logs = [
        spyOn(logger, "info"),
        spyOn(logger, "warn"),
        spyOn(logger, "error"),
        spyOn(logger, "debug"),
      ];
      const path = spyOn(row.Server.prototype, "getSocketPath").mockReturnValue("singleton-test");
      const state = spyOn(row.Server.prototype, "isListening").mockImplementation(() => listening);
      const start = spyOn(row.Server.prototype, "start").mockImplementation(async function () {
        instances.push(this);
        if (startError) {
          throw startError;
        }
        listening = true;
      });
      const close = spyOn(row.Server.prototype, "close").mockImplementation(async () => {
        if (closeError) {
          throw closeError;
        }
        await new Promise<void>((resolve) => {
          finishClose = resolve;
        });
        listening = false;
      });
      try {
        await row.stop();
        expect(close).not.toHaveBeenCalled();
        await expect(row.start()).rejects.toThrow("start failure");
        expect(row.path()).toBe("singleton-test");
        startError = null;
        await row.start();
        await row.start();
        expect(start).toHaveBeenCalledTimes(2);
        expect(instances[0]).toBe(instances[1]);
        await expect(row.stop()).rejects.toThrow("close failure");
        expect(row.path()).toBe("singleton-test");
        closeError = null;
        const stopping = row.stop();
        expect(row.path()).toBe("singleton-test");
        finishClose?.();
        await stopping;
        expect(row.path()).not.toBe("singleton-test");
        await row.stop();
        expect(close).toHaveBeenCalledTimes(2);
        for (const log of logs) {
          expect(log).not.toHaveBeenCalled();
        }
      } finally {
        path.mockRestore();
        state.mockRestore();
        start.mockRestore();
        close.mockRestore();
        for (const log of logs) {
          log.mockRestore();
        }
      }
    });
  }
});
