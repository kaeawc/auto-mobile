import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createDefaultPlanExecutor } from "../../src/server/planExecutorFactory";
import {
  currentRequestDeadline,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";
import { FakeTimer } from "../fakes/FakeTimer";
import { createSetUIStateHandler } from "../../src/server/formTools";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import {
  getLiveDeadlineMs,
  registerLiveDeadline,
  unregisterLiveDeadline,
} from "../../src/daemon/liveDeadlineRegistry";
import {
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
} from "../../src/daemon/wire/constants";

describe("plan internal request inheritance", () => {
  afterEach(() => {
    ToolRegistry.clearTools();

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
      async (_args, progress) => {
        // The step reads the request's deadline ambiently (#15663).
        const requestDeadline = currentRequestDeadline();
        observed.push(requestDeadline?.deadlineMs);
        observed.push(requestDeadline?.timeoutMs);
        observed.push(requestDeadline?.startTime);
        observed.push(getLiveDeadlineMs(requestDeadline?.liveDeadlineKey ?? ""));
        timer.advanceTime(5_000);
        await progress?.(1, 2, "field completed");
        observed.push(getLiveDeadlineMs(requestDeadline?.liveDeadlineKey ?? ""));
        return { success: true };
      },
    );
    const result = await runWithToolSelectionContext(
      {
        planRequest: {
          progress: async () => {
            deadline.extendOnProgress(timer.now(), 10_000);
          },
        },
        requestDeadline: {
          deadlineMs: 10_000,
          timeoutMs: 10_000,
          startTime: 0,
          liveDeadlineKey: "plan-deadline",
        },
      },
      () =>
        createDefaultPlanExecutor(timer).executePlan(
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
    const setUIStateHandler = createSetUIStateHandler({
      setUIStateFactory: () => ({
        execute: async (_options, inheritedProgress, _signal, transport = {}) => {
          const { transportDeadlineMs: deadlineMs, getLiveTransportDeadlineMs: liveDeadline } =
            transport;
          snapshots.push(deadlineMs, liveDeadline?.(), inheritedProgress);
          return { success: true, fields: [], totalAttempts: 0 };
        },
      }),
    });
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
      {
        planRequest: { progress },
        // The enclosing request's deadline, as MCP ingress sets it (#15663).
        requestDeadline: { deadlineMs: 80_000, liveDeadlineKey: "plan-deadline" },
      },
      () =>
        createDefaultPlanExecutor(new FakeTimer()).executePlan(
          { name: "form", mcpVersion: "1.0", steps: [{ tool: "deadlineForm", params: {} }] },
          0,
        ),
    );
    expect(snapshots).toEqual([80_000, 80_000, progress]);
  });

  test("step-supplied metadata cannot replace the enclosing request", async () => {
    const calls: unknown[] = [];
    ToolRegistry.register("deadlineStep", "step", z.object({}).passthrough(), async (args) => {
      calls.push(
        currentRequestDeadline()?.deadlineMs,
        currentRequestDeadline()?.liveDeadlineKey,
        args[INTERNAL_MCP_REQUEST_DEADLINE_PARAM],
        args[INTERNAL_LIVE_DEADLINE_KEY_PARAM],
      );
      return { success: true };
    });
    await runWithToolSelectionContext(
      { planRequest: {}, requestDeadline: { deadlineMs: 42 } },
      () =>
        createDefaultPlanExecutor(new FakeTimer()).executePlan(
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
    // The step runs under the request's deadline; the plan's keys never reach its args.
    expect(calls).toEqual([42, undefined, undefined, undefined]);
  });

  test("concurrent internal calls keep request context isolated and leave plain calls unchanged", async () => {
    ToolRegistry.register("deadlineStep", "step", z.object({}), async () => {
      await Promise.resolve();
      return currentRequestDeadline()?.deadlineMs;
    });
    const results = await Promise.all(
      [1, 2].map((deadlineMs) =>
        runWithToolSelectionContext({ planRequest: {}, requestDeadline: { deadlineMs } }, () =>
          ToolRegistry.callInternal("deadlineStep", {}),
        ),
      ),
    );
    expect(results).toEqual([1, 2]);
    expect(await ToolRegistry.callInternal("deadlineStep", {})).toBeUndefined();
  });
});
