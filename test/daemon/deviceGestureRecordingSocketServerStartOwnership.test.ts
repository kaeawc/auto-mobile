import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceGestureRecordingSocketServer } from "../../src/daemon/deviceGestureRecordingSocketServer";
import { SessionScopedStreamAuthenticator } from "../../src/daemon/streamSocketAuth";
import type { DeviceGestureRecordingCommand } from "../../src/daemon/deviceGestureRecordingSocketTypes";
import type { BootedDevice } from "../../src/models";
import {
  getDeviceGestureRecordingStatus,
  startDeviceGestureRecording,
  stopDeviceGestureRecording,
} from "../../src/daemon/deviceGestureRecordingManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { noActiveDeviceSessionPayload } from "../../src/daemon/deviceSessionResult";

class TestableServer extends DeviceGestureRecordingSocketServer {
  invoke(request: DeviceGestureRecordingCommand) {
    return this.handleRequest(request);
  }
}

describe("device gesture recording start holder admission (#11665)", () => {
  const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
  const iphone: BootedDevice = { deviceId: "physical-iphone", name: "iPhone", platform: "ios" };
  const otherDevice: BootedDevice = { deviceId: "other-iphone", name: "Other", platform: "ios" };
  let manager: SessionManager;
  let pool: DevicePool;
  let timer: FakeTimer;
  let readyCalls: number;
  let selectionCalls: number;
  let server: TestableServer;

  async function arrangeHarness(): Promise<void> {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [device]);
    discovery.setBootedDevices("ios", [iphone, otherDevice]);
    pool = new DevicePool(
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
      new SessionScopedStreamAuthenticator(() => manager, "deviceGestureRecording", {}),
      {
        admissionGate: { assertDeviceActionable: () => {} },
        deviceResolution: {
          selectDevice: async () => {
            selectionCalls++;
            return device;
          },
          readyDevice: async (selected) => {
            readyCalls++;
            return selected;
          },
        },
        bindingGate: async () => {},
      },
    );
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

  afterEach(async () => {
    if (getDeviceGestureRecordingStatus(timer)) {
      await stopDeviceGestureRecording(undefined, "cleanup", timer);
    }
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
  });

  for (const sessionUuid of ["stranger", undefined]) {
    arranged(
      `${sessionUuid ?? "sessionless"} is refused on the held physical iPhone before selection or setup`,
      async () => {
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
        expect(getDeviceGestureRecordingStatus(timer)).toBeNull();
      },
    );
  }

  arranged(
    "a non-holder omitting deviceId is refused against the selected device before setup",
    async () => {
      const response = await server.invoke({ command: "start", sessionUuid: "stranger" });
      expect(response).toMatchObject({
        success: false,
        code: "device_owned_by_other_session",
        retryable: false,
        deviceId: device.deviceId,
      });
      expect(selectionCalls).toBe(1);
      expect(readyCalls).toBe(0);
    },
  );

  for (const sessionUuid of ["stranger", "unknown-session", undefined]) {
    for (const deviceId of [device.deviceId, undefined]) {
      arranged(
        `${sessionUuid ?? "sessionless"} gets the acquire-session refusal on an unheld ${deviceId ? "explicit" : "selected"} device with no setup`,
        async () => {
          await manager.releaseSession("holder");
          const response = await server.invoke({ command: "start", deviceId, sessionUuid });
          const { error } = noActiveDeviceSessionPayload({
            message:
              `deviceGestureRecording start refused: no session of yours holds device '${device.deviceId}'. ` +
              "Call getAndroid or getApple to acquire a session on it first.",
            reason: "device_not_held",
          });
          expect(response).toEqual({
            success: false,
            ...error,
            error: error.message,
          });
          expect(response).toMatchObject({
            code: "no_active_device_session",
            retryable: false,
            nextAction: "acquire_new_session",
            recovery: { action: "acquire_replacement_session", tools: ["getAndroid", "getApple"] },
          });
          expect(readyCalls).toBe(0);
          expect(getDeviceGestureRecordingStatus(timer)).toBeNull();
        },
      );
    }
  }

  arranged("an unheld broker-binding target keeps its slot refusal before any setup", async () => {
    await manager.releaseSession("holder");
    let slotCalls = 0;
    const gatedServer = new TestableServer(
      undefined,
      timer,
      new SessionScopedStreamAuthenticator(() => manager, "deviceGestureRecording", {}),
      {
        admissionGate: { assertDeviceActionable: () => {} },
        deviceResolution: {
          selectDevice: async () => device,
          readyDevice: async (selected) => {
            readyCalls++;
            return selected;
          },
        },
        bindingGate: async () => {
          slotCalls++;
          throw new Error("device_assigned_to_binding");
        },
      },
    );
    await expect(
      gatedServer.invoke({ command: "start", deviceId: device.deviceId }),
    ).rejects.toThrow("device_assigned_to_binding");
    expect(slotCalls).toBe(1);
    expect(readyCalls).toBe(0);
    expect(getDeviceGestureRecordingStatus(timer)).toBeNull();
  });

  arranged("a holder released during the slot gate is refused before setup", async () => {
    const gatedServer = new TestableServer(
      undefined,
      timer,
      new SessionScopedStreamAuthenticator(() => manager, "deviceGestureRecording", {}),
      {
        admissionGate: { assertDeviceActionable: () => {} },
        deviceResolution: {
          selectDevice: async () => device,
          readyDevice: async (selected) => {
            readyCalls++;
            return selected;
          },
        },
        bindingGate: async () => {
          await manager.releaseSession("holder");
        },
      },
    );
    expect(await gatedServer.invoke({ command: "start", sessionUuid: "holder" })).toMatchObject({
      success: false,
      code: "no_active_device_session",
    });
    expect(readyCalls).toBe(0);
    expect(getDeviceGestureRecordingStatus(timer)).toBeNull();
  });

  arranged("ownership is rechecked after the broker-binding gate before setup", async () => {
    let owner = "holder";
    const ownership = spyOn(manager, "getSessionForDevice").mockImplementation(() => owner);
    const gatedServer = new TestableServer(
      undefined,
      timer,
      new SessionScopedStreamAuthenticator(() => manager, "deviceGestureRecording", {}),
      {
        admissionGate: { assertDeviceActionable: () => {} },
        deviceResolution: {
          selectDevice: async () => device,
          readyDevice: async (selected) => {
            readyCalls++;
            return selected;
          },
        },
        bindingGate: async () => {
          owner = "stranger";
        },
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

  arranged("the holder starts successfully with readiness called once", async () => {
    // An already-active fake capture keeps the ingress's real manager call device-free.
    const active = await startDeviceGestureRecording(device, timer, new CountingIdGenerator(), {
      recorderFactory: () => ({
        start: async () => {},
        stop: async () => ({ steps: [{ tool: "tapOn", params: { text: "OK" } }], stepCount: 1 }),
        stepCount: 1,
      }),
      ownerSessionUuid: "holder",
    });
    const response = await server.invoke({
      command: "start",
      deviceId: device.deviceId,
      sessionUuid: "holder",
    });
    expect(response).toMatchObject({ success: true, recordingId: active.recordingId });
    expect(selectionCalls).toBe(1);
    expect(readyCalls).toBe(1);
  });

  arranged("the acquiring connection starts under the session it acquired", async () => {
    await manager.releaseSession("holder");
    const acquired = await pool.bindOrReuseDeviceSession({
      sessionId: "connection-holder",
      deviceId: device.deviceId,
      platform: "android",
      allowSessionRebind: false,
      mcpSessionId: "acquiring-connection",
    });
    expect(
      pool.resolveOwnedDeviceSessionForMcpSession("acquiring-connection", device.deviceId),
    ).toBe(acquired);
    const active = await startDeviceGestureRecording(device, timer, new CountingIdGenerator(), {
      recorderFactory: () => ({
        start: async () => {},
        stop: async () => ({ steps: [{ tool: "tapOn", params: { text: "OK" } }], stepCount: 1 }),
        stepCount: 1,
      }),
      ownerSessionUuid: acquired,
    });
    const response = await server.invoke({
      command: "start",
      deviceId: device.deviceId,
      sessionUuid: acquired,
    });
    expect(response).toMatchObject({ success: true, recordingId: active.recordingId });
    expect(readyCalls).toBe(1);
  });
});
