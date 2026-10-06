import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import type { Plan } from "../../src/models/Plan";
import { registerCriticalSectionTools } from "../../src/server/criticalSectionTools";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

/**
 * Integration of #9961 (criticalSection sub-steps get the top-level migration + schema parse),
 * #10023 (each label's own platform) and #10024 (answered-failure diagnostics) through the real
 * plan executor and the real criticalSection tool. The only fakes are the device handed to the
 * section handler (chosen by the section's own label) and the probe tools it runs.
 */
const devicesByLabel: Record<string, BootedDevice> = {
  A: { platform: "android", deviceId: "device-a", name: "Device A" },
  B: { platform: "ios", deviceId: "device-b", name: "Device B" },
};

describe("criticalSection sub-steps in a mixed-platform plan", () => {
  let restoreTools: () => void;
  let restoreCoordinator: () => void;
  let coordinator: CriticalSectionCoordinator;
  let sectionPlatforms: Record<string, unknown>;
  let sendKeysCommands: Record<string, unknown>;
  let restoreHandler: () => void;

  beforeAll(() => {
    if (!ToolRegistry.getToolForPlan("criticalSection")) {
      registerCriticalSectionTools();
    }
  });

  beforeEach(() => {
    restoreTools = preserveToolRegistry();
    coordinator = CriticalSectionCoordinator.createForTesting(new FakeTimer());
    restoreCoordinator = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    sectionPlatforms = {};
    sendKeysCommands = {};
    ToolRegistry.register(
      "sendKeys",
      "records the migrated sendKeys commands",
      z.object({ device: z.string().optional(), commands: z.array(z.record(z.string(), z.any())) }),
      async (params) => {
        sendKeysCommands[`${params.device}`] = params.commands;
        return createStructuredToolResponse({ success: true });
      },
    );
    const section = ToolRegistry.getToolForPlan("criticalSection")!;
    const handler = spyOn(section, "handler").mockImplementation(
      async (params, progress, signal) => {
        const label = String(params.device);
        sectionPlatforms[label] = params.platform;
        return finalizeToolResponse(
          await section.deviceAwareHandler!(devicesByLabel[label], params, progress, signal),
          { name: section.name, internal: true },
        );
      },
    );
    restoreHandler = () => handler.mockRestore();
  });

  afterEach(() => {
    restoreHandler();
    coordinator.reset();
    restoreCoordinator();
    restoreTools();
  });

  const mixedPlan = (steps: Plan["steps"]): Plan => ({
    name: "mixed critical section",
    devices: [
      { label: "A", platform: "android" },
      { label: "B", platform: "ios" },
    ],
    steps,
  });

  const sectionStep = (device: string, subStep: Record<string, unknown>) => ({
    tool: "criticalSection",
    params: {
      device,
      lock: "mixed",
      deviceCount: 2,
      steps: [{ ...subStep, params: { device, ...(subStep.params as object) } }],
    },
  });

  test("an inputText sub-step on each label migrates with that label's platform, not the request's", async () => {
    const result = await new DefaultPlanExecutor(new FakeTimer()).executePlan(
      mixedPlan([
        sectionStep("A", { tool: "inputText", params: { text: "hello" } }),
        sectionStep("B", { tool: "inputText", params: { text: "hello" } }),
      ]),
      0,
      "android",
    );

    expect(result.failedStep).toBeUndefined();
    expect(result.success).toBe(true);
    // #10023: the section step itself runs with the label's platform ...
    expect(sectionPlatforms).toEqual({ A: "android", B: "ios" });
    // ... and #9961: the sub-step's migration, which keys off the section's device, agrees.
    expect(sendKeysCommands).toEqual({
      A: [{ action: "type", text: "hello", operation: "replace" }],
      B: [{ action: "type", text: "hello", operation: "insert" }],
    });
  });

  test("an android-label plan run under an ios request still migrates the android label as android", async () => {
    const result = await new DefaultPlanExecutor(new FakeTimer()).executePlan(
      mixedPlan([
        sectionStep("A", { tool: "inputText", params: { text: "x" } }),
        sectionStep("B", { tool: "inputText", params: { text: "x" } }),
      ]),
      0,
      "ios",
    );

    expect(result.success).toBe(true);
    expect(sectionPlatforms).toEqual({ A: "android", B: "ios" });
    expect(sendKeysCommands).toMatchObject({
      A: [{ operation: "replace" }],
      B: [{ operation: "insert" }],
    });
  });

  describe("sub-step failures get top-level-step diagnostics (#10024 parity)", () => {
    const singlePlan = (subStep: Record<string, unknown>): Plan => ({
      name: "single section",
      steps: [
        {
          tool: "criticalSection",
          params: {
            device: "A",
            lock: "diag",
            deviceCount: 1,
            steps: [{ ...subStep, params: { device: "A" } }],
          },
        },
      ],
    });

    test("a sub-step returning success:false with warnings promotes them to the plan warnings", async () => {
      ToolRegistry.register("answeredFailure", "answers", z.object({}), async () => ({
        success: false,
        error: "tap failed",
        warnings: ["keyboard dismissal failed"],
      }));

      const result = await new DefaultPlanExecutor(new FakeTimer()).executePlan(
        singlePlan({ tool: "answeredFailure" }),
        0,
        "android",
      );

      expect(result.success).toBe(false);
      expect(result.failedStep?.error).toContain(
        "Failed at step 1/1 (answeredFailure): tap failed",
      );
      expect(result.warnings).toEqual([
        {
          stepIndex: 0,
          tool: "criticalSection",
          warnings: ["step 1 (answeredFailure): keyboard dismissal failed"],
        },
      ]);
    });

    test("a sub-step failed by a waitFor timeout keeps the timeout's diagnostics as plan warnings", async () => {
      ToolRegistry.register("timesOut", "times out", z.object({}), async () =>
        createStructuredToolResponse({
          success: true,
          awaitTimeout: true,
          awaitDuration: 5000,
          candidates: [{ text: "Almost" }],
        }),
      );

      const result = await new DefaultPlanExecutor(new FakeTimer()).executePlan(
        singlePlan({ tool: "timesOut" }),
        0,
        "android",
      );

      expect(result.success).toBe(false);
      expect(result.failedStep?.error).toContain("timesOut waitFor timed out after 5000ms");
      expect(result.warnings).toEqual([
        {
          stepIndex: 0,
          tool: "criticalSection",
          warnings: [
            `step 1 (timesOut): waitFor timeout: ${JSON.stringify({
              awaitDuration: 5000,
              candidates: [{ text: "Almost" }],
              candidateCount: 1,
            })}`,
          ],
        },
      ]);
    });
  });
});
