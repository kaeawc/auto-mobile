import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry, type PlanLifecycleInput } from "../../src/server/toolRegistry";

isolateToolRegistry();

// #10834: the plan lifecycle keeps a failed executePlan's session for the caller's recovery only
// when it knows the call failed, so the registry must hand it the call's outcome.

describe("plan lifecycle receives the tool call's outcome", () => {
  const toolName = "__plan_lifecycle_outcome_probe__";
  const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
    ToolRegistry.unregister(toolName);
  });

  async function callWith(response: () => unknown): Promise<PlanLifecycleInput[]> {
    const seen: PlanLifecycleInput[] = [];
    restore = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        async resolveExecutionTarget(input) {
          return {
            args: input.args,
            baseSessionUuid: "plan-session",
            device,
            internalCall: false,
            sessionUuid: "plan-session",
            shouldResolveDevice: true,
          };
        },
      },
      auditRunner: {
        async run(input) {
          return await input.handler(input.device, input.args, input.progress, input.signal);
        },
      },
      afterToolCall: {
        async handle(input) {
          return { durationMs: 0, finalizedResponse: input.response };
        },
      },
      planLifecycleManager: {
        async afterExecution(input) {
          seen.push(input);
        },
      },
    });
    ToolRegistry.registerDeviceAware(toolName, "outcome probe", z.object({}), async () =>
      response(),
    );
    await ToolRegistry.getTool(toolName)!
      .handler({})
      .catch(() => undefined);
    return seen;
  }

  test("a successful call is reported as succeeded", async () => {
    const seen = await callWith(() => ({ success: true }));
    expect(seen.map((input) => input.succeeded)).toEqual([true]);
  });

  test("a failure response is reported as not succeeded", async () => {
    const seen = await callWith(() => ({ success: false, error: "step 3 failed" }));
    expect(seen.map((input) => input.succeeded)).toEqual([false]);
  });

  test("a thrown failure is reported as not succeeded", async () => {
    const seen = await callWith(() => {
      throw new Error("boom");
    });
    expect(seen.map((input) => input.succeeded)).toEqual([false]);
  });
});
