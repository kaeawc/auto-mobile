import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import {
  PlanExecutionOrchestrator,
  type PlanExecutionRequest,
} from "../../src/server/planExecutionOrchestrator";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

/**
 * #10153: a plan that fails before it runs (here: its labelled device allocation cannot be met)
 * must not auto-release the session the CALLER acquired before the plan. The real registry
 * wrapper, the real plan lifecycle manager, the real orchestrator and a real pool run here; only
 * the execution-target resolver (the caller's session), the audit/after-call stages and the
 * schema validator are fakes.
 */
const androidA: BootedDevice = { deviceId: "a", name: "a", platform: "android", status: "booted" };
const androidB: BootedDevice = { deviceId: "b", name: "b", platform: "android", status: "booted" };

const labelledRequest: PlanExecutionRequest = {
  planContent: "name: two-device\nsteps:\n  - tool: observe\n    params: {}\n",
  startStep: 0,
  platform: "android",
  sessionUuid: "base",
  devices: ["A", "B"],
  deviceAllocationTimeoutMs: 300_000,
};

describe("executePlan lifecycle after a plan that never ran (#10153)", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let pool: DevicePool;
  let restoreTools: () => void;
  let restorePipeline: () => void;
  let callerSession: string | undefined;
  let runBody: () => Promise<unknown>;

  beforeEach(async () => {
    restoreTools = preserveToolRegistry();
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const discovery = new FakeDeviceManager([], [androidA, androidB]);
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "plan-lifecycle-keep", {
        timer,
        deviceHealthMarkers: new FakeDeviceHealthMarkers(timer),
        deviceManager: discovery,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
    );
    await pool.initializeWithDevices([androidA, androidB]);
    DaemonState.getInstance().initialize(sessions, pool);
    await pool.bindOrReuseDeviceSession("base", "a", "android");
    // The only other device is offline, so the labelled plan can never allocate.
    pool.getDevice("b")!.status = "error";

    callerSession = "base";
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async (input) => ({
          args: input.args,
          baseSessionUuid: callerSession,
          device: androidA,
          sessionUuid: "base",
          internalCall: false,
          shouldResolveDevice: true,
        }),
      },
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        handle: async (input) => ({ durationMs: 0, finalizedResponse: input.response }),
      },
      // planLifecycleManager is deliberately NOT overridden: the real hook runs.
    });

    runBody = async () => {
      const orchestrator = new PlanExecutionOrchestrator(
        { device: androidA, request: labelledRequest },
        {
          timer,
          createSchemaValidator: () => ({
            loadSchema: async () => undefined,
            validateYaml: () => ({ valid: true }),
          }),
        },
      );
      const result = await orchestrator.execute();
      return createStructuredToolResponse({ ...result });
    };
    ToolRegistry.registerDeviceAware(
      "executePlan",
      "executePlan stand-in running the real orchestrator",
      z.object({ sessionUuid: z.string().optional(), platform: z.string().optional() }),
      async () => runBody(),
    );
  });

  afterEach(async () => {
    restorePipeline();
    restoreTools();
    await drainUntilQuiescent(timer);
    DaemonState.getInstance().reset();
    sessions.stopCleanupTimer();
    timer.reset();
  });

  const callExecutePlan = async () => {
    const response = await ToolRegistry.getToolForPlan("executePlan")!.handler({
      sessionUuid: "base",
      platform: "android",
    });
    return response.structuredContent as { success: boolean; totalSteps: number; error?: string };
  };

  test("an allocation failure leaves the caller's session and device alone", async () => {
    const result = await callExecutePlan();

    expect(result.success).toBe(false);
    expect(result.totalSteps).toBe(0);
    expect(result.error).toContain("calling session already holds");
    expect(sessions.getSession("base")?.assignedDevice).toBe("a");
    expect(pool.getDevice("a")?.sessionId).toBe("base");
    expect(pool.getDevice("a")?.status).toBe("busy");
    expect(sessions.getSession("base:B")).toBeNull();
    expect(pool.getDevice("b")?.status).toBe("error");
  });

  test("a plan that ran still auto-releases its base session (control)", async () => {
    runBody = async () =>
      createStructuredToolResponse({ success: true, executedSteps: 1, totalSteps: 1 });

    const result = await callExecutePlan();

    expect(result.success).toBe(true);
    expect(sessions.getSession("base")).toBeNull();
    expect(pool.getDevice("a")?.status).toBe("idle");
  });

  test("a plan that failed on its first step still auto-releases its base session (control)", async () => {
    runBody = async () =>
      createStructuredToolResponse({ success: false, executedSteps: 0, totalSteps: 3 });

    await callExecutePlan();

    expect(sessions.getSession("base")).toBeNull();
    expect(pool.getDevice("a")?.status).toBe("idle");
  });

  test("a call that passed no session of its own keeps the previous release behaviour (control)", async () => {
    callerSession = undefined;

    await callExecutePlan();

    expect(sessions.getSession("base")).toBeNull();
    expect(pool.getDevice("a")?.status).toBe("idle");
  });
});
