import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  DefaultPlanExecutor,
  UNEVALUATED_EXPECTATIONS_WARNING,
} from "../../src/utils/plan/PlanExecutor";
import { YamlPlanSerializer } from "../../src/utils/plan/PlanSerializer";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { unregisterTemporaryTools } from "../helpers/withTemporaryTool";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Step-level `expectations` are accepted by the plan schema but nothing evaluates them (#9925).
 * A step carrying them must still run (they must not reach a strict tool schema as an unknown
 * key) and the plan result must say they were not checked.
 */
describe("PlanExecutor — step-level expectations", () => {
  const yaml = (extra: string) => `name: expectations-demo
steps:
  - tool: expectationsStrictTool
${extra}`;

  const registerStrictTool = (seen: Array<Record<string, unknown>>) => {
    ToolRegistry.register(
      "expectationsStrictTool",
      "strict schema tool",
      z.strictObject({
        platform: z.string().optional(),
        deviceId: z.string().optional(),
        sessionUuid: z.string().optional(),
      }),
      async (params) => {
        seen.push(params);
        return createStructuredToolResponse({ success: true });
      },
    );
  };

  afterEach(() => unregisterTemporaryTools("expectationsStrictTool"));

  test("runs the step and warns that expectations are not evaluated", async () => {
    const seen: Array<Record<string, unknown>> = [];
    registerStrictTool(seen);
    const plan = new YamlPlanSerializer().importPlanFromYaml(
      yaml(`    expectations:
      - type: elementVisible
        selector: { testTag: bug_repro_content }
`),
    );

    const result = await new DefaultPlanExecutor(new FakeTimer()).executePlan(plan, 0);

    expect(result.failedStep).toBeUndefined();
    expect(result.success).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("expectations");
    expect(result.warnings).toEqual([
      {
        stepIndex: 0,
        tool: "expectationsStrictTool",
        warnings: [UNEVALUATED_EXPECTATIONS_WARNING],
      },
    ]);
    expect(result.debug?.steps[0].details.warnings).toEqual([UNEVALUATED_EXPECTATIONS_WARNING]);
  });

  test("a step without expectations reports no warnings", async () => {
    const seen: Array<Record<string, unknown>> = [];
    registerStrictTool(seen);
    const plan = new YamlPlanSerializer().importPlanFromYaml(yaml(""));

    const result = await new DefaultPlanExecutor(new FakeTimer()).executePlan(plan, 0);

    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});
