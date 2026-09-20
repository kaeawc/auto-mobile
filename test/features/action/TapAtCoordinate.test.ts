import { describe, expect, test } from "bun:test";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import type { CoordinateTapClient } from "../../../src/features/action/coordinateTapDispatch";
import { dispatchAndroidCoordinateTap } from "../../../src/features/action/coordinateTapDispatch";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

const androidDevice = {
  name: "Android test device",
  platform: "android",
  deviceId: "emulator-5554",
} as BootedDevice;

const iosDevice = {
  name: "iOS test device",
  platform: "ios",
  deviceId: "ios-test-device",
} as BootedDevice;

function observation(
  width: number,
  height: number,
  frameContext = "frame-123",
  rotation = 0,
  node: Record<string, unknown> = {},
): ObserveResult {
  return {
    observationId: "test-observation",
    timestamp: 1,
    screenSize: { width, height },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    rotation,
    viewHierarchy: {
      hierarchy: { node },
      frameContext,
      rotation,
      screenWidth: width,
      screenHeight: height,
    },
  } as ObserveResult;
}

function createAndroidTapAtWithClient(
  observations: ObserveResult[],
  androidClient: CoordinateTapClient,
) {
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveSequence(observations);
  const adb = new FakeAdbExecutor();
  const tapAt = new TapAtCoordinate(androidDevice, adb, {
    timer: new FakeTimer(),
    androidClient,
    iosClient: androidClient,
  });
  tapAt.observeScreen = observeScreen;
  return { tapAt, observeScreen, adb };
}

function createTapAt(device: BootedDevice, width = 10, height = 10) {
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(observation(width, height));
  const androidDispatches: Array<{ x: number; y: number; frameContext?: string }> = [];
  const iosDispatches: Array<{ x: number; y: number; frameContext?: string }> = [];
  const unusedClient: CoordinateTapClient = {
    requestTapCoordinates: async () => ({ success: true }),
  };
  const tapAt = new TapAtCoordinate(device, new FakeAdbExecutor(), {
    timer: new FakeTimer(),
    androidClient: unusedClient,
    iosClient: unusedClient,
    dispatchAndroidCoordinateTap: async (_client, _adb, x, y, _duration, frameContext) => {
      androidDispatches.push({ x, y, frameContext });
    },
    dispatchIosCoordinateTap: async (_client, x, y, _duration, frameContext) => {
      iosDispatches.push({ x, y, frameContext });
    },
  });
  tapAt.observeScreen = observeScreen;
  return { tapAt, observeScreen, androidDispatches, iosDispatches };
}

describe("TapAtCoordinate", () => {
  test("rounds Android coordinates before half-open validation and dispatches native pixels", async () => {
    const { tapAt, observeScreen, androidDispatches } = createTapAt(androidDevice);

    const result = await tapAt.execute({ x: 1.6, y: 2.5 });

    expect(result).toMatchObject({ success: true, x: 2, y: 3 });
    expect(androidDispatches).toEqual([{ x: 2, y: 3, frameContext: "frame-123" }]);
    expect(observeScreen.getGetMostRecentCachedObserveResultCallCount()).toBe(0);
    expect(observeScreen.getExecuteOptions()[0]?.skipWaitForFresh).toBeUndefined();
  });

  test("preserves iOS fractional XCTest points without scale or canonical-pixel conversion", async () => {
    const { tapAt, iosDispatches } = createTapAt(iosDevice);

    const result = await tapAt.execute({ x: 1.25, y: 2.75 });

    expect(result).toMatchObject({ success: true, x: 1.25, y: 2.75 });
    expect(iosDispatches).toEqual([{ x: 1.25, y: 2.75, frameContext: "frame-123" }]);
  });

  test("dispatches resolved Android pixels and iOS points byte-for-byte without daemon conversion (#7336 bullets 2 and 5)", async () => {
    const android = createTapAt(androidDevice, 1080, 2400);
    const androidResult = await android.tapAt.execute({ x: 640.6, y: 1200.4 });
    expect(androidResult).toMatchObject({ success: true, x: 641, y: 1200 });
    expect(android.androidDispatches).toEqual([{ x: 641, y: 1200, frameContext: "frame-123" }]);

    const ios = createTapAt(iosDevice, 393, 852);
    const iosResult = await ios.tapAt.execute({ x: 20.5, y: 68.33333333333333 });
    expect(iosResult).toMatchObject({ success: true, x: 20.5, y: 68.33333333333333 });
    expect(ios.iosDispatches).toEqual([
      { x: 20.5, y: 68.33333333333333, frameContext: "frame-123" },
    ]);
  });

  test("keeps iOS tapAt dispatch in logical points across scale metadata (#7336 bullet 4)", async () => {
    const { tapAt, observeScreen, iosDispatches } = createTapAt(iosDevice, 393, 852);
    const logicalPoint = { x: 20.5, y: 68.33333333333333 };
    const scaleMetadata = [
      { nativeScale: 2, screenScale: 2, pixelWidth: 786, pixelHeight: 1704 },
      { nativeScale: 3, screenScale: 3, pixelWidth: 1179, pixelHeight: 2556 },
      { nativeScale: 2.61, screenScale: 3, pixelWidth: 1026, pixelHeight: 2224 },
      { nativeScale: 2.88, screenScale: 3, pixelWidth: 1132, pixelHeight: 2454 },
    ];

    for (const metadata of scaleMetadata) {
      observeScreen.setObserveResult({
        ...observation(393, 852),
        viewHierarchy: { hierarchy: { node: {} }, frameContext: "frame-123", ...metadata },
      } as ObserveResult);
      await expect(tapAt.execute(logicalPoint)).resolves.toMatchObject({
        success: true,
        ...logicalPoint,
      });
    }

    expect(iosDispatches).toEqual(
      scaleMetadata.map(() => ({ ...logicalPoint, frameContext: "frame-123" })),
    );
  });

  test.each([
    // #7336 bullet 6: both native spaces reject all non-finite coordinates.
    { x: 10, y: 0, label: "right edge" },
    { x: 0, y: 10, label: "bottom edge" },
    { x: -1, y: 0, label: "negative x" },
    { x: 0, y: -1, label: "negative y" },
    { x: Number.NEGATIVE_INFINITY, y: 0, label: "negative Infinity" },
    { x: Number.NaN, y: 0, label: "NaN" },
    { x: 0, y: Number.POSITIVE_INFINITY, label: "Infinity" },
  ])("rejects Android $label without dispatch", async ({ x, y }) => {
    const { tapAt, androidDispatches } = createTapAt(androidDevice);

    const result = await tapAt.execute({ x, y });

    expect(result.success).toBe(false);
    expect(result.error).toContain("tapAt");
    expect(androidDispatches).toEqual([]);
  });

  test.each([
    { x: 10, y: 0, label: "right edge" },
    { x: 0, y: 10, label: "bottom edge" },
    { x: -0.01, y: 0, label: "negative x" },
    { x: 0, y: -0.01, label: "negative y" },
    { x: Number.NEGATIVE_INFINITY, y: 0, label: "negative Infinity" },
    { x: 0, y: Number.NaN, label: "NaN" },
    { x: Number.POSITIVE_INFINITY, y: 0, label: "Infinity" },
  ])("rejects iOS $label without dispatch", async ({ x, y }) => {
    const { tapAt, iosDispatches } = createTapAt(iosDevice);

    const result = await tapAt.execute({ x, y });

    expect(result.success).toBe(false);
    expect(result.error).toContain("tapAt");
    expect(iosDispatches).toEqual([]);
  });

  test("accepts both origins and last in-bounds coordinates in each native space", async () => {
    const android = createTapAt(androidDevice);
    await expect(android.tapAt.execute({ x: 0, y: 0 })).resolves.toMatchObject({ success: true });
    await expect(android.tapAt.execute({ x: 9.49, y: 9.49 })).resolves.toMatchObject({
      success: true,
      x: 9,
      y: 9,
    });

    const ios = createTapAt(iosDevice);
    await expect(ios.tapAt.execute({ x: 0, y: 0 })).resolves.toMatchObject({ success: true });
    await expect(ios.tapAt.execute({ x: 9.999, y: 9.999 })).resolves.toMatchObject({
      success: true,
      x: 9.999,
      y: 9.999,
    });
  });

  test.each([
    { width: 0, height: 10, label: "zero width" },
    { width: 10, height: 0, label: "zero height" },
    { width: -1, height: 10, label: "negative width" },
  ])("rejects $label screenSize without dispatch", async ({ width, height }) => {
    const { tapAt, androidDispatches } = createTapAt(androidDevice, width, height);

    const result = await tapAt.execute({ x: 0, y: 0 });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("positive screenSize"),
    });
    expect(androidDispatches).toEqual([]);
  });

  test("rejects an absent screenSize without dispatch", async () => {
    const { tapAt, observeScreen, androidDispatches } = createTapAt(androidDevice);
    observeScreen.setObserveResult({
      ...observation(10, 10),
      screenSize: undefined,
    } as ObserveResult);

    const result = await tapAt.execute({ x: 0, y: 0 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("positive screenSize");
    expect(androidDispatches).toEqual([]);
  });

  test("treats a stale frame-context rejection as terminal instead of falling back to ADB", async () => {
    const adb = new FakeAdbExecutor();
    const staleClient: CoordinateTapClient = {
      requestTapCoordinates: async () => ({
        success: false,
        error: "Stale frame context for input/tap; observe a fresh frame before retrying",
      }),
    };

    await expect(
      dispatchAndroidCoordinateTap(staleClient, adb, 1, 2, 10, "frame-123"),
    ).rejects.toThrow("Stale frame context");
    expect(adb.wasCommandExecuted("shell input touchscreen tap 1 2")).toBe(false);
  });

  test("re-observes and retries one Android stale-frame rejection when targeting layout is unchanged", async () => {
    const dispatches: Array<{ x: number; y: number; frameContext?: string }> = [];
    const client: CoordinateTapClient = {
      requestTapCoordinates: async (x, y, _duration, _timeout, _perf, frameContext) => {
        dispatches.push({ x, y, frameContext });
        return dispatches.length === 1
          ? {
              success: false,
              error: "Stale frame context for input/tap; observe a fresh frame before retrying",
            }
          : { success: true };
      },
    };
    const stableNode = {
      class: "android.widget.TextView",
      text: "Settings",
      bounds: { left: 0, top: 0, right: 100, bottom: 40 },
    };
    const initial = observation(100, 200, "epoch:1", 0, {
      ...stableNode,
      extras: { traversalIndex: 1 },
      "view-id": "capture-id-1",
    });
    const refreshed = observation(100, 200, "epoch:2", 0, {
      ...stableNode,
      extras: { traversalIndex: 2 },
      "view-id": "capture-id-2",
    });
    const { tapAt, observeScreen, adb } = createAndroidTapAtWithClient(
      [initial, refreshed],
      client,
    );

    const result = await tapAt.execute({ x: 20, y: 30 });

    expect(result).toMatchObject({ success: true, x: 20, y: 30 });
    expect(dispatches).toEqual([
      { x: 20, y: 30, frameContext: "epoch:1" },
      { x: 20, y: 30, frameContext: "epoch:2" },
    ]);
    expect(observeScreen.getExecuteCallCount()).toBe(3);
    expect(adb.wasCommandExecuted("shell input touchscreen tap 20 30")).toBe(false);
  });

  test.each([
    {
      label: "resize",
      refreshed: observation(101, 200, "epoch:2", 0, { text: "Settings" }),
    },
    {
      label: "rotation",
      refreshed: observation(100, 200, "epoch:2", 1, { text: "Settings" }),
    },
    {
      label: "navigation",
      refreshed: observation(100, 200, "epoch:2", 0, { text: "Network & internet" }),
    },
  ])("preserves stale rejection after a genuine Android $label", async ({ refreshed }) => {
    const dispatches: string[] = [];
    const client: CoordinateTapClient = {
      requestTapCoordinates: async (_x, _y, _duration, _timeout, _perf, frameContext) => {
        dispatches.push(frameContext ?? "missing");
        return {
          success: false,
          error: "Stale frame context for input/tap; observe a fresh frame before retrying",
        };
      },
    };
    const initial = observation(100, 200, "epoch:1", 0, { text: "Settings" });
    const { tapAt, observeScreen, adb } = createAndroidTapAtWithClient(
      [initial, refreshed],
      client,
    );

    const result = await tapAt.execute({ x: 20, y: 30 });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Stale frame context"),
    });
    expect(dispatches).toEqual(["epoch:1"]);
    expect(observeScreen.getExecuteCallCount()).toBe(2);
    expect(adb.wasCommandExecuted("shell input touchscreen tap 20 30")).toBe(false);
  });

  test("bounds Android stale-frame recovery to one retry", async () => {
    const dispatches: string[] = [];
    const client: CoordinateTapClient = {
      requestTapCoordinates: async (_x, _y, _duration, _timeout, _perf, frameContext) => {
        dispatches.push(frameContext ?? "missing");
        return {
          success: false,
          error: "Stale frame context for input/tap; observe a fresh frame before retrying",
        };
      },
    };
    const initial = observation(100, 200, "epoch:1", 0, { text: "Settings" });
    const refreshed = observation(100, 200, "epoch:2", 0, { text: "Settings" });
    const { tapAt, observeScreen } = createAndroidTapAtWithClient([initial, refreshed], client);

    const result = await tapAt.execute({ x: 20, y: 30 });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Stale frame context"),
    });
    expect(dispatches).toEqual(["epoch:1", "epoch:2"]);
    expect(observeScreen.getExecuteCallCount()).toBe(2);
  });
});
