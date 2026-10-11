import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { TestRecordingSocketServer } from "../../src/daemon/testRecordingSocketServer";
import { SessionScopedStreamAuthenticator } from "../../src/daemon/streamSocketAuth";
import type { TestRecordingCommand } from "../../src/daemon/testRecordingSocketTypes";
import type { BootedDevice } from "../../src/models";
import {
  getTestRecordingStatus,
  startTestRecording,
  stopTestRecording,
} from "../../src/server/testRecordingManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

class TestableServer extends TestRecordingSocketServer {
  invoke(request: TestRecordingCommand) {
    return this.handleRequest(request);
  }
}

describe("test recording start holder admission (#11665)", () => {
  const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
  const iphone: BootedDevice = { deviceId: "physical-iphone", name: "iPhone", platform: "ios" };
  const otherDevice: BootedDevice = { deviceId: "other-iphone", name: "Other", platform: "ios" };
  let manager: SessionManager;
  let timer: FakeTimer;
  let readyCalls: number;
  let selectionCalls: number;
  let server: TestableServer;

  beforeEach(async () => {
    timer = new FakeTimer();
    manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [device]);
    discovery.setBootedDevices("ios", [iphone, otherDevice]);
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "recording-start", { timer, deviceManager: discovery }),
    );
    await pool.initializeWithDevices([device, iphone, otherDevice]);
    DaemonState.getInstance().initialize(manager, pool);
    await manager.createSession("holder", device.deviceId, "android");
    await manager.createSession("iphone-holder", iphone.deviceId, "ios");
    await manager.createSession("stranger", otherDevice.deviceId, "ios");
    readyCalls = 0;
    selectionCalls = 0;
    server = new TestableServer(
      undefined,
      timer,
      new SessionScopedStreamAuthenticator(() => manager, "testRecording", {}),
      { assertDeviceActionable: () => {} },
      {
        selectDevice: async () => {
          selectionCalls++;
          return device;
        },
        readyDevice: async (selected) => {
          readyCalls++;
          return selected;
        },
      },
      async () => {},
    );
  });

  afterEach(async () => {
    if (getTestRecordingStatus(timer)) {
      await stopTestRecording(undefined, "cleanup", timer);
    }
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
  });

  for (const sessionUuid of ["stranger", undefined]) {
    test(`${sessionUuid ?? "sessionless"} is refused on the held physical iPhone before selection or setup`, async () => {
      const response = await server.invoke({
        command: "start",
        deviceId: iphone.deviceId,
        sessionUuid,
      });
      expect(response).toMatchObject({
        success: false,
        code: "device_owned_by_other_session",
        retryable: false,
        deviceId: iphone.deviceId,
      });
      expect(selectionCalls).toBe(0);
      expect(readyCalls).toBe(0);
      expect(getTestRecordingStatus(timer)).toBeNull();
    });
  }

  test("a non-holder omitting deviceId is refused against the selected device before setup", async () => {
    const response = await server.invoke({ command: "start", sessionUuid: "stranger" });
    expect(response).toMatchObject({
      success: false,
      code: "device_owned_by_other_session",
      retryable: false,
      deviceId: device.deviceId,
    });
    expect(selectionCalls).toBe(1);
    expect(readyCalls).toBe(0);
  });

  test("ownership is rechecked after the managed-slot gate before setup", async () => {
    let owner = "holder";
    const ownership = spyOn(manager, "getSessionForDevice").mockImplementation(() => owner);
    const gatedServer = new TestableServer(
      undefined,
      timer,
      new SessionScopedStreamAuthenticator(() => manager, "testRecording", {}),
      { assertDeviceActionable: () => {} },
      {
        selectDevice: async () => device,
        readyDevice: async (selected) => {
          readyCalls++;
          return selected;
        },
      },
      async () => {
        owner = "stranger";
      },
    );
    try {
      const response = await gatedServer.invoke({
        command: "start",
        deviceId: device.deviceId,
        sessionUuid: "holder",
      });
      expect(response).toMatchObject({
        success: false,
        code: "device_owned_by_other_session",
        deviceId: device.deviceId,
      });
      expect(readyCalls).toBe(0);
    } finally {
      ownership.mockRestore();
    }
  });

  test("the holder starts successfully with readiness called once", async () => {
    // An already-active fake capture keeps the ingress's real manager call device-free.
    const active = await startTestRecording(
      device,
      timer,
      new CountingIdGenerator(),
      () => ({
        start: async () => {},
        stop: async () => ({ steps: [{ tool: "tapOn", params: { text: "OK" } }], stepCount: 1 }),
        stepCount: 1,
      }),
      "holder",
    );
    const response = await server.invoke({
      command: "start",
      deviceId: device.deviceId,
      sessionUuid: "holder",
    });
    expect(response).toMatchObject({ success: true, recordingId: active.recordingId });
    expect(selectionCalls).toBe(1);
    expect(readyCalls).toBe(1);
  });
});
