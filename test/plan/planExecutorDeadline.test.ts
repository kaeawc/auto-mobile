import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  resetSetUIStateFactory,
  setSetUIStateFactory,
  setUIStateHandler,
} from "../../src/server/formTools";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import {
  getLiveDeadlineMs,
  registerLiveDeadline,
  unregisterLiveDeadline,
} from "../../src/daemon/liveDeadlineRegistry";
import {
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
} from "../../src/daemon/constants";

describe("plan internal request inheritance", () => {
  afterEach(() => {
    ToolRegistry.clearTools();
    resetSetUIStateFactory();
    unregisterLiveDeadline("plan-deadline");
  });

  test("step progress extends the enclosing live deadline after schema parsing", async () => {
    const timer = new FakeTimer();
    const deadline = new ProgressExtendableDeadline(timer.now(), 10_000);
    registerLiveDeadline("plan-deadline", deadline);
    const observed: unknown[] = [];
    ToolRegistry.register(
      "deadlineStep",
      "deadline aware step",
      z.object({}),
      async (args, progress) => {
        observed.push(args[INTERNAL_MCP_REQUEST_DEADLINE_PARAM]);
        observed.push(args[INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]);
        observed.push(args[INTERNAL_EXECUTION_START_TIME_PARAM]);
        observed.push(getLiveDeadlineMs(args[INTERNAL_LIVE_DEADLINE_KEY_PARAM]));
        timer.advanceTime(5_000);
        await progress?.(1, 2, "field completed");
        observed.push(getLiveDeadlineMs(args[INTERNAL_LIVE_DEADLINE_KEY_PARAM]));
        return { success: true };
      },
    );
    const result = await runWithToolSelectionContext(
      {
        planRequest: {
          deadlineMs: 10_000,
          timeoutMs: 10_000,
          startTime: 0,
          liveDeadlineKey: "plan-deadline",
          progress: async () => {
            deadline.extendOnProgress(timer.now(), 10_000);
          },
        },
      },
      () =>
        new DefaultPlanExecutor(timer).executePlan(
          {
            name: "deadline",
            mcpVersion: "1.0",
            steps: [{ tool: "deadlineStep", params: {} }],
          },
          0,
        ),
    );
    expect(result.success).toBe(true);
    expect(observed).toEqual([10_000, 10_000, 0, 10_000, 15_000]);
  });

  test("setUIState inside a plan sees the enclosing deadline through its existing handler", async () => {
    const snapshots: unknown[] = [];
    const progress = async () => {};
    setSetUIStateFactory(() => ({
      execute: async (_options, inheritedProgress, _signal, deadlineMs, liveDeadline) => {
        snapshots.push(deadlineMs, liveDeadline?.(), inheritedProgress);
        return { success: true, fields: [], totalAttempts: 0 };
      },
    }));
    registerLiveDeadline("plan-deadline", new ProgressExtendableDeadline(0, 80_000));
    ToolRegistry.register(
      "deadlineForm",
      "form step",
      z.object({}),
      (args, inheritedProgress, signal) =>
        setUIStateHandler(
          { deviceId: "fake", name: "fake", platform: "android" },
          { ...args, fields: [{ selector: { elementId: "name" }, value: "Grace" }] },
          inheritedProgress,
          signal,
        ),
    );
    await runWithToolSelectionContext(
      { planRequest: { deadlineMs: 80_000, liveDeadlineKey: "plan-deadline", progress } },
      () =>
        new DefaultPlanExecutor(new FakeTimer()).executePlan(
          { name: "form", mcpVersion: "1.0", steps: [{ tool: "deadlineForm", params: {} }] },
          0,
        ),
    );
    expect(snapshots).toEqual([80_000, 80_000, progress]);
  });

  test("step-supplied metadata cannot replace the enclosing request", async () => {
    const calls: unknown[] = [];
    ToolRegistry.register("deadlineStep", "step", z.object({}).passthrough(), async (args) => {
      calls.push(args[INTERNAL_MCP_REQUEST_DEADLINE_PARAM], args[INTERNAL_LIVE_DEADLINE_KEY_PARAM]);
      return { success: true };
    });
    await runWithToolSelectionContext({ planRequest: { deadlineMs: 42 } }, () =>
      new DefaultPlanExecutor(new FakeTimer()).executePlan(
        {
          name: "spoof",
          mcpVersion: "1.0",
          steps: [
            {
              tool: "deadlineStep",
              params: {
                [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: 999_999,
                [INTERNAL_LIVE_DEADLINE_KEY_PARAM]: "other-request",
              },
            },
          ],
        },
        0,
      ),
    );
    expect(calls).toEqual([42, undefined]);
  });

  test("concurrent internal calls keep request context isolated and leave plain calls unchanged", async () => {
    ToolRegistry.register("deadlineStep", "step", z.object({}), async (args) => {
      await Promise.resolve();
      return args[INTERNAL_MCP_REQUEST_DEADLINE_PARAM];
    });
    const results = await Promise.all(
      [1, 2].map((deadlineMs) =>
        runWithToolSelectionContext({ planRequest: { deadlineMs } }, () =>
          ToolRegistry.callInternal("deadlineStep", {}),
        ),
      ),
    );
    expect(results).toEqual([1, 2]);
    expect(await ToolRegistry.callInternal("deadlineStep", {})).toBeUndefined();
  });
});
