import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

describe("PlanExecutor failure observation device routing", () => {
  const toolName = "failureObservationRoutingStep";
  const baseSessionUuid = "failure-observation-base";
  const schema = z.object({
    platform: z.string().optional(),
    sessionUuid: z.string().optional(),
    deviceId: z.string().optional(),
    device: z.string().optional(),
  });
  type Params = z.infer<typeof schema>;
  let executor: DefaultPlanExecutor;
  let sessionManager: SessionManager;
  let observations: Params[];
  let stepCalls: Params[];
  let failingDevices: string[];
  let throwFailure: boolean;
  let restoreRegistry: () => void;
  let restoreSpies: Array<() => void>;

  beforeEach(async () => {
    restoreRegistry = preserveToolRegistry();
    observations = [];
    stepCalls = [];
    failingDevices = [];
    throwFailure = false;
    const timer = new FakeTimer();
    executor = new DefaultPlanExecutor(timer);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(baseSessionUuid, "device-A", "android");
    await sessionManager.createSession("session-for-B", "device-B", "android");
    sessionManager.setDeviceLabels(baseSessionUuid, { A: baseSessionUuid, B: "session-for-B" });
    const daemonState = DaemonState.getInstance();
    const initialized = spyOn(daemonState, "isInitialized").mockReturnValue(true);
    const manager = spyOn(daemonState, "getSessionManager").mockReturnValue(sessionManager);
    restoreSpies = [() => manager.mockRestore(), () => initialized.mockRestore()];

    ToolRegistry.register(toolName, "Fake failing step", schema, async (input) => {
      const params = schema.parse(input);
      stepCalls.push(params);
      if (!failingDevices.includes(params.device ?? "A")) {
        return { success: true };
      }
      if (throwFailure) {
        throw new Error("missing element");
      }
      return { success: false, error: "missing element" };
    });
    ToolRegistry.getTool(toolName)!.requiresDevice = true;
    ToolRegistry.register("observe", "Fake recording observation", schema, async (input) => {
      const params = schema.parse(input);
      observations.push(params);
      // Model the existing label map routing: no label selects base device A.
      const sessionUuid = params.device
        ? sessionManager.getDeviceLabels(params.sessionUuid!)?.[params.device]
        : params.sessionUuid;
      expect(sessionUuid).toBeDefined();
      expect(sessionManager.getSession(sessionUuid!)).toBeDefined();
      return createStructuredToolResponse({
        activeWindow: { appId: sessionManager.getDeviceForSession(sessionUuid!) },
      });
    });
  });

  afterEach(() => {
    restoreRegistry();
    for (const restore of restoreSpies) {
      restore();
    }
    sessionManager.stopCleanupTimer();
  });

  function execute(devices?: string[]) {
    const plan: Plan = {
      name: "failure observation routing",
      devices,
      steps: (devices ?? [undefined]).map((device) => ({
        tool: toolName,
        params: device ? { device } : {},
      })),
    };
    return executor.executePlan(
      plan,
      0,
      "android",
      "device-A",
      baseSessionUuid,
      undefined,
      "finish-current-step",
    );
  }

  for (const device of ["A", "B"]) {
    for (const throws of [false, true]) {
      test(`captures ${device} when its step ${throws ? "throws" : "returns failure"}`, async () => {
        failingDevices = [device];
        throwFailure = throws;
        const result = await execute(["A", "B"]);

        expect(result.success).toBe(false);
        expect(observations).toEqual([
          { platform: "android", sessionUuid: baseSessionUuid, device },
        ]);
        expect(stepCalls.find((params) => params.device === device)).toEqual(observations[0]);
        expect(result.failedStep).toMatchObject({
          device,
          failureObservation: { activeWindow: { appId: `device-${device}` } },
        });
        expect(result.perDeviceResults?.get(device)?.failedStep?.failureObservation).toEqual(
          result.failedStep?.failureObservation,
        );
      });
    }
  }

  test("both failing devices retain observations of their own device", async () => {
    failingDevices = ["A", "B"];
    const result = await execute(["A", "B"]);

    expect(observations).toHaveLength(2);
    for (const device of ["A", "B"]) {
      expect(observations).toContainEqual({
        platform: "android",
        sessionUuid: baseSessionUuid,
        device,
      });
      expect(result.perDeviceResults?.get(device)?.failedStep?.failureObservation).toMatchObject({
        activeWindow: { appId: `device-${device}` },
      });
    }
    expect(result.failedStep).toMatchObject({
      device: "A",
      failureObservation: { activeWindow: { appId: "device-A" } },
    });
    // The selected observation lives at top level; deviceFailures omits its duplicate (#9813).
    expect(result.deviceFailures?.[0]).toMatchObject({ device: "A" });
    expect(result.deviceFailures?.[0]).not.toHaveProperty("failureObservation");
    expect(result.deviceFailures?.[1]).toMatchObject({
      device: "B",
      failureObservation: { activeWindow: { appId: "device-B" } },
    });
  });

  test("single-device observation params remain exactly platform and sessionUuid", async () => {
    failingDevices = ["A"];
    const result = await execute();

    expect(result.success).toBe(false);
    expect(observations).toEqual([{ platform: "android", sessionUuid: baseSessionUuid }]);
    expect(result.failedStep?.failureObservation).toMatchObject({
      activeWindow: { appId: "device-A" },
    });
  });
});
