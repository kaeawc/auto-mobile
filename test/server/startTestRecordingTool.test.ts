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
import { isTypedToolRefusal, shapeToolCallError } from "../../src/server/shapeToolCallError";
import { z } from "zod/v4";
import { executionTracker } from "../../src/server/executionTracker";

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
  const unheld: BootedDevice = { deviceId: "emulator-5558", name: "Unheld", platform: "android" };
  let manager: SessionManager;
  let pool: DevicePool;
  let persistence: FakeDeviceSessionPersistence;
  let tools: RealToolCallPath;
  let readiness: ReturnType<
    typeof spyOn<typeof toolExecutionContext, "createToolExecutionContext">
  >;
  let start: ReturnType<typeof spyOn<typeof realTestRecordingManager, "startTestRecording">>;

  beforeEach(async () => {
    const timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [held, other, unheld]);
    discovery.setBootedDevices("ios", [slot]);
    const registry = new FakeSlotRegistry(timer);
    await assignManagedSlotDevice(registry, "ios", slot.deviceId);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "recording-tool-start", {
        timer,
        deviceManager: discovery,
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, timer),
      }),
    );
    await pool.initializeWithDevices([held, other, slot, unheld]);
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
    tools = new RealToolCallPath([held, other, slot, unheld]).install(false);
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

  afterEach(() => {
    start.mockRestore();
    readiness.mockRestore();
    tools.uninstall();
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    expect(executionTracker.getActiveExecutionCount()).toBe(0);
  });

  const unheldRefusal = {
    code: "no_active_device_session",
    reason: "device_not_held",
    nextAction: "acquire_new_session",
    retryable: false,
  };

  function expectNoDeviceWork(): void {
    expect(readiness).not.toHaveBeenCalled();
    expect(tools.deviceSessionManager.getEnsureDeviceReadyCalls()).toBe(0);
    expect(tools.deviceSessionManager.getSetCurrentDeviceCalls()).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    expect(tools.runs).toEqual([]);
  }

  test("a sessionless explicit unheld start is refused before device work", async () => {
    await expect(
      tools.call("startTestRecording", { deviceId: unheld.deviceId }),
    ).rejects.toMatchObject(unheldRefusal);
    expectNoDeviceWork();
  });

  test("a sessionless predicted unheld start is refused before device work", async () => {
    tools.deviceSessionManager.setConnectedDevices([unheld]);
    await expect(tools.call("startTestRecording", {})).rejects.toMatchObject(unheldRefusal);
    expectNoDeviceWork();
  });

  for (const deviceId of [undefined, unheld.deviceId]) {
    test(`a live device-less session cannot auto-acquire (${deviceId ?? "no target"})`, async () => {
      const session = await manager.createSession("device-less", "", "android");
      await expect(
        tools.call("startTestRecording", { sessionUuid: session.sessionId, deviceId }),
      ).rejects.toMatchObject(unheldRefusal);
      expect(manager.getSession(session.sessionId)?.assignedDevice).toBe("");
      expect(pool.getAllDevices().some((device) => device.sessionId === session.sessionId)).toBe(
        false,
      );
      expectNoDeviceWork();
    });
  }

  test("an unheld start throws a typed refusal rendered as an MCP error result", async () => {
    const refusal = await tools.call("startTestRecording", { deviceId: unheld.deviceId }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isTypedToolRefusal(refusal)).toBe(true);
    const result = shapeToolCallError(refusal, { toolName: "startTestRecording", source: "MCP" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false,
      error: expect.any(String),
      ...unheldRefusal,
      recovery: { action: "acquire_replacement_session", tools: ["getAndroid", "getApple"] },
    });
    expectNoDeviceWork();
  });

  test("a different control tool still admits a sessionless unheld device", async () => {
    ToolRegistry.registerDeviceAware(
      "unheldControl",
      "Control admission pin",
      z.object({}),
      async () => ({
        content: [{ type: "text", text: JSON.stringify({ success: true }) }],
      }),
    );
    await tools.call("unheldControl", { deviceId: unheld.deviceId });
    expect(tools.deviceSessionManager.getEnsureDeviceReadyCalls()).toBe(1);
    expect(tools.runs).toMatchObject([{ name: "unheldControl", deviceId: unheld.deviceId }]);
    expect(start).not.toHaveBeenCalled();
  });

  test("a persisted restart-recovery row may restore its held device before starting", async () => {
    await persistence.upsertActiveSession({
      sessionUuid: "recovering",
      deviceId: unheld.deviceId,
      platform: "android",
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 60_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: false,
    });
    readiness.mockImplementationOnce(
      async (sessionId, _manager, _pool, _options, _execution, admitted) => {
        expect(admitted).toBeUndefined();
        await pool.bindOrReuseDeviceSession(sessionId!, unheld.deviceId, "android");
        return { sessionId, deviceId: unheld.deviceId, devicePlatform: "android" };
      },
    );
    await tools.call("startTestRecording", {
      sessionUuid: "recovering",
      deviceId: unheld.deviceId,
    });
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(manager.getSessionForDevice(unheld.deviceId)).toBe("recovering");
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[4]).toBe("recovering");
  });

  test("direct mode still permits an unheld recording start", async () => {
    DaemonState.getInstance().reset();
    await tools.call("startTestRecording", { deviceId: unheld.deviceId });
    expect(readiness).not.toHaveBeenCalled();
    expect(tools.deviceSessionManager.getEnsureDeviceReadyCalls()).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("a held managed-slot device refuses the non-holder before the slot refusal", async () => {
    await manager.createSession("slot-holder", slot.deviceId, "ios");
    await expect(
      tools.call("startTestRecording", { deviceId: slot.deviceId }),
    ).rejects.toMatchObject({
      code: "device_owned_by_other_session",
      deviceId: slot.deviceId,
      retryable: false,
    });
    expectNoDeviceWork();
  });

  test("a predicted idle managed-slot device keeps its refusal before readiness", async () => {
    tools.deviceSessionManager.setConnectedDevices([slot]);
    await expect(tools.call("startTestRecording", { platform: "ios" })).rejects.toMatchObject({
      code: "device_assigned_to_managed_slot",
    });
    expectNoDeviceWork();
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
