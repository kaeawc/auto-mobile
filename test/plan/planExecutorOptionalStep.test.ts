import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerObserveTools } from "../../src/server/observeTools";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Optional (best-effort) plan steps. A step marked `optional: true` whose tool fails must NOT abort
 * the plan — the executor logs it, records it as skipped, and continues. This is the primitive that
 * lets a plan dismiss an intermittent dialog (e.g. the Reminders "Enable iCloud Syncing?" alert,
 * issue #2811) without breaking the runs where that dialog is absent.
 */
describe("PlanExecutor — optional steps", () => {
  let planExecutor: DefaultPlanExecutor;

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
    const deviceSchema = z.object({
      platform: z.string().optional(),
      deviceId: z.string().optional(),
      sessionUuid: z.string().optional(),
      waitFor: z.any().optional(),
    });

    const markDevice = (name: string) => {
      (ToolRegistry.getTool(name) as { requiresDevice: boolean }).requiresDevice = true;
    };

    ToolRegistry.register(
      "optionalStepFail",
      "always fails",
      deviceSchema,
      mock(async () =>
        createStructuredToolResponse({ success: false, error: "element not found" }),
      ),
    );
    markDevice("optionalStepFail");

    ToolRegistry.register(
      "optionalStepThrow",
      "always throws",
      deviceSchema,
      mock(async () => {
        throw new Error("boom");
      }),
    );
    markDevice("optionalStepThrow");

    // The awaitTimeout skip path only applies to the real `observe` tool, so override it here.
    ToolRegistry.register(
      "observe",
      "observe timeout",
      deviceSchema,
      mock(async () =>
        createStructuredToolResponse({
          updatedAt: 0,
          awaitTimeout: true,
          awaitDuration: 5000,
        }),
      ),
    );
    markDevice("observe");

    ToolRegistry.register(
      "optionalStepOk",
      "succeeds",
      deviceSchema,
      mock(async () => createStructuredToolResponse({ success: true })),
    );
    markDevice("optionalStepOk");

    // A tool whose schema requires a field, so bad params throw a ZodError at parse time.
    const strictSchema = z.object({
      requiredField: z.string(),
      platform: z.string().optional(),
      deviceId: z.string().optional(),
      sessionUuid: z.string().optional(),
    });
    ToolRegistry.register(
      "optionalStepStrict",
      "requires a field",
      strictSchema,
      mock(async () => createStructuredToolResponse({ success: true })),
    );
    markDevice("optionalStepStrict");
  });

  afterEach(() => {
    registerObserveTools();
  });

  test("continues past a failed optional step and still succeeds", async () => {
    const plan: Plan = {
      name: "optional-fail-then-ok",
      steps: [
        { tool: "optionalStepFail", params: {}, optional: true },
        { tool: "optionalStepOk", params: {} },
      ],
    };

    const result = await planExecutor.executePlan(plan, 0, "ios", "sim-1");

    expect(result.success).toBe(true);
    expect(result.failedStep).toBeUndefined();
    // Only the mandatory step counts as executed; the optional one is skipped.
    expect(result.executedSteps).toBe(1);
    const statuses = result.debug?.steps.map((s) => s.status);
    expect(statuses).toEqual(["skipped", "completed"]);
  });

  test("skips an optional step whose handler throws and continues", async () => {
    const plan: Plan = {
      name: "optional-throw-then-ok",
      steps: [
        { tool: "optionalStepThrow", params: {}, optional: true },
        { tool: "optionalStepOk", params: {} },
      ],
    };

    const result = await planExecutor.executePlan(plan, 0, "ios", "sim-1");

    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(1);
  });

  test("skips an optional observe awaitTimeout and continues", async () => {
    const plan: Plan = {
      name: "optional-observe-timeout",
      steps: [
        { tool: "observe", params: { waitFor: { text: "x", timeout: 1 } }, optional: true },
        { tool: "optionalStepOk", params: {} },
      ],
    };

    const result = await planExecutor.executePlan(plan, 0, "ios", "sim-1");

    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(1);
  });

  test("a malformed optional step (schema validation error) stays fatal", async () => {
    const plan: Plan = {
      name: "optional-invalid-params",
      steps: [
        // Missing requiredField -> tool.schema.parse throws a ZodError before the handler runs.
        { tool: "optionalStepStrict", params: {}, optional: true },
        { tool: "optionalStepOk", params: {} },
      ],
    };

    const result = await planExecutor.executePlan(plan, 0, "ios", "sim-1");

    // Plan-authoring errors must not be silently skipped, even for optional steps.
    expect(result.success).toBe(false);
    expect(result.failedStep?.tool).toBe("optionalStepStrict");
  });

  test("still aborts the plan when a NON-optional step fails", async () => {
    const plan: Plan = {
      name: "mandatory-fail",
      steps: [
        { tool: "optionalStepFail", params: {} },
        { tool: "optionalStepOk", params: {} },
      ],
    };

    const result = await planExecutor.executePlan(plan, 0, "ios", "sim-1");

    expect(result.success).toBe(false);
    expect(result.failedStep?.tool).toBe("optionalStepFail");
  });

  test("records skipped optional steps in multi-device per-device results", async () => {
    const plan: Plan = {
      name: "parallel-optional-fail-then-ok",
      devices: ["device-a"],
      steps: [
        { tool: "optionalStepFail", params: { device: "device-a" }, optional: true },
        { tool: "optionalStepOk", params: { device: "device-a" } },
      ],
    };

    const result = await planExecutor.executePlan(plan, 0, "ios", "sim-1", "session-1");
    const deviceResult = result.perDeviceResults?.get("device-a");

    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(1);
    expect(deviceResult?.success).toBe(true);
    expect(deviceResult?.executedSteps).toBe(1);
    expect(deviceResult?.skippedSteps).toEqual([
      {
        stepIndex: 0,
        trackIndex: 0,
        tool: "optionalStepFail",
        error: "element not found",
        durationMs: expect.any(Number),
        details: {
          params: { device: "device-a" },
          error: "element not found",
          optional: true,
        },
      },
    ]);
  });

  test("records elapsed duration for skipped optional steps in multi-device results", async () => {
    const fakeTimer = new FakeTimer();
    const timedExecutor = new DefaultPlanExecutor(fakeTimer);
    ToolRegistry.register(
      "optionalStepTimedFail",
      "fails after time passes",
      z.object({
        platform: z.string().optional(),
        device: z.string().optional(),
        sessionUuid: z.string().optional(),
      }),
      mock(async () => {
        fakeTimer.advanceTime(250);
        return createStructuredToolResponse({ success: false, error: "timed out" });
      }),
    );
    (ToolRegistry.getTool("optionalStepTimedFail") as { requiresDevice: boolean }).requiresDevice =
      true;

    const plan: Plan = {
      name: "parallel-optional-timed-fail",
      devices: ["device-a"],
      steps: [{ tool: "optionalStepTimedFail", params: { device: "device-a" }, optional: true }],
    };

    const result = await timedExecutor.executePlan(plan, 0, "ios", "sim-1", "session-1");

    expect(result.success).toBe(true);
    expect(result.perDeviceResults?.get("device-a")?.skippedSteps?.[0].durationMs).toBe(250);
  });
});
