import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { loggerCallsWithPrefix } from "../helpers/loggerCallsWithPrefix";
import { FakeLogger } from "../fakes/FakeLogger";

function registerThrowingTool(name: string): void {
  ToolRegistry.register(name, "Throws for catch logging tests", z.object({}), async () => {
    throw new Error(`${name} boom`);
  });
}

function registerStructuredFailureTool(name: string): void {
  ToolRegistry.register(
    name,
    "Returns a structured failure for plan execution tests",
    z.object({}),
    async () => ({
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: {
              code: "device_already_stopped",
              message: "The device is already stopped",
            },
          }),
        },
      ],
    }),
  );
}

afterEach(() => {
  ToolRegistry.clearTools();
});

describe("PlanExecutor catch logging", () => {
  test("warns before returning a skipped status from an optional thrown step", async () => {
    const log = new FakeLogger();
    registerThrowingTool("optionalThrowingTool");
    const executor = new DefaultPlanExecutor(undefined, log);
    const plan: Plan = {
      name: "optional catch logging",
      steps: [{ tool: "optionalThrowingTool", params: {}, optional: true }],
    };

    const result = await executor.executePlan(plan, 0);

    expect(result.success).toBe(true);
    expect(log.at("warn")).toContainEqual(
      expect.objectContaining({
        message: "[PLAN_STEP_1] optional step optionalThrowingTool threw; returning skipped status",
        args: [expect.objectContaining({ message: "optionalThrowingTool boom" })],
      }),
    );
  });

  test("warns before returning a failed status from a thrown step", async () => {
    const log = new FakeLogger();
    registerThrowingTool("requiredThrowingTool");
    const executor = new DefaultPlanExecutor(undefined, log);
    const plan: Plan = {
      name: "required catch logging",
      steps: [{ tool: "requiredThrowingTool", params: {} }],
    };

    const result = await executor.executePlan(plan, 0);

    expect(result.success).toBe(false);
    expect(log.at("warn")).toContainEqual(
      expect.objectContaining({
        message: "[PLAN_STEP_1] step requiredThrowingTool threw; returning failed status",
        args: [expect.objectContaining({ message: "requiredThrowingTool boom" })],
      }),
    );
  });

  test("returns a failed status for a structured failure envelope", async () => {
    registerStructuredFailureTool("structuredFailureTool");
    const executor = new DefaultPlanExecutor(undefined, new FakeLogger());
    const plan: Plan = {
      name: "structured failure",
      steps: [{ tool: "structuredFailureTool", params: {} }],
    };

    const result = await executor.executePlan(plan, 0);

    expect(result.success).toBe(false);
    expect(result.failedStep).toMatchObject({
      stepIndex: 0,
      tool: "structuredFailureTool",
      error: "device_already_stopped: The device is already stopped",
    });
  });
});

describe("PlanExecutor result boundary warnings", () => {
  test("sequential failure keeps the plan error sentinel and warns", async () => {
    const executor = new DefaultPlanExecutor(new FakeTimer(), new FakeLogger());
    const error = new Error("before step failed");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await executor.executePlan(
        { name: "failure", steps: [{ tool: "unreached", params: {} }] },
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          onBeforePlanStep: async () => {
            throw error;
          },
        },
      );
      expect(result).toMatchObject({
        success: false,
        executedSteps: 0,
        totalSteps: 1,
        failedStep: { stepIndex: -1, tool: "unknown", error: String(error) },
      });
      expect(loggerCallsWithPrefix(warning.mock.calls, "Plan execution failed:")).toEqual([
        ["Plan execution failed: before step failed", error],
      ]);
    } finally {
      warning.mockRestore();
    }
  });

  test.each(["step", "track"] as const)(
    "parallel %s failure preserves the failure sentinel and warns",
    async (boundary) => {
      const executor = new DefaultPlanExecutor(new FakeTimer(), new FakeLogger());
      const error = new Error(`${boundary} failed`);
      const failure =
        boundary === "step"
          ? spyOn(executor, "executeStep").mockRejectedValue(error)
          : spyOn(executor, "executeDeviceTrack").mockRejectedValue(error);
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const result = await executor.executePlan(
          {
            name: "parallel failure",
            devices: ["A"],
            steps: [{ tool: "unreached", params: { device: "A" } }],
          },
          0,
        );
        expect(result).toMatchObject({
          success: false,
          executedSteps: 0,
          totalSteps: 1,
          failedStep: { device: "A", stepIndex: -1, tool: "unknown", error: error.message },
        });
        const label = boundary === "step" ? "Track execution error" : "Unexpected error";
        expect(loggerCallsWithPrefix(warning.mock.calls, `[PARALLEL_EXEC][A] ${label}:`)).toEqual([
          [`[PARALLEL_EXEC][A] ${label}: ${error.message}`, error],
        ]);
      } finally {
        failure.mockRestore();
        warning.mockRestore();
      }
    },
  );
});
