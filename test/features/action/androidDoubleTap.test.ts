import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  ANDROID_DOUBLE_TAP_TIMEOUT_MS,
  DOUBLE_TAP_START_BUDGET_MS,
  dispatchAndroidDoubleTap,
  type AtomicDoubleTapRequestOptions,
} from "../../../src/features/action/androidDoubleTap";
import {
  androidDisplayTapDispatch,
  isStaleFrameContextRejection,
  type CoordinateTapClient,
} from "../../../src/features/action/coordinateTapDispatch";
import { DOUBLE_TAP_GAP_MS } from "../../../src/features/action/tapAtGesture";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { Element, BootedDevice } from "../../../src/models";
import { ActionableError } from "../../../src/models";
import { logger } from "../../../src/utils/logger";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTalkBackNavigationDriver } from "../../fakes/FakeTalkBackNavigationDriver";
import { FakeTalkBackTapStrategy } from "../../fakes/FakeTalkBackTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntil } from "../../helpers/fakeTimerStepping";
import { observation, setFakeTapAtWindow } from "../../helpers/tapAtCoordinate";

/** The target start-to-start interval; Android's own limit is ANDROID_DOUBLE_TAP_TIMEOUT_MS. */
const TARGET_START_TO_START_MS = DOUBLE_TAP_START_BUDGET_MS;
const SLOW_ROUND_TRIP_MS = 300;
const FAST_ROUND_TRIP_MS = 60;

const androidDevice = {
  name: "Android test device",
  platform: "android",
  deviceId: "emulator-5554",
} as BootedDevice;

type TapResult = { success: boolean; error?: string; acknowledged?: boolean };

/**
 * A CtrlProxy fake whose requests take `roundTripMs` of fake time (gesture duration plus reply),
 * recording the fake time each request STARTED.
 */
function timedClient(
  timer: FakeTimer,
  options: { roundTripMs: number; atomic?: (requestNumber: number) => TapResult },
) {
  const tapStarts: number[] = [];
  const doubleRequests: Array<{
    x: number;
    y: number;
    startedAt: number;
    options?: AtomicDoubleTapRequestOptions;
  }> = [];
  const client = {
    requestTapCoordinates: async (
      _x: number,
      _y: number,
      _duration?: number,
      _timeoutMs?: number,
      _perf?: unknown,
      _frameContext?: string,
      onDispatch?: () => void,
    ): Promise<TapResult> => {
      tapStarts.push(timer.now());
      onDispatch?.();
      await timer.sleep(options.roundTripMs);
      return { success: true };
    },
    ...(options.atomic
      ? {
          requestDoubleTapCoordinates: async (
            x: number,
            y: number,
            onDispatch?: () => void,
            requestOptions?: AtomicDoubleTapRequestOptions,
          ): Promise<TapResult> => {
            doubleRequests.push({ x, y, startedAt: timer.now(), options: requestOptions });
            const result = options.atomic?.(doubleRequests.length) ?? { success: true };
            // A reply carrying `acknowledged` (true: device answered, false: reply lost) exists
            // only once the request was written to the socket.
            if (result.success || result.acknowledged !== undefined) {
              onDispatch?.();
            }
            await timer.sleep(options.roundTripMs);
            return result;
          },
        }
      : {}),
  };
  return { client, tapStarts, doubleRequests };
}

function newTimer(): FakeTimer {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return timer;
}

function expectStartToStart(starts: number[], maxMs = TARGET_START_TO_START_MS): void {
  expect(starts).toHaveLength(2);
  expect(starts[1] - starts[0]).toBeLessThanOrEqual(maxMs);
}

describe("dispatchAndroidDoubleTap", () => {
  const point = { x: 10, y: 20 };

  test("sends one device-timed gesture and never a sequential tap when supported", async () => {
    const timer = newTimer();
    const { client, tapStarts, doubleRequests } = timedClient(timer, {
      roundTripMs: SLOW_ROUND_TRIP_MS,
      atomic: () => ({ success: true }),
    });
    const onTapDelivered = mock(() => {});
    const tap = mock(async () => {});
    await dispatchAndroidDoubleTap({
      client,
      point,
      frameContext: "frame-1",
      displayId: 2,
      timer,
      onTapDelivered,
      tap,
    });
    expect(doubleRequests).toMatchObject([
      { x: 10, y: 20, options: { frameContext: "frame-1", displayId: 2 } },
    ]);
    expect(tap).not.toHaveBeenCalled();
    expect(tapStarts).toEqual([]);
    expect(onTapDelivered).toHaveBeenCalledTimes(2);
    expect(timer.getSleepHistory()).toEqual([SLOW_ROUND_TRIP_MS]);
  });

  test("falls back to sequential taps when the runner never dispatched the gesture", async () => {
    const timer = newTimer();
    const { client, tapStarts, doubleRequests } = timedClient(timer, {
      roundTripMs: FAST_ROUND_TRIP_MS,
      atomic: () => ({ success: false, error: "tap_double_v1 is not confirmed" }),
    });
    await dispatchAndroidDoubleTap({
      client,
      point,
      timer,
      tap: () => client.requestTapCoordinates(10, 20, 10, undefined, undefined, undefined),
    });
    expect(doubleRequests).toHaveLength(1);
    expect(tapStarts).toHaveLength(2);
    expectStartToStart(tapStarts);
  });

  test("a dispatched but unconfirmed gesture is indeterminate and never replayed", async () => {
    const timer = newTimer();
    const { client } = timedClient(timer, { roundTripMs: 1 });
    const tap = mock(async () => {});
    const failing = {
      requestDoubleTapCoordinates: async (
        _x: number,
        _y: number,
        onDispatch?: () => void,
      ): Promise<TapResult> => {
        onDispatch?.();
        return { success: false, error: "Double tap timed out after 5000ms", acknowledged: false };
      },
    };
    await expect(
      dispatchAndroidDoubleTap({ client: { ...client, ...failing }, point, timer, tap }),
    ).rejects.toThrow(/outcome is indeterminate.*Do not retry automatically/i);
    expect(tap).not.toHaveBeenCalled();
  });

  const STALE_FRAME_ERROR = "Stale frame context for input/tap; observe again";

  /** A fake whose request reaches the device (onDispatch fires) before `reply` comes back. */
  function dispatchedThenReply(reply: TapResult) {
    return {
      requestDoubleTapCoordinates: async (
        _x: number,
        _y: number,
        onDispatch?: () => void,
      ): Promise<TapResult> => {
        onDispatch?.();
        return reply;
      },
    };
  }

  test("a device stale-frame rejection of a dispatched request is a plain stale error", async () => {
    const timer = newTimer();
    const tap = mock(async () => {});
    const client = dispatchedThenReply({
      success: false,
      error: STALE_FRAME_ERROR,
      acknowledged: true,
    });
    const failure = await dispatchAndroidDoubleTap({
      client,
      point,
      frameContext: "old",
      timer,
      tap,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ActionableError);
    expect((failure as Error).message).toBe(STALE_FRAME_ERROR);
    expect((failure as Error).message).not.toMatch(/indeterminate|Do not retry/i);
    expect(isStaleFrameContextRejection((failure as Error).message)).toBe(true);
    expect(tap).not.toHaveBeenCalled();
  });

  test("any other acknowledged device refusal is a failure, not indeterminate, and not replayed", async () => {
    const timer = newTimer();
    const tap = mock(async () => {});
    const client = dispatchedThenReply({
      success: false,
      error: "Gesture dispatch rejected",
      acknowledged: true,
    });
    const failure = await dispatchAndroidDoubleTap({ client, point, timer, tap }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ActionableError);
    expect((failure as Error).message).toContain("Gesture dispatch rejected");
    expect((failure as Error).message).not.toMatch(/indeterminate|Do not retry/i);
    expect(tap).not.toHaveBeenCalled();
  });

  test("dispatched with no reply is indeterminate: no retry and no fallback taps", async () => {
    const timer = newTimer();
    const tap = mock(async () => {});
    const client = dispatchedThenReply({
      success: false,
      error: "Double tap timed out after 5000ms",
      acknowledged: false,
    });
    await expect(
      dispatchAndroidDoubleTap({ client, point, frameContext: "old", timer, tap }),
    ).rejects.toThrow(/outcome is indeterminate.*Do not retry automatically/i);
    expect(tap).not.toHaveBeenCalled();
  });

  test("starts the second tap the gap after the first tap STARTED, not after its reply", async () => {
    const timer = newTimer();
    const { client, tapStarts } = timedClient(timer, { roundTripMs: 150 });
    await dispatchAndroidDoubleTap({
      point,
      timer,
      tap: () => client.requestTapCoordinates(10, 20),
    });
    expect(tapStarts[1] - tapStarts[0]).toBe(DOUBLE_TAP_GAP_MS);
    expect(timer.getSleepHistory()).toEqual([150, DOUBLE_TAP_GAP_MS - 150, 150]);
  });

  test("a first tap slower than the window is followed immediately and warns", async () => {
    const timer = newTimer();
    const { client, tapStarts } = timedClient(timer, { roundTripMs: SLOW_ROUND_TRIP_MS + 20 });
    const onWarning = mock((_warning: string) => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await dispatchAndroidDoubleTap({
        point,
        timer,
        onWarning,
        tap: () => client.requestTapCoordinates(10, 20),
      });
      // No extra gap is added on top of the slow round trip.
      expect(tapStarts[1] - tapStarts[0]).toBe(SLOW_ROUND_TRIP_MS + 20);
      expect(timer.getSleepHistory()).toEqual([SLOW_ROUND_TRIP_MS + 20, SLOW_ROUND_TRIP_MS + 20]);
      expect(onWarning).toHaveBeenCalledTimes(1);
      expect(onWarning.mock.calls[0]?.[0]).toContain(`${ANDROID_DOUBLE_TAP_TIMEOUT_MS} ms`);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a prompt first tap produces no warning", async () => {
    const timer = newTimer();
    const { client } = timedClient(timer, { roundTripMs: FAST_ROUND_TRIP_MS });
    const onWarning = mock((_warning: string) => {});
    await dispatchAndroidDoubleTap({
      point,
      timer,
      onWarning,
      tap: () => client.requestTapCoordinates(10, 20),
    });
    expect(onWarning).not.toHaveBeenCalled();
  });

  test("abort during the gap prevents the second tap", async () => {
    const timer = newTimer();
    const controller = new AbortController();
    const { client, tapStarts } = timedClient(timer, { roundTripMs: 0 });
    const pending = dispatchAndroidDoubleTap({
      point,
      timer,
      signal: controller.signal,
      tap: () => client.requestTapCoordinates(10, 20),
    });
    // Microtasks only: a real turn would let auto-advance finish the gap first.
    await drainUntil(() => tapStarts.length === 1, { description: "the first tap" });
    controller.abort();
    await expect(pending).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
    expect(tapStarts).toHaveLength(1);
  });

  test("a display change in the gap prevents the second tap", async () => {
    const timer = newTimer();
    const { client, tapStarts } = timedClient(timer, { roundTripMs: 0 });
    let current = true;
    const pending = dispatchAndroidDoubleTap({
      point,
      timer,
      assertCurrent: () => {
        if (!current) {
          throw new ActionableError("Display changed");
        }
      },
      tap: () => client.requestTapCoordinates(10, 20),
    });
    // Microtasks only: a real turn would let auto-advance finish the gap first.
    await drainUntil(() => tapStarts.length === 1, { description: "the first tap" });
    current = false;
    await expect(pending).rejects.toThrow("Display changed");
    expect(tapStarts).toHaveLength(1);
  });
});

describe("explicit-display dispatcher (tapOn / tapAny display)", () => {
  const target = {
    observation: {
      ...observation(100, 200),
      display: { key: "inner", role: "inner", posture: "opened", generation: 7 } as const,
    },
    displayId: 2,
    assertCurrent: () => {},
  };

  test("a single device-timed request carries the display id", async () => {
    const timer = newTimer();
    const adb = new FakeAdbExecutor();
    const { client, tapStarts, doubleRequests } = timedClient(timer, {
      roundTripMs: SLOW_ROUND_TRIP_MS,
      atomic: () => ({ success: true }),
    });
    const onDispatched = mock(() => {});
    const dispatch = await androidDisplayTapDispatch(
      { ...client, supportsCommand: async () => true },
      adb,
      { action: "doubleTap" },
      { target, onDispatched, timer },
    );
    await dispatch({ x: 10, y: 20 });
    expect(doubleRequests).toMatchObject([{ x: 10, y: 20, options: { displayId: 2 } }]);
    expect(tapStarts).toEqual([]);
    expect(onDispatched).toHaveBeenCalledTimes(2);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("an unroutable panel never receives the single-gesture request", async () => {
    const timer = newTimer();
    const adb = new FakeAdbExecutor();
    const { client, doubleRequests } = timedClient(timer, {
      roundTripMs: 1,
      atomic: () => ({ success: true }),
    });
    const dispatch = await androidDisplayTapDispatch(
      { ...client, supportsCommand: async () => false },
      adb,
      { action: "doubleTap" },
      { target, onDispatched: () => {}, timer },
    );
    await dispatch({ x: 10, y: 20 });
    expect(doubleRequests).toEqual([]);
    expect(adb.getExecutedCommands()).toHaveLength(2);
  });

  test("sequential fallback keeps the taps within the target interval", async () => {
    const timer = newTimer();
    const { client, tapStarts } = timedClient(timer, { roundTripMs: FAST_ROUND_TRIP_MS });
    const dispatch = await androidDisplayTapDispatch(
      { ...client, supportsCommand: async () => true },
      new FakeAdbExecutor(),
      { action: "doubleTap" },
      { target, onDispatched: () => {}, timer },
    );
    await dispatch({ x: 10, y: 20 });
    expectStartToStart(tapStarts);
  });

  test("a slow first tap still dispatches the second immediately and reports the risk", async () => {
    const timer = newTimer();
    const { client, tapStarts } = timedClient(timer, { roundTripMs: SLOW_ROUND_TRIP_MS });
    const onWarning = mock((_warning: string) => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const dispatch = await androidDisplayTapDispatch(
        { ...client, supportsCommand: async () => true },
        new FakeAdbExecutor(),
        { action: "doubleTap" },
        { target, onDispatched: () => {}, timer, onWarning },
      );
      await dispatch({ x: 10, y: 20 });
      expect(tapStarts[1] - tapStarts[0]).toBe(SLOW_ROUND_TRIP_MS);
      expect(onWarning).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a dispatched failure of the single gesture is indeterminate, not partial", async () => {
    const timer = newTimer();
    const adb = new FakeAdbExecutor();
    const client: CoordinateTapClient<() => void> & {
      requestDoubleTapCoordinates: (
        x: number,
        y: number,
        onDispatch?: () => void,
      ) => Promise<TapResult>;
    } = {
      requestTapCoordinates: async () => ({ success: true }),
      requestDoubleTapCoordinates: async (_x, _y, onDispatch) => {
        onDispatch?.();
        return { success: false, error: "Double tap timed out" };
      },
    };
    const dispatch = await androidDisplayTapDispatch(
      { ...client, supportsCommand: async () => true },
      adb,
      { action: "doubleTap" },
      { target, onDispatched: () => {}, timer },
    );
    const pending = dispatch({ x: 10, y: 20 });
    await expect(pending).rejects.toThrow(/indeterminate.*Do not retry automatically/i);
    await expect(pending).rejects.not.toThrow(/partially applied/i);
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});

describe("tapAt (Android)", () => {
  function createTapAt(
    client: ReturnType<typeof timedClient>["client"],
    timer: FakeTimer,
    frames: string[] = ["epoch:7"],
  ) {
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveSequence(
      frames.map((frame) => ({
        ...observation(100, 200, frame),
        display: { key: "0", role: "unknown", generation: 0 },
      })),
    );
    const tapAt = new TapAtCoordinate(androidDevice, new FakeAdbExecutor(), {
      timer,
      androidClient: client,
      iosClient: client,
      lastRenderedObservation: () => ({ display: { key: "0" }, displayRevision: 0 }),
    });
    setFakeTapAtWindow(tapAt);
    tapAt.observeScreen = observeScreen;
    return tapAt;
  }

  test.each(["default", "active"] as const)(
    "sends one device-timed double tap (%s display)",
    async (route) => {
      const display = route === "default" ? undefined : route;
      const timer = newTimer();
      const { client, tapStarts, doubleRequests } = timedClient(timer, {
        roundTripMs: SLOW_ROUND_TRIP_MS,
        atomic: () => ({ success: true }),
      });
      const result = await createTapAt(client, timer).execute({
        x: 10,
        y: 20,
        action: "doubleTap",
        display,
      });
      expect(result).toMatchObject({ success: true, action: "doubleTap" });
      expect(tapStarts).toEqual([]);
      expect(doubleRequests).toHaveLength(1);
      if (display === undefined) {
        // The default path fences the request on the observed frame.
        expect(doubleRequests[0]?.options?.frameContext).toBe("epoch:7");
      }
    },
  );

  test.each(["default", "active"] as const)(
    "sequential fallback starts the taps within the target interval (%s display)",
    async (route) => {
      const display = route === "default" ? undefined : route;
      const timer = newTimer();
      const { client, tapStarts } = timedClient(timer, { roundTripMs: FAST_ROUND_TRIP_MS });
      const result = await createTapAt(client, timer).execute({
        x: 10,
        y: 20,
        action: "doubleTap",
        display,
      });
      expect(result).toMatchObject({ success: true });
      expectStartToStart(tapStarts);
    },
  );

  test.each(["default", "active"] as const)(
    "a slow first tap warns in the result instead of silently succeeding (%s display)",
    async (route) => {
      const display = route === "default" ? undefined : route;
      const timer = newTimer();
      const { client, tapStarts } = timedClient(timer, { roundTripMs: SLOW_ROUND_TRIP_MS });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const result = await createTapAt(client, timer).execute({
          x: 10,
          y: 20,
          action: "doubleTap",
          display,
        });
        expect(result.success).toBe(true);
        expect(tapStarts[1] - tapStarts[0]).toBe(SLOW_ROUND_TRIP_MS);
        expect(result.warnings?.join("\n")).toContain("double-tap timeout");
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("a device stale-frame rejection refreshes the frame once, then performs the double tap", async () => {
    const timer = newTimer();
    const { client, tapStarts, doubleRequests } = timedClient(timer, {
      roundTripMs: FAST_ROUND_TRIP_MS,
      atomic: (requestNumber) =>
        requestNumber === 1
          ? { success: false, error: "Stale frame context for input/tap", acknowledged: true }
          : { success: true },
    });
    const tapAt = createTapAt(client, timer, ["epoch:1", "epoch:2"]);
    const result = await tapAt.execute({ x: 10, y: 20, action: "doubleTap" });
    expect(result).toMatchObject({ success: true, action: "doubleTap" });
    expect(result.error).toBeUndefined();
    // Exactly one fresh-frame retry: the stale frame, then the refreshed one; never two plain taps.
    expect(doubleRequests.map((request) => request.options?.frameContext)).toEqual([
      "epoch:1",
      "epoch:2",
    ]);
    expect(tapStarts).toEqual([]);
  });

  test("a stale-frame rejection of the retry is reported once, not as indeterminate", async () => {
    const timer = newTimer();
    const { client, tapStarts, doubleRequests } = timedClient(timer, {
      roundTripMs: FAST_ROUND_TRIP_MS,
      atomic: () => ({ success: false, error: "Stale frame context", acknowledged: true }),
    });
    const result = await createTapAt(client, timer, ["epoch:1", "epoch:2"]).execute({
      x: 10,
      y: 20,
      action: "doubleTap",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Stale frame context");
    expect(result.error).not.toMatch(/indeterminate|Do not retry/i);
    expect(doubleRequests).toHaveLength(2);
    expect(tapStarts).toEqual([]);
  });

  test("a dispatched double tap with no reply is never retried at a fresh frame", async () => {
    const timer = newTimer();
    const { client, tapStarts, doubleRequests } = timedClient(timer, {
      roundTripMs: FAST_ROUND_TRIP_MS,
      atomic: () => ({ success: false, error: "Double tap timed out", acknowledged: false }),
    });
    const result = await createTapAt(client, timer, ["epoch:1", "epoch:2"]).execute({
      x: 10,
      y: 20,
      action: "doubleTap",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/indeterminate.*Do not retry automatically/i);
    expect(doubleRequests).toHaveLength(1);
    expect(tapStarts).toEqual([]);
  });

  test("a dispatched unconfirmed double tap is reported as indeterminate", async () => {
    const timer = newTimer();
    const client = {
      requestTapCoordinates: async () => ({ success: true }),
      requestDoubleTapCoordinates: async (_x: number, _y: number, onDispatch?: () => void) => {
        onDispatch?.();
        return { success: false, error: "Double tap timed out after 5000ms", acknowledged: false };
      },
    };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await createTapAt(client, timer).execute({
        x: 10,
        y: 20,
        action: "doubleTap",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/indeterminate.*Do not retry automatically/i);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("tapAny (Android default display)", () => {
  const element = {
    bounds: { left: 10, top: 20, right: 110, bottom: 70 },
    text: "ListItem",
    clickable: "true",
  } as Element;

  function createTapAny(timer: FakeTimer, client: ReturnType<typeof timedClient>["client"]) {
    const service = {
      ...client,
      requestAction: async (action: string) => ({ success: true, action, totalTimeMs: 1 }),
      supportsNodeActionSelectors: async () => true,
    };
    const tapAny = new TapAnyElement(androidDevice, new FakeAdbExecutor(), {
      timer,
      elementSelector: new FakeElementSelector(element),
      accessibilityDetector: new FakeAccessibilityDetector(),
      accessibilityService: service,
      talkBackStrategy: new FakeTalkBackTapStrategy(),
      talkBackDriverFactory: { createDriver: () => new FakeTalkBackNavigationDriver() },
    });
    tapAny.observedInteraction = (action) =>
      action(
        recordObservationRead({
          viewHierarchy: { hierarchy: { node: { marker: "before" } } },
          screenSize: { width: 500, height: 500 },
        }),
      );
    tapAny.setRefreshViewHierarchyForTesting(async () => null);
    return tapAny;
  }

  test("sends one device-timed double tap", async () => {
    const timer = newTimer();
    const { client, tapStarts, doubleRequests } = timedClient(timer, {
      roundTripMs: SLOW_ROUND_TRIP_MS,
      atomic: () => ({ success: true }),
    });
    const result = await createTapAny(timer, client).execute({ action: "doubleTap" });
    expect(result.success).toBe(true);
    expect(tapStarts).toEqual([]);
    expect(doubleRequests).toMatchObject([{ x: 60, y: 45 }]);
  });

  test("sequential fallback starts the taps within the target interval", async () => {
    const timer = newTimer();
    const { client, tapStarts } = timedClient(timer, { roundTripMs: FAST_ROUND_TRIP_MS });
    const result = await createTapAny(timer, client).execute({ action: "doubleTap" });
    expect(result.success).toBe(true);
    expectStartToStart(tapStarts);
  });

  test("a slow first tap warns in the result", async () => {
    const timer = newTimer();
    const { client, tapStarts } = timedClient(timer, { roundTripMs: SLOW_ROUND_TRIP_MS });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await createTapAny(timer, client).execute({ action: "doubleTap" });
      expect(result.success).toBe(true);
      expect(tapStarts[1] - tapStarts[0]).toBe(SLOW_ROUND_TRIP_MS);
      expect(result.warnings?.join("\n")).toContain("double-tap timeout");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("tapOn (Android default display)", () => {
  const plainElement: Element = {
    "resource-id": "com.example.app:id/target",
    clickable: "true",
    bounds: { left: 0, top: 300, right: 1080, bottom: 460 },
  };

  function createTap(timer: FakeTimer, client: ReturnType<typeof timedClient>["client"]) {
    const service = new FakeCtrlProxy(timer);
    Object.assign(service, client);
    const clientSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      service as unknown as AndroidCtrlProxyClient,
    );
    try {
      return new TapOnElement(androidDevice, new FakeAdbClient(), { timer });
    } finally {
      clientSpy.mockRestore();
    }
  }

  const doubleTap = (tap: TapOnElement) =>
    (
      tap as unknown as {
        executeAndroidTapWithCoordinates(
          action: string,
          x: number,
          y: number,
          durationMs: number,
          element: Element,
        ): Promise<void>;
      }
    ).executeAndroidTapWithCoordinates("doubleTap", 540, 380, 0, plainElement);

  test("sends one device-timed double tap", async () => {
    const timer = newTimer();
    const { client, tapStarts, doubleRequests } = timedClient(timer, {
      roundTripMs: SLOW_ROUND_TRIP_MS,
      atomic: () => ({ success: true }),
    });
    await doubleTap(createTap(timer, client));
    expect(tapStarts).toEqual([]);
    expect(doubleRequests).toMatchObject([{ x: 540, y: 380 }]);
  });

  test("sequential fallback starts the taps within the target interval", async () => {
    const timer = newTimer();
    const { client, tapStarts } = timedClient(timer, { roundTripMs: FAST_ROUND_TRIP_MS });
    await doubleTap(createTap(timer, client));
    expectStartToStart(tapStarts);
  });

  test("a slow first tap on a uiautomator-source element is returned as a warning", async () => {
    const timer = newTimer();
    const { client } = timedClient(timer, { roundTripMs: SLOW_ROUND_TRIP_MS });
    const warnings: string[] = [];
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await createTap(timer, client).executeAndroidTap(
        "doubleTap",
        540,
        380,
        0,
        { ...plainElement, "hierarchy-source": "uiautomator" },
        undefined,
        { onActivationWarning: (warning) => warnings.push(warning) },
        false,
      );
      expect(warnings.join("\n")).toContain("double-tap timeout");
    } finally {
      warn.mockRestore();
    }
  });

  test("a slow first tap is followed immediately and logged", async () => {
    const timer = newTimer();
    const { client, tapStarts } = timedClient(timer, { roundTripMs: SLOW_ROUND_TRIP_MS });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await doubleTap(createTap(timer, client));
      expect(tapStarts[1] - tapStarts[0]).toBe(SLOW_ROUND_TRIP_MS);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "double-tap timeout",
      );
    } finally {
      warn.mockRestore();
    }
  });
});
