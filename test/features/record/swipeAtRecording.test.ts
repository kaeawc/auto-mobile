import { describe, expect, spyOn, test } from "bun:test";
import { ToolCallRecorder } from "../../../src/features/record/ToolCallRecorder";
import type { SwipeAtRecordingContext } from "../../../src/models/SwipeAtOptions";
import type { BootedDevice } from "../../../src/models";
import { createSwipeAtHandler, swipeAtSchema } from "../../../src/server/swipeAtTools";
import { logger } from "../../../src/utils/logger";
import { cropSource } from "../../helpers/imageRelativePoint";
import { createSwipeAt } from "../../helpers/swipeAtCoordinate";

const android: BootedDevice = { deviceId: "swipe-record-a", platform: "android", name: "Android" };
const ios: BootedDevice = { deviceId: "swipe-record-i", platform: "ios", name: "iOS" };

describe("swipeAt fills its recording context", () => {
  test("with the resolved native endpoints and the screen they were resolved against", async () => {
    const { swipeAt } = createSwipeAt(android);
    const recordingContext: SwipeAtRecordingContext = {};

    await swipeAt.execute(
      { from: { x: 10.4, y: 20.6 }, to: { x: 50.5, y: 60.2 } },
      { recordingContext },
    );

    expect(recordingContext.recorded).toEqual({
      screenSize: { width: 100, height: 200 },
      from: { x: 10, y: 21 },
      to: { x: 51, y: 60 },
    });
  });

  test("keeps iOS points fractional", async () => {
    const { swipeAt } = createSwipeAt(ios);
    const recordingContext: SwipeAtRecordingContext = {};

    await swipeAt.execute(
      { from: { x: 10.4, y: 20.6 }, to: { x: 50.5, y: 60.2 } },
      { recordingContext },
    );

    expect(recordingContext.recorded).toMatchObject({ from: { x: 10.4, y: 20.6 } });
  });

  test("resolves percent and image-relative input to the same native points", async () => {
    const percent = createSwipeAt(android);
    const percentContext: SwipeAtRecordingContext = {};
    await percent.swipeAt.execute(
      { from: { x: 10, y: 10 }, to: { x: 90, y: 50 }, coordinateSpace: "percent" },
      { recordingContext: percentContext },
    );
    const source = await cropSource(
      { platform: "android", screenSize: { width: 100, height: 200 } },
      { width: 100, height: 200 },
      { left: 0, top: 0, right: 100, bottom: 200 },
    );
    const image = createSwipeAt(android);
    const imageContext: SwipeAtRecordingContext = {};
    await image.swipeAt.execute(
      { image: { unit: "normalized", source, from: { x: 0.1, y: 0.1 }, to: { x: 0.9, y: 0.5 } } },
      { recordingContext: imageContext },
    );

    expect(percentContext.recorded?.from).toEqual({ x: 10, y: 20 });
    expect(percentContext.recorded?.to).toEqual({ x: 90, y: 100 });
    expect(imageContext.recorded).toEqual(percentContext.recorded);
  });

  test("and leaves it empty when the swipe is refused before dispatch", async () => {
    const { swipeAt, swipes } = createSwipeAt(android);
    const recordingContext: SwipeAtRecordingContext = {};

    const result = await swipeAt.execute(
      { from: { x: 10, y: 20 }, to: { x: 500, y: 20 } },
      { recordingContext },
    );

    expect(result.success).toBe(false);
    expect(swipes).toEqual([]);
    expect(recordingContext.recorded).toBeUndefined();
  });
});

describe("the swipeAt handler", () => {
  test("hands the registry's recording context to the action", async () => {
    const calls: Array<{ recordingContext?: SwipeAtRecordingContext }> = [];
    const handler = createSwipeAtHandler({
      swipeAtFactory: () => ({
        execute: async (_options, call) => {
          calls.push({ recordingContext: call?.recordingContext });
          return { success: true, x1: 1, y1: 2, x2: 3, y2: 4, duration: 300 };
        },
      }),
    });
    const recordingContext: SwipeAtRecordingContext = {};

    await handler(android, {
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
      __swipeAtRecordingContext: recordingContext,
    });

    expect(calls[0].recordingContext).toBe(recordingContext);
  });

  test("does not advertise the internal recording context", () => {
    const parsed = swipeAtSchema.safeParse({
      platform: "android",
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
      __swipeAtRecordingContext: {},
    });

    expect(parsed.success).toBe(false);
  });
});

describe("recording a swipeAt tool call", () => {
  const recorded = {
    screenSize: { width: 1080, height: 2400 },
    from: { x: 108, y: 480 },
    to: { x: 972, y: 1680 },
  };

  function record(args: Record<string, unknown>) {
    const recorder = new ToolCallRecorder();
    recorder.start();
    recorder.record("swipeAt", args);
    return recorder.stopWithWarnings();
  }

  test("persists fractions of the screen, so replay adapts to another size", () => {
    const { steps, warnings } = record({
      platform: "android",
      from: { x: 108, y: 480 },
      to: { x: 972, y: 1680 },
      snapshotId: "ephemeral",
      __swipeAtRecordingContext: { recorded },
    });

    expect(warnings).toEqual([]);
    expect(steps).toEqual([
      {
        tool: "swipeAt",
        params: {
          from: { x: 0.1, y: 0.2 },
          to: { x: 0.9, y: 0.7 },
          coordinateSpace: "normalized",
        },
      },
    ]);
  });

  test("normalizes percent and image input too, dropping the image source", () => {
    const { steps } = record({
      image: {
        unit: "normalized",
        source: { screenshot: {} },
        from: { x: 1, y: 1 },
        to: { x: 2, y: 2 },
      },
      __swipeAtRecordingContext: { recorded },
    });

    expect(steps[0].params).toEqual({
      from: { x: 0.1, y: 0.2 },
      to: { x: 0.9, y: 0.7 },
      coordinateSpace: "normalized",
    });
  });

  test("keeps speed and layer", () => {
    const { steps } = record({
      from: { x: 1, y: 1 },
      to: { x: 2, y: 2 },
      speed: "fast",
      layer: "app",
      __swipeAtRecordingContext: { recorded },
    });

    expect(steps[0].params).toMatchObject({ speed: "fast", layer: "app" });
  });

  test("a digitizer-edge endpoint stays a valid fraction", () => {
    const { steps } = record({
      from: { x: 1, y: 1 },
      to: { x: 2, y: 2 },
      __swipeAtRecordingContext: {
        recorded: { ...recorded, from: { x: 1079, y: 2399 }, to: { x: 0, y: 0 } },
      },
    });

    const { from, to } = steps[0].params as { from: { x: number; y: number }; to: unknown };
    expect(from.x).toBeLessThanOrEqual(1);
    expect(from.y).toBeLessThanOrEqual(1);
    expect(to).toEqual({ x: 0, y: 0 });
  });

  test("a call that never resolved its geometry keeps its params and warns", () => {
    const warn = spyOn(logger, "warn");
    try {
      const params = { from: { x: 108, y: 480 }, to: { x: 972, y: 1680 } };
      const { steps, warnings } = record({ ...params, __swipeAtRecordingContext: {} });

      expect(steps).toEqual([{ tool: "swipeAt", params }]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("swipeAt was recorded without screen geometry");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("without screen geometry"));
    } finally {
      warn.mockRestore();
    }
  });

  test("a recorded step replays proportionally on a screen of another size", async () => {
    const { steps } = record({
      from: { x: 108, y: 480 },
      to: { x: 972, y: 1680 },
      __swipeAtRecordingContext: { recorded },
    });
    const parsed = swipeAtSchema.parse({ platform: "android", ...steps[0].params });
    const { swipeAt, swipes } = createSwipeAt(android, 540, 1200);

    const result = await swipeAt.execute({
      from: parsed.from!,
      to: parsed.to!,
      coordinateSpace: parsed.coordinateSpace,
    });

    expect(result.success).toBe(true);
    expect(swipes.map(({ x1, y1, x2, y2 }) => [x1, y1, x2, y2])).toEqual([[54, 240, 486, 840]]);
  });
});
