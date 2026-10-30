import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { readToolResponse, toolJson, toolStructured } from "../helpers/toolResponse";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry, type ToolRegistryCollaborators } from "../../src/server/toolRegistry";
import { registerPlanTools } from "../../src/server/planTools";
import * as videoRecordingManager from "../../src/daemon/videoRecordingManager";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { RegistryBindingExclusion } from "../../src/daemon/sessionBroker/provisioning/exclusion";
import { DEVICE_OUTSIDE_BROKER_GRANT_CODE } from "../../src/daemon/sessionBroker/connectionRefusal";
import type { BindingKey } from "../../src/daemon/sessionBroker/registry/bindingRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeBindingRegistry } from "../fakes/FakeBindingRegistry";
import { FakePlanVideoRecorder } from "../fakes/FakePlanVideoRecorder";
import { FakeTimer } from "../fakes/FakeTimer";
import { assignBindingDevice } from "../daemon/sessionBroker/provisioning/bindingFixtures";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/**
 * #11397: a managed connection may not acquire devices. `getAndroid`, `getApple`, `startDevice` and
 * `provisionDevice` are refused with `device_outside_broker_grant`; a multi-device `executePlan`
 * (`devices: [A, B]`) used to reach the generic pool allocator (`DevicePool.assignMultipleDevices`)
 * for its derived label session and was handed a generic device outside the connection's slot.
 * Plan labels are served only by the connection's own slot sessions, without the allocator.
 */
describe("managed connection executePlan device labels (#11397)", () => {
  const slotA: BootedDevice = { name: "Binding A", deviceId: "IOS-SLOT-A", platform: "ios" };
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

  let originalCollaborators: ToolRegistryCollaborators;
  let restorePipeline: () => void;
  let sessionManager: SessionManager;
  let pool: DevicePool;
  let keyA: BindingKey;
  let allocatorCalls: string[][];
  let restoreVideoRecorder: () => void;

  // The executePlan tool builds its orchestrator without an injection seam, so the video
  // manager that the orchestrator's default recorder delegates to is replaced instead. The
  // orchestrator reads those bindings when it is constructed, after this runs.
  const fakeVideoRecorder = (): (() => void) => {
    const fake = new FakePlanVideoRecorder();
    const spies = [
      spyOn(videoRecordingManager, "startVideoRecording").mockImplementation(
        fake.startVideoRecording,
      ),
      spyOn(videoRecordingManager, "stopVideoRecording").mockImplementation(
        fake.stopVideoRecording,
      ),
      spyOn(videoRecordingManager, "rollbackVideoRecordingStart").mockResolvedValue(undefined),
      spyOn(videoRecordingManager, "getVideoRecordingStatus").mockResolvedValue(undefined),
      spyOn(videoRecordingManager, "getVideoRecordingMetadata").mockResolvedValue(null),
    ];
    return () => spies.forEach((spy) => spy.mockRestore());
  };

  const setUp = async (): Promise<void> => {
    restoreVideoRecorder = fakeVideoRecorder();
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
    const devices = new FakeDeviceReadiness();
    devices.setConnectedDevices([slotA, free]);
    originalCollaborators = ToolRegistry.getCollaboratorsForTesting();
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: devices });
    ToolRegistry.setCollaboratorsForTesting({
      toolCallRepository: { async recordToolCall(): Promise<void> {} },
    });
    ToolRegistry.setCollaboratorsForTesting({
      navigationToolCallRecorder: { record: () => undefined },
    });

    const timer = new FakeTimer();
    const registry = new FakeBindingRegistry(timer);
    keyA = await assignBindingDevice(registry, "ios", slotA.deviceId, "runner-a", execA);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("ios", [slotA, free]);
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "slots-hunt-plan-allocation", {
        timer,
        deviceManager: fakeDeviceUtils,
        bindingExclusion: new RegistryBindingExclusion(async () => registry, timer),
      }),
    );
    await pool.initializeWithDevices([slotA, free]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    await sessionManager.createSession(execA, slotA.deviceId, "ios");
    sessionManager.setDeviceReadiness(execA, "automationReady");
    DaemonState.getInstance()
      .getBrokerConnectionScopes()
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
  };

  const tearDown = (): void => {
    restoreVideoRecorder();
    restorePipeline();
    ToolRegistry.setCollaboratorsForTesting(originalCollaborators);
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  };

  const runPlan = async (
    planContent: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const response = readToolResponse(
      await ToolRegistry.getTool("executePlan")!.handler({
        planContent,
        startStep: 0,
        platform: "ios",
        sessionUuid: execA,
        deviceAllocationTimeoutMs: 1_000,
        abortStrategy: "immediate",
        __mcpSessionId: mcpA,
        ...args,
      }),
    );
    return response.structuredContent === undefined ? toolJson(response) : toolStructured(response);
  };

  // The first executePlan call pays the plan pipeline's one-time module and schema cost, which put
  // the first test over the 100 ms budget on a loaded runner. Pay it once outside the timed tests.
  beforeAll(async () => {
    await setUp();
    try {
      await runPlan(PLAN, { devices: ["A", "B"] });
    } finally {
      tearDown();
    }
  });

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await setUp();
        await fn();
      },
      timeout,
    );
  }

  type CriterionRow = [criterion: string, line: string];

  function arrangedEachRow(table: CriterionRow[]) {
    return (
      name: string,
      fn: (...row: CriterionRow) => void | Promise<void>,
      timeout?: number,
    ): void => {
      test.each(table)(
        name,
        async (...row: CriterionRow) => {
          await setUp();
          await fn(...row);
        },
        timeout,
      );
    };
  }
  afterEach(tearDown);

  arranged(
    "a label beyond the binding sessions is refused before the generic allocator is asked",
    async () => {
      const result = await runPlan(PLAN, { devices: ["A", "B"] });

      // The connection's only device is its slot device; label B needs a device from the generic pool.
      expect(allocatorCalls).toEqual([]);
      expect(result).toMatchObject({
        success: false,
        code: DEVICE_OUTSIDE_BROKER_GRANT_CODE,
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
    },
  );

  arranged(
    "labels declared only in the plan are refused the same way, with or without the socket id",
    async () => {
      const viaSocket = await runPlan(PLAN);
      // An internal caller carries no socket session id: the slot session identifies the connection.
      const viaSession = await runPlan(PLAN, { __mcpSessionId: undefined });

      expect(allocatorCalls).toEqual([]);
      const refusal = { code: DEVICE_OUTSIDE_BROKER_GRANT_CODE, reason: "tool", deviceLabel: "B" };
      expect(viaSocket).toMatchObject(refusal);
      expect(viaSession).toMatchObject(refusal);
    },
  );

  arranged(
    "a label whose declared platform the binding device cannot satisfy is refused",
    async () => {
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
      expect(result).toMatchObject({ code: DEVICE_OUTSIDE_BROKER_GRANT_CODE, deviceLabel: "A" });
    },
  );

  // #11421: the slot serves a label with its own device or not at all.
  describe("a label's declared simulator criteria", () => {
    const labelPlan = (...criteria: string[]): string =>
      [
        "name: slots-criteria",
        "devices:",
        "  - label: A",
        "    platform: ios",
        ...criteria.map((line) => `    ${line}`),
        "steps:",
        "  - tool: slotProbe",
        "    device: A",
        "    params: {}",
        "",
      ].join("\n");

    function arrangeNested(): void {
      ToolRegistry.registerDeviceAware(
        "slotProbe",
        "Binding probe",
        z.object({}).passthrough(),
        async () => ({ success: true }),
      );
    }

    function arrangedNestedEachRow(table: CriterionRow[]) {
      return (
        name: string,
        fn: (...row: CriterionRow) => void | Promise<void>,
        timeout?: number,
      ): void => {
        arrangedEachRow(table)(
          name,
          async (...row: CriterionRow) => {
            await arrangeNested();
            await fn(...row);
          },
          timeout,
        );
      };
    }

    function arrangedNested(name: string, fn: () => void | Promise<void>, timeout?: number): void {
      arranged(
        name,
        async () => {
          await arrangeNested();
          await fn();
        },
        timeout,
      );
    }

    const slotDeviceIs = (facts: { simulatorType?: string; iosVersion?: string }): void => {
      Object.assign(pool.getDevice(slotA.deviceId)!, facts);
    };

    arrangedNestedEachRow([
      ["simulatorType", 'simulatorType: "iPad Pro"'],
      ["iosVersion", 'iosVersion: "17.5"'],
    ])("a %s the binding device does not have is refused", async (_criterion, line) => {
      slotDeviceIs({ simulatorType: "iPhone 16", iosVersion: "18.0" });

      const result = await runPlan(labelPlan(line));

      expect(allocatorCalls).toEqual([]);
      expect(result).toMatchObject({
        success: false,
        code: DEVICE_OUTSIDE_BROKER_GRANT_CODE,
        deviceLabel: "A",
      });
    });

    arrangedNested("criteria the binding device meets are served by it", async () => {
      slotDeviceIs({ simulatorType: "iPhone 16", iosVersion: "18.0" });

      const result = await runPlan(labelPlan('simulatorType: "iPhone 16"', 'iosVersion: "18.0"'));

      expect(result).toMatchObject({ success: true, deviceMapping: { A: slotA.deviceId } });
    });

    arrangedNested(
      "criteria the pool cannot evaluate for the binding device are not a refusal",
      async () => {
        // The harness device carries neither a simulator type nor an iOS version.
        const result = await runPlan(labelPlan('simulatorType: "iPad Pro"', 'iosVersion: "17.5"'));

        expect(result).toMatchObject({ success: true, deviceMapping: { A: slotA.deviceId } });
      },
    );
  });

  arranged(
    "a single label is served by the binding device without the generic allocator",
    async () => {
      const probed: string[] = [];
      ToolRegistry.registerDeviceAware(
        "slotProbe",
        "Binding probe",
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
    },
  );

  // #11421: the slot session belongs to the connection for its lifetime. Plan auto-release frees
  // the sessions a plan run owns; a managed connection's slot session is not one of them.
  describe("the binding session outlives the plan (#11421)", () => {
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

    function arrangeNested2(): void {
      probed = [];
      ToolRegistry.registerDeviceAware(
        "slotProbe",
        "Binding probe",
        z.object({}).passthrough(),
        async (device: BootedDevice) => {
          probed.push(device.deviceId);
          return { success: true };
        },
      );
    }

    function arrangedNested2(name: string, fn: () => void | Promise<void>, timeout?: number): void {
      arranged(
        name,
        async () => {
          await arrangeNested2();
          await fn();
        },
        timeout,
      );
    }

    const expectSlotSessionLive = async (): Promise<void> => {
      expect(sessionManager.getSession(execA)?.assignedDevice).toBe(slotA.deviceId);
      expect(sessionManager.getSessionForDevice(slotA.deviceId)).toBe(execA);
      // The next control call on the same connection still runs on the slot device.
      probed = [];
      await probe(execA, mcpA);
      expect(probed).toEqual([slotA.deviceId]);
    };

    arrangedNested2(
      "a successful plan leaves the binding session and its device with the connection",
      async () => {
        const result = await runPlan(PROBE_PLAN);

        expect(result).toMatchObject({ success: true, deviceId: slotA.deviceId });
        await expectSlotSessionLive();
      },
    );

    arrangedNested2(
      "a successful single-label plan leaves the binding session with the connection",
      async () => {
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
      },
    );

    arrangedNested2("a refused plan leaves the binding session with the connection", async () => {
      const result = await runPlan(PLAN, { devices: ["A", "B"] });

      expect(result.code).toBe(DEVICE_OUTSIDE_BROKER_GRANT_CODE);
      await expectSlotSessionLive();
    });

    arrangedNested2("a failed plan leaves the binding session with the connection", async () => {
      const result = await runPlan(
        planOf("name: slots-fail", "steps:", "  - tool: noSuchTool", "    params: {}"),
      );

      expect(result.success).toBe(false);
      await expectSlotSessionLive();
    });

    arrangedNested2("a generic connection keeps its caller-held session after a plan", async () => {
      await sessionManager.createSession(genericSession, free.deviceId, "ios");
      sessionManager.setDeviceReadiness(genericSession, "automationReady");
      await probe(genericSession);
      const result = await runPlan(PROBE_PLAN, {
        sessionUuid: genericSession,
        __mcpSessionId: "mcp-socket-generic",
      });
      expect(result).toMatchObject({ success: true, deviceId: free.deviceId });
      expect(sessionManager.peekSession(genericSession)?.assignedDevice).toBe(free.deviceId);
      expect(sessionManager.getSessionForDevice(free.deviceId)).toBe(genericSession);
      await expectSlotSessionLive();
    });

    // A generic connection's plan frees a base it acquired itself, unlike a binding session.
    arrangedNested2(
      "a generic connection's session is still auto-released after its plan",
      async () => {
        await sessionManager.createSession(genericSession, free.deviceId, "ios");
        sessionManager.setDeviceReadiness(genericSession, "automationReady");
        await probe(genericSession);
        await releaseSessionAndDevice(sessionManager, pool, free.deviceId, genericSession, {
          reason: "plan-auto-release",
        });

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
      },
    );
  });
});
