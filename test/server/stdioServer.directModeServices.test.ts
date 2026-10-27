import { DeviceReadiness } from "../../src/daemon/readiness/DeviceReadiness";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { expect, test } from "bun:test";
import {
  createDirectModeAppearanceDeviceSource,
  type AppearanceDeviceSource,
} from "../../src/daemon/appearanceSocketServer";
import { startDirectModeServices } from "../../src/startup/stdioServer";

test("direct-mode services start sockets without host appearance sync", async () => {
  const calls: string[] = [];
  const readiness = DeviceReadiness.createInstance(
    new FakeDeviceClientProvider(new FakeAdbExecutor(), new FakeDeviceUtils()),
  );
  const pinned = { deviceId: "emulator-5556", name: "Pinned", platform: "android" } as const;
  readiness.setExplicitDevicePin(pinned);
  const modules = {
    startVideoRecordingSocketServer: async () => {
      calls.push("video");
    },
    startDeviceGestureRecordingSocketServer: async (
      service: Pick<DeviceReadiness, "ensureDeviceReady" | "getPlatformDeviceManager">,
    ) => {
      expect(service).toBe(readiness);
      calls.push("gesture");
    },
    startDeviceSnapshotSocketServer: async () => {
      calls.push("snapshot");
    },
    startAppearanceSocketServer: async (source?: AppearanceDeviceSource) => {
      calls.push("appearance");
      // The sessionless targets of a direct process are its explicit pin (#14375).
      expect(source?.getSessionlessDevices?.()).toEqual([pinned]);
    },
    createDirectModeAppearanceDeviceSource: createDirectModeAppearanceDeviceSource,
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
  await startDirectModeServices(modules, readiness);
  expect(calls).toEqual(["video", "gesture", "snapshot", "appearance", "webrtc"]);
});
