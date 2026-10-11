import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { RegistryManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import * as toolExecutionContext from "../../src/server/toolExecutionContext";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSlotRegistry } from "../fakes/FakeSlotRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { RealToolCallPath } from "../helpers/realToolCallPath";
import { assignManagedSlotDevice } from "../daemon/managedSlots/managedSlotFixtures";
import type { BootedDevice } from "../../src/models";
import { registerPlanTools } from "../../src/server/planTools";
import * as realTestRecordingManager from "../../src/server/testRecordingManager";
import { ToolRegistry } from "../../src/server/toolRegistry";

isolateToolRegistry();

const realStartTestRecording = realTestRecordingManager.startTestRecording;
const realStopTestRecording = realTestRecordingManager.stopTestRecording;
const realGetTestRecordingStatus = realTestRecordingManager.getTestRecordingStatus;

describe("startTestRecording tool", () => {
  const mockDevice = {
    deviceId: "emulator-5554",
    name: "Pixel 6 API 33",
    platform: "android" as const,
    status: "booted" as const,
  };

  const mockStartTestRecording = mock(() =>
    Promise.resolve({
      recordingId: "rec-123",
      startedAt: "2024-01-01T00:00:00.000Z",
      deviceId: "emulator-5554",
      platform: "android",
    }),
  );

  beforeAll(() => {
    if (!ToolRegistry.getTool("startTestRecording")) {
      registerPlanTools();
    }
  });

  afterEach(() => {
    mockStartTestRecording.mockClear();
  });

  afterAll(() => {
    mock.module("../../src/server/testRecordingManager", () => ({
      startTestRecording: realStartTestRecording,
      stopTestRecording: realStopTestRecording,
      getTestRecordingStatus: realGetTestRecordingStatus,
    }));
  });

  test("successfully starts a new recording", async () => {
    mock.module("../../src/server/testRecordingManager", () => ({
      startTestRecording: mockStartTestRecording,
      stopTestRecording: mock(() => Promise.resolve({})),
      getTestRecordingStatus: mock(() => null),
    }));

    const tool = ToolRegistry.getTool("startTestRecording");
    expect(tool).toBeDefined();
    expect(tool!.deviceAwareHandler).toBeDefined();

    const response = await tool!.deviceAwareHandler!(mockDevice, {});
    const payload = JSON.parse(response.content?.[0]?.text ?? "{}");

    expect(payload.success).toBe(true);
    expect(payload.recordingId).toBe("rec-123");
    expect(payload.startedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(payload.deviceId).toBe("emulator-5554");
    expect(payload.platform).toBe("android");
  });

  test("returns existing session when recording already active", async () => {
    const existingSession = {
      recordingId: "existing-456",
      startedAt: "2024-01-01T00:30:00.000Z",
      deviceId: "emulator-5554",
      platform: "android",
    };

    mock.module("../../src/server/testRecordingManager", () => ({
      startTestRecording: mock(() => Promise.resolve(existingSession)),
      stopTestRecording: mock(() => Promise.resolve({})),
      getTestRecordingStatus: mock(() => existingSession),
    }));

    const tool = ToolRegistry.getTool("startTestRecording");
    expect(tool).toBeDefined();

    const response = await tool!.deviceAwareHandler!(mockDevice, {});
    const payload = JSON.parse(response.content?.[0]?.text ?? "{}");

    expect(payload.success).toBe(true);
    expect(payload.recordingId).toBe("existing-456");
    expect(payload.startedAt).toBe("2024-01-01T00:30:00.000Z");
  });

  test("returns error when recording fails to start", async () => {
    mock.module("../../src/server/testRecordingManager", () => ({
      startTestRecording: mock(() =>
        Promise.reject(new Error("Unable to connect to accessibility service")),
      ),
      stopTestRecording: mock(() => Promise.resolve({})),
      getTestRecordingStatus: mock(() => null),
    }));

    const tool = ToolRegistry.getTool("startTestRecording");
    expect(tool).toBeDefined();

    const response = await tool!.deviceAwareHandler!(mockDevice, {});
    const payload = JSON.parse(response.content?.[0]?.text ?? "{}");

    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Unable to connect to accessibility service");
  });

  test("returns error when recording active on different device", async () => {
    const differentDevice = {
      deviceId: "emulator-5556",
      name: "Pixel 7 API 34",
      platform: "android" as const,
      status: "booted" as const,
    };

    mock.module("../../src/server/testRecordingManager", () => ({
      startTestRecording: mock(() =>
        Promise.reject(
          new Error(
            "Recording already active on device emulator-5554 (rec-123). Stop the existing recording before starting a new one on emulator-5556.",
          ),
        ),
      ),
      stopTestRecording: mock(() => Promise.resolve({})),
      getTestRecordingStatus: mock(() => ({
        recordingId: "rec-123",
        deviceId: "emulator-5554",
        platform: "android",
        startedAt: "2024-01-01T00:00:00.000Z",
        eventCount: 5,
        durationMs: 30000,
      })),
    }));

    const tool = ToolRegistry.getTool("startTestRecording");
    expect(tool).toBeDefined();

    const response = await tool!.deviceAwareHandler!(differentDevice, {});
    const payload = JSON.parse(response.content?.[0]?.text ?? "{}");

    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Recording already active on device emulator-5554");
    expect(payload.error).toContain("emulator-5556");
  });
});

describe("startTestRecording ToolRegistry admission (#11665)", () => {
  const held: BootedDevice = { deviceId: "emulator-5554", name: "Held", platform: "android" };
  const other: BootedDevice = { deviceId: "emulator-5556", name: "Other", platform: "android" };
  const slot: BootedDevice = { deviceId: "slot-iphone", name: "Slot", platform: "ios" };
  let manager: SessionManager;
  let tools: RealToolCallPath;
  let readiness: ReturnType<
    typeof spyOn<typeof toolExecutionContext, "createToolExecutionContext">
  >;
  let start: ReturnType<typeof spyOn<typeof realTestRecordingManager, "startTestRecording">>;

  beforeAll(async () => {
    const timer = new FakeTimer();
    manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [held, other]);
    discovery.setBootedDevices("ios", [slot]);
    const registry = new FakeSlotRegistry(timer);
    await assignManagedSlotDevice(registry, "ios", slot.deviceId);
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "recording-tool-start", {
        timer,
        deviceManager: discovery,
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, timer),
      }),
    );
    await pool.initializeWithDevices([held, other, slot]);
    DaemonState.getInstance().initialize(manager, pool);
    await pool.bindOrReuseDeviceSession(
      "holder",
      held.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      "acquiring-connection",
    );
    await manager.createSession("stranger", other.deviceId, "android");
    manager.setDeviceReadiness("holder", "automationReady");
    tools = new RealToolCallPath([held, other, slot]).install();
    tools.setBody((input) => input.handler(input.device, input.args, input.progress, input.signal));
    // Fake the readiness boundary after the real registry's ownership and session admission.
    readiness = spyOn(toolExecutionContext, "createToolExecutionContext").mockImplementation(
      async (sessionId) => ({
        sessionId,
        deviceId: held.deviceId,
        devicePlatform: held.platform,
      }),
    );
    start = spyOn(realTestRecordingManager, "startTestRecording").mockResolvedValue({
      recordingId: "fake-recording",
      startedAt: "2024-01-01T00:00:00.000Z",
      deviceId: held.deviceId,
      platform: held.platform,
    });
    registerPlanTools();
  });

  beforeEach(() => {
    readiness.mockClear();
    start.mockClear();
    tools.runs.length = 0;
  });

  afterAll(() => {
    start.mockRestore();
    readiness.mockRestore();
    tools.uninstall();
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
  });

  for (const sessionUuid of ["stranger", undefined]) {
    test(`${sessionUuid ?? "sessionless"} is refused before readiness or recording setup`, async () => {
      await expect(
        tools.call("startTestRecording", { deviceId: held.deviceId, sessionUuid }),
      ).rejects.toMatchObject({
        code: "device_owned_by_other_session",
        deviceId: held.deviceId,
        retryable: false,
      });
      expect(readiness).not.toHaveBeenCalled();
      expect(tools.deviceSessionManager.getEnsureDeviceReadyCalls()).toBe(0);
      expect(start).not.toHaveBeenCalled();
      expect(tools.runs).toEqual([]);
    });
  }

  test("the holder's start works and calls the fake readiness once", async () => {
    const response = await tools.call("startTestRecording", {
      deviceId: held.deviceId,
      sessionUuid: "holder",
    });
    expect(JSON.stringify(response)).toContain("fake-recording");
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[4]).toBe("holder");
  });

  test("the acquiring MCP connection's deviceId-only start works as the holder", async () => {
    const response = await tools.call("startTestRecording", {
      deviceId: held.deviceId,
      __mcpSessionId: "acquiring-connection",
    });
    expect(JSON.stringify(response)).toContain("fake-recording");
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[4]).toBe("holder");
  });

  test("an idle managed-slot device keeps its existing refusal before readiness", async () => {
    await expect(
      tools.call("startTestRecording", { deviceId: slot.deviceId }),
    ).rejects.toMatchObject({ code: "device_assigned_to_managed_slot" });
    expect(readiness).not.toHaveBeenCalled();
    expect(tools.deviceSessionManager.getEnsureDeviceReadyCalls()).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });
});
