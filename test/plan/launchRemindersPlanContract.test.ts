import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { registerAppTools } from "../../src/server/appTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { YamlPlanSerializer } from "../../src/utils/plan/PlanSerializer";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

interface CapturedCall {
  name: string;
  args: Record<string, unknown>;
}

const planToolSchema = z.object({}).passthrough();

describe("launch Reminders plan contract", () => {
  afterEach(() => {
    registerAppTools();
    registerObserveTools();
  });

  test("parses and executes the bundled launch, observe, and cleanup sequence", async () => {
    const calls: CapturedCall[] = [];
    for (const name of ["launchApp", "observe", "terminateApp"]) {
      ToolRegistry.register(name, `Contract fake for ${name}`, planToolSchema, async (args) => {
        calls.push({ name, args });
        return createStructuredToolResponse({ success: true });
      });
    }

    const content = await Bun.file(
      new URL(
        "../../ios/XCTestRunner/Sources/XCTestRunnerTests/Resources/Plans/launch-reminders-app.yaml",
        import.meta.url,
      ),
    ).text();
    const plan = new YamlPlanSerializer().importPlanFromYaml(content);

    const result = await new DefaultPlanExecutor().executePlan(
      plan,
      0,
      "ios",
      "contract-simulator",
    );

    expect(result).toMatchObject({
      success: true,
      executedSteps: 3,
      totalSteps: 3,
    });
    expect(calls.map((call) => call.name)).toEqual(["launchApp", "observe", "terminateApp"]);
    expect(calls[0].args.appId).toBe("com.apple.reminders");
    expect(calls[1].args.waitFor).toEqual({
      activeWindow: { appId: "com.apple.reminders" },
      timeout: 30000,
    });
    expect(calls[2].args.appId).toBe("com.apple.reminders");
  });
});
