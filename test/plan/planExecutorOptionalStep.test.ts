import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { unregisterTemporaryTools } from "../helpers/withTemporaryTool";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { convertDebugStepsToRecords } from "../../src/server/planExecutionOrchestrator";

/**
 * Optional (best-effort) plan steps. A step marked `optional: true` whose tool fails must NOT abort
 * the plan — the executor logs it, records it as skipped, and continues. This is the primitive that
 * lets a plan dismiss an intermittent dialog (e.g. the Reminders "Enable iCloud Syncing?" alert,
 * issue #2811) without breaking the runs where that dialog is absent.
 */
describe("PlanExecutor — optional steps", () => {
  let planExecutor: DefaultPlanExecutor;
  let originalDebugMode: boolean;

  beforeEach(() => {
    originalDebugMode = isDebugModeEnabled();
    setDebugModeEnabled(false);
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
    setDebugModeEnabled(originalDebugMode);
    unregisterTemporaryTools(
      "observe",
      "optionalStepFail",
      "optionalStepThrow",
      "optionalStepOk",
      "optionalStepStrict",
      "optionalStepTimedFail",
      "optionalStepTimed",
      "optionalEnvelopeProbe",
    );
  });

  for (const text of ["not json", '{"success":tr']) {
    for (const optional of [false, true]) {
      test(`malformed envelope ${text} is ${optional ? "skipped" : "failed"}`, async () => {
        ToolRegistry.register(
          "optionalEnvelopeProbe",
          "synthetic envelope",
          z.object({}),
          async () => ({
            content: [{ type: "text", text }],
          }),
        );
        const result = await new DefaultPlanExecutor(new FakeTimer()).executePlan(
          {
            name: "malformed envelope",
            steps: [
              { tool: "optionalEnvelopeProbe", params: {}, optional },
              { tool: "optionalStepOk", params: {} },
            ],
          },
          0,
        );
        expect(result.success).toBe(optional);
        expect(result.debug?.steps[0].status).toBe(optional ? "skipped" : "failed");
        expect(result.debug?.steps[0].details.error).toContain("optionalEnvelopeProbe");
        expect(result.debug?.steps[0].details.error).toContain("could not be interpreted");
        expect(result.debug?.steps).toHaveLength(optional ? 2 : 1);
      });
    }
  }

  for (const debugMode of [false, true]) {
    for (const outcome of ["completed", "failed", "skipped", "aborted"] as const) {
      test(`records step elapsed time for ${outcome} with debug mode ${debugMode}`, async () => {
        setDebugModeEnabled(debugMode);
        const timer = new FakeTimer();
        timer.setCurrentTime(1_790_000_000_000);
        const controller = new AbortController();
        ToolRegistry.register("optionalStepTimed", "timed step", z.object({}), async () => {
          timer.advanceTime(250);
          if (outcome === "aborted") {
            controller.abort();
          }
          return createStructuredToolResponse({
            success: outcome === "completed" || outcome === "aborted",
            error: outcome === "completed" ? undefined : "timed failure",
          });
        });
        const result = await new DefaultPlanExecutor(timer).executePlan(
          {
            name: "step-duration",
            steps: [{ tool: "optionalStepTimed", params: {}, optional: outcome === "skipped" }],
          },
          0,
          undefined,
          undefined,
          undefined,
          controller.signal,
        );

        expect(result.success).toBe(outcome === "completed" || outcome === "skipped");
        expect(result.debug?.executionTimeMs).toBe(250);
        expect(result.debug?.steps?.[0]?.status).toBe(outcome === "aborted" ? "failed" : outcome);
        expect(result.debug?.steps?.[0]?.durationMs).toBe(250);
        expect(convertDebugStepsToRecords(result.debug?.steps)[0]?.durationMs).toBe(250);
      });
    }
  }

  test("parallel tracks record their own skipped-step elapsed times", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_790_000_000_000);
    timer.enableAutoAdvance();
    ToolRegistry.register(
      "optionalStepTimed",
      "timed parallel failure",
      z.object({ device: z.string(), elapsed: z.number() }),
      async ({ elapsed }) => {
        await timer.sleep(elapsed);
        return createStructuredToolResponse({ success: false, error: "timed failure" });
      },
    );
    const result = await new DefaultPlanExecutor(timer).executePlan({
      name: "parallel-step-durations",
      devices: ["device-a", "device-b"],
      steps: [
        { tool: "optionalStepTimed", params: { device: "device-a", elapsed: 250 }, optional: true },
        { tool: "optionalStepTimed", params: { device: "device-b", elapsed: 400 }, optional: true },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.perDeviceResults?.get("device-a")?.skippedSteps?.[0]?.durationMs).toBe(250);
    expect(result.perDeviceResults?.get("device-b")?.skippedSteps?.[0]?.durationMs).toBe(400);
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
