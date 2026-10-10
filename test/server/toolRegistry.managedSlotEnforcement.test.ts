import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { RegistryManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import {
  DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE,
  DEVICE_OUTSIDE_MANAGED_SLOTS_CODE,
  DeviceAssignedToManagedSlotError,
  DeviceOutsideManagedSlotsError,
} from "../../src/daemon/managedSlots/managedSlotRefusal";
import type { SlotKey } from "../../src/daemon/managedSlots/slotRegistry";
import { assertManagedConnectionPlainToolCall } from "../../src/server/managedConnectionToolGate";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeSlotRegistry } from "../fakes/FakeSlotRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { assignManagedSlotDevice } from "../daemon/managedSlots/managedSlotFixtures";

/**
 * #11178 part b: the device-aware tool path refuses control of a device another managed slot holds
 * (idle or not, explicit deviceId or resolved target), and confines a managed connection's control
 * to its own slot devices and sessions. Reads stay open everywhere (owner decision Q6).
 */
describe("ToolRegistry managed-slot enforcement (#11178)", () => {
  const slotA: BootedDevice = { name: "Slot A", deviceId: "IOS-SLOT-A", platform: "ios" };
  const slotB: BootedDevice = { name: "Slot B", deviceId: "IOS-SLOT-B", platform: "ios" };
  const free: BootedDevice = { name: "Free", deviceId: "IOS-FREE", platform: "ios" };
  const execA = "exec-a";
  const mcpA = "mcp-socket-a";

  let handled: string[];
  let originalDeviceSessionManager: unknown;
  let originalToolCallRepository: unknown;
  let originalNavigationRecorder: unknown;
  let restorePipeline: () => void;
  let sessionManager: SessionManager;
  let registry: FakeSlotRegistry;
  let keyA: SlotKey;
  let timer: FakeTimer;

  const call = (name: string, args: Record<string, unknown>) =>
    ToolRegistry.getTool(name)!.handler(args);

  async function outcome(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await call(name, args);
    } catch (error) {
      return error;
    }
  }

  beforeEach(async () => {
    handled = [];
    ToolRegistry.clearTools();
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
      deviceReadAccess: { listBooted: async () => [slotA, slotB, free], isAuthorized: () => true },
      auditRunner: {
        run: (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        async handle(input) {
          return { durationMs: 0, finalizedResponse: input.response };
        },
      },
    });
    const devices = new FakeDeviceSessionManager();
    devices.setConnectedDevices([slotA, slotB, free]);
    originalDeviceSessionManager = Reflect.get(ToolRegistry, "deviceSessionManager");
    Reflect.set(ToolRegistry, "deviceSessionManager", devices);
    originalToolCallRepository = Reflect.get(ToolRegistry, "toolCallRepository");
    Reflect.set(ToolRegistry, "toolCallRepository", { async recordToolCall(): Promise<void> {} });
    originalNavigationRecorder = Reflect.get(ToolRegistry, "navigationToolCallRecorder");
    Reflect.set(ToolRegistry, "navigationToolCallRecorder", { record: () => undefined });

    timer = new FakeTimer();
    registry = new FakeSlotRegistry(timer);
    keyA = await assignManagedSlotDevice(registry, "ios", slotA.deviceId, "runner-a", execA);
    // Slot B is assigned but idle: no session holds it.
    await assignManagedSlotDevice(registry, "ios", slotB.deviceId, "runner-b");
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("ios", [slotA, slotB, free]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "managed-slot-enforcement", {
        timer,
        deviceManager: fakeDeviceUtils,
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, timer),
      }),
    );
    await pool.initializeWithDevices([slotA, slotB, free]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    await sessionManager.createSession(execA, slotA.deviceId, "ios");
    sessionManager.setDeviceReadiness(execA, "automationReady");

    ToolRegistry.registerDeviceAware(
      "controlProbe",
      "Control probe",
      z.object({}).passthrough(),
      async (device: BootedDevice) => {
        handled.push(`control:${device.deviceId}`);
        return { success: true };
      },
    );
    ToolRegistry.registerDeviceAware(
      "readProbe",
      "Read probe",
      z.object({}).passthrough(),
      async (device: BootedDevice) => {
        handled.push(`read:${device.deviceId}`);
        return { success: true };
      },
      { deviceReadOnly: true },
    );
  });

  afterEach(() => {
    restorePipeline();
    Reflect.set(ToolRegistry, "deviceSessionManager", originalDeviceSessionManager);
    Reflect.set(ToolRegistry, "toolCallRepository", originalToolCallRepository);
    Reflect.set(ToolRegistry, "navigationToolCallRecorder", originalNavigationRecorder);
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  test("a generic control call on another slot's idle device is refused; a read is not", async () => {
    const refused = await outcome("controlProbe", { platform: "ios", deviceId: slotB.deviceId });
    expect(refused).toBeInstanceOf(DeviceAssignedToManagedSlotError);
    expect((refused as DeviceAssignedToManagedSlotError).code).toBe(
      DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE,
    );

    await call("readProbe", { platform: "ios", deviceId: slotB.deviceId });
    expect(handled).toEqual([`read:${slotB.deviceId}`]);
  });

  test("a slot's own execution controls its device; it cannot reach another slot's", async () => {
    await call("controlProbe", { sessionUuid: execA, deviceId: slotA.deviceId });
    expect(handled).toEqual([`control:${slotA.deviceId}`]);

    const refused = await outcome("controlProbe", { sessionUuid: execA, deviceId: slotB.deviceId });
    expect(refused).toBeInstanceOf(DeviceAssignedToManagedSlotError);
  });

  test("a released execution loses control of the slot device even though its session lives on", async () => {
    await call("controlProbe", { sessionUuid: execA, deviceId: slotA.deviceId });
    await registry.releaseExecution(keyA, execA);
    // Control calls share one registry read per second; the next read sees the cleared owner.
    timer.advanceTime(1_000);

    const refused = await outcome("controlProbe", { sessionUuid: execA, deviceId: slotA.deviceId });

    expect(refused).toBeInstanceOf(DeviceAssignedToManagedSlotError);
    expect(handled).toEqual([`control:${slotA.deviceId}`]);
  });

  describe("a managed connection", () => {
    beforeEach(() => {
      DaemonState.getInstance()
        .getManagedConnectionScopes()
        .bind(mcpA, { scopeKey: keyA.scopeKey, sessionUuids: [execA] });
    });

    test("controls its slot device", async () => {
      await call("controlProbe", {
        sessionUuid: execA,
        deviceId: slotA.deviceId,
        __mcpSessionId: mcpA,
      });
      expect(handled).toEqual([`control:${slotA.deviceId}`]);
    });

    test("may not control an unassigned device, sessionless or not", async () => {
      const refused = await outcome("controlProbe", {
        platform: "ios",
        deviceId: free.deviceId,
        __mcpSessionId: mcpA,
      });
      expect(refused).toBeInstanceOf(DeviceOutsideManagedSlotsError);
      expect((refused as DeviceOutsideManagedSlotsError).code).toBe(
        DEVICE_OUTSIDE_MANAGED_SLOTS_CODE,
      );
      expect((refused as DeviceOutsideManagedSlotsError).toPayload()).toMatchObject({
        reason: "device",
        deviceId: free.deviceId,
        scopeKey: keyA.scopeKey,
      });
      expect(handled).toEqual([]);
    });

    test("may not route control through a session outside its slots", async () => {
      await sessionManager.createSession("other-session", free.deviceId, "ios");
      const refused = await outcome("controlProbe", {
        sessionUuid: "other-session",
        deviceId: free.deviceId,
        __mcpSessionId: mcpA,
      });
      expect((refused as DeviceOutsideManagedSlotsError).toPayload()).toMatchObject({
        reason: "session",
        sessionUuid: "other-session",
      });
    });

    test("still reads any device", async () => {
      await call("readProbe", { platform: "ios", deviceId: free.deviceId, __mcpSessionId: mcpA });
      await call("readProbe", { platform: "ios", deviceId: slotB.deviceId, __mcpSessionId: mcpA });
      expect(handled).toEqual([`read:${free.deviceId}`, `read:${slotB.deviceId}`]);
    });

    test("may not acquire, start, provision or delete devices, or retarget setActiveDevice", () => {
      const gate = (toolName: string, args: Record<string, unknown>, sessionUuid?: string) => () =>
        assertManagedConnectionPlainToolCall({
          daemonMode: true,
          requiresDevice: false,
          toolName,
          mcpSessionId: mcpA,
          args,
          sessionUuid,
        });
      for (const tool of [
        "getAndroid",
        "getApple",
        "startDevice",
        "provisionDevice",
        "deleteDevice",
      ]) {
        expect(gate(tool, {})).toThrow(DeviceOutsideManagedSlotsError);
      }
      expect(gate("setActiveDevice", { deviceId: free.deviceId })).toThrow("not one of its slot");
      expect(gate("setActiveDevice", { deviceId: slotA.deviceId }, execA)).not.toThrow();
      expect(
        gate("killDevice", { device: { deviceId: free.deviceId, name: "Free", platform: "ios" } }),
      ).toThrow(DeviceOutsideManagedSlotsError);
      expect(gate("listDevices", {})).not.toThrow();
      // Stopping is lifecycle too: even its own slot device stops only through slot release (#11271).
      const ownKill = gate(
        "killDevice",
        { device: { deviceId: slotA.deviceId, name: "Slot A", platform: "ios" } },
        execA,
      );
      expect(ownKill).toThrow(DeviceOutsideManagedSlotsError);
      try {
        ownKill();
      } catch (error) {
        expect((error as DeviceOutsideManagedSlotsError).toPayload()).toMatchObject({
          reason: "tool",
          action: "killDevice",
        });
      }
      // A generic connection is not confined.
      expect(() =>
        assertManagedConnectionPlainToolCall({
          daemonMode: true,
          requiresDevice: false,
          toolName: "getApple",
          mcpSessionId: "generic-socket",
          args: {},
          sessionUuid: undefined,
        }),
      ).not.toThrow();
    });
  });
});
