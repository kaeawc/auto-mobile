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

function observation(width: number, height: number, frameContext = "frame-123"): ObserveResult {
  return {
    observationId: "test-observation",
    timestamp: 1,
    screenSize: { width, height },
    viewHierarchy: { hierarchy: { node: {} }, frameContext },
  } as ObserveResult;
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

  test.each([
    { x: 10, y: 0, label: "right edge" },
    { x: 0, y: 10, label: "bottom edge" },
    { x: -1, y: 0, label: "negative x" },
    { x: 0, y: -1, label: "negative y" },
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
});
