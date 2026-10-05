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
    expect(response.structuredContent).toEqual(result);
    expect(JSON.parse(response.content[0].text!)).toEqual(result);
    expect(tool.outputSchema!.parse(response.structuredContent)).toEqual(result);
  },
);
