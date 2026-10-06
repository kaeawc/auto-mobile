import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import {
  MAX_PLAN_TOOL_RESULTS_CHARS,
  MAX_STEP_TOOL_RESULT_CHARS,
  StepToolResultCollector,
  boundStepToolResult,
} from "../../src/utils/plan/stepToolResults";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { unregisterTemporaryTools } from "../helpers/withTemporaryTool";

// #10090: executePlan used to unwrap each step's tool response only for the pass/fail verdict and
// drop it, so the JUnit runner's getSelection/getToolResult/getTypedResponse always saw nothing.

const pickTool = "toolResultsPick";
const failTool = "toolResultsFail";
const imageTool = "toolResultsImageOnly";
const stepSchema = z.object({
  label: z.string().optional(),
  platform: z.string().optional(),
  deviceId: z.string().optional(),
  sessionUuid: z.string().optional(),
});

const markDevice = (name: string) => {
  (ToolRegistry.getTool(name) as { requiresDevice: boolean }).requiresDevice = true;
};

describe("PlanExecutor toolResults (#10090)", () => {
  let executor: DefaultPlanExecutor;

  beforeEach(() => {
    executor = new DefaultPlanExecutor(new FakeTimer());
    ToolRegistry.register(pickTool, "Pick a random row", stepSchema, async (params) =>
      createStructuredToolResponse({
        success: true,
        action: "tap",
        selectedElement: { text: `Row ${params.label}`, selectionStrategy: "random" },
        observation: { viewHierarchy: { huge: "x".repeat(50_000) } },
        tapDebug: { attempts: 1 },
      }),
    );
    markDevice(pickTool);
    ToolRegistry.register(failTool, "Always fails", stepSchema, async () =>
      createStructuredToolResponse({ success: false, error: "element not found" }),
    );
    markDevice(failTool);
    ToolRegistry.register(imageTool, "Image-only success", stepSchema, async () => ({
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    }));
    markDevice(imageTool);
  });

  afterEach(() => unregisterTemporaryTools(pickTool, failTool, imageTool));

  test("a completed step's payload is returned with its plan step index and tool", async () => {
    const plan: Plan = {
      name: "pick",
      steps: [
        { tool: pickTool, params: { label: "7" } },
        { tool: pickTool, params: { label: "8" } },
      ],
    };

    const result = await executor.executePlan(plan, 0, "android");

    expect(result.success).toBe(true);
    expect(result.toolResults?.map((entry) => [entry.stepIndex, entry.tool])).toEqual([
      [0, pickTool],
      [1, pickTool],
    ]);
    expect(result.toolResults?.[0]?.result).toEqual({
      success: true,
      action: "tap",
      selectedElement: { text: "Row 7", selectionStrategy: "random" },
    });
  });

  test("bulky observation and tap diagnostics are not carried", async () => {
    const result = await executor.executePlan(
      { name: "bulk", steps: [{ tool: pickTool, params: { label: "1" } }] },
      0,
      "android",
    );

    const carried = result.toolResults?.[0]?.result ?? {};
    expect(carried).not.toHaveProperty("observation");
    expect(carried).not.toHaveProperty("tapDebug");
    expect(JSON.stringify(result.toolResults).length).toBeLessThan(500);
  });

  test("a resumed plan keeps plan step indexes, and a skipped optional step leaves a gap", async () => {
    const plan: Plan = {
      name: "resume",
      steps: [
        { tool: pickTool, params: { label: "0" } },
        { tool: failTool, optional: true, params: {} },
        { tool: pickTool, params: { label: "2" } },
        { tool: failTool, optional: true, params: {} },
        { tool: pickTool, params: { label: "4" } },
      ],
    };

    const result = await executor.executePlan(plan, 1, "android");

    expect(result.success).toBe(true);
    expect(result.toolResults?.map((entry) => entry.stepIndex)).toEqual([2, 4]);
    expect(result.skippedSteps?.map((step) => step.stepIndex)).toEqual([1, 3]);
  });

  test("a failed plan still returns the results of the steps that completed before the failure", async () => {
    const plan: Plan = {
      name: "fail-late",
      steps: [
        { tool: pickTool, params: { label: "0" } },
        { tool: pickTool, params: { label: "1" } },
        { tool: failTool, params: {} },
        { tool: pickTool, params: { label: "3" } },
      ],
    };

    const result = await executor.executePlan(plan, 0, "android");

    expect(result.success).toBe(false);
    expect(result.failedStep?.stepIndex).toBe(2);
    expect(result.toolResults?.map((entry) => entry.stepIndex)).toEqual([0, 1]);
  });

  test("a step with no object payload contributes no entry and a plan with none omits the field", async () => {
    const result = await executor.executePlan(
      { name: "image", steps: [{ tool: imageTool, params: {} }] },
      0,
      "android",
    );

    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty("toolResults");
  });
});

describe("boundStepToolResult / StepToolResultCollector", () => {
  test("drops bulky fields and screenshot fields but keeps small ones", () => {
    const { result, truncated } = boundStepToolResult({
      success: true,
      selectedElement: { text: "a" },
      elements: { clickable: [1, 2, 3] },
      viewHierarchy: { node: [] },
      screenshotUri: "automobile:screenshot/1",
      warnings: ["w"],
    });
    expect(result).toEqual({ success: true, selectedElement: { text: "a" } });
    expect(truncated).toBe(false);
  });

  test("an oversized payload narrows to its core fields and is flagged", () => {
    const { result, truncated } = boundStepToolResult({
      success: true,
      selectedElement: { text: "a" },
      extra: "x".repeat(MAX_STEP_TOOL_RESULT_CHARS),
    });
    expect(result).toEqual({ success: true, selectedElement: { text: "a" } });
    expect(truncated).toBe(true);
  });

  test("when even the core fields are oversized only success survives", () => {
    const { result, truncated } = boundStepToolResult({
      success: true,
      message: "m".repeat(MAX_STEP_TOOL_RESULT_CHARS),
    });
    expect(result).toEqual({ success: true });
    expect(truncated).toBe(true);
  });

  test("once the plan budget is spent later steps carry only success", () => {
    const collector = new StepToolResultCollector();
    const perStep = Math.floor(MAX_STEP_TOOL_RESULT_CHARS * 0.9);
    const steps = Math.ceil(MAX_PLAN_TOOL_RESULTS_CHARS / perStep) + 2;
    for (let i = 0; i < steps; i++) {
      collector.add(i, "tapOn", { success: true, message: "m".repeat(perStep - 40) });
    }
    const entries = collector.toArray() ?? [];
    expect(entries).toHaveLength(steps);
    expect(entries[0]?.truncated).toBeUndefined();
    expect(entries[steps - 1]).toEqual({
      stepIndex: steps - 1,
      tool: "tapOn",
      result: { success: true },
      truncated: true,
    });
    expect(JSON.stringify(entries).length).toBeLessThan(MAX_PLAN_TOOL_RESULTS_CHARS + 1024);
  });

  test("a device label is carried and entries are ordered by plan step index", () => {
    const collector = new StepToolResultCollector();
    collector.add(3, "tapOn", { success: true }, "B");
    collector.add(1, "tapOn", { success: true }, "A");
    expect(collector.toArray()?.map((entry) => [entry.stepIndex, entry.device])).toEqual([
      [1, "A"],
      [3, "B"],
    ]);
  });
});

describe("PlanExecutor toolResults edge shapes (#10090)", () => {
  const bareTool = "toolResultsBare";
  const trackTool = "toolResultsTrack";
  let executor: DefaultPlanExecutor;

  beforeEach(() => {
    executor = new DefaultPlanExecutor(new FakeTimer());
    ToolRegistry.register(bareTool, "Unwrapped payload", stepSchema, async () => ({
      success: true,
      selectedElement: { text: "bare" },
    }));
    markDevice(bareTool);
    ToolRegistry.register(
      trackTool,
      "Per-device payload",
      z.object({ device: z.string(), index: z.number() }),
      async (params) =>
        createStructuredToolResponse({
          success: true,
          selectedElement: { text: `r${params.index}` },
        }),
    );
  });

  afterEach(() => unregisterTemporaryTools(bareTool, trackTool));

  test("a bare unwrapped success payload is carried as-is", async () => {
    const result = await executor.executePlan(
      { name: "bare", steps: [{ tool: bareTool, params: {} }] },
      0,
      "android",
    );
    expect(result.toolResults?.[0]?.result).toEqual({
      success: true,
      selectedElement: { text: "bare" },
    });
  });

  test("multi-device tracks report plan step indexes with their device label", async () => {
    const result = await executor.executePlan(
      {
        name: "parallel",
        devices: ["A", "B"],
        steps: [
          { tool: trackTool, params: { device: "A", index: 0 } },
          { tool: trackTool, params: { device: "B", index: 1 } },
          { tool: trackTool, params: { device: "A", index: 2 } },
        ],
      },
      0,
    );
    expect(result.success).toBe(true);
    expect(
      result.toolResults?.map((entry) => [entry.stepIndex, entry.device, entry.result]),
    ).toEqual([
      [0, "A", { success: true, selectedElement: { text: "r0" } }],
      [1, "B", { success: true, selectedElement: { text: "r1" } }],
      [2, "A", { success: true, selectedElement: { text: "r2" } }],
    ]);
  });
});
