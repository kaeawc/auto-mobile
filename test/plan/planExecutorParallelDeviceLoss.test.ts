import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { DeviceLostError, deviceLostErrorFromAbortSignal } from "../../src/models/DeviceLostError";
import type { AbortStrategy, Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { OPERATION_CANCELLED_MESSAGE } from "../../src/utils/constants";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { withTemporaryTool } from "../helpers/withTemporaryTool";

const toolName = "parallelDeviceLossTest";
const toolSchema = z.object({ device: z.string(), later: z.boolean().optional() });

function parallelPlan(devices = ["A", "B"]): Plan {
  return {
    name: "parallel device loss",
    devices,
    steps: [
      { tool: toolName, params: { device: "A" } },
      { tool: toolName, params: { device: "B" } },
      { tool: toolName, params: { device: "B", later: true } },
    ],
  };
}

// Drain the executor's promise continuations without advancing real time.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

async function checkDeviceLoss(
  strategy: AbortStrategy,
  devices = ["A", "B"],
  siblingError?: Error,
  hideSignalReason = false,
): Promise<void> {
  const loss = new DeviceLostError("A", "device-disconnected:A");
  const siblingStarted = Promise.withResolvers<void>();
  const releaseSibling = Promise.withResolvers<void>();
  const siblingFinished = Promise.withResolvers<void>();
  let siblingSignal: AbortSignal | undefined;
  let abortedInFlight = false;
  let reasonAtAbort: DeviceLostError | undefined;
  let laterCalls = 0;
  let settled = false;

  await withTemporaryTool(
    toolName,
    () => {
      ToolRegistry.register(
        toolName,
        "Deferred parallel device loss fake",
        toolSchema,
        async (params: z.infer<typeof toolSchema>, _progress, signal) => {
          if (params.device === "A") {
            await siblingStarted.promise;
            throw loss;
          }
          if (params.later) {
            laterCalls++;
            return { success: true };
          }
          siblingSignal = signal;
          if (signal) {
            if (hideSignalReason) {
              Object.defineProperty(signal, "reason", { get: () => undefined });
            }
            signal.addEventListener(
              "abort",
              () => {
                abortedInFlight = signal.aborted;
                reasonAtAbort = deviceLostErrorFromAbortSignal(signal);
              },
              { once: true },
            );
          }
          siblingStarted.resolve();
          await releaseSibling.promise;
          siblingFinished.resolve();
          if (siblingError) {
            throw siblingError;
          }
          return { success: true };
        },
      );
      ToolRegistry.getTool(toolName)!.requiresDevice = false;
    },
    async () => {
      // Supply a caller signal so tools receive the composed signal, not just
      // the internal controller's signal.
      const execution = new DefaultPlanExecutor(new FakeTimer()).executePlan(
        parallelPlan(devices),
        0,
        undefined,
        undefined,
        undefined,
        new AbortController().signal,
        strategy,
      );
      const completion = execution.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await siblingStarted.promise;
        await flushMicrotasks();
        expect(settled).toBe(false);
        expect(abortedInFlight).toBe(true);
        expect(siblingSignal?.aborted).toBe(true);
        expect(reasonAtAbort).toBe(loss);
        expect(deviceLostErrorFromAbortSignal(siblingSignal!)).toBe(loss);
        expect(laterCalls).toBe(0);

        releaseSibling.resolve();
        await expect(execution).rejects.toBe(loss);
        await siblingFinished.promise;
        await flushMicrotasks();
        expect(settled).toBe(true);
        expect(laterCalls).toBe(0);
      } finally {
        releaseSibling.resolve();
        await siblingFinished.promise;
        await completion;
        await flushMicrotasks();
      }
    },
  );
}

describe("parallel plan device loss", () => {
  test("aborts siblings in flight and waits for them before rejecting", async () => {
    await checkDeviceLoss("immediate");
  });

  test("device loss also aborts siblings with finish-current-step", async () => {
    await checkDeviceLoss("finish-current-step");
  });

  test("rethrows the originating loss even when a later loss is first in device order", async () => {
    await checkDeviceLoss(
      "immediate",
      ["B", "A"],
      new DeviceLostError("B", "device-disconnected:B"),
    );
  });

  test("retains the typed reason when Bun hides the composed signal reason", async () => {
    await checkDeviceLoss("immediate", ["A", "B"], undefined, true);
  });

  test("device loss wins over an ordinary sibling failure", async () => {
    await checkDeviceLoss("finish-current-step", ["B", "A"], new Error("ordinary sibling failure"));
  });

  test("ordinary failure still aborts siblings and aggregates cancelled results", async () => {
    const siblingStarted = Promise.withResolvers<void>();
    const releaseSibling = Promise.withResolvers<void>();
    let siblingSignal: AbortSignal | undefined;
    let laterCalls = 0;
    await withTemporaryTool(
      toolName,
      () => {
        ToolRegistry.register(
          toolName,
          "Ordinary parallel failure fake",
          toolSchema,
          async (params: z.infer<typeof toolSchema>, _progress, signal) => {
            if (params.device === "A") {
              await siblingStarted.promise;
              return { success: false, error: "ordinary failure" };
            }
            if (params.later) {
              laterCalls++;
              return { success: true };
            }
            siblingSignal = signal;
            siblingStarted.resolve();
            await releaseSibling.promise;
            return { success: true };
          },
        );
        ToolRegistry.getTool(toolName)!.requiresDevice = false;
      },
      async () => {
        const execution = new DefaultPlanExecutor(new FakeTimer()).executePlan(parallelPlan(), 0);
        try {
          await siblingStarted.promise;
          await flushMicrotasks();
          expect(siblingSignal?.aborted).toBe(true);
        } finally {
          releaseSibling.resolve();
        }
        const result = await execution;
        expect(result).toMatchObject({
          success: false,
          executedSteps: 0,
          totalSteps: 3,
          failedStep: { device: "A", stepIndex: 0, tool: toolName, error: "ordinary failure" },
        });
        expect(result.perDeviceResults?.get("A")).toMatchObject({
          success: false,
          executedSteps: 0,
          totalSteps: 1,
          failedStep: { stepIndex: 0, trackIndex: 0, error: "ordinary failure" },
        });
        expect(result.perDeviceResults?.get("B")).toMatchObject({
          success: false,
          executedSteps: 0,
          totalSteps: 2,
          failedStep: {
            stepIndex: 1,
            trackIndex: 0,
            error: expect.stringContaining(OPERATION_CANCELLED_MESSAGE),
          },
        });
        expect(laterCalls).toBe(0);
      },
    );
  });

  test("ordinary finish-current-step failure still lets siblings finish naturally", async () => {
    let laterCalls = 0;
    let siblingAborted = false;
    await withTemporaryTool(
      toolName,
      () => {
        ToolRegistry.register(
          toolName,
          "Ordinary finish-current-step fake",
          toolSchema,
          async (params: z.infer<typeof toolSchema>, _progress, signal) => {
            if (params.device === "A") {
              return { success: false, error: "ordinary failure" };
            }
            siblingAborted ||= signal?.aborted === true;
            if (params.later) {
              laterCalls++;
            }
            return { success: true };
          },
        );
        ToolRegistry.getTool(toolName)!.requiresDevice = false;
      },
      async () => {
        const result = await new DefaultPlanExecutor(new FakeTimer()).executePlan(
          parallelPlan(),
          0,
          undefined,
          undefined,
          undefined,
          undefined,
          "finish-current-step",
        );
        expect(result).toMatchObject({
          success: false,
          executedSteps: 2,
          totalSteps: 3,
          failedStep: { device: "A", stepIndex: 0, error: "ordinary failure" },
        });
        expect(result.perDeviceResults?.get("B")).toMatchObject({
          success: true,
          executedSteps: 2,
          totalSteps: 2,
        });
        expect(siblingAborted).toBe(false);
        expect(laterCalls).toBe(1);
      },
    );
  });

  for (const devices of [undefined, ["A"]]) {
    test(`single-track device loss still rejects (${devices ? "partitioned" : "sequential"})`, async () => {
      const loss = new DeviceLostError("A", "device-disconnected:A");
      await withTemporaryTool(
        toolName,
        () => {
          ToolRegistry.register(toolName, "Single-track loss fake", toolSchema, async () => {
            throw loss;
          });
          ToolRegistry.getTool(toolName)!.requiresDevice = false;
        },
        async () => {
          await expect(
            new DefaultPlanExecutor(new FakeTimer()).executePlan(
              {
                name: "single-track loss",
                devices,
                steps: [{ tool: toolName, params: { device: "A" } }],
              },
              0,
            ),
          ).rejects.toBe(loss);
        },
      );
    });
  }
});
