import { afterEach, describe, expect, test } from "bun:test";
import { AmbiguousDeviceTargetError } from "../../src/daemon/ambiguousDeviceTargetRefusal";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { registerInteractionTools } from "../../src/server/interactionTools";
import {
  ToolRegistry,
  type AuditRunnerInput,
  type ToolRegistryCollaborators,
} from "../../src/server/toolRegistry";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

describe("ToolRegistry two-session device pinning (#11810)", () => {
  const deviceA: BootedDevice = {
    name: "Pixel A",
    deviceId: "emulator-5554",
    platform: "android",
  };
  const deviceB: BootedDevice = {
    name: "Pixel B",
    deviceId: "emulator-5556",
    platform: "android",
  };
  const deviceC: BootedDevice = {
    name: "Pixel C",
    deviceId: "emulator-5558",
    platform: "android",
  };

  let ran: Array<{ name: string; deviceId: string }>;
  let originalCollaborators: ToolRegistryCollaborators;
  let restorePipeline: () => void;
  let sessionManager: SessionManager;
  let fakeReadiness: FakeDeviceReadiness;

  const rotate = (args: Record<string, unknown>) =>
    ToolRegistry.getTool("rotate")!.handler({ orientation: "landscape", ...args });

  async function arrangeHarness(connected: BootedDevice[]): Promise<void> {
    ran = [];
    ToolRegistry.clearTools();
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
      deviceReadAccess: { listBooted: async () => connected, isAuthorized: () => true },
      auditRunner: {
        async run(input: AuditRunnerInput) {
          ran.push({ name: input.name, deviceId: input.device.deviceId });
          return { success: true };
        },
      },
      afterToolCall: {
        async handle(input) {
          return { durationMs: 0, finalizedResponse: input.response };
        },
      },
    });
    fakeReadiness = new FakeDeviceReadiness();
    fakeReadiness.setConnectedDevices(connected);
    originalCollaborators = ToolRegistry.getCollaboratorsForTesting();
    ToolRegistry.setCollaboratorsForTesting({
      deviceReadiness: fakeReadiness,
      toolCallRepository: { async recordToolCall(): Promise<void> {} },
      navigationToolCallRecorder: { record: () => undefined },
    });

    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", connected);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "two-session-device-pinning", {
        timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    await pool.initializeWithDevices(connected);
    DaemonState.getInstance().initialize(sessionManager, pool);
    await sessionManager.createSession("session-a", deviceA.deviceId, "android");
    await sessionManager.createSession("session-b", deviceB.deviceId, "android");
    sessionManager.setDeviceReadiness("session-a", "automationReady");
    sessionManager.setDeviceReadiness("session-b", "automationReady");
    registerInteractionTools({});
  }

  afterEach(() => {
    restorePipeline();
    ToolRegistry.setCollaboratorsForTesting(originalCollaborators);
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    expect(DaemonState.getInstance().isInitialized()).toBe(false);
    sessionManager.stopCleanupTimer();
  });

  test("each session's calls run on its own device, interleaved", async () => {
    // Keep harness construction in the timed test body, including pool/session setup.
    await arrangeHarness([deviceA, deviceB]);

    await rotate({ sessionUuid: "session-b" });
    await rotate({ sessionUuid: "session-a" });
    await rotate({ sessionUuid: "session-b" });

    expect(ran).toEqual([
      { name: "rotate", deviceId: deviceB.deviceId },
      { name: "rotate", deviceId: deviceA.deviceId },
      { name: "rotate", deviceId: deviceB.deviceId },
    ]);
    expect(fakeReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
    expect(fakeReadiness.getSetCurrentDeviceCalls()).toEqual([]);
    expect(fakeReadiness.getCurrentDevice()).toBeUndefined();
  });

  test("a sessionless call naming no device after session B's call is refused, not resolved to B's device", async () => {
    await arrangeHarness([deviceA, deviceB]);
    await rotate({ sessionUuid: "session-b" });

    await expect(rotate({ platform: "android" })).rejects.toBeInstanceOf(
      AmbiguousDeviceTargetError,
    );
    expect(ran).toEqual([{ name: "rotate", deviceId: deviceB.deviceId }]);
  });

  test("a sessionless call follows only an explicit pin", async () => {
    await arrangeHarness([deviceA, deviceB, deviceC]);
    await rotate({ sessionUuid: "session-b" });
    fakeReadiness.setExplicitDevicePin(deviceC);

    // Same-platform ambiguity accepts a pin for a named platform (executionTarget.ts).
    await rotate({ platform: "android" });

    expect(ran).toEqual([
      { name: "rotate", deviceId: deviceB.deviceId },
      { name: "rotate", deviceId: deviceC.deviceId },
    ]);
  });

  test("a sessionless call with an explicit free deviceId runs on that device", async () => {
    await arrangeHarness([deviceA, deviceB, deviceC]);

    await rotate({ deviceId: deviceC.deviceId });

    expect(ran).toEqual([{ name: "rotate", deviceId: deviceC.deviceId }]);
  });
});
