import { describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import type { FailureObservationSummary } from "../../src/models/FailureObservation";
import type { AbortStrategy, Plan, PlanExecutionResult } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor, selectParallelFailure } from "../../src/utils/plan/PlanExecutor";
import { PlanPartitioner } from "../../src/utils/plan/PlanPartitioner";
import { FakeTimer } from "../fakes/FakeTimer";
import { withTemporaryTool } from "../helpers/withTemporaryTool";

const toolName = "parallelFailureSelectionTest";
const toolSchema = z.object({ device: z.string() });

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

function parallelPlan(): Plan {
  return {
    name: "parallel failure selection",
    // Deliberately reverse lexical order to catch name-based tie breaking.
    devices: ["Z", "A"],
    steps: [
      { tool: toolName, params: { device: "Z" } },
      { tool: toolName, params: { device: "A" } },
    ],
  };
}

interface RunOptions {
  plan?: Plan;
  strategy?: AbortStrategy;
  successfulDevices?: string[];
  delayedTrack?: string;
  failureObservation?: FailureObservationSummary;
  holdFirstObservation?: boolean;
}

async function runInOrder(
  order: string[],
  {
    plan = parallelPlan(),
    strategy = "finish-current-step",
    successfulDevices = [],
    delayedTrack,
    failureObservation,
    holdFirstObservation = false,
  }: RunOptions = {},
): Promise<PlanExecutionResult> {
  const releases = new Map(order.map((device) => [device, Promise.withResolvers<void>()]));
  const started = new Map(order.map((device) => [device, Promise.withResolvers<void>()]));
  const executor = new DefaultPlanExecutor(new FakeTimer());
  const observationRelease = Promise.withResolvers<void>();
  let observationCalls = 0;
  if (failureObservation) {
    Object.defineProperty(executor, "buildFailureObservationContext", {
      value: async () => {
        if (holdFirstObservation && observationCalls++ === 0) {
          await observationRelease.promise;
        }
        return failureObservation;
      },
    });
  }
  if (delayedTrack) {
    // Hold the sibling before its first abort check, exercising the real
    // executeDeviceTrack catch that returns the -1 sentinel on cancellation.
    const executeTrack = executor["executeDeviceTrack"].bind(executor);
    Object.defineProperty(executor, "executeDeviceTrack", {
      value: async (...args: Parameters<typeof executeTrack>) => {
        if (args[0] === delayedTrack) {
          started.get(delayedTrack)!.resolve();
          await releases.get(delayedTrack)!.promise;
        }
        return executeTrack(...args);
      },
    });
  }
  return withTemporaryTool(
    toolName,
    () => {
      ToolRegistry.register(
        toolName,
        "Deferred parallel failure fake",
        toolSchema,
        async (params: z.infer<typeof toolSchema>) => {
          started.get(params.device)!.resolve();
          await releases.get(params.device)!.promise;
          return successfulDevices.includes(params.device)
            ? { success: true }
            : { success: false, error: `failure on ${params.device}` };
        },
      );
      ToolRegistry.getTool(toolName)!.requiresDevice = false;
    },
    async () => {
      const execution = executor.executePlan(
        plan,
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        strategy,
      );
      try {
        await Promise.all([...started.values()].map((gate) => gate.promise));
        for (const device of order) {
          releases.get(device)!.resolve();
          await flushMicrotasks();
        }
        observationRelease.resolve();
        return await execution;
      } finally {
        observationRelease.resolve();
        for (const release of releases.values()) {
          release.resolve();
        }
        await execution;
      }
    },
  );
}

describe("parallel reported failure selection", () => {
  for (const order of [
    ["A", "Z"],
    ["Z", "A"],
  ]) {
    const settleOrder = order.join(" then ");
    test(`reports the lowest plan index when tracks settle ${settleOrder}`, async () => {
      const result = await runInOrder(order);
      expect(result.failedStep).toEqual({
        device: "Z",
        stepIndex: 0,
        tool: toolName,
        error: "failure on Z",
        failureObservation: undefined,
      });
      expect(result.deviceFailures).toEqual([
        result.failedStep,
        {
          device: "A",
          stepIndex: 1,
          tool: toolName,
          error: "failure on A",
          failureObservation: undefined,
        },
      ]);
      expect(result.perDeviceResults?.get("A")?.failedStep?.stepIndex).toBe(1);
      expect(result.perDeviceResults?.get("Z")?.failedStep?.stepIndex).toBe(0);
    });

    test(`breaks equal-index ties by plan device order when tracks settle ${settleOrder}`, async () => {
      const partition = PlanPartitioner.partition(parallelPlan())!;
      partition.deviceTracks.get("A")![0].planIndex = 0;
      const partitionSpy = spyOn(PlanPartitioner, "partition").mockReturnValue(partition);
      try {
        const result = await runInOrder(order);
        expect(result.failedStep).toMatchObject({
          device: "Z",
          stepIndex: 0,
          error: "failure on Z",
        });
        expect(result.deviceFailures?.map(({ device }) => device)).toEqual(["Z", "A"]);
        expect(result.deviceFailures?.[0]).toEqual(result.failedStep);
      } finally {
        partitionSpy.mockRestore();
      }
    });

    test(`real step failure beats a track-level sentinel when tracks settle ${settleOrder}`, async () => {
      const plan = parallelPlan();
      plan.steps.push({
        tool: toolName,
        params: { device: "A" },
        get label(): string {
          throw new Error("track-level failure");
        },
      });
      const result = await runInOrder(order, { plan, successfulDevices: ["A"] });
      expect(result.failedStep).toMatchObject({ device: "Z", stepIndex: 0, error: "failure on Z" });
      expect(result.perDeviceResults?.get("A")?.failedStep).toMatchObject({
        stepIndex: -1,
        tool: "unknown",
        error: "track-level failure",
      });
      expect(result.deviceFailures).toEqual([
        result.failedStep,
        { device: "A", stepIndex: -1, tool: "unknown", error: "track-level failure" },
      ]);
    });
  }

  test("immediate abort excludes a sibling failure with a lower plan index", async () => {
    const result = await runInOrder(["A", "Z"], {
      strategy: "immediate",
      successfulDevices: ["Z"],
    });
    expect(result.failedStep).toMatchObject({ device: "A", stepIndex: 1, error: "failure on A" });
    expect(result.perDeviceResults?.get("Z")?.failedStep).toMatchObject({
      stepIndex: 0,
      failureObservation: undefined,
    });
    expect(result.deviceFailures?.map(({ device }) => device)).toEqual(["A", "Z"]);
    expect(result.deviceFailures?.[0]).toEqual(result.failedStep);
    const sibling = result.perDeviceResults!.get("Z")!.failedStep!;
    expect(result.deviceFailures?.[1]).toEqual({
      device: "Z",
      stepIndex: sibling.stepIndex,
      tool: sibling.tool,
      error: sibling.error,
      failureObservation: sibling.failureObservation,
    });
  });

  test("immediate abort excludes a sibling track-level sentinel", async () => {
    const result = await runInOrder(["A", "Z"], { strategy: "immediate", delayedTrack: "Z" });
    expect(result.failedStep).toMatchObject({ device: "A", stepIndex: 1, error: "failure on A" });
    expect(result.perDeviceResults?.get("Z")?.failedStep).toMatchObject({
      stepIndex: -1,
      tool: "unknown",
    });
    expect(result.deviceFailures?.map(({ device }) => device)).toEqual(["A", "Z"]);
    expect(result.deviceFailures?.[0]).toEqual(result.failedStep);
    expect(result.deviceFailures?.[1]).toMatchObject({
      device: "Z",
      stepIndex: -1,
      tool: "unknown",
    });
  });

  test("pins a single failure while a sibling succeeds", async () => {
    const result = await runInOrder(["Z", "A"], { successfulDevices: ["Z"] });
    expect(result.failedStep).toMatchObject({ device: "A", stepIndex: 1, error: "failure on A" });
    expect(result).toMatchObject({ success: false, executedSteps: 1, totalSteps: 2 });
    expect(result.perDeviceResults?.get("Z")?.success).toBe(true);
    expect(result.deviceFailures).toEqual([result.failedStep]);
  });

  test("sequential single-device failure omits deviceFailures", async () => {
    const plan = parallelPlan();
    delete plan.devices;
    plan.steps = [plan.steps[0]];
    const result = await runInOrder(["Z"], { plan });
    expect(result.failedStep).toMatchObject({
      stepIndex: 0,
      tool: toolName,
      error: "failure on Z",
    });
    expect(result).not.toHaveProperty("perDeviceResults");
    expect(result).not.toHaveProperty("deviceFailures");
  });

  test("omits the selected observation from deviceFailures while preserving other evidence", async () => {
    const observation = { capturedAtMs: 12, activeWindow: { appId: "fake.app" } };
    const result = await runInOrder(["A", "Z"], { failureObservation: observation });
    expect(result.deviceFailures).toEqual([
      {
        device: "Z",
        stepIndex: 0,
        tool: toolName,
        error: "failure on Z",
      },
      {
        device: "A",
        stepIndex: 1,
        tool: toolName,
        error: "failure on A",
        failureObservation: observation,
      },
    ]);
    expect(result.failedStep?.failureObservation).toBe(observation);
    expect(result.deviceFailures?.[0]).not.toHaveProperty("failureObservation");
    expect(result.deviceFailures?.[1]?.failureObservation).toBe(
      result.perDeviceResults?.get("A")?.failedStep?.failureObservation,
    );
  });

  test("omits abort-consequence observations but retains the device failure", async () => {
    const observation = { capturedAtMs: 12, activeWindow: { appId: "fake.app" } };
    // Z has failed and is capturing evidence when A finishes and triggers abort.
    const result = await runInOrder(["Z", "A"], {
      strategy: "immediate",
      failureObservation: observation,
      holdFirstObservation: true,
    });
    expect(result.failedStep).toMatchObject({ device: "A", failureObservation: observation });
    expect(result.perDeviceResults?.get("Z")?.failedStep?.failureObservation).toBe(observation);
    expect(result.deviceFailures?.[1]).toEqual({
      device: "Z",
      stepIndex: 0,
      tool: toolName,
      error: "failure on Z",
    });
    expect(result.deviceFailures?.[1]).not.toHaveProperty("failureObservation");
  });

  test("pins a single-track partitioned plan", async () => {
    const plan = parallelPlan();
    plan.devices = ["Z"];
    plan.steps = [plan.steps[0]];
    const result = await runInOrder(["Z"], { plan });
    expect(result.failedStep).toMatchObject({ device: "Z", stepIndex: 0, error: "failure on Z" });
    expect(result.perDeviceResults?.size).toBe(1);
    expect(result).not.toHaveProperty("deviceFailures");
  });

  test("pins success with no reported failure", async () => {
    const result = await runInOrder(["A", "Z"], { successfulDevices: ["A", "Z"] });
    expect(result).toMatchObject({ success: true, executedSteps: 2, totalSteps: 2 });
    expect(result.failedStep).toBeUndefined();
    expect(result).not.toHaveProperty("deviceFailures");
    expect([...result.perDeviceResults!.values()].every((track) => track.success)).toBe(true);
  });
});

function failure(
  deviceOrder: number,
  stepIndex: number,
  abortConsequence = false,
): Parameters<typeof selectParallelFailure>[0][number] {
  return {
    failedStep: { device: ["Z", "A"][deviceOrder], stepIndex, tool: toolName, error: "failure" },
    deviceOrder,
    abortConsequence,
  };
}

describe("selectParallelFailure", () => {
  test("returns undefined for success and preserves a single failure object", () => {
    expect(selectParallelFailure([])).toBeUndefined();
    const only = failure(1, 4);
    expect(selectParallelFailure([only])).toBe(only.failedStep);
  });

  for (const reverse of [false, true]) {
    test(`orders real indexes before sentinel, then device order (reverse=${reverse})`, () => {
      const early = failure(1, 2);
      const tieWinner = failure(0, 2);
      const late = failure(0, 8);
      const sentinel = failure(0, -1);
      const candidates = [sentinel, late, early, tieWinner];
      if (reverse) {
        candidates.reverse();
      }
      const snapshot = [...candidates];
      expect(selectParallelFailure(candidates)).toBe(tieWinner.failedStep);
      expect(candidates).toEqual(snapshot);
    });

    for (const siblingIndex of [-1, 0]) {
      test(`excludes abort consequence at index ${siblingIndex} (reverse=${reverse})`, () => {
        const cause = failure(1, 5);
        const sibling = failure(0, siblingIndex, true);
        const candidates = reverse ? [cause, sibling] : [sibling, cause];
        expect(selectParallelFailure(candidates)).toBe(cause.failedStep);
      });
    }

    test(`an originating sentinel beats an aborted real index (reverse=${reverse})`, () => {
      const cause = failure(1, -1);
      const sibling = failure(0, 0, true);
      expect(selectParallelFailure(reverse ? [cause, sibling] : [sibling, cause])).toBe(
        cause.failedStep,
      );
    });

    test(`falls back to deterministic ordering when every failure is a consequence (reverse=${reverse})`, () => {
      const winner = failure(0, 2, true);
      const candidates = [failure(0, -1, true), failure(1, 2, true), winner];
      expect(selectParallelFailure(reverse ? candidates.reverse() : candidates)).toBe(
        winner.failedStep,
      );
    });

    test(`breaks sentinel-only ties by plan device order (reverse=${reverse})`, () => {
      const winner = failure(0, -1);
      const other = failure(1, -1);
      expect(selectParallelFailure(reverse ? [winner, other] : [other, winner])).toBe(
        winner.failedStep,
      );
    });
  }
});
