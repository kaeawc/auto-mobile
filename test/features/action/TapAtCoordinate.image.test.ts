import { afterEach, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { SnapshotReferenceStore } from "../../../src/features/observe/SnapshotReferenceStore";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createTapAt, observation } from "../../helpers/tapAtCoordinate";
import { cropSource } from "../../helpers/imageRelativePoint";

const screenSize = { width: 100, height: 200 };
const bounds = { left: 10, top: 20, right: 60, bottom: 100 };
const devices: BootedDevice[] = [
  { deviceId: "image-android", platform: "android", name: "Fake Android" },
  { deviceId: "image-ios", platform: "ios", name: "Fake iOS" },
];
test.each([
  [1, 75],
  [3, 25],
] as const)(
  "native full screenshot rotation %s dispatches the corrected corner",
  async (rotation, y) => {
    const { tapAt, iosDispatches } = createTapAt(devices[1], 200, 100);
    expect(
      await tapAt.execute({
        image: {
          unit: "pixels",
          x: 75,
          y: 300,
          source: {
            screenshot: {
              screenSize: { width: 200, height: 100 },
              imageSize: { width: 300, height: 600 },
              screenshotOrientation: "native",
              rotation,
            },
          },
        },
      }),
    ).toMatchObject({ success: true, x: 100, y });
    expect(iosDispatches.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 100, y }]);
  },
);
afterEach(() => {
  for (const device of devices) {
    displayTransitions.reset(device.deviceId);
  }
});

test.each(devices)(
  "image crop shares tap / long press / double tap dispatch on $platform",
  async (device) => {
    const source = await cropSource(
      { platform: device.platform === "ios" ? "ios" : "android", screenSize },
      device.platform === "ios" ? { width: 300, height: 600 } : screenSize,
      bounds,
    );
    const { tapAt, androidDispatches, iosDispatches } = createTapAt(device, 100, 200);
    for (const action of ["tap", "longPress", "doubleTap"] as const) {
      expect(
        await tapAt.execute({ image: { unit: "normalized", x: 0.2, y: 0.5, source }, action }),
      ).toMatchObject({ success: true, x: 20, y: 60, action });
    }
    const dispatched = device.platform === "android" ? androidDispatches : iosDispatches;
    expect(dispatched.map(({ x, y }) => ({ x, y }))).toEqual(Array(4).fill({ x: 20, y: 60 }));
    expect(dispatched.map(({ duration }) => duration)).toEqual(
      device.platform === "android" ? [10, 1000, 10, 10] : [50, 1000, 50, 50],
    );
  },
);

test.each(devices)(
  "source screen-size changes fail before dispatch on $platform",
  async (device) => {
    const source = await cropSource(
      { platform: device.platform === "ios" ? "ios" : "android", screenSize },
      screenSize,
      bounds,
    );
    const { tapAt, androidDispatches, iosDispatches } = createTapAt(device, 101, 200);
    expect(
      await tapAt.execute({ image: { unit: "normalized", x: 0.2, y: 0.5, source } }),
    ).toMatchObject({
      success: false,
      x: 0.2,
      y: 0.5,
      error: expect.stringContaining("observe again"),
    });
    expect(androidDispatches).toEqual([]);
    expect(iosDispatches).toEqual([]);
  },
);

test.each(devices)(
  "snapshotId validation remains additive to image coordinates on $platform",
  async (device) => {
    const timer = new FakeTimer();
    const references = new SnapshotReferenceStore(
      timer,
      new CountingIdGenerator("image-reference"),
    );
    const captured = {
      ...observation(100, 200),
      display: { key: "main", role: "unknown" as const },
      displayRevision: 0,
    } as ObserveResult;
    const capture = references.capture(device.deviceId, captured);
    if (capture.status !== "captured") {
      throw new Error("Expected snapshot reference");
    }
    const { tapAt, observeScreen, androidDispatches, iosDispatches } = createTapAt(
      device,
      100,
      200,
      undefined,
      undefined,
      references,
    );
    observeScreen.setObserveResult(captured);
    const source = await cropSource(
      { platform: device.platform === "ios" ? "ios" : "android", screenSize },
      screenSize,
      bounds,
    );
    const options = {
      image: { unit: "normalized" as const, x: 0.2, y: 0.5, source },
      snapshotId: capture.reference.snapshotId,
    };
    expect(await tapAt.execute(options)).toMatchObject({ success: true, x: 20, y: 60 });
    timer.advanceTime(300_000);
    expect(await tapAt.execute(options)).toMatchObject({
      success: false,
      error: expect.stringContaining("expired"),
    });
    expect(androidDispatches.length + iosDispatches.length).toBe(1);
  },
);

test("Android rounding preserves the crop's final included raster pixel", async () => {
  const source = await cropSource({ platform: "android", screenSize }, screenSize, bounds);
  const { tapAt, androidDispatches } = createTapAt(devices[0], 100, 200);
  for (const point of [
    { unit: "normalized" as const, x: 1, y: 1 },
    { unit: "pixels" as const, x: 49.99, y: 79.99 },
  ]) {
    expect(await tapAt.execute({ image: { ...point, source } })).toMatchObject({
      success: true,
      x: 59,
      y: 99,
    });
  }
  expect(androidDispatches.map(({ x, y }) => ({ x, y }))).toEqual([
    { x: 59, y: 99 },
    { x: 59, y: 99 },
  ]);
});

test.each(["x", "y", "coordinateSpace"])(
  "runtime image plus %s is rejected before dispatch",
  async (field) => {
    const { tapAt, androidDispatches } = createTapAt(devices[0], 100, 200);
    const options = {
      image: {
        unit: "normalized" as const,
        x: 0.2,
        y: 0.5,
        source: { screenshot: { screenSize, screenshotOrientation: "display" as const } },
      },
    };
    // Exercise a malformed runtime client without weakening the public TypeScript union.
    Reflect.set(options, field, field === "coordinateSpace" ? "absolute" : 20);
    expect(await tapAt.execute(options)).toMatchObject({
      success: false,
      error: expect.stringContaining("mutually exclusive"),
    });
    expect(androidDispatches).toEqual([]);
  },
);
