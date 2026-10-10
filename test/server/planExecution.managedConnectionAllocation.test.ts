import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerPlanTools } from "../../src/server/planTools";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { RegistryManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import { DEVICE_OUTSIDE_MANAGED_SLOTS_CODE } from "../../src/daemon/managedSlots/managedSlotRefusal";
import type { SlotKey } from "../../src/daemon/managedSlots/slotRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeSlotRegistry } from "../fakes/FakeSlotRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { assignManagedSlotDevice } from "../daemon/managedSlots/managedSlotFixtures";

/**
 * #11397: a managed connection may not acquire devices. `getAndroid`, `getApple`, `startDevice` and
 * `provisionDevice` are refused with `device_outside_managed_slots`; a multi-device `executePlan`
 * (`devices: [A, B]`) used to reach the generic pool allocator (`DevicePool.assignMultipleDevices`)
 * for its derived label session and was handed a generic device outside the connection's slot.
 * Plan labels are served only by the connection's own slot sessions, without the allocator.
 */
describe("managed connection executePlan device labels (#11397)", () => {
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

    // Record what reaches the generic multi-device allocators, then stop the plan before any step.
    allocatorCalls = [];
    pool.assignMultipleDevices = async (sessionIds: string[]) => {
      allocatorCalls.push([...sessionIds]);
      throw new Error("stop after the allocator was reached");
    };
    pool.assignMultipleDevicesByCriteria = async (requests) => {
      allocatorCalls.push(requests.map((request) => request.sessionId));
      throw new Error("stop after the criteria allocator was reached");
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

  const runPlan = async (
    planContent: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const response = await ToolRegistry.getTool("executePlan")!.handler({
      planContent,
      startStep: 0,
      platform: "ios",
      sessionUuid: execA,
      deviceAllocationTimeoutMs: 1_000,
      abortStrategy: "immediate",
      __mcpSessionId: mcpA,
      ...args,
    });
    return response.structuredContent ?? JSON.parse(response.content[0].text);
  };

  test("a label beyond the slot sessions is refused before the generic allocator is asked", async () => {
    const result = await runPlan(PLAN, { devices: ["A", "B"] });

    // The connection's only device is its slot device; label B needs a device from the generic pool.
    expect(allocatorCalls).toEqual([]);
    expect(result).toMatchObject({
      success: false,
      code: DEVICE_OUTSIDE_MANAGED_SLOTS_CODE,
      retryable: false,
      // #11421: the refusal's own evidence is on the wire, not only in the message.
      action: "executePlan",
      reason: "tool",
      scopeKey: keyA.scopeKey,
      deviceLabel: "B",
      // The plan result's own fields are not replaced by the refusal payload.
      platform: "ios",
      deviceId: slotA.deviceId,
    });
    expect(typeof result.error).toBe("string");
    expect(sessionManager.getDeviceLabels(execA)).toBeUndefined();
    expect(sessionManager.getSession(`${execA}:B`)).toBeFalsy();
  });

  test("labels declared only in the plan are refused the same way, with or without the socket id", async () => {
    const viaSocket = await runPlan(PLAN);
    // An internal caller carries no socket session id: the slot session identifies the connection.
    const viaSession = await runPlan(PLAN, { __mcpSessionId: undefined });

    expect(allocatorCalls).toEqual([]);
    const refusal = { code: DEVICE_OUTSIDE_MANAGED_SLOTS_CODE, reason: "tool", deviceLabel: "B" };
    expect(viaSocket).toMatchObject(refusal);
    expect(viaSession).toMatchObject(refusal);
  });

  test("a label whose declared platform the slot device cannot satisfy is refused", async () => {
    const result = await runPlan(
      [
        "name: slots-platform",
        "devices:",
        "  - label: A",
        "    platform: android",
        "steps:",
        "  - tool: observe",
        "    device: A",
        "    params: {}",
        "",
      ].join("\n"),
    );

    expect(allocatorCalls).toEqual([]);
    expect(result).toMatchObject({ code: DEVICE_OUTSIDE_MANAGED_SLOTS_CODE, deviceLabel: "A" });
  });

  test("a single label is served by the slot device without the generic allocator", async () => {
    const probed: string[] = [];
    ToolRegistry.registerDeviceAware(
      "slotProbe",
      "Slot probe",
      z.object({}).passthrough(),
      async (device: BootedDevice) => {
        probed.push(device.deviceId);
        return { success: true };
      },
    );

    const result = await runPlan(
      [
        "name: slots-single",
        "devices:",
        "  - A",
        "steps:",
        "  - tool: slotProbe",
        "    device: A",
        "    params: {}",
        "",
      ].join("\n"),
    );

    expect(allocatorCalls).toEqual([]);
    expect(result).toMatchObject({ success: true, deviceMapping: { A: slotA.deviceId } });
    expect(probed).toEqual([slotA.deviceId]);
  });

  // #11421: the slot session belongs to the connection for its lifetime. Plan auto-release frees
  // the sessions a plan run owns; a managed connection's slot session is not one of them.
  describe("the slot session outlives the plan (#11421)", () => {
    const genericSession = "generic-session";
    let probed: string[];

    const planOf = (...lines: string[]): string => [...lines, ""].join("\n");
    const PROBE_PLAN = planOf(
      "name: slots-probe",
      "steps:",
      "  - tool: slotProbe",
      "    params: {}",
    );
    const probe = (sessionUuid: string, mcpSessionId?: string) =>
      ToolRegistry.getTool("slotProbe")!.handler({
        platform: "ios",
        sessionUuid,
        __mcpSessionId: mcpSessionId,
      });

    beforeEach(() => {
      probed = [];
      ToolRegistry.registerDeviceAware(
        "slotProbe",
        "Slot probe",
        z.object({}).passthrough(),
        async (device: BootedDevice) => {
          probed.push(device.deviceId);
          return { success: true };
        },
      );
    });

    const expectSlotSessionLive = async (): Promise<void> => {
      expect(sessionManager.getSession(execA)?.assignedDevice).toBe(slotA.deviceId);
      expect(sessionManager.getSessionForDevice(slotA.deviceId)).toBe(execA);
      // The next control call on the same connection still runs on the slot device.
      probed = [];
      await probe(execA, mcpA);
      expect(probed).toEqual([slotA.deviceId]);
    };

    test("a successful plan leaves the slot session and its device with the connection", async () => {
      const result = await runPlan(PROBE_PLAN);

      expect(result).toMatchObject({ success: true, deviceId: slotA.deviceId });
      await expectSlotSessionLive();
    });

    test("a successful single-label plan leaves the slot session with the connection", async () => {
      const result = await runPlan(
        planOf(
          "name: slots-label",
          "devices:",
          "  - A",
          "steps:",
          "  - tool: slotProbe",
          "    device: A",
          "    params: {}",
        ),
      );

      expect(result).toMatchObject({ success: true });
      await expectSlotSessionLive();
    });

    test("a refused plan leaves the slot session with the connection", async () => {
      const result = await runPlan(PLAN, { devices: ["A", "B"] });

      expect(result.code).toBe(DEVICE_OUTSIDE_MANAGED_SLOTS_CODE);
      await expectSlotSessionLive();
    });

    test("a failed plan leaves the slot session with the connection", async () => {
      const result = await runPlan(
        planOf("name: slots-fail", "steps:", "  - tool: noSuchTool", "    params: {}"),
      );

      expect(result.success).toBe(false);
      await expectSlotSessionLive();
    });

    // docs/tools.md (`holdSessionOnFailure` "instead of auto-releasing them") and the
    // `plan-auto-release` row of docs/using/device-ownership.md: a generic connection's plan
    // frees its base session and device, whether or not the session existed before the plan.
    test("a generic connection's session is still auto-released after its plan", async () => {
      await sessionManager.createSession(genericSession, free.deviceId, "ios");
      sessionManager.setDeviceReadiness(genericSession, "automationReady");
      await probe(genericSession);

      const result = await runPlan(PROBE_PLAN, {
        sessionUuid: genericSession,
        __mcpSessionId: "mcp-socket-generic",
      });

      expect(result).toMatchObject({ success: true, deviceId: free.deviceId });
      expect(probed).toEqual([free.deviceId, free.deviceId]);
      expect(sessionManager.getSession(genericSession)).toBeFalsy();
      expect(sessionManager.getSessionForDevice(free.deviceId)).toBeNull();
      // The managed connection next to it is untouched.
      expect(sessionManager.getSession(execA)?.assignedDevice).toBe(slotA.deviceId);
    });
  });
});
