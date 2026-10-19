import { recordPlanCall } from "../../helpers/recordPlanCall";
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { ToolCallRecorder } from "../../../src/features/record/ToolCallRecorder";
import { logger } from "../../../src/utils/logger";
import { createSwipeAt } from "../../helpers/swipeAtCoordinate";
import type { BootedDevice } from "../../../src/models";
import type { SwipeAtRecordingContext } from "../../../src/models/SwipeAtOptions";

const device: BootedDevice = { deviceId: "swipe-rec", platform: "android", name: "Fake" };

function record(args: Record<string, unknown>) {
  const recorder = new ToolCallRecorder();
  recorder.start();
  recordPlanCall(recorder, "swipeAt", args);
  return recorder.stopWithWarnings();
}

describe("recorded swipeAt geometry (#12878)", () => {
  test("an absolute swipe is stored as fractions of the screen it was resolved against", async () => {
    const { swipeAt } = createSwipeAt(device, 1080, 2400);
    const recordingContext: SwipeAtRecordingContext = {};
    await swipeAt.execute(
      { from: { x: 540, y: 1200 }, to: { x: 108, y: 600 } },
      { recordingContext },
    );

    const { steps, warnings } = record({
      from: { x: 540, y: 1200 },
      to: { x: 108, y: 600 },
      snapshotId: "ephemeral",
      __swipeAtRecordingContext: recordingContext,
    });

    expect(steps).toEqual([
      {
        tool: "swipeAt",
        params: {
          from: { x: 0.5, y: 0.5 },
          to: { x: 0.1, y: 0.25 },
          coordinateSpace: "normalized",
        },
      },
    ]);
    expect(warnings).toEqual([]);
  });

  test("the recorded step replays proportionally on a rotated screen", async () => {
    const { steps } = record({
      from: { x: 540, y: 1200 },
      to: { x: 108, y: 600 },
      __swipeAtRecordingContext: { screenSize: { width: 1080, height: 2400 } },
    });
    const { swipeAt, swipes } = createSwipeAt(device, 2400, 1080);

    await swipeAt.execute(steps[0].params as never);

    expect(swipes).toHaveLength(1);
    expect(swipes[0].x1).toBeCloseTo(1200, -1);
    expect(swipes[0].y1).toBeCloseTo(540, -1);
    expect(swipes[0].x2).toBeCloseTo(240, -1);
    expect(swipes[0].y2).toBeCloseTo(270, -1);
  });

  test("an absolute swipe without a resolved screen keeps its pixels and warns", () => {
    const warn = spyOn(logger, "warn");
    try {
      const params = { from: { x: 540, y: 1200 }, to: { x: 108, y: 600 } };
      const { steps, warnings } = record({ ...params, __swipeAtRecordingContext: {} });

      expect(steps).toEqual([{ tool: "swipeAt", params }]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("swipeAt was recorded without geometry");
    } finally {
      warn.mockRestore();
    }
  });

  test("already-normalized and percent swipes are recorded unchanged without a warning", () => {
    const params = {
      from: { x: 0.2, y: 0.8 },
      to: { x: 0.2, y: 0.2 },
      coordinateSpace: "normalized",
    };
    const { steps, warnings } = record({ ...params, __swipeAtRecordingContext: {} });

    expect(steps).toEqual([{ tool: "swipeAt", params }]);
    expect(warnings).toEqual([]);
  });
});

describe("swipeAt recording context wiring (#12878)", () => {
  // Load the large module graphs outside the timed test; beforeAll is excluded from the budget.
  let dispatch: typeof import("../../../src/server/pipeline/deviceCallDispatch");
  let swipeAtTools: typeof import("../../../src/server/swipeAtTools");
  beforeAll(async () => {
    dispatch = await import("../../../src/server/pipeline/deviceCallDispatch");
    swipeAtTools = await import("../../../src/server/swipeAtTools");
  });

  test("the dispatcher hands swipeAt a fresh recording context the handler fills", async () => {
    const args = dispatch.deviceAwareHandlerArgs({}, {} as never, undefined, "swipeAt");
    expect(args.__swipeAtRecordingContext).toEqual({});

    const seen: unknown[] = [];
    const handler = swipeAtTools.createSwipeAtHandler({
      swipeAtFactory: () => ({
        execute: async (_options, call) => {
          seen.push(call?.recordingContext);
          return { success: true, x1: 1, y1: 2, x2: 3, y2: 4, duration: 1 };
        },
      }),
    });
    await handler(device, {
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
      __swipeAtRecordingContext: args.__swipeAtRecordingContext as SwipeAtRecordingContext,
    });
    expect(seen).toEqual([args.__swipeAtRecordingContext]);
  });
});
