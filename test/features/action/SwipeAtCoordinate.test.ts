import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { SnapshotReferenceStore } from "../../../src/features/observe/SnapshotReferenceStore";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeTimer } from "../../fakes/FakeTimer";
import { cropSource } from "../../helpers/imageRelativePoint";
import { createSwipeAt } from "../../helpers/swipeAtCoordinate";
import { observation } from "../../helpers/tapAtCoordinate";
import {
  capturedFloatingCoverHierarchy,
  observationOf,
} from "../../helpers/prototypeWindowCapture";

const androidDevice: BootedDevice = {
  deviceId: "swipe-at-android",
  platform: "android",
  name: "Fake Android",
};
const iosDevice: BootedDevice = {
  deviceId: "swipe-at-ios",
  platform: "ios",
  name: "Fake iOS",
};
const devices = [androidDevice, iosDevice];
const screenSize = { width: 100, height: 200 };

afterEach(() => {
  for (const device of devices) {
    displayTransitions.reset(device.deviceId);
  }
});

describe("swipeAt dispatch", () => {
  test.each(devices)("dispatches an axis-aligned swipe on $platform", async (device) => {
    const { swipeAt, swipes } = createSwipeAt(device);

    const result = await swipeAt.execute({ from: { x: 10, y: 20 }, to: { x: 10, y: 150 } });

    expect(result).toMatchObject({ success: true, x1: 10, y1: 20, x2: 10, y2: 150 });
    expect(swipes).toEqual([{ x1: 10, y1: 20, x2: 10, y2: 150, duration: 300 }]);
  });

  test.each(devices)("dispatches a diagonal swipe on $platform", async (device) => {
    const { swipeAt, swipes } = createSwipeAt(device);

    const result = await swipeAt.execute({ from: { x: 10, y: 20 }, to: { x: 80, y: 170 } });

    expect(result).toMatchObject({ success: true, x1: 10, y1: 20, x2: 80, y2: 170 });
    expect(swipes).toEqual([{ x1: 10, y1: 20, x2: 80, y2: 170, duration: 300 }]);
  });

  test("swipes right-to-left and bottom-to-top without reordering the points", async () => {
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    await swipeAt.execute({ from: { x: 90, y: 180 }, to: { x: 5, y: 10 } });

    expect(swipes).toEqual([{ x1: 90, y1: 180, x2: 5, y2: 10, duration: 300 }]);
  });

  test.each([
    ["slow", 600],
    ["normal", 300],
    ["fast", 100],
  ] as const)("maps speed %s to a %d ms gesture", async (speed, duration) => {
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    await swipeAt.execute({ from: { x: 10, y: 20 }, to: { x: 10, y: 150 }, speed });

    expect(swipes.map((swipe) => swipe.duration)).toEqual([duration]);
  });

  test.each(devices)("dispatches the exact durationMs on $platform", async (device) => {
    const { swipeAt, swipes } = createSwipeAt(device);

    const result = await swipeAt.execute({
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
      durationMs: 87,
    });

    expect(swipes).toEqual([{ x1: 10, y1: 20, x2: 10, y2: 150, duration: 87 }]);
    // 130 px over 87 ms.
    expect(result).toMatchObject({ success: true, duration: 87, velocityPxPerSecond: 1494 });
  });

  test("reports the speed-preset velocity too", async () => {
    const { swipeAt } = createSwipeAt(androidDevice);

    const result = await swipeAt.execute({ from: { x: 0, y: 0 }, to: { x: 30, y: 40 } });

    // 50 px over the 300 ms normal preset.
    expect(result.velocityPxPerSecond).toBe(167);
  });

  test.each([
    [{ durationMs: 100, speed: "fast" as const }, "cannot be combined with speed"],
    [{ durationMs: 0 }, "integer from 1 to 3000"],
    [{ durationMs: 3001 }, "integer from 1 to 3000"],
    [{ durationMs: 1.5 }, "integer from 1 to 3000"],
  ])("rejects %j before observing or dispatching", async (extra, message) => {
    const { swipeAt, observeScreen, swipes } = createSwipeAt(androidDevice);

    const result = await swipeAt.execute({
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
      ...extra,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain(message);
    expect(swipes).toEqual([]);
    expect(observeScreen.getExecuteCallCount()).toBe(0);
    expect(observeScreen.getGetMostRecentCachedObserveResultCallCount()).toBe(0);
  });

  test("reports a failed dispatch without claiming the swipe happened", async () => {
    const { swipeAt, gesture } = createSwipeAt(androidDevice);
    gesture.failWith = "injection refused";

    const result = await swipeAt.execute({ from: { x: 10, y: 20 }, to: { x: 10, y: 150 } });

    expect(result).toMatchObject({
      success: false,
      x1: 10,
      y1: 20,
      x2: 10,
      y2: 150,
      error: expect.stringContaining("injection refused"),
    });
  });
});

describe("swipeAt coordinate spaces", () => {
  test("converts normalized points against the observed screen size", async () => {
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    const result = await swipeAt.execute({
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.9, y: 0.5 },
      coordinateSpace: "normalized",
    });

    expect(result).toMatchObject({ success: true, x1: 10, y1: 20, x2: 90, y2: 100 });
    expect(swipes.map(({ x1, y1, x2, y2 }) => [x1, y1, x2, y2])).toEqual([[10, 20, 90, 100]]);
  });

  test("converts percent points against the observed screen size", async () => {
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    await swipeAt.execute({
      from: { x: 10, y: 10 },
      to: { x: 90, y: 50 },
      coordinateSpace: "percent",
    });

    expect(swipes.map(({ x1, y1, x2, y2 }) => [x1, y1, x2, y2])).toEqual([[10, 20, 90, 100]]);
  });

  test("keeps absolute as the default space", async () => {
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    await swipeAt.execute({
      from: { x: 10, y: 20 },
      to: { x: 50, y: 60 },
      coordinateSpace: "absolute",
    });

    expect(swipes.map(({ x1, y1, x2, y2 }) => [x1, y1, x2, y2])).toEqual([[10, 20, 50, 60]]);
  });

  test("rounds Android points to whole pixels and leaves iOS points fractional", async () => {
    const android = createSwipeAt(androidDevice);
    const ios = createSwipeAt(iosDevice);
    const options = { from: { x: 10.4, y: 20.6 }, to: { x: 50.5, y: 60.2 } };

    await android.swipeAt.execute(options);
    await ios.swipeAt.execute(options);

    expect(android.swipes.map(({ x1, y1, x2, y2 }) => [x1, y1, x2, y2])).toEqual([
      [10, 21, 51, 60],
    ]);
    expect(ios.swipes.map(({ x1, y1, x2, y2 }) => [x1, y1, x2, y2])).toEqual([
      [10.4, 20.6, 50.5, 60.2],
    ]);
  });

  test.each([
    ["normalized", { x: 1.5, y: 0.5 }],
    ["normalized", { x: 0.5, y: -0.1 }],
    ["percent", { x: 50, y: 101 }],
  ] as const)("rejects an out-of-range %s point before dispatch", async (space, bad) => {
    for (const endpoint of ["from", "to"] as const) {
      const { swipeAt, swipes } = createSwipeAt(androidDevice);
      const good = { x: 0.2, y: 0.2 };
      const options =
        endpoint === "from"
          ? { from: bad, to: good, coordinateSpace: space }
          : { from: good, to: bad, coordinateSpace: space };

      const result = await swipeAt.execute(options);

      expect(result.success).toBe(false);
      expect(result.error).toContain("swipeAt");
      expect(result.error).toContain(space);
      expect(swipes).toEqual([]);
    }
  });
});

describe("swipeAt bounds", () => {
  test.each([
    ["from beyond the right edge", { from: { x: 100, y: 50 }, to: { x: 10, y: 50 } }],
    ["to beyond the bottom edge", { from: { x: 10, y: 50 }, to: { x: 10, y: 200 } }],
    ["from at a negative coordinate", { from: { x: -1, y: 50 }, to: { x: 10, y: 60 } }],
    ["to at a negative coordinate", { from: { x: 10, y: 50 }, to: { x: 10, y: -5 } }],
  ])("rejects a swipe with %s before dispatch", async (_label, options) => {
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    const result = await swipeAt.execute(options);

    expect(result.success).toBe(false);
    expect(result.error).toContain("swipeAt");
    expect(result.error).toContain("outside screen bounds");
    expect(swipes).toEqual([]);
  });

  test("accepts the last on-screen pixel on both ends", async () => {
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    const result = await swipeAt.execute({ from: { x: 0, y: 0 }, to: { x: 99, y: 199 } });

    expect(result.success).toBe(true);
    expect(swipes).toHaveLength(1);
  });

  test("rejects a zero-length swipe, which would be a tap", async () => {
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    const result = await swipeAt.execute({ from: { x: 30, y: 40 }, to: { x: 30, y: 40 } });

    expect(result.success).toBe(false);
    expect(result.error).toContain("same point");
    expect(swipes).toEqual([]);
  });

  test("rejects points that collapse to the same pixel after Android rounding", async () => {
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    const result = await swipeAt.execute({ from: { x: 30.1, y: 40.1 }, to: { x: 30.4, y: 40.4 } });

    expect(result.success).toBe(false);
    expect(result.error).toContain("same point");
    expect(swipes).toEqual([]);
  });

  test("refuses to dispatch without a positive observed screen size", async () => {
    const { swipeAt, observeScreen, swipes } = createSwipeAt(androidDevice);
    observeScreen.setObserveResult(observation(0, 0));

    const result = await swipeAt.execute({ from: { x: 1, y: 1 }, to: { x: 2, y: 2 } });

    expect(result.success).toBe(false);
    expect(result.error).toContain("screenSize");
    expect(swipes).toEqual([]);
  });

  test("rejects non-finite coordinates", async () => {
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    const result = await swipeAt.execute({ from: { x: Number.NaN, y: 1 }, to: { x: 2, y: 2 } });

    expect(result.success).toBe(false);
    expect(result.error).toContain("finite");
    expect(swipes).toEqual([]);
  });
});

describe("swipeAt snapshotId", () => {
  function capture(references: SnapshotReferenceStore, device: BootedDevice) {
    const captured = {
      ...observation(100, 200),
      display: { key: "main", role: "unknown" as const },
      displayRevision: 0,
    } as ObserveResult;
    const result = references.capture(device.deviceId, captured);
    if (result.status !== "captured") {
      throw new Error("Snapshot reference unavailable");
    }
    return { captured, snapshotId: result.reference.snapshotId };
  }

  test.each(devices)(
    "dispatches a swipe bound to a current snapshot on $platform",
    async (device) => {
      const references = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator("s"));
      const { captured, snapshotId } = capture(references, device);
      const { swipeAt, observeScreen, swipes } = createSwipeAt(device, 100, 200, references);
      observeScreen.setObserveResult(captured);

      const result = await swipeAt.execute({
        from: { x: 10, y: 20 },
        to: { x: 60, y: 120 },
        snapshotId,
      });

      expect(result.success).toBe(true);
      expect(swipes).toHaveLength(1);
    },
  );

  test.each(devices)(
    "rejects a changed snapshot layout before a swipe on $platform",
    async (device) => {
      const references = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
      const { captured, snapshotId } = capture(references, device);
      const { swipeAt, observeScreen, swipes } = createSwipeAt(device, 100, 200, references);
      observeScreen.setObserveResult({
        ...captured,
        viewHierarchy: {
          ...captured.viewHierarchy!,
          hierarchy: { node: { bounds: { left: 0, top: 0, right: 90, bottom: 90 } } },
        },
      });
      const result = await swipeAt.execute({
        from: { x: 10, y: 20 },
        to: { x: 60, y: 120 },
        snapshotId,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        "Snapshot reference is stale (tap-targeting layout changed); re-observe.",
      );
      expect(swipes).toEqual([]);
    },
  );

  test("rejects an expired snapshot before dispatch", async () => {
    const timer = new FakeTimer();
    const references = new SnapshotReferenceStore(timer, new CountingIdGenerator("s"));
    const { captured, snapshotId } = capture(references, androidDevice);
    timer.advanceTime(300_000);
    const { swipeAt, observeScreen, swipes } = createSwipeAt(androidDevice, 100, 200, references);
    observeScreen.setObserveResult(captured);

    const result = await swipeAt.execute({
      from: { x: 10, y: 20 },
      to: { x: 60, y: 120 },
      snapshotId,
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining("expired") });
    expect(swipes).toEqual([]);
  });

  test("rejects an unknown snapshot before dispatch", async () => {
    const references = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator("s"));
    const { swipeAt, swipes } = createSwipeAt(androidDevice, 100, 200, references);

    const result = await swipeAt.execute({
      from: { x: 10, y: 20 },
      to: { x: 60, y: 120 },
      snapshotId: "missing-snapshot",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(swipes).toEqual([]);
  });

  test("rejects a snapshot whose screen geometry changed since observe", async () => {
    const references = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator("s"));
    const { captured, snapshotId } = capture(references, androidDevice);
    const { swipeAt, observeScreen, swipes } = createSwipeAt(androidDevice, 100, 200, references);
    observeScreen.setObserveResult({
      ...observation(200, 100, "frame-123", 1),
      display: captured.display,
      displayRevision: 0,
    } as ObserveResult);

    const result = await swipeAt.execute({
      from: { x: 10, y: 20 },
      to: { x: 60, y: 90 },
      snapshotId,
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining("stale") });
    expect(swipes).toEqual([]);
  });
});

describe("swipeAt image-relative points", () => {
  const bounds = { left: 10, top: 20, right: 60, bottom: 100 };

  test.each(devices)("resolves normalized crop-relative endpoints on $platform", async (device) => {
    const source = await cropSource(
      { platform: device.platform === "ios" ? "ios" : "android", screenSize },
      device.platform === "ios" ? { width: 300, height: 600 } : screenSize,
      bounds,
    );
    const { swipeAt, swipes } = createSwipeAt(device);

    const result = await swipeAt.execute({
      image: { unit: "normalized", source, from: { x: 0.2, y: 0.5 }, to: { x: 0.8, y: 0.25 } },
    });

    // Crop is 50x80 at (10,20): (0.2,0.5) -> (20,60), (0.8,0.25) -> (50,40).
    expect(result).toMatchObject({ success: true, x1: 20, y1: 60, x2: 50, y2: 40 });
    expect(swipes.map(({ x1, y1, x2, y2 }) => [x1, y1, x2, y2])).toEqual([[20, 60, 50, 40]]);
  });

  test("resolves pixel crop-relative endpoints", async () => {
    const source = await cropSource({ platform: "android", screenSize }, screenSize, bounds);
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    await swipeAt.execute({
      image: { unit: "pixels", source, from: { x: 10, y: 10 }, to: { x: 30, y: 70 } },
    });

    expect(swipes.map(({ x1, y1, x2, y2 }) => [x1, y1, x2, y2])).toEqual([[20, 30, 40, 90]]);
  });

  test("rejects an image swipe combined with outer coordinates", async () => {
    const source = await cropSource({ platform: "android", screenSize }, screenSize, bounds);
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    const result = await swipeAt.execute({
      image: { unit: "normalized", source, from: { x: 0.2, y: 0.5 }, to: { x: 0.8, y: 0.25 } },
      from: { x: 1, y: 1 },
      to: { x: 5, y: 5 },
    } as never);

    expect(result.success).toBe(false);
    expect(result.error).toContain("mutually exclusive");
    expect(swipes).toEqual([]);
  });

  test("rejects an image endpoint outside the screen", async () => {
    const source = await cropSource({ platform: "android", screenSize }, screenSize, bounds);
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    const result = await swipeAt.execute({
      image: { unit: "normalized", source, from: { x: 0.2, y: 0.5 }, to: { x: 5, y: 0.25 } },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("swipeAt image");
    expect(result.error).not.toContain("tapAt");
    expect(swipes).toEqual([]);
  });

  test("requires both a from and a to point without image", async () => {
    const { swipeAt, swipes } = createSwipeAt(androidDevice);

    const result = await swipeAt.execute({ from: { x: 1, y: 1 } } as never);

    expect(result.success).toBe(false);
    expect(result.error).toContain("from and to");
    expect(swipes).toEqual([]);
  });
});

describe("swipeAt layer", () => {
  // Device capture (API 36, 1080x2400): the floating prototype window spans [525,1565][1011,1723].
  const INSIDE_FLOATING = { x: 768, y: 1644 };
  const APP_ONLY = { x: 100, y: 400 };

  function over() {
    const harness = createSwipeAt(androidDevice, 1080, 2400);
    harness.observeScreen.setObserveResult({
      ...observationOf(capturedFloatingCoverHierarchy()),
      screenSize: { width: 1080, height: 2400 },
    });
    return harness;
  }

  test('"app" refuses before dispatch when the prototype covers where the finger goes down', async () => {
    const { swipeAt, swipes } = over();

    const result = await swipeAt.execute({
      from: INSIDE_FLOATING,
      to: { x: 768, y: 900 },
      layer: "app",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot swipe at (768, 1644) with layer "app"');
    expect(swipes).toEqual([]);
  });

  test('"app" decides ownership from the from point, not the to point', async () => {
    const { swipeAt, swipes } = over();

    const result = await swipeAt.execute({ from: APP_ONLY, to: INSIDE_FLOATING, layer: "app" });

    expect(result.error).toBeUndefined();
    expect(swipes).toHaveLength(1);
  });

  test('"prototype" refuses a from point the prototype does not cover', async () => {
    const { swipeAt, swipes } = over();

    const result = await swipeAt.execute({
      from: APP_ONLY,
      to: INSIDE_FLOATING,
      layer: "prototype",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no AutoMobile prototype window covers that point");
    expect(swipes).toEqual([]);
  });

  test("omitting layer dispatches regardless of what the from point lies under", async () => {
    const { swipeAt, swipes } = over();

    const result = await swipeAt.execute({ from: INSIDE_FLOATING, to: { x: 768, y: 900 } });

    expect(result.error).toBeUndefined();
    expect(swipes).toHaveLength(1);
  });
});

describe("swipeAt display fence", () => {
  const stamped = (): ObserveResult =>
    ({
      ...observation(100, 200),
      displayRevision: 41,
      display: { key: "inner", role: "inner", posture: "opened", generation: 7 },
    }) as ObserveResult;

  function fenced(callerKnowsRevision = true) {
    const transitions = new FakeDisplayTransitionReader();
    const harness = createSwipeAt(androidDevice, 100, 200, undefined, {
      displayTransitions: transitions,
      renderedDisplayRevision: () => (callerKnowsRevision ? 41 : undefined),
      renderedDisplayGeneration: () => (callerKnowsRevision ? 7 : undefined),
    });
    harness.observeScreen.setObserveResult(stamped());
    return { ...harness, transitions };
  }

  const staleResult = {
    success: false,
    staleDisplay: {
      observedGeneration: 7,
      currentGeneration: 8,
      currentDisplayKey: "cover",
      retry: "observe",
    },
    error: expect.stringContaining("Display changed since these coordinates were chosen"),
  };

  test("a display change since the caller observed returns a typed stale-display failure", async () => {
    const { swipeAt, swipes, transitions } = fenced();
    transitions.transition();

    const result = await swipeAt.execute({ from: { x: 10, y: 20 }, to: { x: 60, y: 120 } });

    expect(result).toMatchObject({ ...staleResult, x1: 10, y1: 20, x2: 60, y2: 120 });
    expect(swipes).toEqual([]);
  });

  test("a display change while the pre-dispatch observation is read refuses before dispatch", async () => {
    const { swipeAt, observeScreen, swipes, transitions } = fenced();
    const read = observeScreen.execute.bind(observeScreen);
    observeScreen.execute = async (options) => {
      const observed = await read(options);
      transitions.transition();
      return observed;
    };

    const result = await swipeAt.execute({ from: { x: 10, y: 20 }, to: { x: 60, y: 120 } });

    expect(result).toMatchObject(staleResult);
    expect(swipes).toEqual([]);
  });

  test("the dispatch carries the in-flight display fence, so a late transition aborts it", async () => {
    const { swipeAt, swipes, fences, transitions } = fenced();
    const result = await swipeAt.execute({ from: { x: 10, y: 20 }, to: { x: 60, y: 120 } });

    expect(result.success).toBe(true);
    expect(swipes).toHaveLength(1);
    expect(fences).toEqual([true]);
    expect(transitions.fullRevision).toBe(41);
  });

  test("an unchanged display dispatches normally", async () => {
    const { swipeAt, swipes } = fenced(false);

    const result = await swipeAt.execute({ from: { x: 10, y: 20 }, to: { x: 60, y: 120 } });

    expect(result.success).toBe(true);
    expect(swipes).toHaveLength(1);
  });
});

describe("swipeAt device lock (#4280)", () => {
  const locked = (secure: boolean) =>
    ({
      ...observation(100, 200),
      deviceLock: { locked: true, keyguardShowing: true, secure },
    }) as ObserveResult;

  test("a swipe on a locked keyguard still dispatches, but never reads as a clean success", async () => {
    const { swipeAt, observeScreen, swipes } = createSwipeAt(androidDevice);
    observeScreen.setObserveResult(locked(false));

    const result = await swipeAt.execute({ from: { x: 50, y: 180 }, to: { x: 50, y: 20 } });

    expect(swipes).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result).toMatchObject({
      deviceLock: { locked: true, keyguardShowing: true, secure: false },
      deviceLockWarning: expect.stringContaining("dismiss the keyguard"),
    });
  });

  test("a secure lock tells the agent to ask the user to unlock", async () => {
    const { swipeAt, observeScreen } = createSwipeAt(androidDevice);
    observeScreen.setObserveResult(locked(true));

    const result = await swipeAt.execute({ from: { x: 50, y: 180 }, to: { x: 50, y: 20 } });

    expect(result).toMatchObject({
      deviceLockWarning: expect.stringContaining("unlock the device"),
    });
  });

  test("an unlocked device carries no lock fields", async () => {
    const { swipeAt } = createSwipeAt(androidDevice);

    const result = await swipeAt.execute({ from: { x: 50, y: 180 }, to: { x: 50, y: 20 } });

    expect(result).not.toHaveProperty("deviceLock");
    expect(result).not.toHaveProperty("deviceLockWarning");
  });
});
