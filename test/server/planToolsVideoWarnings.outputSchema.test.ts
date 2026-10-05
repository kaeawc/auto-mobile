import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { toJSONSchema } from "zod/v4";
import type { ExecutePlanResult } from "../../src/models";
import { registerPlanTools } from "../../src/server/planTools";
import { PlanExecutionOrchestrator } from "../../src/server/planExecutionOrchestrator";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();
beforeAll(() => registerPlanTools());
let execute:
  | ReturnType<typeof spyOn<typeof PlanExecutionOrchestrator.prototype, "execute">>
  | undefined;
afterEach(() => execute?.mockRestore());
const base: ExecutePlanResult = { success: true, executedSteps: 1, totalSteps: 1 };

test("executePlan advertises optional typed video fields", () => {
  const schema = ToolRegistry.getTool("executePlan")!.outputSchema!;
  const json = toJSONSchema(schema);
  for (const key of ["videoFilePaths", "videoRecordingIds", "videoWarnings"]) {
    expect(json.properties?.[key]).toMatchObject({ type: "array", items: { type: "string" } });
    expect(json.required ?? []).not.toContain(key);
    expect(schema.safeParse({ ...base, [key]: [123] }).success).toBe(false);
  }
  expect(schema.parse(base)).toEqual(base);
});

test.each([false, true])(
  "executePlan structured content preserves videoWarnings with paths=%s",
  async (hasPaths) => {
    const result: ExecutePlanResult = {
      ...base,
      videoWarnings: ["Video gap: 25600ms without capture"],
      ...(hasPaths ? { videoFilePaths: ["/fake/video.mp4"], videoRecordingIds: ["rec-1"] } : {}),
    };
    execute = spyOn(PlanExecutionOrchestrator.prototype, "execute").mockResolvedValue(result);
    const tool = ToolRegistry.getTool("executePlan")!;
    const response = await tool.deviceAwareHandler!(
      { platform: "ios", deviceId: "fake-device", name: "Fake" },
      { platform: "ios", planContent: "", startStep: 0, deviceAllocationTimeoutMs: 5000 },
    );
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual(result);
    expect(JSON.parse(response.content[0].text!)).toEqual(result);
    expect(tool.outputSchema!.parse(response.structuredContent)).toEqual(result);
  },
);

test("executePlan advertises optional typed skippedSteps", () => {
  const schema = ToolRegistry.getTool("executePlan")!.outputSchema!;
  const json = toJSONSchema(schema);
  expect(json.properties?.skippedSteps).toMatchObject({
    type: "array",
    items: {
      type: "object",
      required: ["stepIndex", "tool", "error"],
      properties: {
        stepIndex: { type: "integer" },
        tool: { type: "string" },
        error: { type: "string" },
        device: { type: "string" },
      },
    },
  });
  expect(json.required ?? []).not.toContain("skippedSteps");
  for (const entry of [
    { stepIndex: 0, tool: "tapOn" },
    { stepIndex: 0.5, tool: "tapOn", error: "missing" },
    { stepIndex: 0, tool: "tapOn", error: 123 },
    { stepIndex: 0, tool: "tapOn", error: "missing", device: 123 },
  ]) {
    expect(schema.safeParse({ ...base, skippedSteps: [entry] }).success).toBe(false);
  }
});

test("executePlan structured content preserves skippedSteps", async () => {
  const result: ExecutePlanResult = {
    ...base,
    executedSteps: 0,
    skippedSteps: [{ stepIndex: 0, tool: "tapOn", error: "missing", device: "A" }],
  };
  execute = spyOn(PlanExecutionOrchestrator.prototype, "execute").mockResolvedValue(result);
  const tool = ToolRegistry.getTool("executePlan")!;
  const response = await tool.deviceAwareHandler!(
    { platform: "ios", deviceId: "fake-device", name: "Fake" },
    { platform: "ios", planContent: "", startStep: 0, deviceAllocationTimeoutMs: 5000 },
  );
  expect(response.isError).toBeUndefined();
  expect(response.structuredContent).toEqual(result);
  expect(JSON.parse(response.content[0].text!)).toEqual(result);
  expect(tool.outputSchema!.parse(response.structuredContent)).toEqual(result);
});

// Results from the orchestrator, rather than hand-written YAML/parser fixtures.
test.each([
  {
    success: false,
    executedSteps: 0,
    totalSteps: 2,
    failedStep: { stepIndex: 0, tool: "tapOn", error: "missing" },
  },
  { success: false, executedSteps: 0, totalSteps: 0, error: "Plan YAML validation failed" },
  { success: false, executedSteps: 0, totalSteps: 0, error: "Caught orchestrator failure" },
  {
    success: false,
    executedSteps: 1,
    totalSteps: 2,
    deviceMapping: { A: "fake-A", B: "fake-B" },
    failedStep: { stepIndex: 1, tool: "tapOn", error: "B failed" },
  },
])("executePlan failure keeps its structured and text payload: %j", async (result) => {
  execute = spyOn(PlanExecutionOrchestrator.prototype, "execute").mockResolvedValue(result);
  const tool = ToolRegistry.getTool("executePlan")!;
  const response = await tool.deviceAwareHandler!(
    { platform: "ios", deviceId: "fake-device", name: "Fake" },
    { platform: "ios", planContent: "", startStep: 0, deviceAllocationTimeoutMs: 5000 },
  );
  expect(response.isError).toBe(true);
  expect(response.structuredContent).toEqual(result);
  expect(JSON.parse(response.content[0].text!)).toEqual(result);
  expect(tool.outputSchema!.parse(response.structuredContent)).toEqual(result);
});

test("executePlan with nothing to execute remains successful", async () => {
  const result: ExecutePlanResult = { success: true, executedSteps: 0, totalSteps: 0 };
  execute = spyOn(PlanExecutionOrchestrator.prototype, "execute").mockResolvedValue(result);
  const response = await ToolRegistry.getTool("executePlan")!.deviceAwareHandler!(
    { platform: "ios", deviceId: "fake-device", name: "Fake" },
    { platform: "ios", planContent: "", startStep: 0, deviceAllocationTimeoutMs: 5000 },
  );
  expect(response.isError).toBeUndefined();
  expect(response.structuredContent).toEqual(result);
  expect(JSON.parse(response.content[0].text!)).toEqual(result);
});
