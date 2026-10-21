import { expect, test } from "bun:test";
import { startDirectModeServices } from "../../src/startup/stdioServer";

test("direct-mode services start sockets without host appearance sync", async () => {
  const calls: string[] = [];
  const modules = {
    startVideoRecordingSocketServer: async () => {
      calls.push("video");
    },
    startDeviceGestureRecordingSocketServer: async () => {
      calls.push("gesture");
    },
    startDeviceSnapshotSocketServer: async () => {
      calls.push("snapshot");
    },
    startAppearanceSocketServer: async () => {
      calls.push("appearance");
    },
    startWebRtcStreamSocketServer: async () => {
      calls.push("webrtc");
    },
    startAppearanceSyncScheduler: () => {
      calls.push("scheduler");
    },
    isAppearanceSyncEnabled: () => true,
    get DeviceReadiness(): never {
      throw new Error("Direct startup must not read global readiness");
    },
  };
  await startDirectModeServices(modules);
  expect(calls).toEqual(["video", "gesture", "snapshot", "appearance", "webrtc"]);
});
