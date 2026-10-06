import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as yaml from "js-yaml";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  MAX_EXECUTE_PLAN_BUDGET_CONTENT_CHARS,
  resolveMcpRequestTimeoutMs,
} from "../../src/daemon/mcpRequestTimeout";
import { SessionManager } from "../../src/daemon/sessionManager";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice, Plan } from "../../src/models";
import {
  getMcpRecorder,
  resetMcpRecordingState,
  startMcpRecording,
  stopMcpRecording,
} from "../../src/server/mcpRecordingManager";
import {
  PlanExecutionOrchestrator,
  type PlanExecutionRequest,
} from "../../src/server/planExecutionOrchestrator";
import { PlanSchemaValidator } from "../../src/utils/plan/PlanSchemaValidator";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

/**
 * A labelled plan built from steps `recordSteps` records (#10052) goes through executePlan's
 * schema validation (#10124) before any device allocation, so the caller-held-device fail-fast
 * (#10153) still applies to it and a plan the schema rejects never reaches the allocation wait
 * or the request-budget bound that wait uses.
 */
const androidA: BootedDevice = { deviceId: "a", name: "a", platform: "android", status: "booted" };
const androidB: BootedDevice = { deviceId: "b", name: "b", platform: "android", status: "booted" };

/** Steps as the recorder stores them, one per newly recorded tool family. */
function recordedSteps(): Plan["steps"] {
  resetMcpRecordingState();
  const timer = new FakeTimer();
  startMcpRecording({ timer });
  const recorder = getMcpRecorder()!;
  recorder.record("tapAt", { x: 10, y: 20, snapshotId: "snap-1", sessionUuid: "recording" });
  recorder.record("homeScreen", {});
  recorder.record("setNotificationPolicy", { appId: "com.example", policyAccess: true });
  recorder.record("setDeviceState", { connectivity: { airplaneMode: true } });
  const recorded = yaml.load(stopMcpRecording({ timer }).planContent) as Plan;
  return recorded.steps;
}

/** The recorded steps as one two-device plan, every step bound to label A. */
function labelledPlanYaml(extraSteps: Array<Record<string, unknown>> = []): string {
  return yaml.dump({
    name: "recorded-labelled",
    devices: ["A", "B"],
    steps: [...recordedSteps().map((step) => ({ ...step, device: "A" })), ...extraSteps],
  });
}

describe("recorded-tool labelled plan: schema validation before allocation (#10052, #10124, #10153)", () => {
  let validator: PlanSchemaValidator;
  let timer: FakeTimer;
  let sessions: SessionManager;
  let pool: DevicePool;

  beforeAll(async () => {
    validator = new PlanSchemaValidator();
    await validator.loadSchema();
    // Warm the plan schema compile so no test body pays for it (100ms/test budget).
    validator.validateYaml("name: warm\nsteps:\n  - tool: observe\n");
  });

  afterAll(() => {
    resetMcpRecordingState();
  });

  beforeEach(async () => {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "recorded-plan-schema-first", {
        timer,
        deviceHealthMarkers: new FakeDeviceHealthMarkers(timer),
        deviceManager: new FakeDeviceManager([], [androidA, androidB]),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
    );
    await pool.initializeWithDevices([androidA, androidB]);
    DaemonState.getInstance().initialize(sessions, pool);
    await pool.bindOrReuseDeviceSession("base", "a", "android");
  });

  afterEach(async () => {
    await drainUntilQuiescent(timer);
    DaemonState.getInstance().reset();
    sessions.stopCleanupTimer();
    timer.reset();
  });

  const orchestrate = (planContent: string, planRequest?: { deadlineMs: number }) => {
    const request: PlanExecutionRequest = {
      planContent,
      startStep: 0,
      platform: "android",
      sessionUuid: "base",
      deviceAllocationTimeoutMs: 300_000,
    };
    const orchestrator = new PlanExecutionOrchestrator(
      { device: androidA, request },
      { timer, createSchemaValidator: () => validator },
    );
    return runWithToolSelectionContext({ planRequest }, () => orchestrator.execute());
  };

  const expectNoAllocationTraces = () => {
    expect(timer.now()).toBe(0);
    expect(sessions.getDeviceLabels("base")).toBeUndefined();
    expect(sessions.getSession("base:B")).toBeNull();
    expect(pool.getDevice("a")?.sessionId).toBe("base");
    expect(pool.getDevice("b")?.sessionId ?? null).toBeNull();
  };

  test("the recorded-tool plan is schema-valid, so only allocation can reject it", () => {
    expect(validator.validateYaml(labelledPlanYaml()).errors ?? []).toEqual([]);
  });

  test("it fails at once with the caller-held shortfall when another session holds the other device", async () => {
    await pool.bindOrReuseDeviceSession("other-client", "b", "android");

    const result = await orchestrate(labelledPlanYaml());

    expect(result.success).toBe(false);
    expect(result.error).not.toContain("validation failed");
    expect(result.error).toContain("needs 2 device(s)");
    expect(result.error).toContain("calling session already holds a");
    expect(timer.now()).toBe(0);
    expect(sessions.getDeviceLabels("base")).toBeUndefined();
    expect(sessions.getSession("base:B")).toBeNull();
    expect(pool.getDevice("a")?.sessionId).toBe("base");
    expect(pool.getDevice("b")?.sessionId).toBe("other-client");
  });

  test("a plan the schema rejects reports validation, not allocation, and allocates nothing", async () => {
    // `doNotDisturb: {}` is a tool-rejected value the plan schema mirrors (by-design rejection).
    const rejected = labelledPlanYaml([
      { tool: "setDeviceState", device: "B", params: { doNotDisturb: {} } },
    ]);
    expect(validator.validateYaml(rejected).valid).toBe(false);

    const result = await orchestrate(rejected);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Plan YAML validation failed");
    expect(result.error).not.toContain("allocating");
    expectNoAllocationTraces();
  });

  test("a spent request budget still reports validation first for a rejected plan", async () => {
    const rejected = labelledPlanYaml([
      { tool: "setDeviceState", device: "B", params: { doNotDisturb: {} } },
    ]);

    // The allocation bound would clamp a budget this spent to a single zero-length attempt and
    // report an allocation timeout; validation must win before that bound is ever computed.
    const result = await orchestrate(rejected, { deadlineMs: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Plan YAML validation failed");
    expect(result.error).not.toContain("Timed out allocating");
    expectNoAllocationTraces();
  });

  test("the request-path step budget of a rejected plan is bounded and never throws", () => {
    // The daemon derives the request deadline from raw step budgets before the orchestrator
    // validates, so it must cope with whatever the schema will go on to reject.
    const hostile = [
      "name: bad",
      "devices: [A]",
      "steps:",
      "  - tool: observe",
      "    device: A",
      "    waitFor: not-an-object",
      "  - tool: setDeviceState",
      "    params: { doNotDisturb: {} }",
      "  - 42",
      "  - { tool: [not, a, string] }",
    ].join("\n");

    for (const planContent of [hostile, "{{{ not yaml", "x".repeat(10)]) {
      const timeoutMs = resolveMcpRequestTimeoutMs({
        id: "r1",
        type: "mcp_request",
        method: "tools/call",
        params: { name: "executePlan", arguments: { planContent } },
      });
      expect(Number.isFinite(timeoutMs)).toBe(true);
      expect(timeoutMs).toBeGreaterThan(0);
    }
    expect(MAX_EXECUTE_PLAN_BUDGET_CONTENT_CHARS).toBeGreaterThan(0);
  });
});
