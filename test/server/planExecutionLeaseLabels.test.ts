import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { PlanExecutionResult } from "../../src/models";
import * as planUtils from "../../src/server/planExecutorFactory";
import { PlanExecutionOrchestrator } from "../../src/server/planExecutionOrchestrator";
import { serverConfig, type PlanExecutionTarget } from "../../src/utils/ServerConfig";
import { FakeTimer } from "../fakes/FakeTimer";

// #14444: a lease names the label sessions its own invocation allocates, so plan-time loss
// handling never treats a sibling label published under the same base as this plan's device.

const LABELED_PLAN = `
name: labels
devices:
  - A
  - B
steps:
  - tool: observe
    device: A
    params: {}
`;
const SINGLE_DEVICE_PLAN = "name: single\nsteps:\n  - tool: observe\n    params: {}\n";
const success: PlanExecutionResult = { success: true, executedSteps: 1, totalSteps: 1 };

describe("plan execution lease label membership (#14444)", () => {
  const proto = PlanExecutionOrchestrator.prototype;
  const originalAllocate = proto["allocateDevices"];
  let leasedDuringRun: readonly PlanExecutionTarget[];
  let execute: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;

  beforeEach(() => {
    leasedDuringRun = [];
    execute = spyOn(planUtils, "executePlan").mockImplementation(async () => {
      leasedDuringRun = serverConfig.getActivePlanExecutions();
      return success;
    });
    // Allocation needs a live daemon pool; only the lease registered before it is under test.
    proto["allocateDevices"] = async () => undefined;
  });
  afterEach(() => {
    proto["allocateDevices"] = originalAllocate;
    execute.mockRestore();
  });

  function run(planContent: string, sessionUuid: string, device?: string) {
    return new PlanExecutionOrchestrator(
      {
        device: { platform: "android", deviceId: "device-a", name: "A" },
        request: {
          platform: "android",
          planContent,
          startStep: 0,
          sessionUuid,
          device,
          deviceAllocationTimeoutMs: 5000,
        },
      },
      {
        timer: new FakeTimer(),
        // Never reach the real recorder (#11512); an unavailable one only adds a video warning.
        videoRecorder: {
          startVideoRecording: async () => {
            throw new Error("recording unavailable");
          },
          stopVideoRecording: async () => {
            throw new Error("no recording started");
          },
        },
        createSchemaValidator: () => ({
          loadSchema: async () => undefined,
          validateYaml: () => ({ valid: true }),
        }),
      },
    ).execute();
  }

  test("a labeled plan's lease names exactly the label sessions it allocates", async () => {
    expect((await run(LABELED_PLAN, "base:B")).success).toBe(true);
    expect(leasedDuringRun).toEqual([
      {
        sessionUuid: "base:B",
        deviceId: "device-a",
        executionId: undefined,
        labelSessionUuids: ["base:B", "base:B:B"],
      },
    ]);
  });

  test("the primary label maps to the plan's own session", async () => {
    expect((await run(LABELED_PLAN, "base", "B")).success).toBe(true);
    expect(leasedDuringRun.map((lease) => lease.labelSessionUuids)).toEqual([["base:A", "base"]]);
  });

  test("a single-device plan's lease names no sibling label session", async () => {
    expect((await run(SINGLE_DEVICE_PLAN, "base")).success).toBe(true);
    expect(leasedDuringRun.map((lease) => lease.labelSessionUuids)).toEqual([[]]);
    expect(serverConfig.getActivePlanExecutions()).toEqual([]);
  });
});
