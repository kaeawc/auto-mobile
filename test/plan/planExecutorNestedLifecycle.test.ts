import { describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../src/models";
import type { Plan } from "../../src/models/Plan";
import {
  ToolRegistry,
  ToolRegistryClass,
  type PlanLifecycleInput,
} from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { createStructuredToolResponse, getStructuredField } from "../../src/utils/toolUtils";
import { FakeLogger } from "../fakes/FakeLogger";
import { FakeTimer } from "../fakes/FakeTimer";

describe("PlanExecutor nested lifecycle", () => {
  test("nested wrapper defers release until the outer plan completes step three", async () => {
    const timer = new FakeTimer();
    const registry = new ToolRegistryClass(timer, new FakeLogger());
    registry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
    const device: BootedDevice = { deviceId: "device-A", name: "Pixel", platform: "android" };
    const lifecycleInputs: PlanLifecycleInput[] = [];
    const events: string[] = [];
    let released = false;
    const restore = registry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async (input) => ({
          args: input.args,
          baseSessionUuid: "outer-session",
          device,
          internalCall: false,
          sessionUuid: "outer-session",
          shouldResolveDevice: true,
        }),
      },
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        handle: async (input) => ({ durationMs: 0, finalizedResponse: input.response }),
      },
      planLifecycleManager: {
        afterExecution: async (input) => {
          lifecycleInputs.push(input);
          if (input.name === "executePlan" && !input.nestedInPlan) {
            released = true;
            events.push("release");
          }
        },
      },
    });
    const toolLookup = spyOn(ToolRegistry, "getToolForPlan").mockImplementation((name) =>
      registry.getToolForPlan(name),
    );
    const schema = z.object({
      sessionUuid: z.string(),
      platform: z.string().optional(),
      deviceId: z.string().optional(),
      nested: z.boolean().optional(),
    });
    const plan: Plan = {
      name: "outer",
      steps: [
        { tool: "firstStep", params: {} },
        { tool: "executePlan", params: { nested: true } },
        { tool: "thirdStep", params: {} },
      ],
    };
    registry.registerDeviceAware("firstStep", "First", schema, async () => {
      events.push("first");
      return createStructuredToolResponse({ success: true });
    });
    registry.registerDeviceAware("thirdStep", "Third", schema, async () => {
      expect(released).toBe(false);
      events.push("third");
      return createStructuredToolResponse({ success: true });
    });
    registry.registerDeviceAware("executePlan", "Fake plan", schema, async (_device, args) =>
      runWithToolSelectionContext({ planRequest: {} }, async () => {
        if (args.nested) {
          expect(args.sessionUuid).toBe("outer-session");
          events.push("nested");
          return createStructuredToolResponse({ success: true });
        }
        const result = await new DefaultPlanExecutor(timer).executePlan(
          plan,
          0,
          "android",
          device.deviceId,
          "outer-session",
        );
        return createStructuredToolResponse(result);
      }),
    );
    try {
      // Internal calls without an enclosing plan still own their lifecycle.
      const response = await registry.callInternal("executePlan", { sessionUuid: "outer-session" });
      expect(getStructuredField(response, "success")).toBe(true);
      expect(events).toEqual(["first", "nested", "third", "release"]);
      expect(lifecycleInputs.map(({ name, nestedInPlan }) => ({ name, nestedInPlan }))).toEqual([
        { name: "firstStep", nestedInPlan: true },
        { name: "executePlan", nestedInPlan: true },
        { name: "thirdStep", nestedInPlan: true },
        { name: "executePlan", nestedInPlan: false },
      ]);
      expect(timer.getSleepHistory()).toEqual([]);
    } finally {
      toolLookup.mockRestore();
      restore();
    }
  });
});
