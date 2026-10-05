import { logger } from "../../../src/utils/logger";
import { resolveIosObserveRotation } from "../../../src/features/observe/iosObserveRotation";
import { createTapAt, observation, setFakeTapAtWindow } from "../../helpers/tapAtCoordinate";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeCryptoService } from "../../../src/utils/crypto";
import { getTempDir, TEMP_SUBDIRS } from "../../../src/utils/tempDir";
import { issue8379Hierarchy, issue8379SyntheticOutlier } from "../../fixtures/issue8379Hierarchy";
import {
  DOUBLE_TAP_GAP_MS,
  LONG_PRESS_MIN_MS,
  LONG_PRESS_MAX_MS,
} from "../../../src/features/action/tapAtGesture";
import { tapAtSchema } from "../../../src/server/interactionTools";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import type { CoordinateTapClient } from "../../../src/features/action/coordinateTapDispatch";
import { dispatchAndroidCoordinateTap } from "../../../src/features/action/coordinateTapDispatch";
import { computeFreshness } from "../../../src/features/observe/observationFreshness";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { ObservedAndroidDisplayCache } from "../../../src/features/observe/ObservationDisplay";
import { resolveGestureCtrlProxyTimeoutMs } from "../../../src/features/action/gestureTransportTimeout";
import type { RenderedObservationReader } from "../../../src/features/action/TargetDisplayAction";
import { extractHierarchyScreenSize } from "../../../src/features/observe/hierarchyScreenSize";
import { SnapshotReferenceStore } from "../../../src/features/observe/SnapshotReferenceStore";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import {
  loadAndroidHomeObserve,
  loadIosFractionalObserve,
} from "../../fixtures/observe/observeFixture";

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

function createAndroidTapAtWithClient(
  observations: ObserveResult[],
  androidClient: CoordinateTapClient,
  snapshotReferences?: SnapshotReferenceStore,
  lastRenderedObservation?: RenderedObservationReader,
) {
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveSequence(observations);
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  const tapAt = new TapAtCoordinate(androidDevice, adb, {
    timer,
    androidClient,
    iosClient: androidClient,
    snapshotReferences,
    lastRenderedObservation,
  });
  setFakeTapAtWindow(tapAt);
  tapAt.observeScreen = observeScreen;
  return { tapAt, observeScreen, adb, timer };
}

describe("TapAtCoordinate", () => {
  describe("device-lock annotation", () => {
    test.each([true, false])("matches the base annotation for secure=%s", async (secure) => {
      const deviceLock = { locked: true, keyguardShowing: true, secure };
      const before = { ...observation(10, 10), deviceLock };
      const { tapAt, observeScreen, adb, androidDispatches } = createTapAt(androidDevice);
      // A post-action unlock must not erase the action-start evidence.
      observeScreen.setObserveSequence([before, observation(10, 10)]);
      const timestampRead = spyOn(adb, "getDeviceTimestampMs");
      const lockRead = spyOn(adb, "getDeviceLock");
      const foregroundRead = spyOn(adb, "getForegroundApp");
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const result = await tapAt.execute({ x: 1, y: 2 });
        // Baseline counts recorded on the pre-fix source: no additional lock/device read.
        expect(observeScreen.getExecuteCallCount()).toBe(2);
        expect(observeScreen.getGetMostRecentCachedObserveResultCallCount()).toBe(0);
        expect(timestampRead).toHaveBeenCalledTimes(1);
        expect(lockRead).toHaveBeenCalledTimes(0);
        expect(foregroundRead).toHaveBeenCalledTimes(0);
        expect(adb.getExecutedCommands()).toEqual([]);
        expect(androidDispatches).toHaveLength(1);
        const actualWarnings = [...warn.mock.calls];
        warn.mockClear();
        const base = createTapAt(androidDevice);
        base.observeScreen.setObserveResult(before);
        const expected = await base.tapAt.observedInteraction(async () => ({ success: true }), {
          changeExpected: false,
          previousObservation: before,
        });
        expect(result.success).toBe(true);
        expect(result).toMatchObject({
          deviceLock,
          deviceLockWarning: expected.deviceLockWarning,
        });
        expect(actualWarnings).toEqual(warn.mock.calls);
        expect(actualWarnings).toHaveLength(1);
      } finally {
        timestampRead.mockRestore();
        lockRead.mockRestore();
        foregroundRead.mockRestore();
        warn.mockRestore();
      }
    });

    test.each([androidDevice, iosDevice])(
      "omits lock keys for unlocked Android / iOS: %s",
      async (device) => {
        const { tapAt, observeScreen } = createTapAt(device);
        observeScreen.setObserveResult({
          ...observation(10, 10),
          deviceLock: { locked: device.platform === "ios", keyguardShowing: true, secure: true },
        });
        const result = await tapAt.execute({ x: 1, y: 2 });
        expect(result.success).toBe(true);
        expect(Object.hasOwn(result, "deviceLock")).toBe(false);
        expect(Object.hasOwn(result, "deviceLockWarning")).toBe(false);
      },
    );

    test("explicit display retains the same annotation", async () => {
      const deviceLock = { locked: true, keyguardShowing: true, secure: true };
      const { tapAt, observeScreen } = createTapAt(
        androidDevice,
        10,
        10,
        undefined,
        undefined,
        undefined,
        undefined,
        () => ({ display: { key: "0" } }),
      );
      observeScreen.setObserveResult({
        ...observation(10, 10),
        display: { key: "0", role: "unknown", generation: 0 },
        deviceLock,
      });
      const result = await tapAt.execute({ x: 1, y: 2, display: "active" });
      expect(result).toMatchObject({
        success: true,
        deviceLock,
        deviceLockWarning: expect.stringContaining("PIN/pattern/password"),
      });
    });

    test.each(["stale snapshot", "invalid coordinates"])(
      "annotates returned %s failures like the base class",
      async (scenario) => {
        const deviceLock = { locked: true, keyguardShowing: true, secure: false };
        const { tapAt, observeScreen, androidDispatches } = createTapAt(androidDevice);
        observeScreen.setObserveResult({ ...observation(10, 10), deviceLock });
        const result = await tapAt.execute(
          scenario === "stale snapshot"
            ? { x: 1, y: 2, snapshotId: "missing-snapshot" }
            : { x: 100, y: 2 },
        );
        expect(result).toMatchObject({
          success: false,
          deviceLock,
          deviceLockWarning: expect.stringContaining("swipe lock"),
        });
        expect(androidDispatches).toHaveLength(0);
      },
    );

    test("retry retains initial pre-dispatch lock evidence", async () => {
      const deviceLock = { locked: true, keyguardShowing: true, secure: true };
      let calls = 0;
      const client: CoordinateTapClient = {
        requestTapCoordinates: async () =>
          ++calls === 1
            ? { success: false, error: "Stale frame context for input/tap" }
            : { success: true },
      };
      const { tapAt, observeScreen, adb, timer } = createAndroidTapAtWithClient(
        [
          { ...observation(10, 10, "epoch:1"), deviceLock },
          observation(10, 10, "epoch:2"),
          observation(10, 10, "epoch:3"),
        ],
        client,
      );
      timer.enableAutoAdvance();
      const result = await tapAt.execute({ x: 1, y: 2 });
      expect(result).toMatchObject({ success: true, deviceLock });
      expect(calls).toBe(2);
      expect(observeScreen.getExecuteCallCount()).toBe(3);
      expect(adb.getExecutedCommands()).toEqual([]);
    });
  });

  test.each(["tap", "doubleTap"] as const)(
    "%s ignores a poisoned persistent Android window cache",
    async (action) => {
      const previousDataDir = process.env.AUTOMOBILE_DATA_DIR;
      const dataDir = mkdtempSync(path.join(tmpdir(), "tap-at-window-cache-"));
      try {
        process.env.AUTOMOBILE_DATA_DIR = dataDir;
        const windowDir = getTempDir(TEMP_SUBDIRS.WINDOW);
        mkdirSync(windowDir, { recursive: true, mode: 0o700 });
        writeFileSync(
          path.join(windowDir, NodeCryptoService.generateCacheKey(androidDevice.deviceId)),
          JSON.stringify({
            appId: "com.example.app",
            activityName: "com.example.app.MainActivity",
            layoutSeqSum: 1,
          }),
          { mode: 0o600 },
        );
        const { tapAt, adb, androidDispatches } = createTapAt(androidDevice);
        expect(await tapAt.execute({ x: 1, y: 2, action })).toMatchObject({ success: true });
        expect(androidDispatches).toHaveLength(action === "doubleTap" ? 2 : 1);
        expect(adb.getExecutedCommands()).toEqual([]);
      } finally {
        if (previousDataDir === undefined) {
          delete process.env.AUTOMOBILE_DATA_DIR;
        } else {
          process.env.AUTOMOBILE_DATA_DIR = previousDataDir;
        }
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );

  test("Duo landscape bounds dispatch x=700 and reject exclusive edges", async () => {
    const { tapAt, iosDispatches } = createTapAt(iosDevice, 951, 669);
    expect((await tapAt.execute({ x: 700, y: 48 })).success).toBe(true);
    expect(iosDispatches).toHaveLength(1);
    for (const coordinates of [
      { x: 951, y: 0 },
      { x: 0, y: 669 },
    ]) {
      const result = await tapAt.execute(coordinates);
      expect(result.success).toBe(false);
      expect(result.error).toContain("outside screen bounds [0, 951) x [0, 669)");
    }
    expect(iosDispatches).toHaveLength(1);
  });

  test("captured Duo hierarchy yields a screenSize in which tapAt {700,48} dispatches", async () => {
    const screenSize = extractHierarchyScreenSize(issue8379Hierarchy([issue8379SyntheticOutlier]))!;
    const { tapAt, observeScreen, iosDispatches } = createTapAt(iosDevice);
    observeScreen.setObserveResult(observation(screenSize.width, screenSize.height));
    expect((await tapAt.execute({ x: 700, y: 48 })).success).toBe(true);
    for (const coordinates of [
      { x: 951, y: 0 },
      { x: 0, y: 669 },
    ]) {
      expect((await tapAt.execute(coordinates)).success).toBe(false);
    }
    expect(iosDispatches).toHaveLength(1);
  });

  test("single-panel portrait overflow rejects tapAt x=700", async () => {
    const root = { left: 0, top: 0, right: 393, bottom: 852 };
    const child = { left: 350, top: 100, right: 620, bottom: 380 };
    const screenSize = extractHierarchyScreenSize({
      hierarchy: { bounds: root, node: { bounds: root, node: [{ bounds: child }] } },
    });
    expect(screenSize).not.toBeNull();
    const { tapAt, observeScreen, iosDispatches } = createTapAt(iosDevice);
    observeScreen.setObserveResult(observation(screenSize!.width, screenSize!.height));
    const result = await tapAt.execute({ x: 700, y: 48 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("outside screen bounds [0, 393) x [0, 852)");
    expect(iosDispatches).toHaveLength(0);
  });
  test.each([androidDevice, iosDevice])("dispatches bounded long press on %s", async (device) => {
    const { tapAt, androidDispatches, iosDispatches } = createTapAt(device, 100, 200);
    const result = await tapAt.execute({ x: 50, y: 100, action: "longPress", durationMs: 750 });
    expect(result).toMatchObject({ success: true, action: "longPress", x: 50, y: 100 });
    const dispatches = device.platform === "android" ? androidDispatches : iosDispatches;
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.duration).toBe(750);
  });

  test.each([androidDevice, iosDevice])(
    "double taps with a fake 200ms interval on %s",
    async (device) => {
      const { tapAt, androidDispatches, iosDispatches, timer } = createTapAt(device, 100, 200);
      const start = timer.now();
      const result = await tapAt.execute({ x: 10, y: 20, action: "doubleTap" });
      expect(result).toMatchObject({ success: true, action: "doubleTap" });
      const dispatches = device.platform === "android" ? androidDispatches : iosDispatches;
      expect(dispatches).toHaveLength(2);
      expect(dispatches.map(({ x, y }) => [x, y])).toEqual([
        [10, 20],
        [10, 20],
      ]);
      expect(timer.now() - start).toBe(DOUBLE_TAP_GAP_MS);
    },
  );

  test.each(
    [
      { device: androidDevice, display: undefined, route: "Android" },
      { device: iosDevice, display: undefined, route: "iOS default" },
      { device: iosDevice, display: "active", route: "iOS explicit" },
    ].flatMap((route) =>
      ["advance", "static", "second failure", "first stale", "cancel", "display change"].map(
        (scenario) => ({ ...route, scenario }),
      ),
    ),
  )("double-tap frame safety: $route / $scenario", async ({ device, display, scenario }) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const controller = new AbortController();
    const adb = new FakeAdbExecutor();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult({
      ...observation(100, 200, "epoch:7"),
      display: { key: "0", role: "unknown", generation: 0 },
    });
    let current = scenario === "first stale" ? "epoch:8" : "epoch:7";
    let delivered = 0;
    const sent: Array<string | undefined> = [];
    const client: CoordinateTapClient<() => void> = {
      requestTapCoordinates: async (
        _x,
        _y,
        _duration,
        _timeout,
        _perf,
        frameContext,
        onDispatch,
      ) => {
        sent.push(frameContext);
        onDispatch?.();
        if (frameContext !== undefined && frameContext !== current) {
          return { success: false, error: "Stale frame context for input/tap" };
        }
        if (sent.length === 2 && scenario === "second failure") {
          return { success: false, error: "Synthetic second tap failure" };
        }
        delivered++;
        if (scenario !== "static") {
          current = `epoch:${7 + delivered}`;
        }
        if (scenario === "display change") {
          displayTransitions.notifyTransition(device.deviceId, "changed after first tap");
        }
        return { success: true };
      },
    };
    const tapAt = new TapAtCoordinate(device, adb, {
      timer,
      androidClient: client,
      iosClient: client,
      invalidateIosCache: () => {},
      lastRenderedObservation: () => ({ display: { key: "0" }, displayRevision: 0 }),
    });
    setFakeTapAtWindow(tapAt);
    tapAt.observeScreen = observeScreen;
    // Cancel in the gap, after the first transport has confirmed success.
    const sleep = spyOn(timer, "sleep").mockImplementation(async (ms) => {
      timer.advanceTime(ms);
      if (scenario === "cancel") {
        controller.abort();
      }
    });
    try {
      const result = await tapAt.execute(
        { x: 10, y: 20, action: "doubleTap", display },
        undefined,
        controller.signal,
      );
      if (scenario === "advance" || scenario === "static") {
        expect(result).toMatchObject({ success: true, action: "doubleTap", x: 10, y: 20 });
        expect(delivered).toBe(2);
        expect(sent).toEqual(["epoch:7", undefined]);
      } else if (scenario === "first stale") {
        expect(result.error).toBe(
          device.platform === "android"
            ? "Failed to tap at coordinates: Stale frame context for input/tap"
            : "Failed to tap at coordinates: CtrlProxy iOS tap failed: Stale frame context for input/tap",
        );
        expect(result.success).toBe(false);
        expect(delivered).toBe(0);
        expect(sent).toEqual(["epoch:7"]);
      } else {
        expect(result.success).toBe(false);
        expect(result.error).toContain("one tap was delivered");
        expect(result.error).toContain("Do not retry automatically");
        expect(delivered).toBe(1);
        expect(sent).toEqual(scenario === "second failure" ? ["epoch:7", undefined] : ["epoch:7"]);
        if (scenario === "second failure") {
          expect(result.error).toContain("Synthetic second tap failure");
        } else if (scenario === "display change") {
          expect(result.staleDisplay).toBeDefined();
          expect(result.error).toContain("Display changed");
        } else {
          expect(result.error).toContain("cancel");
        }
      }
      expect(adb.getExecutedCommands()).toEqual([]);
    } finally {
      sleep.mockRestore();
    }
  });

  test.each([false, true])("second Android tap falls back to ADB (failure %s)", async (fails) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    const command = "shell input touchscreen tap 10 20";
    if (fails) {
      adb.setCommandError(command, new Error("Synthetic fallback failure"));
    }
    let runnerDelivered = 0;
    const frames: Array<string | undefined> = [];
    const client: CoordinateTapClient<() => void> = {
      requestTapCoordinates: async (_x, _y, _duration, _timeout, _perf, frame, onDispatch) => {
        frames.push(frame);
        if (frames.length === 2) {
          // No onDispatch: the runner proves this tap was never sent, so fallback is safe.
          return { success: false, error: "Not connected" };
        }
        onDispatch?.();
        runnerDelivered++;
        return { success: true };
      },
    };
    const tapAt = new TapAtCoordinate(androidDevice, adb, { timer, androidClient: client });
    setFakeTapAtWindow(tapAt);
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation(100, 200));
    tapAt.observeScreen = observe;

    const result = await tapAt.execute({ x: 10, y: 20, action: "doubleTap" });

    expect(frames).toEqual(["frame-123", undefined]);
    expect(runnerDelivered).toBe(1);
    expect(adb.getExecutedCommands()).toEqual([command]);
    expect(result.success).toBe(!fails);
    if (fails) {
      expect(result.error).toContain("Synthetic fallback failure");
      expect(result.error).toContain("one tap was delivered");
      expect(result.error).toContain("Do not retry automatically");
    } else {
      // One confirmed runner tap plus the one successful ADB tap completes the gesture.
      expect(runnerDelivered + adb.getExecutedCommands().length).toBe(2);
      expect(result.error).toBeUndefined();
    }
  });

  test("stale first frame retries once before delivering exactly two Android taps", async () => {
    let current = "epoch:2";
    let delivered = 0;
    const frames: Array<string | undefined> = [];
    const client: CoordinateTapClient<() => void> = {
      requestTapCoordinates: async (_x, _y, _duration, _timeout, _perf, frame, onDispatch) => {
        frames.push(frame);
        onDispatch?.();
        if (frame !== undefined && frame !== current) {
          return { success: false, error: "Stale frame context for input/tap" };
        }
        delivered++;
        current = `epoch:${2 + delivered}`;
        return { success: true };
      },
    };
    const { tapAt, observeScreen, adb, timer } = createAndroidTapAtWithClient(
      [observation(100, 200, "epoch:1"), observation(100, 200, "epoch:2")],
      client,
    );
    timer.enableAutoAdvance();

    const result = await tapAt.execute({ x: 10, y: 20, action: "doubleTap" });

    expect(result).toMatchObject({ success: true, action: "doubleTap" });
    expect(delivered).toBe(2);
    expect(frames).toEqual(["epoch:1", "epoch:2", undefined]);
    expect(observeScreen.getExecuteCallCount()).toBe(3);
    expect(
      observeScreen
        .getExecuteOptions()
        .slice(0, 2)
        .map((options) => options.freshness),
    ).toEqual(["cached-ok", "cached-ok"]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test.each(
    [
      { device: androidDevice, display: undefined, route: "Android default" },
      { device: androidDevice, display: "active", route: "Android explicit" },
      { device: iosDevice, display: undefined, route: "iOS default" },
      { device: iosDevice, display: "active", route: "iOS explicit" },
    ].flatMap((route) => [
      ...[1, 2].map((abortAfter) => ({ ...route, abortAfter, action: "doubleTap" as const })),
      ...(["tap", "longPress"] as const).map((action) => ({ ...route, abortAfter: 1, action })),
    ]),
  )(
    "$route $action cancellation immediately after confirmed tap $abortAfter",
    async ({ device, display, abortAfter, action }) => {
      const controller = new AbortController();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const adb = new FakeAdbExecutor();
      const observe = new FakeObserveScreen();
      observe.setObserveResult({
        ...observation(100, 200),
        display: { key: "0", role: "unknown", generation: 0 },
      });
      let delivered = 0;
      let invalidations = 0;
      const frames: Array<string | undefined> = [];
      const client: CoordinateTapClient = {
        requestTapCoordinates: async (_x, _y, _duration, _timeout, _perf, frame) => {
          frames.push(frame);
          delivered++;
          if (delivered === abortAfter) {
            controller.abort();
          }
          return { success: true };
        },
      };
      const tapAt = new TapAtCoordinate(device, adb, {
        timer,
        androidClient: client,
        iosClient: client,
        lastRenderedObservation: () => ({ display: { key: "0" }, displayRevision: 0 }),
        invalidateIosCache: () => {
          invalidations++;
        },
      });
      setFakeTapAtWindow(tapAt);
      tapAt.observeScreen = observe;

      const result = await tapAt.execute(
        { x: 10, y: 20, action, display },
        undefined,
        controller.signal,
      );

      expect(result).toMatchObject({ success: false, x: 10, y: 20, action });
      expect(result.error).toBe(
        `Failed to tap at coordinates: ${OPERATION_CANCELLED_MESSAGE}${
          action === "doubleTap" && abortAfter === 1
            ? " Double tap partially applied: one tap was delivered; the second tap was not confirmed. Do not retry automatically."
            : ""
        }`,
      );
      expect(delivered).toBe(abortAfter);
      expect(frames).toEqual(
        abortAfter === 1
          ? [display && device.platform === "android" ? undefined : "frame-123"]
          : [display && device.platform === "android" ? undefined : "frame-123", undefined],
      );
      expect(adb.getExecutedCommands()).toEqual([]);
      expect(invalidations).toBe(device.platform === "ios" ? 1 : 0);
    },
  );

  test("explicit Android display change in the double-tap gap prevents the second dispatch", async () => {
    const timer = new FakeTimer();
    const transitions = new FakeDisplayTransitionReader();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    const observe = new FakeObserveScreen();
    observe.setObserveResult({
      ...observation(100, 200),
      display: { key: "0", role: "unknown", generation: 7 },
    });
    let delivered = 0;
    const client: CoordinateTapClient = {
      requestTapCoordinates: async () => {
        delivered++;
        return { success: true };
      },
    };
    const tapAt = new TapAtCoordinate(androidDevice, adb, {
      timer,
      androidClient: client,
      displayTransitions: transitions,
      lastRenderedObservation: () => ({
        display: { key: "0", generation: 7 },
        displayRevision: 41,
      }),
    });
    setFakeTapAtWindow(tapAt);
    tapAt.observeScreen = observe;
    const sleep = spyOn(timer, "sleep").mockImplementation(async (ms) => {
      expect(ms).toBe(DOUBLE_TAP_GAP_MS);
      expect(delivered).toBe(1);
      timer.advanceTime(ms);
      transitions.transition();
    });
    try {
      const result = await tapAt.execute({ x: 10, y: 20, action: "doubleTap", display: "active" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("one tap was delivered");
      expect(result.error).toContain("Do not retry automatically");
      expect(result.error).toContain('Re-observe display "cover"');
      expect(result.staleDisplay).toEqual({
        observedGeneration: 7,
        currentGeneration: 8,
        currentDisplayKey: "cover",
        retry: "observe",
      });
      expect(delivered).toBe(1);
      expect(adb.getExecutedCommands()).toEqual([]);
    } finally {
      sleep.mockRestore();
    }
  });

  test.each([androidDevice, iosDevice])(
    "schema and implementation share duration bounds on %s",
    async (device) => {
      for (const durationMs of [
        LONG_PRESS_MIN_MS - 1,
        LONG_PRESS_MIN_MS,
        LONG_PRESS_MAX_MS,
        LONG_PRESS_MAX_MS + 1,
      ]) {
        const options = { x: 1, y: 2, action: "longPress" as const, durationMs };
        const valid = durationMs >= LONG_PRESS_MIN_MS && durationMs <= LONG_PRESS_MAX_MS;
        expect(tapAtSchema.safeParse(options).success).toBe(valid);
        const { tapAt } = createTapAt(device);
        expect(await tapAt.execute(options)).toMatchObject({ success: valid, action: "longPress" });
      }
    },
  );

  test.each([androidDevice, iosDevice])(
    "cancels during the double-tap gap on %s",
    async (device) => {
      const { tapAt, timer, androidDispatches, iosDispatches, iosCacheInvalidations } =
        createTapAt(device);
      const gapTimer = new FakeTimer();
      const controller = new AbortController();
      let gapStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        gapStarted = resolve;
      });
      const sleep = spyOn(timer, "sleep").mockImplementation((ms) => {
        expect(ms).toBe(DOUBLE_TAP_GAP_MS);
        const pending = gapTimer.sleep(ms);
        gapStarted();
        return pending;
      });
      try {
        const pending = tapAt.execute(
          { x: 1, y: 2, action: "doubleTap" },
          undefined,
          controller.signal,
        );
        await started;
        gapTimer.advanceTime(DOUBLE_TAP_GAP_MS / 2);
        controller.abort();
        const result = await pending;
        expect(result).toMatchObject({
          success: false,
          action: "doubleTap",
        });
        expect(result.error).toBe(
          `Failed to tap at coordinates: ${OPERATION_CANCELLED_MESSAGE} Double tap partially applied: one tap was delivered; the second tap was not confirmed. Do not retry automatically.`,
        );
        const dispatches = device.platform === "android" ? androidDispatches : iosDispatches;
        expect(dispatches).toHaveLength(1);
        expect(iosCacheInvalidations()).toBe(device.platform === "ios" ? 1 : 0);
        gapTimer.advanceTime(DOUBLE_TAP_GAP_MS / 2);
        await Promise.resolve();
        expect(dispatches).toHaveLength(1);
      } finally {
        gapTimer.resolveAll();
        sleep.mockRestore();
      }
    },
  );

  test.each(
    [androidDevice, iosDevice].flatMap((device) =>
      [undefined, "active"].map((display) => ({ device, display })),
    ),
  )(
    "pre-aborted gestures dispatch nothing on $device.platform display $display",
    async ({ device, display }) => {
      const { tapAt, androidDispatches, iosDispatches } = createTapAt(device);
      const controller = new AbortController();
      controller.abort();
      for (const action of ["tap", "longPress", "doubleTap"] as const) {
        expect(
          await tapAt.execute({ x: 1, y: 2, action, display }, undefined, controller.signal),
        ).toMatchObject({
          success: false,
          x: 1,
          y: 2,
          action,
          error: `Failed to tap at coordinates: ${OPERATION_CANCELLED_MESSAGE}`,
        });
      }
      expect(androidDispatches).toHaveLength(0);
      expect(iosDispatches).toHaveLength(0);
    },
  );

  test.each([androidDevice, iosDevice])(
    "rejects invalid gesture and ratios before dispatch on %s",
    async (device) => {
      const { tapAt, androidDispatches, iosDispatches } = createTapAt(device, 100, 200);
      for (const options of [
        { x: 101, y: 0, coordinateSpace: "percent" as const },
        { x: Number.NaN, y: 0, coordinateSpace: "normalized" as const },
        { x: 1.01, y: 0, coordinateSpace: "normalized" as const },
        { x: 0, y: 0, action: "longPress" as const, durationMs: 499 },
        { x: 0, y: 0, action: "tap" as const, durationMs: 750 },
      ]) {
        expect((await tapAt.execute(options)).success).toBe(false);
      }
      expect(androidDispatches).toHaveLength(0);
      expect(iosDispatches).toHaveLength(0);
    },
  );

  test.each([
    { device: androidDevice, width: 10.5, height: 20.25 },
    { device: androidDevice, width: 20.25, height: 10.5 },
    { device: iosDevice, width: 10.5, height: 20.25 },
    { device: iosDevice, width: 20.25, height: 10.5 },
  ])(
    "resolves percentage and normalized edges on $device.platform $width x $height",
    async ({ device, width, height }) => {
      const { tapAt, androidDispatches, iosDispatches } = createTapAt(device, width, height);
      const values = [0, 0.25, 0.5, 0.75, 1];
      for (const ratio of values) {
        const result = await tapAt.execute({ x: ratio, y: ratio, coordinateSpace: "normalized" });
        expect(result.success).toBe(true);
        const percentage = await tapAt.execute({
          x: ratio * 100,
          y: ratio * 100,
          coordinateSpace: "percent",
        });
        expect(percentage).toMatchObject({ success: true, x: result.x, y: result.y });
        expect(Math.abs(result.x / width - ratio)).toBeLessThanOrEqual(
          0.5 / width + Number.EPSILON,
        );
        expect(Math.abs(result.y / height - ratio)).toBeLessThanOrEqual(
          0.5 / height + Number.EPSILON,
        );
      }
      const dispatches = device.platform === "android" ? androidDispatches : iosDispatches;
      expect(dispatches.map(({ x }) => x)).toEqual(
        [...dispatches.map(({ x }) => x)].sort((a, b) => a - b),
      );
      expect(dispatches.at(-1)?.x).toBeLessThan(width);
      expect(dispatches.at(-1)?.y).toBeLessThan(height);
    },
  );
  beforeEach(() => {
    displayTransitions.reset(androidDevice.deviceId);
    displayTransitions.reset(iosDevice.deviceId);
  });

  afterEach(() => {
    displayTransitions.reset(androidDevice.deviceId);
    displayTransitions.reset(iosDevice.deviceId);
  });

  test.each(["longPress", "doubleTap"] as const)(
    "rejects an expired snapshot before %s dispatch",
    async (action) => {
      const timer = new FakeTimer();
      const references = new SnapshotReferenceStore(timer, new CountingIdGenerator("snapshot"));
      const captured = {
        ...observation(100, 100),
        display: { key: "main", role: "unknown" as const },
        displayRevision: 0,
      } as ObserveResult;
      const capture = references.capture(androidDevice.deviceId, captured);
      expect(capture.status).toBe("captured");
      if (capture.status !== "captured") {
        throw new Error("Snapshot reference unavailable");
      }
      const reference = capture.reference;
      expect(reference.snapshotId).toBe("snapshot-1");
      timer.advanceTime(300_000);
      const { tapAt, observeScreen, androidDispatches } = createTapAt(
        androidDevice,
        100,
        100,
        undefined,
        undefined,
        references,
      );
      observeScreen.setObserveResult(captured);
      const result = await tapAt.execute({
        x: 30,
        y: 40,
        action,
        snapshotId: reference.snapshotId,
      });
      expect(result).toMatchObject({
        success: false,
        action,
        error: expect.stringContaining("expired"),
      });
      expect(androidDispatches).toEqual([]);
    },
  );

  test("dispatches a tap bound to an unchanged snapshot frame", async () => {
    const references = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const captured = {
      ...observation(100, 100),
      display: { key: "main", role: "unknown" as const },
      displayRevision: 0,
    } as ObserveResult;
    const capture = references.capture(androidDevice.deviceId, captured);
    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") {
      throw new Error("Snapshot reference unavailable");
    }
    const reference = capture.reference;
    const { tapAt, observeScreen, androidDispatches } = createTapAt(
      androidDevice,
      100,
      100,
      undefined,
      undefined,
      references,
    );
    observeScreen.setObserveResult(captured);
    expect(await tapAt.execute({ x: 30, y: 40, snapshotId: reference.snapshotId })).toMatchObject({
      success: true,
      x: 30,
      y: 40,
    });
    expect(androidDispatches).toEqual([{ x: 30, y: 40, duration: 10, frameContext: "frame-123" }]);
  });

  test("dispatches snapshot-bound long presses and double taps with gesture durations", async () => {
    const references = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const captured = {
      ...observation(100, 100),
      display: { key: "main", role: "unknown" as const },
      displayRevision: 0,
    } as ObserveResult;
    const capture = references.capture(androidDevice.deviceId, captured);
    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") {
      throw new Error("Snapshot reference unavailable");
    }
    const reference = capture.reference;
    const { tapAt, observeScreen, androidDispatches, timer } = createTapAt(
      androidDevice,
      100,
      100,
      undefined,
      undefined,
      references,
    );
    observeScreen.setObserveResult(captured);
    expect(
      await tapAt.execute({
        x: 0.3,
        y: 0.4,
        coordinateSpace: "normalized",
        action: "longPress",
        durationMs: 750,
        snapshotId: reference.snapshotId,
      }),
    ).toMatchObject({ success: true, action: "longPress", x: 30, y: 40 });
    const start = timer.now();
    expect(
      await tapAt.execute({ x: 30, y: 40, action: "doubleTap", snapshotId: reference.snapshotId }),
    ).toMatchObject({ success: true, action: "doubleTap" });
    expect(androidDispatches).toEqual([
      { x: 30, y: 40, duration: 750, frameContext: "frame-123" },
      { x: 30, y: 40, duration: 10, frameContext: "frame-123" },
      { x: 30, y: 40, duration: 10, frameContext: undefined },
    ]);
    expect(timer.now() - start).toBe(DOUBLE_TAP_GAP_MS);
  });

  test("reuses a snapshot after a tap when only the event frame token advances", async () => {
    const references = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const captured = {
      ...observation(100, 100),
      display: { key: "main", role: "unknown" as const },
      displayRevision: 0,
      activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
    } as ObserveResult;
    const capture = references.capture(androidDevice.deviceId, captured);
    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") {
      throw new Error("Snapshot reference unavailable");
    }
    const reference = capture.reference;
    const { tapAt, observeScreen, androidDispatches } = createTapAt(
      androidDevice,
      100,
      100,
      undefined,
      undefined,
      references,
    );
    observeScreen.setObserveResult(captured);
    expect(await tapAt.execute({ x: 30, y: 40, snapshotId: reference.snapshotId })).toMatchObject({
      success: true,
    });
    observeScreen.setObserveResult({
      ...captured,
      displayRevision: 0,
      activeWindow: { ...captured.activeWindow!, layoutSeqSum: 2 },
      viewHierarchy: { ...captured.viewHierarchy!, frameContext: "frame-124", captureSequence: 2 },
    });
    expect(await tapAt.execute({ x: 30, y: 40, snapshotId: reference.snapshotId })).toMatchObject({
      success: true,
    });
    expect(androidDispatches).toHaveLength(2);
  });

  test("rejects changed snapshot activity and geometry before dispatch", async () => {
    const references = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const captured = {
      ...observation(100, 100),
      display: { key: "main", role: "unknown" as const },
      displayRevision: 0,
      activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
    } as ObserveResult;
    const capture = references.capture(androidDevice.deviceId, captured);
    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") {
      throw new Error("Snapshot reference unavailable");
    }
    const reference = capture.reference;
    const { tapAt, observeScreen, androidDispatches } = createTapAt(
      androidDevice,
      100,
      100,
      undefined,
      undefined,
      references,
    );
    observeScreen.setObserveResult({
      ...captured,
      activeWindow: { ...captured.activeWindow!, activityName: ".Settings" },
    });
    const staleFrame = await tapAt.execute({ x: 30, y: 40, snapshotId: reference.snapshotId });
    expect(staleFrame).toMatchObject({
      success: false,
      error: expect.stringContaining("activityName"),
    });
    observeScreen.setObserveResult({ ...captured, screenSize: { width: 20, height: 100 } });
    const resized = await tapAt.execute({ x: 30, y: 40, snapshotId: reference.snapshotId });
    expect(resized).toMatchObject({ success: false, error: expect.stringContaining("width") });
    expect(androidDispatches).toEqual([]);
  });

  test("retries a snapshot tap once with a freshly validated Android token", async () => {
    const references = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const initial = {
      ...observation(100, 200, "epoch:1"),
      display: { key: "main", role: "unknown" as const },
      activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
    } as ObserveResult;
    const refreshed = {
      ...initial,
      viewHierarchy: { ...initial.viewHierarchy!, frameContext: "epoch:2" },
    };
    const capture = references.capture(androidDevice.deviceId, initial);
    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") {
      throw new Error("Snapshot reference unavailable");
    }
    const reference = capture.reference;
    const dispatches: string[] = [];
    const client: CoordinateTapClient = {
      requestTapCoordinates: async (_x, _y, _duration, _timeout, _perf, frameContext) => {
        dispatches.push(frameContext ?? "missing");
        return dispatches.length === 1
          ? { success: false, error: "Stale frame context for input/tap" }
          : { success: true };
      },
    };
    const { tapAt, observeScreen } = createAndroidTapAtWithClient(
      [initial, refreshed],
      client,
      references,
    );
    expect(await tapAt.execute({ x: 30, y: 40, snapshotId: reference.snapshotId })).toMatchObject({
      success: true,
    });
    expect(dispatches).toEqual(["epoch:1", "epoch:2"]);
    expect(
      observeScreen
        .getExecuteOptions()
        .slice(0, 2)
        .map((item) => item.freshness),
    ).toEqual(["cached-ok", "fresh"]);
  });

  test("does not redispatch a snapshot tap after fresh observation changes activity", async () => {
    const references = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const initial = {
      ...observation(100, 200, "epoch:1"),
      display: { key: "main", role: "unknown" as const },
      activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
    } as ObserveResult;
    const refreshed = {
      ...initial,
      activeWindow: { ...initial.activeWindow!, activityName: ".Settings" },
      viewHierarchy: { ...initial.viewHierarchy!, frameContext: "epoch:2" },
    };
    const capture = references.capture(androidDevice.deviceId, initial);
    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") {
      throw new Error("Snapshot reference unavailable");
    }
    const reference = capture.reference;
    const dispatches: string[] = [];
    const client: CoordinateTapClient = {
      requestTapCoordinates: async (_x, _y, _duration, _timeout, _perf, frameContext) => {
        dispatches.push(frameContext ?? "missing");
        return { success: false, error: "Stale frame context for input/tap" };
      },
    };
    const { tapAt } = createAndroidTapAtWithClient([initial, refreshed], client, references);
    const result = await tapAt.execute({ x: 30, y: 40, snapshotId: reference.snapshotId });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("activityName changed"),
    });
    expect(dispatches).toEqual(["epoch:1"]);
  });

  test("rejects the caller's old coordinates when another path detected the fold first", async () => {
    let callerRevision = 0;
    const { tapAt, observeScreen, androidDispatches } = createTapAt(
      androidDevice,
      200,
      200,
      undefined,
      () => callerRevision,
    );
    const inner = {
      display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
      screenSize: { width: 200, height: 200 },
    } as ObserveResult;
    const cover = {
      display: { key: "cover", role: "cover", posture: "closed", generation: 2 },
      screenSize: { width: 100, height: 100 },
    } as ObserveResult;
    displayTransitions.record(androidDevice.deviceId, inner);
    // setPosture's internal observe detects the fold but is not rendered to the caller.
    displayTransitions.checkIdentity(androidDevice.deviceId, cover.display);
    displayTransitions.record(androidDevice.deviceId, cover);
    observeScreen.setObserveResult({ ...observation(100, 100, "cover"), display: cover.display });

    const rejected = await tapAt.execute({ x: 50, y: 50 });
    expect(rejected).toMatchObject({
      success: false,
      error: expect.stringContaining("Re-observe"),
    });
    expect(observeScreen.getExecuteCallCount()).toBe(0);
    expect(androidDispatches).toEqual([]);

    // An explicit caller-visible observe of the cover panel advances its revision.
    callerRevision = displayTransitions.revision(androidDevice.deviceId);
    const accepted = await tapAt.execute({ x: 50, y: 50 });
    expect(accepted.success).toBe(true);
    expect(androidDispatches).toHaveLength(1);
  });

  test("allows unchanged display coordinates from the caller's last observation", async () => {
    const { tapAt, androidDispatches } = createTapAt(androidDevice, 100, 100, undefined, () => 0);
    const result = await tapAt.execute({ x: 50, y: 50 });
    expect(result.success).toBe(true);
    expect(androidDispatches).toHaveLength(1);
  });

  test.each([false, true])(
    "classifies explicit-display tap failure (dispatched %s)",
    async (dispatched) => {
      const client: CoordinateTapClient<() => void> = {
        requestTapCoordinates: async (_x, _y, _duration, _timeout, _perf, _frame, onDispatch) => {
          if (dispatched) {
            onDispatch?.();
          }
          return { success: false, error: "Tap timed out after 5000ms" };
        },
      };
      const { tapAt, observeScreen, adb } = createAndroidTapAtWithClient(
        [observation(100, 100)],
        client,
        undefined,
        () => ({ display: { key: "0" } }),
      );
      observeScreen.setObserveResult({
        ...observation(100, 100),
        display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
      } as ObserveResult);
      const result = await tapAt.execute({ x: 10, y: 20, display: "0" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Tap timed out after 5000ms");
      if (dispatched) {
        expect(result.error).toMatch(/outcome is indeterminate.*Do not retry automatically/i);
      } else {
        expect(result.error).not.toMatch(/indeterminate/i);
      }
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

  test.each(["tap", "longPress"] as const)(
    "preserves explicit-display ADB %s timeout",
    async (action) => {
      const adb = new FakeAdbExecutor();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const client = {
        supportsCommand: async () => false,
        requestTapCoordinates: async () => ({ success: true }),
      };
      const observeScreen = new FakeObserveScreen();
      observeScreen.setObserveResult({
        ...observation(100, 100),
        display: { key: "inner", role: "inner", posture: "opened", generation: 0 },
      } as ObserveResult);
      const tapAt = new TapAtCoordinate(
        {
          ...androidDevice,
          displays: {
            panels: [{ key: "inner", role: "inner", sizePx: { width: 100, height: 100 } }],
            postures: [],
          },
        },
        adb,
        {
          timer,
          androidClient: client,
          iosClient: client,
          lastRenderedObservation: () => ({ display: { key: "inner" } }),
        },
      );
      setFakeTapAtWindow(tapAt);
      tapAt.observeScreen = observeScreen;
      const displayId = spyOn(
        ObservedAndroidDisplayCache.prototype,
        "logicalIdForPanel",
      ).mockResolvedValue(2);
      try {
        const result = await tapAt.execute({
          x: 10,
          y: 20,
          display: "inner",
          action,
          ...(action === "longPress" ? { durationMs: 10000 } : {}),
        });
        expect(result.success).toBe(true);
        expect(adb.getExecutedCommands()).toEqual([
          `shell input touchscreen -d 2 ${action === "longPress" ? "swipe 10 20 10 20 10000" : "tap 10 20"}`,
        ]);
        expect(adb.getCommandCalls()[0].timeoutMs).toBe(
          action === "longPress" ? resolveGestureCtrlProxyTimeoutMs(10000) : undefined,
        );
      } finally {
        displayId.mockRestore();
      }
    },
  );

  test("keeps the existing path for a caller who has never observed", async () => {
    const { tapAt, androidDispatches } = createTapAt(
      androidDevice,
      100,
      100,
      undefined,
      () => undefined,
    );
    displayTransitions.notifyTransition(androidDevice.deviceId, "prior fold");
    const result = await tapAt.execute({ x: 50, y: 50 });
    expect(result.success).toBe(true);
    expect(androidDispatches).toHaveLength(1);
  });

  test("rejects stale coordinates when CtrlProxy pushes a fold before dispatch", async () => {
    const { tapAt, observeScreen, androidDispatches } = createTapAt(androidDevice, 200, 200);
    displayTransitions.record(androidDevice.deviceId, {
      display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
      screenSize: { width: 200, height: 200 },
    });
    const execute = spyOn(observeScreen, "execute").mockImplementation(async () => {
      displayTransitions.notifyAndroidTransition(androidDevice.deviceId, {
        change: "changed",
        displayId: 0,
        panelUniqueId: "local:cover",
        width: 100,
        height: 100,
      });
      return observation(200, 200);
    });
    try {
      const result = await tapAt.execute({ x: 50, y: 50 });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Re-observe");
      expect(androidDispatches).toEqual([]);
      expect(displayTransitions.revision(androidDevice.deviceId)).toBe(1);
    } finally {
      execute.mockRestore();
      displayTransitions.reset(androidDevice.deviceId);
    }
  });

  test("rejects panel-A coordinates when the pre-dispatch observation detects a fold", async () => {
    const { tapAt, observeScreen, androidDispatches } = createTapAt(androidDevice, 200, 200);
    const panelA = {
      display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
      screenSize: { width: 200, height: 200 },
    } as ObserveResult;
    const panelB = {
      display: { key: "cover", role: "cover", posture: "closed", generation: 2 },
      screenSize: { width: 100, height: 100 },
    } as ObserveResult;
    displayTransitions.record(androidDevice.deviceId, panelA);
    const execute = spyOn(observeScreen, "execute").mockImplementation(async () => {
      displayTransitions.checkIdentity(androidDevice.deviceId, panelB.display);
      displayTransitions.record(androidDevice.deviceId, panelB);
      return observation(100, 100, "panel-b");
    });
    try {
      const result = await tapAt.execute({ x: 50, y: 50 });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Re-observe");
      expect(androidDispatches).toEqual([]);
    } finally {
      execute.mockRestore();
      displayTransitions.reset(androidDevice.deviceId);
    }
  });

  test("accepts coordinates chosen after re-observing the transitioned panel", async () => {
    const { tapAt, observeScreen, androidDispatches } = createTapAt(androidDevice, 100, 100);
    const panelA = {
      display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
      screenSize: { width: 200, height: 200 },
    } as ObserveResult;
    const panelB = {
      display: { key: "cover", role: "cover", posture: "closed", generation: 2 },
      screenSize: { width: 100, height: 100 },
    } as ObserveResult;
    displayTransitions.record(androidDevice.deviceId, panelA);
    displayTransitions.checkIdentity(androidDevice.deviceId, panelB.display);
    displayTransitions.record(androidDevice.deviceId, panelB);
    observeScreen.setObserveResult({
      ...observation(100, 100, "panel-b"),
      display: panelB.display,
    });
    try {
      const result = await tapAt.execute({ x: 50, y: 50 });
      expect(result.success).toBe(true);
      expect(androidDispatches).toHaveLength(1);
    } finally {
      displayTransitions.reset(androidDevice.deviceId);
    }
  });

  test("rounds in-bounds Android coordinates and dispatches native pixels", async () => {
    const { tapAt, observeScreen, androidDispatches } = createTapAt(androidDevice);

    const result = await tapAt.execute({ x: 1.6, y: 2.5 });

    expect(result).toMatchObject({ success: true, x: 2, y: 3 });
    expect(androidDispatches).toEqual([{ x: 2, y: 3, duration: 10, frameContext: "frame-123" }]);
    expect(observeScreen.getGetMostRecentCachedObserveResultCallCount()).toBe(0);
    expect(observeScreen.getExecuteOptions()[0]?.freshness).toBe("cached-ok");
  });

  test("accepts fractional Android coordinates just inside the right edge and clamps to the last pixel", async () => {
    const { tapAt, androidDispatches } = createTapAt(androidDevice, 1080, 2400);

    const result = await tapAt.execute({ x: 1079.999, y: 500 });

    expect(result).toMatchObject({ success: true, x: 1079, y: 500 });
    expect(androidDispatches).toEqual([
      { x: 1079, y: 500, duration: 10, frameContext: "frame-123" },
    ]);
  });

  test("reports the clamped Android pixel when dispatch fails at the screen edge", async () => {
    const dispatched: Array<{ x: number; y: number }> = [];
    const client: CoordinateTapClient = {
      requestTapCoordinates: async (x, y) => {
        dispatched.push({ x, y });
        throw new Error("native tap failed");
      },
    };
    const { tapAt } = createAndroidTapAtWithClient([observation(1080, 2400)], client);

    const result = await tapAt.execute({ x: 1079.999, y: 2399.999 });

    expect(dispatched).toEqual([{ x: 1079, y: 2399 }]);
    expect(result).toMatchObject({
      success: false,
      x: 1079,
      y: 2399,
      error: expect.stringContaining("native tap failed"),
    });
  });

  test.each([
    { x: 1080, expectedCoordinate: "1080" },
    { x: -0.5, expectedCoordinate: "-0.5" },
  ])("reports raw Android out-of-bounds x=$x", async ({ x, expectedCoordinate }) => {
    const { tapAt, androidDispatches } = createTapAt(androidDevice, 1080, 2400);

    const result = await tapAt.execute({ x, y: 500 });

    expect(result.success).toBe(false);
    expect(result.error).toContain(expectedCoordinate);
    expect(result.error).toContain("outside screen bounds [0, 1080) x [0, 2400)");
    expect(androidDispatches).toEqual([]);
  });

  test("keeps in-bounds integer Android coordinates unchanged", async () => {
    const { tapAt, androidDispatches } = createTapAt(androidDevice, 1080, 2400);

    const result = await tapAt.execute({ x: 500, y: 700 });

    expect(result).toMatchObject({ success: true, x: 500, y: 700 });
    expect(androidDispatches).toEqual([
      { x: 500, y: 700, duration: 10, frameContext: "frame-123" },
    ]);
  });

  test("dispatches the center of a captured Android observe bound in physical pixels", async () => {
    const captured = loadAndroidHomeObserve().observe;
    const bounds = captured.elements?.clickable[0]?.bounds;
    if (!bounds) {
      throw new Error("Android capture has no clickable bounds");
    }
    const x = (bounds.left + bounds.right) / 2;
    const y = (bounds.top + bounds.bottom) / 2;
    const { tapAt, observeScreen, androidDispatches } = createTapAt(androidDevice);
    observeScreen.setObserveResult(captured);

    const result = await tapAt.execute({ x, y });

    expect(captured.screenSize).toEqual({ width: 1080, height: 2400 });
    expect(result).toMatchObject({ success: true, x: Math.round(x), y: Math.round(y) });
    expect(androidDispatches).toEqual([
      {
        x: Math.round(x),
        y: Math.round(y),
        duration: 10,
        frameContext: captured.viewHierarchy?.frameContext,
      },
    ]);
  });

  test("dispatches a fractional iOS observe bound in XCTest points despite Retina scale", async () => {
    const captured = loadIosFractionalObserve();
    const bounds = captured.elements?.text[0]?.bounds;
    if (!bounds) {
      throw new Error("iOS fixture has no text bounds");
    }
    const x = (bounds.left + bounds.right) / 2;
    const y = (bounds.top + bounds.bottom) / 2;
    const { tapAt, observeScreen, iosDispatches } = createTapAt(iosDevice);
    observeScreen.setObserveResult(captured);

    const result = await tapAt.execute({ x, y });

    expect(captured.screenSize).toEqual({ width: 393, height: 852 });
    expect(captured.viewHierarchy?.screenScale).toBe(3);
    expect(result).toMatchObject({ success: true, x, y });
    expect(iosDispatches).toEqual([
      { x, y, duration: 50, frameContext: captured.viewHierarchy?.frameContext },
    ]);
  });

  test("uses current-orientation landscape bounds without rotating the native tap", async () => {
    const captured = loadAndroidHomeObserve().observe;
    const portrait = captured.elements?.clickable[0]?.bounds;
    if (!portrait) {
      throw new Error("Android capture has no clickable bounds");
    }
    // Rotate the captured rectangle into a landscape observation; no landscape
    // observe capture is stored in-tree. The input path must consume it as-is.
    const landscape = observation(
      captured.screenSize.height,
      captured.screenSize.width,
      "landscape-frame",
      90,
      {
        bounds: {
          left: captured.screenSize.height - portrait.bottom,
          top: portrait.left,
          right: captured.screenSize.height - portrait.top,
          bottom: portrait.right,
        },
      },
    );
    const bounds = landscape.viewHierarchy?.hierarchy.node.bounds;
    if (!bounds) {
      throw new Error("Landscape observation has no bounds");
    }
    const x = (bounds.left + bounds.right) / 2;
    const y = (bounds.top + bounds.bottom) / 2;
    const { tapAt, observeScreen, androidDispatches } = createTapAt(androidDevice);
    observeScreen.setObserveResult(landscape);

    const result = await tapAt.execute({ x, y });

    expect(landscape.screenSize).toEqual({ width: 2400, height: 1080 });
    expect(result).toMatchObject({ success: true, x: Math.round(x), y: Math.round(y) });
    expect(androidDispatches).toEqual([
      { x: Math.round(x), y: Math.round(y), duration: 10, frameContext: "landscape-frame" },
    ]);
  });

  test("preserves iOS fractional XCTest points without scale or canonical-pixel conversion", async () => {
    const { tapAt, iosDispatches } = createTapAt(iosDevice);

    const result = await tapAt.execute({ x: 1.25, y: 2.75 });

    expect(result).toMatchObject({ success: true, x: 1.25, y: 2.75 });
    expect(iosDispatches).toEqual([{ x: 1.25, y: 2.75, duration: 50, frameContext: "frame-123" }]);
  });

  test("synthetic unfolded Duo bounds accept tapAt 700,48 after an orientation correction", async () => {
    const { tapAt, observeScreen, iosDispatches } = createTapAt(iosDevice);
    const inner = {
      key: "primary-1",
      role: "inner" as const,
      posture: "opened" as const,
      generation: 1,
    };
    displayTransitions.record(
      iosDevice.deviceId,
      {
        observationId: "test-observation",
        display: inner,
        screenSize: { width: 669, height: 951 },
      },
      "ios",
    );
    observeScreen.setObserveResult(observation(951, 669));
    const result = await tapAt.execute({ x: 700, y: 48 }, async (step) => {
      if (step === 10) {
        displayTransitions.checkIosGeometry(
          iosDevice.deviceId,
          { width: 951, height: 669 },
          "test-observation",
          inner,
        );
      }
    });
    expect(result).toMatchObject({ success: true, x: 700, y: 48 });
    expect(iosDispatches).toEqual([{ x: 700, y: 48, duration: 50, frameContext: "frame-123" }]);
  });

  test("iOS tap invalidates the cache and observes from the dispatch time", async () => {
    const { tapAt, observeScreen, timer, iosCacheInvalidations } = createTapAt(
      iosDevice,
      10,
      10,
      (clock) => clock.advanceTime(25),
    );
    timer.advanceTime(100);
    observeScreen.setObserveResult((index) => {
      if (index === 0) {
        timer.advanceTime(25); // pre-dispatch observation
      }
      const updatedAt = index === 0 ? 125 : index === 1 ? 124 : 175;
      return {
        ...observation(10, 10),
        updatedAt,
        freshness: computeFreshness({
          requestedAfter: index === 0 ? undefined : 150,
          actualTimestamp: updatedAt,
          now: timer.now(),
          verified: true,
        }),
      } as ObserveResult;
    });
    const result = await tapAt.execute({ x: 1, y: 2 });

    expect(result.success).toBe(true);
    expect(iosCacheInvalidations()).toBe(1);
    expect(observeScreen.getExecuteOptions()[1]?.minTimestamp).toBe(150);
    expect(observeScreen.getExecuteCallCount()).toBe(3);
    expect(result.observation.updatedAt).toBe(175);
  });

  test("iOS double tap invalidates once after both taps", async () => {
    const { tapAt, iosDispatches, iosCacheInvalidations } = createTapAt(iosDevice);

    const result = await tapAt.execute({ x: 1, y: 2, action: "doubleTap" });

    expect(result).toMatchObject({ success: true, action: "doubleTap" });
    expect(iosDispatches).toHaveLength(2);
    expect(iosCacheInvalidations()).toBe(1);
  });

  test("iOS double tap invalidates after a rejected second tap", async () => {
    const { tapAt, iosDispatches, iosCacheInvalidations } = createTapAt(
      iosDevice,
      10,
      10,
      undefined,
      undefined,
      undefined,
      2,
    );

    const result = await tapAt.execute({ x: 1, y: 2, action: "doubleTap" });

    expect(result).toMatchObject({ success: false, action: "doubleTap" });
    expect(result.error).toContain("one tap was delivered");
    expect(result.error).toContain("Synthetic iOS tap rejection");
    expect(iosDispatches).toHaveLength(2);
    expect(iosCacheInvalidations()).toBe(1);
  });

  for (const action of ["tap", "doubleTap"] as const) {
    test.each(["settle-throws", "throws"] as const)(
      `display iOS ${action} preserves delivered count after %s`,
      async (outcome) => {
        const display = {
          key: "main",
          role: "unknown" as const,
          posture: "unknown" as const,
          generation: 0,
        };
        const before = { ...observation(10, 10), display };
        const after = { ...observation(10, 10, "after", 0, { text: "Destination" }), display };
        const h = createTapAt(
          {
            ...iosDevice,
            displays: {
              panels: [{ key: "main", role: "unknown", sizePx: { width: 10, height: 10 } }],
              postures: [],
            },
          },
          10,
          10,
          undefined,
          undefined,
          undefined,
          undefined,
          () => before,
        );
        let postReads = 0;
        h.observeScreen.setObserveResult(() => {
          if (!h.iosDispatches.length) {
            return before;
          }
          postReads++;
          if (outcome === "throws" || postReads > 1) {
            throw new Error("display post-read unavailable");
          }
          return after;
        });
        const result = await h.tapAt.execute({ x: 1, y: 2, display: "main", action });
        const count = action === "tap" ? 1 : 2;
        expect(h.iosDispatches).toHaveLength(count);
        if (outcome === "throws") {
          expect(result.success).toBe(false);
          expect(result.error).toContain("Do not retry automatically");
          expect(result.error).toContain(
            `${count} ${count === 1 ? "tap was" : "taps were"} delivered`,
          );
          expect(result.observation).toBeUndefined();
        } else {
          expect(result.success).toBe(true);
          expect(result.observation?.viewHierarchy).toEqual(after.viewHierarchy);
          expect(result.observation?.freshness?.warning).toContain("display settle");
        }
      },
    );
  }

  test("explicit-display iOS gestures invalidate after dispatch", async () => {
    const displayDevice: BootedDevice = {
      ...iosDevice,
      displays: {
        panels: [{ key: "main", role: "unknown", sizePx: { width: 10, height: 10 } }],
        postures: [],
      },
    };
    const lastRenderedObservation = () => ({ display: { key: "main" } });
    const display = {
      key: "main",
      role: "unknown" as const,
      posture: "unknown" as const,
      generation: 0,
    };
    const completed = createTapAt(
      displayDevice,
      10,
      10,
      undefined,
      undefined,
      undefined,
      undefined,
      lastRenderedObservation,
    );
    completed.observeScreen.setObserveResult({
      ...observation(10, 10),
      display,
    } as ObserveResult);
    const completedResult = await completed.tapAt.execute({
      x: 1,
      y: 2,
      action: "doubleTap",
      display: "main",
    });
    expect(completedResult.success).toBe(true);
    expect(completed.iosDispatches).toHaveLength(2);
    expect(completed.iosCacheInvalidations()).toBe(1);

    const rejected = createTapAt(
      displayDevice,
      10,
      10,
      undefined,
      undefined,
      undefined,
      2,
      lastRenderedObservation,
    );
    rejected.observeScreen.setObserveResult({ ...observation(10, 10), display } as ObserveResult);
    const rejectedResult = await rejected.tapAt.execute({
      x: 1,
      y: 2,
      action: "doubleTap",
      display: "main",
    });
    expect(rejectedResult).toMatchObject({ success: false, action: "doubleTap" });
    expect(rejectedResult.error).toContain("one tap was delivered");
    expect(rejectedResult.error).toContain("Synthetic iOS tap rejection");
    expect(rejected.iosCacheInvalidations()).toBe(1);

    const aborted = createTapAt(
      displayDevice,
      10,
      10,
      undefined,
      undefined,
      undefined,
      undefined,
      lastRenderedObservation,
    );
    aborted.observeScreen.setObserveResult({ ...observation(10, 10), display } as ObserveResult);
    const gapTimer = new FakeTimer();
    const controller = new AbortController();
    let gapStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      gapStarted = resolve;
    });
    const sleep = spyOn(aborted.timer, "sleep").mockImplementation((ms) => {
      const pending = gapTimer.sleep(ms);
      gapStarted();
      return pending;
    });
    try {
      const pending = aborted.tapAt.execute(
        { x: 1, y: 2, action: "doubleTap", display: "main" },
        undefined,
        controller.signal,
      );
      await started;
      controller.abort();
      const result = await pending;
      expect(result).toMatchObject({ success: false, action: "doubleTap" });
      expect(result.error).toBe(
        `Failed to tap at coordinates: ${OPERATION_CANCELLED_MESSAGE} Double tap partially applied: one tap was delivered; the second tap was not confirmed. Do not retry automatically.`,
      );
      expect(aborted.iosDispatches).toHaveLength(1);
      expect(aborted.iosCacheInvalidations()).toBe(1);
    } finally {
      gapTimer.resolveAll();
      sleep.mockRestore();
    }

    const plain = createTapAt(
      displayDevice,
      10,
      10,
      undefined,
      undefined,
      undefined,
      undefined,
      lastRenderedObservation,
    );
    plain.observeScreen.setObserveResult({ ...observation(10, 10), display } as ObserveResult);
    expect(await plain.tapAt.execute({ x: 1, y: 2, display: "main" })).toMatchObject({
      success: true,
    });
    expect(plain.iosCacheInvalidations()).toBe(1);
  });

  test("rejected iOS tap leaves the cache valid", async () => {
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(observation(10, 10));
    let invalidations = 0;
    const unusedClient: CoordinateTapClient = {
      requestTapCoordinates: async () => ({ success: false, error: "Stale frame context" }),
    };
    const tapAt = new TapAtCoordinate(iosDevice, new FakeAdbExecutor(), {
      timer: new FakeTimer(),
      androidClient: unusedClient,
      iosClient: unusedClient,
      invalidateIosCache: () => {
        invalidations++;
      },
    });
    setFakeTapAtWindow(tapAt);
    tapAt.observeScreen = observeScreen;

    const result = await tapAt.execute({ x: 1, y: 2 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Stale frame context");
    expect(invalidations).toBe(0);
  });

  test("dispatches resolved Android pixels and iOS points byte-for-byte without daemon conversion (#7336 bullets 2 and 5)", async () => {
    const android = createTapAt(androidDevice, 1080, 2400);
    const androidResult = await android.tapAt.execute({ x: 640.6, y: 1200.4 });
    expect(androidResult).toMatchObject({ success: true, x: 641, y: 1200 });
    expect(android.androidDispatches).toEqual([
      { x: 641, y: 1200, duration: 10, frameContext: "frame-123" },
    ]);

    const ios = createTapAt(iosDevice, 393, 852);
    const iosResult = await ios.tapAt.execute({ x: 20.5, y: 68.33333333333333 });
    expect(iosResult).toMatchObject({ success: true, x: 20.5, y: 68.33333333333333 });
    expect(ios.iosDispatches).toEqual([
      { x: 20.5, y: 68.33333333333333, duration: 50, frameContext: "frame-123" },
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
      scaleMetadata.map(() => ({ ...logicalPoint, duration: 50, frameContext: "frame-123" })),
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

  test("uses a held Android swipe if CtrlProxy cannot start a long press", async () => {
    const adb = new FakeAdbExecutor();
    const rejectedClient: CoordinateTapClient = {
      requestTapCoordinates: async () => ({ success: false, error: "gesture unavailable" }),
    };
    await dispatchAndroidCoordinateTap(rejectedClient, adb, 1, 2, 750, "frame-123");
    expect(adb.wasCommandExecuted("shell input touchscreen swipe 1 2 1 2 750")).toBe(true);
    expect(adb.wasCommandExecuted("shell input touchscreen tap 1 2")).toBe(false);
  });

  test("re-observes and retries one Android stale-frame rejection when the frame token advances and targeting layout is unchanged", async () => {
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
    expect(
      observeScreen
        .getExecuteOptions()
        .slice(0, 2)
        .map((options) => options.freshness),
    ).toEqual(["cached-ok", "cached-ok"]);
    expect(adb.wasCommandExecuted("shell input touchscreen tap 20 30")).toBe(false);
  });

  test("rejects a stale-frame retry when its observation detects a fold", async () => {
    const dispatches: string[] = [];
    const client: CoordinateTapClient = {
      requestTapCoordinates: async (_x, _y, _duration, _timeout, _perf, frameContext) => {
        dispatches.push(frameContext ?? "missing");
        return dispatches.length === 1
          ? {
              success: false,
              error: "Stale frame context for input/tap; observe a fresh frame before retrying",
            }
          : { success: true };
      },
    };
    const { tapAt, observeScreen } = createAndroidTapAtWithClient(
      [observation(100, 200, "epoch:1")],
      client,
    );
    observeScreen.setObserveResult((index) => {
      if (index === 1) {
        displayTransitions.notifyTransition(androidDevice.deviceId, "fold");
      }
      return observation(100, 200, index === 0 ? "epoch:1" : "epoch:2");
    });

    try {
      const result = await tapAt.execute({ x: 20, y: 30 });

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("Re-observe the active panel"),
      });
      expect(dispatches).toEqual(["epoch:1"]);
      expect(observeScreen.getExecuteCallCount()).toBe(2);
    } finally {
      displayTransitions.reset(androidDevice.deviceId);
    }
  });

  test.each([
    { location: "top-level", capture: "initial" },
    { location: "nested view hierarchy", capture: "initial" },
    { location: "top-level", capture: "refreshed" },
    { location: "nested view hierarchy", capture: "refreshed" },
  ])(
    "refuses a stale-frame retry when the $capture $location is truncated",
    async ({ location, capture }) => {
      const dispatches: string[] = [];
      const client: CoordinateTapClient = {
        requestTapCoordinates: async (_x, _y, _duration, _timeout, _perf, frameContext) => {
          dispatches.push(frameContext ?? "missing");
          return dispatches.length === 1
            ? {
                success: false,
                error: "Stale frame context for input/tap; observe a fresh frame before retrying",
              }
            : { success: true };
        },
      };
      const initial = observation(100, 200, "epoch:1", 0, { text: "Settings" });
      const refreshed = observation(100, 200, "epoch:2", 0, { text: "Settings" });
      const truncated = capture === "initial" ? initial : refreshed;
      if (location === "top-level") {
        truncated.truncationReasons = ["max_nodes"];
      } else if (truncated.viewHierarchy) {
        truncated.viewHierarchy.truncationReasons = ["max_depth"];
      }
      const { tapAt, observeScreen } = createAndroidTapAtWithClient([initial, refreshed], client);

      const result = await tapAt.execute({ x: 20, y: 30 });

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("Stale frame context"),
      });
      expect(dispatches).toEqual(["epoch:1"]);
      expect(observeScreen.getExecuteCallCount()).toBe(2);
    },
  );

  test("refuses a stale-frame retry when the refreshed frame token is the rejected token", async () => {
    const dispatches: string[] = [];
    const client: CoordinateTapClient = {
      requestTapCoordinates: async (_x, _y, _duration, _timeout, _perf, frameContext) => {
        dispatches.push(frameContext ?? "missing");
        return dispatches.length === 1
          ? {
              success: false,
              error: "Stale frame context for input/tap; observe a fresh frame before retrying",
            }
          : { success: true };
      },
    };
    const initial = observation(100, 200, "epoch:1", 0, { text: "Settings" });
    const refreshed = observation(100, 200, "epoch:1", 0, { text: "Settings" });
    const { tapAt, observeScreen } = createAndroidTapAtWithClient([initial, refreshed], client);

    const result = await tapAt.execute({ x: 20, y: 30 });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Stale frame context"),
    });
    expect(dispatches).toEqual(["epoch:1"]);
    expect(observeScreen.getExecuteCallCount()).toBe(2);
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

test("iOS snapshot tap accepts size-derived rotation and rejects a later rotation before dispatch", async () => {
  const references = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
  const initial: ObserveResult = {
    ...observation(100, 200),
    display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
    rotation: resolveIosObserveRotation(undefined, { width: 100, height: 200 }),
    viewHierarchy: { ...observation(100, 200).viewHierarchy!, rotation: undefined },
  };
  const capture = references.capture(iosDevice.deviceId, initial);
  expect(capture.status).toBe("captured");
  if (capture.status !== "captured") {
    throw new Error("Missing iOS snapshot reference");
  }
  const { tapAt, observeScreen, iosDispatches } = createTapAt(
    iosDevice,
    100,
    200,
    undefined,
    undefined,
    references,
  );
  observeScreen.setObserveResult(initial);
  expect(
    (await tapAt.execute({ x: 10, y: 20, snapshotId: capture.reference.snapshotId })).success,
  ).toBe(true);
  observeScreen.setObserveResult({ ...initial, rotation: 1 });
  expect(
    await tapAt.execute({ x: 10, y: 20, snapshotId: capture.reference.snapshotId }),
  ).toMatchObject({ success: false, error: expect.stringContaining("rotation") });
  expect(iosDispatches).toHaveLength(1);
});
