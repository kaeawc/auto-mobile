import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

describe("PlanExecutor — observe waitFor timeout", () => {
  let planExecutor: DefaultPlanExecutor;
  const nextStep = mock(async () => createStructuredToolResponse({ success: true }));

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor(new FakeTimer());
    nextStep.mockClear();
    const observeSchema = z.object({
      platform: z.string().optional(),
      deviceId: z.string().optional(),
      sessionUuid: z.string().optional(),
      waitFor: z.any().optional(),
    });
    const observeHandler = mock(async () =>
      createStructuredToolResponse({
        updatedAt: 0,
        screenSize: { width: 100, height: 100 },
        systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
        awaitTimeout: true,
        awaitDuration: 5000,
      }),
    );
    ToolRegistry.register("observe", "Mock observe timeout", observeSchema, observeHandler);
    (ToolRegistry.getTool("observe") as { requiresDevice: boolean }).requiresDevice = true;

    const noopSchema = z.object({ platform: z.string().optional() });
    ToolRegistry.register(
      "observeAwaitTimeoutChainNoop",
      "noop after observe",
      noopSchema,
      nextStep,
    );
  });

  afterEach(() => {
    ToolRegistry.unregister("observe");
    ToolRegistry.unregister("openLink");
    ToolRegistry.unregister("observeAwaitTimeoutChainNoop");
  });

  test("fails the plan when observe returns awaitTimeout true (does not advance to next step)", async () => {
    const plan: Plan = {
      name: "timeout-chain",
      steps: [
        { tool: "observe", params: { waitFor: { elementId: "x", timeout: 1 } } },
        { tool: "observeAwaitTimeoutChainNoop", params: {} },
      ],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(false);
    expect(result.executedSteps).toBe(0);
    expect(result.failedStep?.tool).toBe("observe");
    expect(result.failedStep?.error).toBe("observe waitFor timed out after 5000ms");
    expect(nextStep).not.toHaveBeenCalled();
  });

  test("fails openLink at its waitFor timeout and stops before the following step", async () => {
    ToolRegistry.register("openLink", "Mock openLink", z.object({}).passthrough(), async () =>
      createStructuredToolResponse({
        success: true,
        awaitTimeout: true,
        timedOut: true,
        matched: false,
        awaitDuration: 5000,
      }),
    );
    const result = await planExecutor.executePlan(
      {
        name: "openLink timeout",
        steps: [
          { tool: "openLink", params: { url: "myapp://checkout", waitFor: { text: "Pay" } } },
          { tool: "observeAwaitTimeoutChainNoop", params: {} },
        ],
      },
      0,
    );
    expect(result.success).toBe(false);
    expect(result.executedSteps).toBe(0);
    expect(result.failedStep).toEqual({
      stepIndex: 0,
      tool: "openLink",
      error: "openLink waitFor timed out after 5000ms",
    });
    expect(result.debug?.steps[0].status).toBe("failed");
    expect(nextStep).not.toHaveBeenCalled();
  });

  test.each(["observe", "openLink"])("skips an optional %s timeout and continues", async (tool) => {
    ToolRegistry.register(tool, "Mock wait timeout", z.object({}).passthrough(), async () =>
      createStructuredToolResponse({
        success: true,
        awaitTimeout: true,
        timedOut: true,
        matched: false,
        awaitDuration: 5000,
      }),
    );
    const result = await planExecutor.executePlan(
      {
        name: "optional timeout",
        steps: [
          { tool, params: { waitFor: { text: "Pay" } }, optional: true },
          { tool: "observeAwaitTimeoutChainNoop", params: {} },
        ],
      },
      0,
    );
    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(1);
    expect(result.failedStep).toBeUndefined();
    expect(result.debug?.steps[0]).toMatchObject({
      status: "skipped",
      details: { error: `${tool} waitFor timed out after 5000ms`, optional: true },
    });
    expect(nextStep).toHaveBeenCalledTimes(1);
  });

  describe("failed-step record (#10024)", () => {
    function registerRecordingObserve(): { calls: number } {
      const recorded = { calls: 0 };
      ToolRegistry.unregister("observe");
      ToolRegistry.register(
        "observe",
        "Recording observe",
        z.object({}).passthrough(),
        async () => {
          recorded.calls++;
          return createStructuredToolResponse({
            activeWindow: { appId: "com.example.dialog" },
            elements: { clickable: [{ text: "Error dialog OK" }] },
          });
        },
      );
      (ToolRegistry.getTool("observe") as { requiresDevice: boolean }).requiresDevice = true;
      return recorded;
    }

    test("an observe timeout summarizes its own response and keeps warnings and diagnostics", async () => {
      ToolRegistry.unregister("observe");
      ToolRegistry.register("observe", "Timeout observe", z.object({}).passthrough(), async () =>
        createStructuredToolResponse({
          awaitTimeout: true,
          awaitDuration: 5000,
          timedOut: true,
          matched: false,
          polls: 4,
          activeWindow: { appId: "com.example.error" },
          elements: { text: [{ text: "Something went wrong" }] },
          candidates: [
            { text: "Welcom", "resource-id": "welcome", bounds: { left: 0 }, node: [{}] },
          ],
          warnings: ["w"],
        }),
      );
      const result = await planExecutor.executePlan(
        {
          name: "observe timeout observation",
          steps: [{ tool: "observe", params: { waitFor: { text: "Welcome", timeout: 5000 } } }],
        },
        0,
        "android",
        "emulator-5554",
      );

      expect(result.success).toBe(false);
      expect(result.failedStep?.failureObservation).toMatchObject({
        awaitTimeout: true,
        activeWindow: { appId: "com.example.error" },
        visibleTextsSample: ["Something went wrong"],
      });
      expect(result.warnings).toEqual([{ stepIndex: 0, tool: "observe", warnings: ["w"] }]);
      expect(result.debug?.steps[0].details).toMatchObject({
        params: { waitFor: { text: "Welcome", timeout: 5000 } },
        warnings: ["w"],
        waitForTimeout: {
          awaitDuration: 5000,
          timedOut: true,
          matched: false,
          polls: 4,
          candidates: [{ text: "Welcom", "resource-id": "welcome", bounds: { left: 0 } }],
          candidateCount: 1,
        },
      });
    });

    test("an openLink timeout captures its failure observation through observe", async () => {
      const observe = registerRecordingObserve();
      ToolRegistry.register("openLink", "Mock openLink", z.object({}).passthrough(), async () =>
        createStructuredToolResponse({ success: true, awaitTimeout: true, awaitDuration: 5000 }),
      );
      const result = await planExecutor.executePlan(
        {
          name: "openLink timeout observation",
          steps: [{ tool: "openLink", params: { url: "myapp://x", waitFor: { text: "Pay" } } }],
        },
        0,
        "android",
        "emulator-5554",
      );

      expect(observe.calls).toBe(1);
      expect(result.failedStep).toMatchObject({
        stepIndex: 0,
        tool: "openLink",
        error: "openLink waitFor timed out after 5000ms",
        failureObservation: { activeWindow: { appId: "com.example.dialog" } },
      });
      expect(result.debug?.steps[0].details).toMatchObject({
        waitForTimeout: { awaitDuration: 5000 },
      });
    });

    test("a skipped optional timeout captures no observation", async () => {
      const observe = registerRecordingObserve();
      ToolRegistry.register("openLink", "Mock openLink", z.object({}).passthrough(), async () =>
        createStructuredToolResponse({ success: true, awaitTimeout: true, awaitDuration: 5000 }),
      );
      const result = await planExecutor.executePlan(
        {
          name: "optional openLink timeout",
          steps: [{ tool: "openLink", params: { url: "myapp://x" }, optional: true }],
        },
        0,
        "android",
        "emulator-5554",
      );

      expect(result.success).toBe(true);
      expect(observe.calls).toBe(0);
    });

    test("warnings on a success:false tool result reach the plan result", async () => {
      registerRecordingObserve();
      ToolRegistry.register("openLink", "Failing openLink", z.object({}).passthrough(), async () =>
        createStructuredToolResponse({ success: false, error: "no handler", warnings: ["w"] }),
      );
      const result = await planExecutor.executePlan(
        {
          name: "failing tool warnings",
          steps: [{ tool: "openLink", params: { url: "myapp://x" } }],
        },
        0,
        "android",
        "emulator-5554",
      );

      expect(result.success).toBe(false);
      expect(result.failedStep?.error).toBe("no handler");
      expect(result.warnings).toEqual([{ stepIndex: 0, tool: "openLink", warnings: ["w"] }]);
    });
  });

  for (const tool of ["observe", "openLink"]) {
    test.each([false, undefined])(
      "passes satisfied " + tool + " waitFor with awaitTimeout=%s",
      async (awaitTimeout) => {
        ToolRegistry.register(tool, "Mock satisfied wait", z.object({}).passthrough(), async () =>
          createStructuredToolResponse({
            success: true,
            awaitTimeout,
            matched: true,
            timedOut: false,
          }),
        );
        const result = await planExecutor.executePlan(
          { name: "satisfied wait", steps: [{ tool, params: { waitFor: { text: "Pay" } } }] },
          0,
        );
        expect(result.success).toBe(true);
        expect(result.executedSteps).toBe(1);
        expect(result.debug?.steps[0].status).toBe("completed");
      },
    );
  }
});
