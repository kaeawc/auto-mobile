import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { registerPlanTools } from "../../../src/server/planTools";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { RegistryManagedSlotExclusion } from "../../../src/daemon/managedSlots/managedSlotExclusion";
import { DEVICE_OUTSIDE_MANAGED_SLOTS_CODE } from "../../../src/daemon/managedSlots/managedSlotRefusal";
import type { SlotKey } from "../../../src/daemon/managedSlots/slotRegistry";
import type { BootedDevice } from "../../../src/models";
import { FakeDeviceSessionManager } from "../../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { assignManagedSlotDevice } from "../../daemon/managedSlots/managedSlotFixtures";

/**
 * Hunt (managed slots, 2026-10-10): a managed connection may not acquire devices. `getAndroid`,
 * `getApple`, `startDevice` and `provisionDevice` are refused with `device_outside_managed_slots`,
 * but a multi-device `executePlan` (`devices: [A, B]`) reaches the generic pool allocator
 * (`DevicePool.assignMultipleDevices`) for its derived label session and is handed a generic
 * device outside the connection's slot.
 */
describe("hunt: managed connection multi-device executePlan", () => {
  const slotA: BootedDevice = { name: "Slot A", deviceId: "IOS-SLOT-A", platform: "ios" };
  const free: BootedDevice = { name: "Free", deviceId: "IOS-FREE", platform: "ios" };
  const execA = "exec-a";
  const mcpA = "mcp-socket-a";
  const PLAN = [
    "name: slots-hunt",
    "devices:",
    "  - A",
    "  - B",
    "steps:",
    "  - tool: observe",
    "    device: B",
    "    params: {}",
    "",
  ].join("\n");

  let originalDeviceSessionManager: unknown;
  let originalToolCallRepository: unknown;
  let originalNavigationRecorder: unknown;
  let restorePipeline: () => void;
  let sessionManager: SessionManager;
  let pool: DevicePool;
  let keyA: SlotKey;
  let allocatorCalls: string[][];

  beforeEach(async () => {
    ToolRegistry.clearTools();
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
      deviceReadAccess: { listBooted: async () => [slotA, free], isAuthorized: () => true },
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
    devices.setConnectedDevices([slotA, free]);
    originalDeviceSessionManager = Reflect.get(ToolRegistry, "deviceSessionManager");
    Reflect.set(ToolRegistry, "deviceSessionManager", devices);
    originalToolCallRepository = Reflect.get(ToolRegistry, "toolCallRepository");
    Reflect.set(ToolRegistry, "toolCallRepository", { async recordToolCall(): Promise<void> {} });
    originalNavigationRecorder = Reflect.get(ToolRegistry, "navigationToolCallRecorder");
    Reflect.set(ToolRegistry, "navigationToolCallRecorder", { record: () => undefined });

    const timer = new FakeTimer();
    const registry = new FakeSlotRegistry(timer);
    keyA = await assignManagedSlotDevice(registry, "ios", slotA.deviceId, "runner-a", execA);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("ios", [slotA, free]);
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "slots-hunt-plan-allocation", {
        timer,
        deviceManager: fakeDeviceUtils,
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, timer),
      }),
    );
    await pool.initializeWithDevices([slotA, free]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    await sessionManager.createSession(execA, slotA.deviceId, "ios");
    sessionManager.setDeviceReadiness(execA, "automationReady");
    DaemonState.getInstance()
      .getManagedConnectionScopes()
      .bind(mcpA, { scopeKey: keyA.scopeKey, sessionUuids: [execA] });

    // Record what reaches the generic multi-device allocator, then stop the plan before any step.
    allocatorCalls = [];
    pool.assignMultipleDevices = async (sessionIds: string[]) => {
      allocatorCalls.push([...sessionIds]);
      throw new Error("hunt: stop after the allocator was reached");
    };

    registerPlanTools();
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

  test("is refused device_outside_managed_slots before the generic allocator is asked for a device", async () => {
    let outcome: unknown;
    try {
      outcome = await ToolRegistry.getTool("executePlan")!.handler({
        planContent: PLAN,
        startStep: 0,
        platform: "ios",
        sessionUuid: execA,
        devices: ["A", "B"],
        deviceAllocationTimeoutMs: 1_000,
        abortStrategy: "immediate",
        __mcpSessionId: mcpA,
      });
    } catch (error) {
      outcome = error;
    }

    // The connection's only device is its slot device; label B needs a device from the generic pool.
    expect(allocatorCalls).toEqual([]);
    expect(
      JSON.stringify(outcome instanceof Error ? { message: outcome.message } : outcome),
    ).toContain(DEVICE_OUTSIDE_MANAGED_SLOTS_CODE);
  });
});
