import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerBarrierTools } from "../../src/server/barrierTools";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import type { Plan } from "../../src/models/Plan";
import type { BootedDevice } from "../../src/models";

const makeDevice = (deviceId: string): BootedDevice => ({
  platform: "android",
  deviceId,
  name: `Device ${deviceId}`,
});

const parseResponse = (response: any): any => JSON.parse(response.content[0].text);

describe("barrier tool", () => {
  beforeAll(() => {
    if (!ToolRegistry.getToolForPlan("barrier")) {
      registerBarrierTools();
    }
  });

  beforeEach(() => {
    CriticalSectionCoordinator.getInstance().reset();
  });

  test("tool is registered with correct schema", () => {
    const tool = ToolRegistry.getToolForPlan("barrier");
    expect(tool).toBeDefined();
    expect(tool?.name).toBe("barrier");
    expect(tool?.description).toContain("proceed concurrently");
    expect(tool?.deviceAwareHandler).toBeDefined();
  });

  test("single device with deviceCount 1 passes the barrier", async () => {
    const tool = ToolRegistry.getToolForPlan("barrier");
    const response = await tool!.deviceAwareHandler!(
      makeDevice("device-1"),
      { lock: "solo", deviceCount: 1 },
      undefined,
      undefined,
    );
    const parsed = parseResponse(response);
    expect(parsed.success).toBe(true);
    expect(parsed.lock).toBe("solo");
    expect(parsed.deviceId).toBe("device-1");
    expect(parsed.deviceCount).toBe(1);
  });

  test("two devices synchronize and both pass concurrently", async () => {
    const tool = ToolRegistry.getToolForPlan("barrier");

    const results = await Promise.all([
      tool!.deviceAwareHandler!(
        makeDevice("device-1"),
        { lock: "pair", deviceCount: 2 },
        undefined,
        undefined,
      ),
      tool!.deviceAwareHandler!(
        makeDevice("device-2"),
        { lock: "pair", deviceCount: 2 },
        undefined,
        undefined,
      ),
    ]);

    const parsed = results.map(parseResponse);
    expect(parsed.every((r) => r.success)).toBe(true);
    expect(new Set(parsed.map((r) => r.deviceId))).toEqual(new Set(["device-1", "device-2"]));
  });

  test("rejects with an actionable error on barrier timeout", async () => {
    const tool = ToolRegistry.getToolForPlan("barrier");
    // deviceCount 2 but only one device arrives; short timeout so the test is fast.
    await expect(
      tool!.deviceAwareHandler!(
        makeDevice("device-1"),
        { lock: "lonely", deviceCount: 2, timeout: 50 },
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/Barrier "lonely" failed for device device-1/);
  });

  test("schema preserves the injected __lockNamespace (not stripped by parse)", () => {
    const tool = ToolRegistry.getToolForPlan("barrier");
    const parsed = tool!.schema.parse({
      lock: "sync",
      deviceCount: 2,
      __lockNamespace: "session-A",
    });
    expect(parsed.__lockNamespace).toBe("session-A");
  });

  test("__lockNamespace scopes the barrier: same lock name, different plans do not cross-satisfy", async () => {
    const tool = ToolRegistry.getToolForPlan("barrier");

    // One device from plan A and one from plan B arrive at the same lock name
    // "sync" (deviceCount 2) but with different namespaces. If the namespace were
    // ignored the shared barrier would lift at 2 arrivals and both would pass;
    // with scoping each still waits for its own second device, so both time out.
    const aTimedOut = tool!.deviceAwareHandler!(
      makeDevice("planA-device-1"),
      { lock: "sync", deviceCount: 2, timeout: 50, __lockNamespace: "session-A" },
      undefined,
      undefined,
    )
      .then(() => "passed")
      .catch(() => "timed-out");

    const bTimedOut = tool!.deviceAwareHandler!(
      makeDevice("planB-device-1"),
      { lock: "sync", deviceCount: 2, timeout: 50, __lockNamespace: "session-B" },
      undefined,
      undefined,
    )
      .then(() => "passed")
      .catch(() => "timed-out");

    expect(await aTimedOut).toBe("timed-out");
    expect(await bTimedOut).toBe("timed-out");
  });

  test("schema preserves the device label and sessionUuid (not stripped by parse)", () => {
    // Issue #6117: PlanExecutor requires every multi-device step to carry
    // `params.device`, then runs `tool.schema.parse` before dispatch. A schema
    // without the device-targeting fields strips the label, so every track's
    // barrier routes to the base session's device.
    const tool = ToolRegistry.getToolForPlan("barrier");
    const parsed = tool!.schema.parse({
      device: "B",
      lock: "sync",
      deviceCount: 2,
      sessionUuid: "base-uuid",
      platform: "android",
      __lockNamespace: "base-uuid",
    });
    expect(parsed).toMatchObject({
      device: "B",
      lock: "sync",
      deviceCount: 2,
      sessionUuid: "base-uuid",
      platform: "android",
      __lockNamespace: "base-uuid",
    });
  });

  test("two-track plan with one barrier per track passes (each track routes to its own device)", async () => {
    // Issue #6117 end-to-end: push the barrier through the real executeStep
    // (buildEnhancedStepParams -> schema.parse -> callInternal -> handler
    // routing). The fake resolver maps the surviving `device` label to a
    // distinct device; if the label were stripped, both tracks would resolve
    // to the base device and `awaitBarrier` would reject the duplicate arrival.
    const devicesByLabel: Record<string, BootedDevice> = {
      A: makeDevice("device-a"),
      B: makeDevice("device-b"),
    };
    const resolvedDeviceIds: string[] = [];
    const restore = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async (input) => {
          const label = typeof input.args.device === "string" ? input.args.device : "A";
          const device = devicesByLabel[label];
          resolvedDeviceIds.push(device.deviceId);
          return {
            args: input.args,
            baseSessionUuid: "base-uuid",
            device,
            internalCall: true,
            sessionUuid: label === "A" ? "base-uuid" : `base-uuid:${label}`,
            shouldResolveDevice: true,
          };
        },
      },
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        handle: async (input) => ({ durationMs: 0, finalizedResponse: input.response }),
      },
      planLifecycleManager: {
        afterExecution: async () => {},
      },
    });

    try {
      const plan: Plan = {
        name: "two-track barrier",
        devices: ["A", "B"],
        steps: [
          { tool: "barrier", params: { device: "A", lock: "sync", deviceCount: 2, timeout: 200 } },
          { tool: "barrier", params: { device: "B", lock: "sync", deviceCount: 2, timeout: 200 } },
        ],
      };

      const result = await new DefaultPlanExecutor().executePlan(
        plan,
        0,
        "android",
        "device-a",
        "base-uuid",
      );

      expect(result.failedStep?.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.perDeviceResults?.get("A")?.success).toBe(true);
      expect(result.perDeviceResults?.get("B")?.success).toBe(true);
      expect(new Set(resolvedDeviceIds)).toEqual(new Set(["device-a", "device-b"]));
    } finally {
      restore();
    }
  });
});
