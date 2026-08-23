import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerObserveTools } from "../../src/server/observeTools";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

describe("PlanExecutor — captureObserveSteps", () => {
  let planExecutor: DefaultPlanExecutor;

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
    const observeSchema = z.object({
      platform: z.string().optional(),
      deviceId: z.string().optional(),
      sessionUuid: z.string().optional(),
    });
    const observeHandler = mock(async () =>
      createStructuredToolResponse({
        updatedAt: Date.now(),
        screenSize: { width: 1080, height: 2400 },
        systemInsets: { left: 0, top: 100, right: 0, bottom: 80 },
        activeWindow: { appId: "com.example.app" },
        viewHierarchy: { hierarchy: { node: { "resource-id": "com.example:id/search" } } },
        elements: {
          clickable: [],
          scrollable: [],
          text: [
            {
              text: "Dan Corkill",
              resourceId: "com.example:id/name",
              bounds: { left: 0, top: 0, right: 1, bottom: 1 },
            },
          ],
        },
      }),
    );
    ToolRegistry.register("observe", "Mock observe", observeSchema, observeHandler);
    (ToolRegistry.getTool("observe") as { requiresDevice: boolean }).requiresDevice = true;

    const noopSchema = z.object({
      platform: z.string().optional(),
      deviceId: z.string().optional(),
      sessionUuid: z.string().optional(),
    });
    ToolRegistry.register(
      "captureTestNoop",
      "Mock noop",
      noopSchema,
      mock(async () => createStructuredToolResponse({ ok: true })),
    );
    (ToolRegistry.getTool("captureTestNoop") as { requiresDevice: boolean }).requiresDevice = true;
  });

  afterEach(() => {
    registerObserveTools();
  });

  test("summary mode stores stepObservation without viewHierarchy on successful observe steps", async () => {
    const plan: Plan = {
      name: "capture-test",
      steps: [
        { tool: "observe", params: {}, label: "First" },
        { tool: "captureTestNoop", params: {}, label: "Second" },
      ],
    };

    const result = await planExecutor.executePlan(
      plan,
      0,
      "android",
      "emulator-5554",
      undefined,
      undefined,
      undefined,
      { captureObserveSteps: "summary" },
    );

    expect(result.success).toBe(true);
    expect(result.debug?.steps).toBeDefined();
    const observeStep = result.debug!.steps.find((s) => s.step.includes(": observe"));
    expect(observeStep?.details?.stepObservation).toBeDefined();
    const snap = observeStep!.details.stepObservation as Record<string, unknown>;
    expect(snap.visibleTextsSample).toEqual(expect.arrayContaining(["Dan Corkill"]));
    expect(snap.resourceIdsSample).toEqual(expect.arrayContaining(["com.example:id/name"]));
    expect(snap.viewHierarchy).toBeUndefined();
    expect(snap.rawViewHierarchy).toBeUndefined();

    const noopStep = result.debug!.steps.find((s) => s.step.includes(": captureTestNoop"));
    expect(noopStep?.details?.stepObservation).toBeUndefined();
  });

  test("full mode keeps viewHierarchy on stepObservation", async () => {
    const plan: Plan = {
      name: "capture-full",
      steps: [{ tool: "observe", params: {} }],
    };

    const result = await planExecutor.executePlan(
      plan,
      0,
      "android",
      "emulator-5554",
      undefined,
      undefined,
      undefined,
      {
        captureObserveSteps: "full",
      },
    );

    expect(result.success).toBe(true);
    const snap = result.debug!.steps[0].details.stepObservation as Record<string, unknown>;
    expect(snap.viewHierarchy).toBeDefined();
  });
});
